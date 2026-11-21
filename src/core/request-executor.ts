/**
 * ============================================================
 * 请求执行器（Request Executor）—— 整个工具的核心管线
 * ============================================================
 *
 * 【在架构中的位置】
 * Service Worker 收到 UI 的"发送请求"指令后，调用本模块完成一次完整请求。
 * UI 侧不直接发请求，原因：
 *   1. 面板关掉 / 标签页切走时，Service Worker 里的请求仍能跑完；
 *   2. 请求逻辑（脚本沙箱、变量、鉴权）只有一份，不会出现两套行为。
 *
 * 【执行管线（8 步）】
 *   ① 取变量作用域（环境 / 集合 / 全局 / 会话）
 *   ② 变量插值：把 {{var}} 换成真实值
 *   ③ 前置拦截脚本：在沙箱里跑用户脚本，可改写 URL / 头 / 体 / 方法
 *   ④ 二次插值：脚本可能刚写入新变量（如 token），需要再插值一次
 *   ⑤ 合成最终请求：拼 query、套鉴权、序列化 body
 *   ⑥ 发起网络请求（带超时）
 *   ⑦ 后置拦截脚本：可读响应、可写断言、可提取变量、可改写响应
 *   ⑧ 组装结果返回给 UI
 *
 * 【为什么把依赖做成可注入】
 * 本模块不直接依赖 chrome.* 和真实的 fetch，而是通过 deps 注入。
 * 这样单元测试可以在 Node 里用假的 fetch 跑完整条管线，
 * 不需要真的联网，也不需要 chrome 运行环境。
 */

import {
  base64ToBytes,
  buildQueryString,
  bytesToBase64,
  normalizeUrl,
  splitUrlAndQuery,
} from '../shared/utils';
import type {
  BodyConfig,
  HttpMethod,
  HttpRequest,
  HttpResponseData,
  KeyValue,
  LogEntry,
  RequestTiming,
  ResolvedRequest,
  ScriptOutcome,
  SslMode,
  TestResult,
  VariableScope,
} from '../shared/types';
import { interpolate, keyValuesToRecord, mergeScopes } from './variables';
import { buildDiagnosticReport, type DiagnosticReport } from './network-diagnostics';
import { formatScriptError } from './script-error';
import {
  createFetchSender,
  serializeMultipartBody,
  type HttpSender,
  type SendPayload,
} from './http-sender';
import { BridgeError, describeBridgeError } from './native-bridge';
import {
  runSandbox,
  type SandboxRequestState,
  type SandboxResponseState,
  type SandboxScope,
} from './sandbox';

/** 执行器可注入的依赖 */
export interface ExecuteDeps {
  /** 网络实现，默认 globalThis.fetch */
  fetchImpl?: typeof fetch;
  /** 时钟，默认 Date.now */
  now?: () => number;
  /** 超时（毫秒），默认 30000 */
  timeout?: number;
  /** 是否跟随重定向，默认 true */
  followRedirects?: boolean;
  /** 是否携带 Cookie，默认 true */
  sendCookies?: boolean;
  /**
   * 查询某个 URL 最近一次的网络层错误码（net::ERR_xxx）。
   * 由 Service Worker 注入，内部数据来自 chrome.webRequest.onErrorOccurred。
   * 没有这个依赖时，错误提示只能给出笼统的 "Failed to fetch"。
   */
  getNetError?: (url: string) => string | undefined;
  /** 用户在设置里填写的代理地址，仅用于生成更贴合的排查建议 */
  proxyHint?: string;
  /**
   * 查询某个 URL 最近一次请求的分段耗时。
   * 由 Service Worker 注入，数据来自 chrome.webRequest 的四个事件时间戳。
   * 没有这个依赖时，只能给出本地测的总耗时。
   */
  getTiming?: (url: string) => RequestTiming | undefined;
  /**
   * 发送网关。默认走浏览器原生 fetch；Service Worker 在需要走本机桥接时注入桥接版。
   *
   * 【为什么要把它做成可注入的依赖】
   * 核心层不许碰 chrome.*，所以"要不要走 native 通道"这个决定必须由上层做。
   * 上层决定好之后，把对应的 sender 塞进来，执行器只管调 send()。
   */
  sender?: HttpSender;
  /**
   * 本次请求的 SSL 决策（模式 + 是否跳过校验）。
   * 由上层根据设置和桥接就绪状态算好后传进来。
   */
  ssl?: { mode: SslMode; allowInsecure: boolean };
  /**
   * SSL 降级提示。
   *
   * 【为什么要由上层传下来，而不是执行器自己判断】
   * 只有上层知道桥接程序当前是否就绪。执行器拿不到这个信息，
   * 所以"用户以为的配置 ≠ 实际做的事"这件事必须由上层算好后带下来。
   */
  sslNotice?: string;
}

