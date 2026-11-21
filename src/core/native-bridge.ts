/**
 * ============================================================
 * Native 桥接客户端（协议层）
 * ============================================================
 *
 * 【在架构中的位置】
 * 发送网关的第二条实现。核心层负责"把请求交给桥接程序"，
 * 真正调用 chrome.runtime.connectNative 的适配器放在
 * `src/background/native-host.ts`（那一层才允许碰 chrome.*）。
 *
 * 【初学者先看这里】
 * 为什么要拆成两个文件？
 * 因为本项目的硬规矩是：**核心层（src/core/）不许 import chrome.*、不许碰 DOM**。
 * 这样单元测试才能在 Node 里直接跑，不需要浏览器。
 *
 *   src/core/native-bridge.ts     ← 纯逻辑：怎么组消息、怎么解析响应（可单测）
 *   src/background/native-host.ts ← 适配器：真的去调 chrome.runtime.connectNative
 *
 * 【关键实现细节：消息协议】
 * Chrome native messaging 的标准帧格式是 **4 字节小端长度 + UTF-8 JSON**。
 * 这个封帧由浏览器和伴生程序负责，扩展这一侧只管传 JSON 对象，
 * 所以本文件只需要关心"消息体的形状"。
 *
 * 【安全边界】
 * - 伴生程序只被动响应，不主动外联、不开端口、不读用户文件。
 * - 桥接请求**不携带浏览器的 Cookie** —— 避免跨进程泄露登录态。
 * - allowed_origins 精确到扩展 ID，不用通配符（由 host manifest 保证）。
 */

import type { CertificateInfo } from './certificate';
import type { HttpSender, SendPayload, SendResult } from './http-sender';
import { uid } from '../shared/utils';

/** 伴生程序的注册名（必须与 host manifest 里的 name 完全一致） */
export const BRIDGE_HOST_NAME = 'com.chrome_postman.bridge';

/**
 * 桥接通道的底层传输。
 *
 * 【为什么用接口而不是直接调 chrome.runtime】
 * 核心层不许碰 chrome.*。定义成接口之后：
 * - 单测里注入一个假实现就能测完整条链路；
 * - 真实实现放在 background 层，两者解耦。
 */
export interface BridgeClient {
  /**
   * 发一条消息给伴生程序，等它回一条。
   * @param message 要发的 JSON 对象
   * @returns 伴生程序回的 JSON 对象
   */
  send(message: unknown): Promise<unknown>;
}

/** 发 HTTP 请求时的请求体（发给伴生程序的那一侧） */
export interface BridgeHttpRequest {
  method: string;
  url: string;
  headers: Record<string, string>;
  /** 文本请求体 */
  body?: string;
  /** 二进制请求体（Base64） */
  bodyBase64?: string;
  /** 超时（毫秒） */
  timeoutMs: number;
  /**
   * 是否校验服务器证书。
   *
   * 【这就是整个方案的核心】
   * Node 的 https 模块有这个选项，浏览器的 fetch 没有。
   * 它为 false 时，自签名证书、过期证书、域名不匹配的证书都能连上。
   */
  rejectUnauthorized: boolean;
  /** SNI 覆盖（用 IP 直连时可能需要） */
  servername?: string | null;
}

/** 伴生程序回的响应体 */
export interface BridgeHttpResponse {
  status: number;
  statusText: string;
  headers: Record<string, string>;
  body: string;
  bodyBase64: string | null;
  elapsedMs: number;
  finalUrl?: string;
}

/** 伴生程序回的错误 */
export interface BridgeErrorInfo {
  code: string;
  message: string;
  /** 出错时的证书详情（证书问题才有） */
  cert?: CertificateInfo;
}

/**
 * 桥接通道的错误。
 *
 * 【为什么要自定义错误类型】
 * 执行器会区分"网络错误"和"脚本错误"。证书校验失败属于网络错误，
 * 但它的文案必须和笼统的 "Failed to fetch" 完全不同 ——
 * 用户需要知道是证书问题，而不是"网络连不上"。
 */
export class BridgeError extends Error {
  /** 伴生程序给的错误码，如 CERT_HAS_EXPIRED */
  readonly code: string;
  /** 出错时的证书详情 */
  readonly cert?: CertificateInfo;

  constructor(info: BridgeErrorInfo) {
    super(info.message || info.code || '本地桥接请求失败');
    this.name = 'BridgeError';
    this.code = info.code || 'BRIDGE_ERROR';
    this.cert = info.cert;
  }
}

/** 组装一条"发 HTTP 请求"的消息 */
export function buildHttpMessage(payload: SendPayload, id: string = uid('bridge')) {
  const req: BridgeHttpRequest = {
    method: payload.method,
    url: payload.url,
    headers: payload.headers,
    timeoutMs: payload.timeoutMs,
    // 关键一行：把 SSL 决策翻译成 Node 的 rejectUnauthorized
    rejectUnauthorized: !payload.ssl.allowInsecure,
  };
  if (payload.body !== undefined) req.body = payload.body;
  if (payload.bodyBase64 !== undefined) req.bodyBase64 = payload.bodyBase64;

  return { id, action: 'http', req };
}

/** 组装一条"探活"消息 */
export function buildPingMessage(id: string = uid('bridge')) {
  return { id, action: 'ping' };
}

/** 组装一条"证书体检"消息 */
export function buildInspectCertMessage(url: string, timeoutMs = 10000, id: string = uid('bridge')) {
  return { id, action: 'inspect-cert', req: { url, timeoutMs } };
}

