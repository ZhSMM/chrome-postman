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
  normalizeUrl,
  splitUrlAndQuery,
  toBlobBuffer,
} from '../shared/utils';
import type {
  BodyConfig,
  HttpMethod,
  HttpRequest,
  HttpResponseData,
  KeyValue,
  LogEntry,
  ResolvedRequest,
  ScriptOutcome,
  TestResult,
  VariableScope,
} from '../shared/types';
import { interpolate, keyValuesToRecord, mergeScopes } from './variables';
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
}

/** 执行结果 */
export interface ExecuteOutcome {
  request: ResolvedRequest;
  response: HttpResponseData | null;
  outcome: ScriptOutcome;
  error?: string;
  totalTime: number;
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

/** 步骤 ⑤：合成最终要发出去的 URL / 头 / 体 */
export interface ComposedRequest {
  url: string;
  headers: Record<string, string>;
  body?: BodyInit;
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

  switch (body.mode) {
    case 'json': {
      if (body.raw && body.raw.trim()) {
        try {
          JSON.parse(body.raw);
        } catch (err) {
          throw new Error(`请求体不是合法 JSON：${(err as Error).message}`);
        }
        payload = body.raw;
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
      if (!Object.keys(headers).some((k) => k.toLowerCase() === 'content-type')) {
        headers['Content-Type'] = 'application/x-www-form-urlencoded';
      }
      break;
    }
    case 'form-data': {
      const form = new FormData();
      (body.formData ?? [])
        .filter((item) => item.enabled && item.key)
        .forEach((item) => {
          if (item.isFile) {
            const bytes = item.fileBase64 ? base64ToBytes(item.fileBase64) : new Uint8Array();
            const blob = new Blob([toBlobBuffer(bytes)], { type: item.mimeType || 'application/octet-stream' });
            form.append(item.key, blob, item.fileName || 'file');
          } else {
            form.append(item.key, item.value ?? '');
          }
        });
      payload = form;
      // 注意：multipart 的 boundary 由浏览器自动生成，不能手动写 Content-Type
      break;
    }
    case 'binary': {
      if (body.binaryBase64) {
        const bytes = base64ToBytes(body.binaryBase64);
        payload = new Blob([toBlobBuffer(bytes)], { type: body.binaryMimeType || 'application/octet-stream' });
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

  return { url, headers, body: payload };
}

/** 判断响应是不是二进制（是的话按 Base64 存） */
function isBinaryContentType(contentType: string): boolean {
  return /^(application\/octet-stream|application\/zip|application\/pdf|image\/|audio\/|video\/|font\/)/i.test(
    contentType,
  );
}

/**
 * 主入口：执行一次完整的请求。
 *
 * @param request 请求草稿
 * @param scope   变量作用域
 * @param deps    可注入的依赖（fetch / 时钟 / 超时等）
 */
export async function executeRequest(
  request: HttpRequest,
  scope: VariableScope = emptyScope(),
  deps: ExecuteDeps = {},
): Promise<ExecuteOutcome> {
  const now = deps.now ?? (() => Date.now());
  const fetchImpl = deps.fetchImpl ?? globalThis.fetch.bind(globalThis);
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
      outcome.error = `前置脚本错误：${pre.error}`;
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
    const targetUrl = normalizeUrl(composed.url);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);
    try {
      const rawResponse = await fetchImpl(targetUrl, {
        method: resolved.method,
        headers: composed.headers,
        body: composed.body,
        redirect: followRedirects ? 'follow' : 'manual',
        credentials: sendCookies ? 'include' : 'omit',
        signal: controller.signal,
      });

      const responseTime = Math.max(0, now() - startedAt);
      const contentType = rawResponse.headers.get('content-type') ?? '';
      const headerRecord: Record<string, string> = {};
      rawResponse.headers.forEach((value, key) => {
        headerRecord[key] = value;
      });

      let bodyText: string;
      let isBase64 = false;
      if (isBinaryContentType(contentType)) {
        const buffer = await rawResponse.arrayBuffer();
        const bytes = new Uint8Array(buffer);
        let binary = '';
        const chunk = 0x8000;
        for (let i = 0; i < bytes.length; i += chunk) {
          binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
        }
        bodyText = btoa(binary);
        isBase64 = true;
      } else {
        bodyText = await rawResponse.text();
      }

      response = {
        status: rawResponse.status,
        statusText: rawResponse.statusText,
        headers: headerRecord,
        body: bodyText,
        isBase64,
        size: bodyText.length,
        responseTime,
        finalUrl: rawResponse.url || targetUrl,
      };
    } finally {
      clearTimeout(timer);
    }
  } catch (err) {
    const e = err as Error;
    if (e?.name === 'AbortError') {
      errorMessage = `请求超时（${timeout} ms）`;
    } else {
      errorMessage = describeNetworkError(e, resolved);
    }
    outcome.error = outcome.error ?? errorMessage;
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
      outcome.error = outcome.error ?? `后置脚本错误：${post.error}`;
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
    totalTime: Math.max(0, now() - startedAt),
  };
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
 * 把底层的网络错误翻译成用户能看懂的提示。
 * 这是"新手友好"的重要一环：光说 "Failed to fetch" 没人知道该干嘛。
 */
function describeNetworkError(error: Error, resolved: ResolvedRequest): string {
  const message = error?.message ?? String(error);
  if (/Failed to fetch|NetworkError|load failed/i.test(message)) {
    return [
      `请求失败：无法连接到 ${resolved.url}。`,
      '可能原因：① 域名不存在或拼写错误；② 网络不通；③ 服务端拒绝跨域且扩展未获得该域名的访问权限；④ HTTPS 页面访问 HTTP 接口被浏览器拦截。',
      `（原始错误：${message}）`,
    ].join('\n');
  }
  return `请求失败：${message}`;
}

/** 导出给 UI 用：把 KeyValue[] 转成 Record */
export { keyValuesToRecord };
export type { LogEntry, TestResult };