/** 执行结果 */
export interface ExecuteOutcome {
  request: ResolvedRequest;
  response: HttpResponseData | null;
  outcome: ScriptOutcome;
  error?: string;
  diagnostic?: DiagnosticReport;
  totalTime: number;
  /** 分段耗时（webRequest 可用时才有细分） */
  timing?: RequestTiming;
  /** 本次是否跳过了证书校验（UI 要显示横幅） */
  insecure?: boolean;
  /** SSL 降级提示（绝不静默降级，有值就必须在 UI 上说出来） */
  sslNotice?: string;
}

/** 空的作用域 */
function emptyScope(): VariableScope {
  return { environment: {}, collection: {}, globals: {}, session: {} };
}

/**
 * 步骤 ②：变量插值。
 * 把请求里所有可能出现 {{var}} 的地方都替换掉。
 */
export function resolveRequest(request: HttpRequest, scope: VariableScope): ResolvedRequest {
  const missing = new Set<string>();
  const resolveText = (text: string): string => {
    const result = interpolate(text ?? '', scope);
    result.missing.forEach((name) => missing.add(name));
    return result.text;
  };

  const headers: Record<string, string> = {};
  request.headers
    .filter((item) => item.enabled && item.key?.trim())
    .forEach((item) => {
      headers[item.key.trim()] = resolveText(item.value);
    });

  const params: [string, string][] = request.params
    .filter((item) => item.enabled && item.key?.trim())
    .map((item) => [item.key.trim(), resolveText(item.value)] as [string, string]);

  const body: BodyConfig = {
    ...request.body,
    raw: resolveText(request.body?.raw ?? ''),
    form: (request.body?.form ?? []).map((item) => ({
      ...item,
      key: resolveText(item.key),
      value: resolveText(item.value),
    })),
    formData: (request.body?.formData ?? []).map((item) => ({
      ...item,
      key: resolveText(item.key),
      value: resolveText(item.value),
    })),
  };

  const auth = {
    ...request.auth,
    username: request.auth?.username ? resolveText(request.auth.username) : request.auth?.username,
    password: request.auth?.password ? resolveText(request.auth.password) : request.auth?.password,
    token: request.auth?.token ? resolveText(request.auth.token) : request.auth?.token,
    apiKey: request.auth?.apiKey ? resolveText(request.auth.apiKey) : request.auth?.apiKey,
    apiValue: request.auth?.apiValue ? resolveText(request.auth.apiValue) : request.auth?.apiValue,
    oauthToken: request.auth?.oauthToken ? resolveText(request.auth.oauthToken) : request.auth?.oauthToken,
  };

  return {
    method: (request.method ?? 'GET').toUpperCase() as HttpMethod,
    url: resolveText(request.url),
    headers,
    params,
    body,
    auth,
    raw: request,
    missing: Array.from(missing),
  };
}

/**
 * 步骤 ④：对已经插值过的请求再做一次插值。
 * 为什么需要？因为前置脚本可能写了新变量，例如：
 *   pm.environment.set('token', 'abc');
 * 而 URL 里原本写的是 {{token}}，第一次插值时它还不存在。
 */