/**
 * 解析伴生程序的响应。
 *
 * 【为什么要严格校验字段】
 * 伴生程序是一个**不受浏览器沙箱保护**的外部进程。
 * 扩展必须假设它可能返回奇怪的东西（版本不匹配、被用户改坏了、
 * 或者注册表指向了另一个程序）。所以宁可报错，也不能把 undefined 塞进下游。
 */
export function parseBridgeResponse(raw: unknown): {
  ok: boolean;
  id?: string;
  res?: BridgeHttpResponse;
  cert?: CertificateInfo;
  version?: string;
  error?: BridgeErrorInfo;
} {
  if (!raw || typeof raw !== 'object') {
    throw new BridgeError({ code: 'BAD_RESPONSE', message: '本地桥接程序返回了无法识别的数据' });
  }
  const message = raw as Record<string, any>;

  if (message.ok === false) {
    const err = message.error ?? {};
    throw new BridgeError({
      code: err.code ?? 'BRIDGE_ERROR',
      message: err.message ?? '本地桥接程序报告了一个错误',
      cert: err.cert,
    });
  }

  return {
    ok: true,
    id: typeof message.id === 'string' ? message.id : undefined,
    res: message.res as BridgeHttpResponse | undefined,
    cert: message.cert as CertificateInfo | undefined,
    version: typeof message.version === 'string' ? message.version : undefined,
  };
}

/**
 * 造一个走 native 通道的发送器。
 *
 * 【与浏览器通道的差别，只有两处】
 * 1. 证书校验可以关（rejectUnauthorized）
 * 2. 不带浏览器的 Cookie（伴生程序没有 cookie jar）
 */
export function createBridgeSender(client: BridgeClient): HttpSender {
  return {
    async send(payload: SendPayload): Promise<SendResult> {
      const message = buildHttpMessage(payload);
      const raw = await client.send(message);
      const parsed = parseBridgeResponse(raw);

      if (!parsed.res) {
        throw new BridgeError({
          code: 'EMPTY_RESPONSE',
          message: '本地桥接程序没有返回响应内容',
        });
      }

      const res = parsed.res;
      return {
        status: res.status,
        statusText: res.statusText ?? '',
        headers: res.headers ?? {},
        body: res.body ?? '',
        bodyBase64: res.bodyBase64 ?? null,
        elapsedMs: res.elapsedMs ?? 0,
        finalUrl: res.finalUrl ?? payload.url,
        // 把"这次是不是跳过了校验"如实传上去，UI 要用它显示横幅
        insecure: payload.ssl.allowInsecure,
      };
    },
  };
}

/**
 * 把桥接通道的错误翻译成人话。
 *
 * 【为什么值得单独写一个函数】
 * 桥接通道最常见的失败是**证书问题**，而用户看到 "Failed to fetch" 完全不知道该干嘛。
 * 这里按错误码给出具体解释 + 可执行的下一步。
 */
export function describeBridgeError(err: BridgeError): string {
  const code = err.code ?? '';
  const base = err.message || code;

  switch (code) {
    case 'CERT_HAS_EXPIRED':
      return `服务器证书已过期：${base}。请更换证书，或把签发它的 CA 装进系统信任库。`;
    case 'CERT_NOT_TRUSTED':
    case 'SELF_SIGNED_CERT_IN_CHAIN':
    case 'UNABLE_TO_VERIFY_LEAF_SIGNATURE':
      return `服务器证书不受信任（通常是自签名证书）：${base}。请把签发 CA 装进系统信任库，或用本地桥接程序跳过校验。`;
    case 'CERT_HOSTNAME_MISMATCH':
    case 'ERR_TLS_CERT_ALTNAME_INVALID':
      return `证书上的域名与请求地址不一致：${base}。请检查 URL 是否写错，或该服务是否换过证书。`;
    case 'ECONNREFUSED':
      return `本机桥接程序拒绝了连接：${base}。请确认伴生程序仍在运行。`;
    case 'ETIMEDOUT':
      return `本机桥接程序请求超时：${base}。请检查目标服务是否可达。`;
    case 'BRIDGE_NOT_INSTALLED':
      return '未检测到本地桥接程序。请先安装伴生程序，或改用「严格校验」模式。';
    default:
      return `本地桥接请求失败（${code}）：${base}`;
  }
}

/**
 * 探测伴生程序是否就绪。
 *
 * 【为什么单独一个函数，而不是复用 createBridgeSender】
 * 探测要的是"版本号"而不是"响应体"，而且失败时要能拿到错误原因
 * （比如"没装伴生程序"和"伴生程序崩了"是两回事，用户需要知道）。
 */
export async function probeBridge(client: BridgeClient): Promise<{
  available: boolean;
  version?: string;
  error?: string;
}> {
  try {
    const raw = await client.send(buildPingMessage());
    const parsed = parseBridgeResponse(raw);
    return { available: true, version: parsed.version ?? 'unknown' };
  } catch (err) {
    const e = err as Error;
    return { available: false, error: e?.message ?? String(e) };
  }
}

/**
 * 读一个地址的证书详情。
 *
 * 这是伴生程序的第二个价值：扩展自己读不到证书（F3 实测），
 * 但 Node 的 TLS socket 提供 getPeerCertificate()。
 */
export async function inspectCertificate(
  client: BridgeClient,
  url: string,
  timeoutMs = 10000,
): Promise<CertificateInfo> {
  const raw = await client.send(buildInspectCertMessage(url, timeoutMs));
  const parsed = parseBridgeResponse(raw);
  if (!parsed.cert) {
    throw new BridgeError({
      code: 'NO_CERT',
      message: '本地桥接程序没有返回证书信息',
    });
  }
  return parsed.cert;
}