function reInterpolate(resolved: ResolvedRequest, scope: VariableScope): void {
  const fresh = resolveRequest(resolved.raw, scope);
  // 脚本可能已经改过 resolved 的字段，所以只更新"仍然等于原始值"的字段，
  // 避免把脚本的修改覆盖掉。判断方式：脚本改写后原值对不上。
  if (resolved.url === interpolate(resolved.raw.url, scope).text || resolved.url === resolved.raw.url) {
    resolved.url = fresh.url;
  }
  resolved.params = fresh.params;
  resolved.body = fresh.body;
  resolved.missing = fresh.missing;
}

/** 把 ResolvedRequest 转成沙箱可用的结构 */
function toSandboxRequest(resolved: ResolvedRequest): SandboxRequestState {
  return {
    method: resolved.method,
    url: resolved.url,
    headers: Object.entries(resolved.headers).map(([key, value]) => ({ key, value, enabled: true })),
    body: { mode: resolved.body.mode, raw: resolved.body.raw ?? '' },
    auth: (resolved.auth ?? { type: 'none' }) as unknown as Record<string, unknown>,
  };
}

/** 把沙箱改写后的请求合并回 ResolvedRequest */
function applyRequestPatch(resolved: ResolvedRequest, patch: SandboxRequestState): void {
  if (patch.method) resolved.method = patch.method.toUpperCase() as HttpMethod;
  if (typeof patch.url === 'string') resolved.url = patch.url;
  if (Array.isArray(patch.headers)) {
    const record: Record<string, string> = {};
    patch.headers.forEach((item) => {
      if (!item?.key) return;
      record[item.key] = item.value ?? '';
    });
    resolved.headers = record;
  }
  if (patch.body && typeof patch.body === 'object') {
    resolved.body = {
      ...resolved.body,
      mode: (patch.body.mode as BodyConfig['mode']) ?? resolved.body.mode,
      raw: patch.body.raw ?? resolved.body.raw,
    };
  }
  if (patch.auth && typeof patch.auth === 'object') {
    resolved.auth = { ...resolved.auth, ...(patch.auth as any) };
  }
}

/** 把作用域转成沙箱需要的结构 */
function toSandboxScope(scope: VariableScope): SandboxScope {
  return {
    environment: scope.environment,
    collection: scope.collection,
    globals: scope.globals,
    session: scope.session,
  };
}

/**
 * 请求体的"通道形态"。
 *
 * 【为什么要两种形态】
 * - `body`（BodyInit）是给浏览器 fetch 用的，能装 FormData / Blob；
 * - `channel` 是给 native 通道用的，必须能被 JSON 序列化 ——
 *   Chrome 的 native messaging 只传 JSON，塞 FormData 进去会变成空对象。
 *
 * 有了它，两条通道发出去的内容完全一致，用户不会遇到
 * "在浏览器里能传文件，走桥接就丢了" 这种诡异差异。
 */
export type ChannelBody =
  | { kind: 'none' }
  | { kind: 'text'; text: string }
  | { kind: 'binary'; base64: string };

/** 步骤 ⑤：合成最终要发出去的 URL / 头 / 体 */
export interface ComposedRequest {
  url: string;
  headers: Record<string, string>;
  /** 给 fetch 用的请求体 */
  body?: BodyInit;
  /** 给 native 通道用的请求体（JSON 可序列化） */
  channel: ChannelBody;
}

export function composeRequest(resolved: ResolvedRequest): ComposedRequest {
  const headers: Record<string, string> = { ...resolved.headers };

  // --- URL：内联 query + 参数表 ---
  const { base, params: inlineParams } = splitUrlAndQuery(resolved.url);
  const allParams: [string, string][] = [...inlineParams, ...resolved.params];

  // --- 鉴权 ---
  const auth = resolved.auth ?? { type: 'none' };
  switch (auth.type) {
    case 'basic': {
      const raw = `${auth.username ?? ''}:${auth.password ?? ''}`;
      headers['Authorization'] = `Basic ${btoa(unescape(encodeURIComponent(raw)))}`;
      break;
    }
    case 'bearer': {
      if (auth.token) headers['Authorization'] = `Bearer ${auth.token}`;
      break;
    }
    case 'oauth2': {
      if (auth.oauthToken) headers['Authorization'] = `Bearer ${auth.oauthToken}`;
      break;
    }
    case 'apikey': {
      if (auth.apiKey) {
        if (auth.apiKeyIn === 'query') {
          allParams.push([auth.apiKey, auth.apiValue ?? '']);
        } else {
          headers[auth.apiKey] = auth.apiValue ?? '';
        }
      }
      break;
    }
    default:
      break;
  }

  // --- 请求体 ---
  const body = resolved.body ?? { mode: 'none', raw: '', form: [], formData: [] };
  let payload: BodyInit | undefined;
  let channel: ChannelBody = { kind: 'none' };

  switch (body.mode) {
    case 'json': {
      if (body.raw && body.raw.trim()) {
        try {
          JSON.parse(body.raw);
        } catch (err) {
          throw new Error(`请求体不是合法 JSON：${(err as Error).message}`);
        }
        payload = body.raw;
        channel = { kind: 'text', text: body.raw };
        if (!Object.keys(headers).some((k) => k.toLowerCase() === 'content-type')) {
          headers['Content-Type'] = 'application/json';
        }
      }
      break;
    }
    case 'text':
    case 'xml':
    case 'html': {
      payload = body.raw ?? '';
      channel = { kind: 'text', text: body.raw ?? '' };
      const typeMap: Record<string, string> = {
        text: 'text/plain',
        xml: 'application/xml',
        html: 'text/html',
      };
      if (!Object.keys(headers).some((k) => k.toLowerCase() === 'content-type')) {
        headers['Content-Type'] = typeMap[body.mode];
      }
      break;
    }
    case 'form-urlencoded': {
      const form = new URLSearchParams();
      (body.form ?? [])
        .filter((item) => item.enabled && item.key)
        .forEach((item) => form.append(item.key, item.value ?? ''));
      payload = form.toString();
      channel = { kind: 'text', text: form.toString() };
      if (!Object.keys(headers).some((k) => k.toLowerCase() === 'content-type')) {
        headers['Content-Type'] = 'application/x-www-form-urlencoded';
      }
      break;
    }
    case 'form-data': {
      /*
       * 【为什么手动序列化 multipart，而不是用 FormData】
       * FormData 只能交给浏览器自己发 —— 走 native 通道时是 Node 在发，
       * 它不认识 FormData，分段就丢了。所以这里统一手动序列化，
       * 顺带把 boundary 写进 Content-Type，两条通道才能发出一模一样的字节。
       *
       * 另外必须**强制**覆盖 Content-Type：用户如果手填了一个不带 boundary 的
       * multipart/form-data，服务端解析不出分段（这是 v1.1 的一个隐藏坑）。
       */
      const { bytes, contentType } = serializeMultipartBody(body.formData ?? []);
      payload = bytes as unknown as BodyInit;
      channel = { kind: 'binary', base64: bytesToBase64(bytes) };
      headers['Content-Type'] = contentType;
      break;
    }
    case 'binary': {
      if (body.binaryBase64) {
        const bytes = base64ToBytes(body.binaryBase64);
        payload = bytes as unknown as BodyInit;
        channel = { kind: 'binary', base64: body.binaryBase64 };
        if (!Object.keys(headers).some((k) => k.toLowerCase() === 'content-type')) {
          headers['Content-Type'] = body.binaryMimeType || 'application/octet-stream';
        }
      }
      break;
    }
    default:
      break;
  }

  const query = buildQueryString(allParams);
  const url = query ? `${base}${base.includes('?') ? '&' : '?'}${query}` : base;

  return { url, headers, body: payload, channel };
}

/**
 * 主入口：执行一次完整的请求。
 *
 * @param request 请求草稿
 * @param scope   变量作用域
 * @param deps    可注入的依赖（发送网关 / 时钟 / 超时等）
 */
export async function executeRequest(
  request: HttpRequest,
  scope: VariableScope = emptyScope(),
  deps: ExecuteDeps = {},
): Promise<ExecuteOutcome> {
  const now = deps.now ?? (() => Date.now());
  const timeout = deps.timeout ?? 30000;
  const followRedirects = deps.followRedirects ?? true;
  const sendCookies = deps.sendCookies ?? true;

  const startedAt = now();

  const outcome: ScriptOutcome = {
    variables: { environment: {}, globals: {}, session: {} },
    tests: [],
    logs: [],
  };

  let currentScope: VariableScope = { ...scope };
  let resolved = resolveRequest(request, currentScope);
  let response: HttpResponseData | null = null;
  let errorMessage: string | undefined;
  let diagnostic: DiagnosticReport | undefined;
  let timing: RequestTiming | undefined;
  let targetUrl = '';

  /* ---------- 步骤 ③：前置拦截脚本 ---------- */
  if (request.preScript?.trim()) {
    const pre = await runSandbox({
      script: request.preScript,
      phase: 'pre',
      request: toSandboxRequest(resolved),
      scope: toSandboxScope(currentScope),
    });
    outcome.tests.push(...pre.tests);
    outcome.logs.push(...pre.logs);
    mergeOutcomeVariables(outcome, pre.variables);
    if (pre.error) {
      // 脚本错误存进 outcome.error（结构化，带行列号，UI 用它标红出错行）
      outcome.error = pre.error;
      // 同时把可读摘要放进顶层 error，toast 才有东西可显示
      errorMessage = errorMessage ?? formatScriptError(pre.error);
    }
    if (pre.request) {
      applyRequestPatch(resolved, pre.request);
    }
    currentScope = mergeScopes(currentScope, {
      environment: pre.variables.environment,
      globals: pre.variables.globals,
      session: pre.variables.session,
    });
    // 步骤 ④：脚本可能写了新变量，二次插值
    reInterpolate(resolved, currentScope);
  }

  /* ---------- 步骤 ⑤⑥：合成并发送 ---------- */
  try {
    const composed = composeRequest(resolved);
    // 赋给外层变量：失败时要用它去查网络层的错误码
    targetUrl = normalizeUrl(composed.url);

    /*
     * 【发送网关 —— 整条管线唯一的分叉点】
     * 上层没注入 sender 时，走浏览器原生 fetch（默认，绝大多数请求都是这条）。
     * 上层注入了桥接版 sender 时，请求改由本机 Node 程序发，
     * 这条路才有可能跳过证书校验。
     */
    const sender = deps.sender ?? createFetchSender({ fetchImpl: deps.fetchImpl, now });

    const payload: SendPayload = {
      method: resolved.method,
      url: targetUrl,
      headers: composed.headers,
      timeoutMs: timeout,
      followRedirects,
      sendCookies,
      ssl: {
        mode: deps.ssl?.mode ?? 'strict',
        allowInsecure: deps.ssl?.allowInsecure ?? false,
      },
    };
    if (composed.channel.kind === 'text') payload.body = composed.channel.text;
    if (composed.channel.kind === 'binary') payload.bodyBase64 = composed.channel.base64;

    const sendResult = await sender.send(payload);

    const responseTime = Math.max(0, now() - startedAt);
    /*
     * 二进制响应用 Base64 承载。
     * size 沿用 v1.1 的口径（响应体字符串长度），避免历史记录的大小对不上。
     */
    const bodyText = sendResult.bodyBase64 ?? sendResult.body;
    const isBase64 = sendResult.bodyBase64 !== null;

    response = {
      status: sendResult.status,
      statusText: sendResult.statusText,
      headers: sendResult.headers,
      body: bodyText,
      isBase64,
      size: bodyText.length,
      responseTime,
      finalUrl: sendResult.finalUrl || targetUrl,
      insecure: sendResult.insecure,
    };

    // 取分段耗时（webRequest 的四个事件时间戳）
    timing = await waitForTiming(deps.getTiming, targetUrl, responseTime);
  } catch (err) {
    const e = err as Error;
    const rawMessage = e?.message ?? String(e);

    // 取网络层的真实错误码（如果用户启用了网络诊断）。
    // webRequest 事件与 fetch 的 reject 是两条独立通路，存在先后竞态，
    // 所以这里短暂轮询一下，避免"错误先到、事件后到"导致查不到。
    const netError = deps.getNetError ? await waitForNetError(deps.getNetError, targetUrl) : undefined;

    diagnostic = buildDiagnosticReport(targetUrl, rawMessage, netError, deps.proxyHint);

    if (e instanceof BridgeError) {
      // 桥接通道的错误（最常见的是证书问题），文案必须具体，
      // 不能和笼统的 "Failed to fetch" 混为一谈
      errorMessage = errorMessage ?? describeBridgeError(e);
    } else if (e?.name === 'AbortError') {
      errorMessage = errorMessage ?? `请求超时（${timeout} ms）`;
    } else {
      errorMessage = errorMessage ?? formatNetworkError(diagnostic, resolved);
    }
    // 注意：网络错误**不**写进 outcome.error。
    // outcome.error 只装脚本错误（结构化），网络错误走顶层 error 字段，
    // 这样 UI 能明确区分"网络失败"和"脚本写错了"。
  }

  /* ---------- 步骤 ⑦：后置拦截脚本 ---------- */
  if (request.postScript?.trim()) {
    const post = await runSandbox({
      script: request.postScript,
      phase: 'post',
      request: toSandboxRequest(resolved),
      response: response ? toSandboxResponse(response) : undefined,
      scope: toSandboxScope(currentScope),
    });
    outcome.tests.push(...post.tests);
    outcome.logs.push(...post.logs);
    mergeOutcomeVariables(outcome, post.variables);
    if (post.error) {
      outcome.error = outcome.error ?? post.error;
      errorMessage = errorMessage ?? formatScriptError(post.error);
    }
    if (post.response && response) {
      // 脚本可以改写响应（例如把状态码改成 200 以便后续断言）
      response = {
        ...response,
        status: post.response.code ?? response.status,
        statusText: post.response.status ?? response.statusText,
        headers: post.response.headers?.length
          ? Object.fromEntries(post.response.headers.map((item) => [item.key, item.value]))
          : response.headers,
        body: typeof post.response.body === 'string' ? post.response.body : response.body,
      };
    }
    currentScope = mergeScopes(currentScope, {
      environment: post.variables.environment,
      globals: post.variables.globals,
      session: post.variables.session,
    });
  }

  return {
    request: resolved,
    response,
    outcome,
    error: errorMessage,
    diagnostic,
    totalTime: Math.max(0, now() - startedAt),
    timing,
    /*
     * 本次是否跳过了证书校验。
     * 以 SSL 决策为准 —— 决策层已经保证了"要跳过但桥接没就绪"时会退回严格校验。
     */
    insecure: deps.ssl?.allowInsecure ?? false,
    // 降级提示原样往上带，UI 必须显示出来（绝不静默）
    sslNotice: deps.sslNotice,
  };
}

/**
 * 轮询等待网络层错误码出现。
 *
 * 【为什么要轮询而不是直接查一次】
 * fetch 的 Promise reject 与 chrome.webRequest.onErrorOccurred 事件
 * 分别走 Blink 和浏览器进程两条通路，谁先到并不确定。
 * 实测中大部分情况是事件先到，但为了稳妥，失败后短暂等一下再取。
 */
async function waitForNetError(
  getNetError: (url: string) => string | undefined,
  url: string,
  timeoutMs = 600,
): Promise<string | undefined> {
  if (!url) return undefined;
  const deadline = Date.now() + timeoutMs;
  let found = getNetError(url);
  while (!found && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 60));
    found = getNetError(url);
  }
  return found;
}

/**
 * 轮询等待分段耗时数据出现。
 *
 * 【为什么也要轮询】
 * 和网络错误码一样：fetch resolve 与 webRequest.onCompleted 是两条独立通路，
 * onCompleted 可能在 fetch 之后才触发。等一小会儿就能拿到完整的四段时间戳。
 *
 * @param fallbackTotal 本地测到的总耗时（webRequest 没数据时兜底）
 */
async function waitForTiming(
  getTiming: ((url: string) => RequestTiming | undefined) | undefined,
  url: string,
  fallbackTotal: number,
  timeoutMs = 500,
): Promise<RequestTiming> {
  const fallback: RequestTiming = {
    phases: { connect: 0, waiting: 0, download: 0 },
    total: fallbackTotal,
    fromCache: false,
    redirects: 0,
    source: 'local',
  };

  if (!getTiming || !url) return fallback;

  const deadline = Date.now() + timeoutMs;
  let found = getTiming(url);
  while (!found && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 60));
    found = getTiming(url);
  }
  // 拿到了分段数据就用它，否则退回本地总耗时
  return found ?? fallback;
}

/** 把响应转成沙箱结构 */
function toSandboxResponse(response: HttpResponseData): SandboxResponseState {
  return {
    code: response.status,
    status: response.statusText,
    headers: Object.entries(response.headers).map(([key, value]) => ({ key, value })),
    body: response.body,
    responseTime: response.responseTime,
    size: response.size,
  };
}

/** 合并脚本写入的变量 */
function mergeOutcomeVariables(
  outcome: ScriptOutcome,
  variables: { environment: Record<string, string>; globals: Record<string, string>; session: Record<string, string> },
): void {
  outcome.variables.environment = { ...outcome.variables.environment, ...variables.environment };
  outcome.variables.globals = { ...outcome.variables.globals, ...variables.globals };
  outcome.variables.session = { ...outcome.variables.session, ...variables.session };
}

/**
 * 把诊断报告渲染成用户能看懂的错误文案。
 *
 * 分两层：
 *   1. 第一行给结论（"代理服务器连不上"），让人一眼知道方向
 *   2. 后面给可执行的步骤，而不是"请检查网络"这种废话
 */
function formatNetworkError(diagnostic: DiagnosticReport, resolved: ResolvedRequest): string {
  const lines: string[] = [];
  const explanation = diagnostic.explanation;

  if (explanation) {
    lines.push(`请求失败：${explanation.title}`);
    lines.push('');
    lines.push(explanation.detail);
    if (diagnostic.suggestions.length) {
      lines.push('');
      lines.push('排查建议：');
      diagnostic.suggestions.forEach((item, index) => {
        lines.push(`  ${index + 1}. ${item}`);
      });
    }
    lines.push('');
    lines.push(`（网络错误码：${diagnostic.netError}）`);
    return lines.join('\n');
  }

  // 没有拿到错误码（未启用诊断，或不是网络层错误）：给出通用但可操作的信息
  if (/Failed to fetch|NetworkError|load failed/i.test(diagnostic.rawError)) {
    return [
      `请求失败：无法连接到 ${resolved.url}。`,
      '',
      '可能原因：',
      '  ① 域名不存在或拼写错误；',
      '  ② 本机网络不通；',
      '  ③ 浏览器设置了代理，而目标域名被代理规则拦截或代理自身故障；',
      '  ④ 服务端拒绝跨域且扩展未获得该域名的访问权限；',
      '  ⑤ HTTPS 页面访问 HTTP 接口被浏览器拦截。',
      '',
      '想看到更精确的原因？在「⋯ → 设置」里开启「网络诊断」后重试，',
      '工具会读取 Chrome 内部的网络错误码（例如 net::ERR_PROXY_CONNECTION_FAILED）并给出针对性建议。',
      '',
      `（原始错误：${diagnostic.rawError}）`,
    ].join('\n');
  }
  return `请求失败：${diagnostic.rawError}`;
}

/** 导出给 UI 用：把 KeyValue[] 转成 Record */
export { keyValuesToRecord };
export type { LogEntry, TestResult };
