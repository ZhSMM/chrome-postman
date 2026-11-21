/**
 * ============================================================
 * 发送网关（HTTP Sender）—— 请求真正发出去的那一步
 * ============================================================
 *
 * 【在架构中的位置】
 * 管线长这样：
 *
 *   ① 解析草稿 → ② 变量插值 → ③ 构建头/体 → ④ 前置脚本
 *          ↓
 *     ⑤【发送网关】← 唯一的分叉点
 *          ├─ strict / system-trust
 *          │     └─ fetchSender：浏览器原生 fetch
 *          └─ native-bridge
 *                └─ bridgeSender：sendNativeMessage → 本机 Node 程序
 *          ↓
 *   ⑥ 读取响应 → ⑦ 后置脚本 → ⑧ 落库
 *
 * 【为什么要有这一层抽象，而不是直接在执行器里写 fetch】
 * 1. MV3 扩展**无法关闭 TLS 证书校验** —— 校验发生在 Chromium 网络栈的
 *    net::CertVerifier 层，扩展的 JS 根本碰不到那个开关。
 *    想跳过校验，唯一办法是让请求**不经过浏览器进程**，改由本机 Node 程序发
 *    （Node 的 https 模块有 rejectUnauthorized 选项，浏览器没有）。
 * 2. 有了 HttpSender 接口，核心层依然是纯函数 —— 不 import chrome.*、
 *    不碰 DOM，单测在 Node 里直接跑。测"跳过校验"路径只要注入一个假的 sender，
 *    不需要真的装伴生程序。
 * 3. 以后想加别的传输方式（比如走系统代理），只需要再加一个 sender 实现。
 *
 * 【初学者先看这里】
 * "网关"这个词听起来很玄，其实就是**把"用什么方式发出去"这件事抽出来**。
 * 上面写死了走浏览器，下面写死了走本机程序，中间这段是共用的。
 *
 * 【关键实现细节 / 踩坑点】
 * - 浏览器自己发请求时，multipart 的 boundary 是浏览器生成的；
 *   但走 native 通道时没有浏览器帮忙，必须**我们自己序列化**，
 *   并且把 boundary 写进 Content-Type 头。否则服务端解析不出分段。
 *   为了让两条通道的行为完全一致，这里统一走手动序列化。
 * - fetch 的超时靠 AbortController 实现。超时时抛的是 AbortError，
 *   执行器靠 `err.name === 'AbortError'` 识别它并给出"请求超时"提示。
 * - fetch 的 body 不接受 FormData 之外的"不可序列化"对象，
 *   所以 SendPayload 里只放 string / base64 这两种能安全过 JSON 的形态。
 */

import type { MultipartPart, SslMode } from '../shared/types';
import { base64ToBytes, bytesToBase64 } from '../shared/utils';

/**
 * 一次发送的输入。
 *
 * 【为什么所有字段都是"能过 JSON"的类型】
 * 这个结构体会被原样发给 native 通道（Chrome 的 native messaging 只传 JSON）。
 * 所以不能塞 FormData、Blob、ReadableStream 这些浏览器专有对象 ——
 * 塞进去在 native 通道上会直接变成空对象。
 */
export interface SendPayload {
  /** HTTP 方法 */
  method: string;
  /** 完整 URL（含 query） */
  url: string;
  /** 请求头（小写键名更安全，但这里保持用户写的样子） */
  headers: Record<string, string>;
  /** 文本请求体（JSON / text / xml / html / form-urlencoded） */
  body?: string;
  /** 二进制请求体（Base64） */
  bodyBase64?: string;
  /** 超时（毫秒） */
  timeoutMs: number;
  /** 是否跟随 30x */
  followRedirects: boolean;
  /** 是否携带 Cookie */
  sendCookies: boolean;
  /**
   * SSL 决策。
   * mode 决定"谁来发"，allowInsecure 决定"要不要跳过证书校验"。
   */
  ssl: { mode: SslMode; allowInsecure: boolean };
}

/**
 * 一次发送的结果。
 *
 * 无论走哪条通道，返回的结构都长这样 —— 执行器不需要关心底下是 fetch 还是 Node。
 */
export interface SendResult {
  /** 状态码 */
  status: number;
  /** 状态文本 */
  statusText: string;
  /** 响应头 */
  headers: Record<string, string>;
  /** 响应体文本（二进制响应时这里是空串，用 bodyBase64 承载） */
  body: string;
  /** 二进制响应体的 Base64；不是二进制时为 null */
  bodyBase64: string | null;
  /** 本次发送的网络耗时（毫秒） */
  elapsedMs: number;
  /** 最终 URL（跟随重定向后） */
  finalUrl?: string;
  /**
   * 本次是否跳过了证书校验。
   *
   * 【为什么必须一路带上来】
   * UI 要在响应面板顶部显示"此响应未经证书校验"的醒目横幅。
   * 这个信息只有发请求的那一层知道（是它决定的 rejectUnauthorized），
   * 所以必须在返回值里显式带出来，不能靠上层猜。
   */
  insecure: boolean;
}

/**
 * 发送网关接口。
 *
 * 执行器只认这个接口，不认具体实现。
 */
export interface HttpSender {
  send(payload: SendPayload): Promise<SendResult>;
}

/**
 * 判断响应是不是二进制（是的话按 Base64 存）。
 *
 * 【为什么要按 Content-Type 判断】
 * 扩展要能把响应体原样交给用户（下载图片、导出二进制），
 * 所以不能一律按 UTF-8 文本解码 —— 那样二进制内容会被损坏。
 */
export function isBinaryContentType(contentType: string): boolean {
  return /^(application\/octet-stream|application\/zip|application\/pdf|image\/|audio\/|video\/|font\/)/i.test(
    contentType ?? '',
  );
}

/** 生成一个 multipart boundary */
function generateBoundary(): string {
  const bytes = new Uint8Array(12);
  // crypto 在扩展页面和 Service Worker 里都有；但万一没有也要能跑
  if (typeof crypto !== 'undefined' && typeof crypto.getRandomValues === 'function') {
    crypto.getRandomValues(bytes);
  } else {
    for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
  }
  const hex = Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
  return `----ChromePostmanBoundary${hex}`;
}

/**
 * 文件名的转义。
 *
 * 【为什么要两个名字】
 * - `filename="..."` 是老写法，遇到非 ASCII 会被服务端乱码；
 * - `filename*=UTF-8''...` 是 RFC 5987 的标准扩展，新服务端认这个。
 * 两个都给，老服务端取前者，新服务端优先取后者。
 */
function escapeFilename(name: string): { quoted: string; extended: string | null } {
  const quoted = name.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  // 只有含非 ASCII 字符时才需要补扩展名
  const extended = /[^\x20-\x7e]/.test(name) ? encodeURIComponent(name) : null;
  return { quoted, extended };
}

/**
 * 把 multipart 分段序列化成字节。
 *
 * 【为什么自己序列化，而不是用 FormData】
 * FormData 只能交给浏览器自己发。走 native 通道时是 Node 在发，
 * 它不认识 FormData。所以必须在扩展这边就变成字节，顺带把 boundary 写进请求头。
 *
 * 格式（RFC 7578）：
 *   --BOUNDARY\r\n
 *   Content-Disposition: form-data; name="a"\r\n
 *   \r\n
 *   value\r\n
 *   --BOUNDARY--\r\n
 */
export function serializeMultipartBody(
  parts: MultipartPart[],
  boundary?: string,
): { bytes: Uint8Array; contentType: string } {
  const bnd = boundary ?? generateBoundary();
  const encoder = new TextEncoder();
  const chunks: Uint8Array[] = [];

  const pushText = (text: string) => {
    chunks.push(encoder.encode(text));
  };

  (parts ?? [])
    .filter((part) => part?.enabled && part.key)
    .forEach((part) => {
      pushText(`--${bnd}\r\n`);

      if (part.isFile) {
        const fileName = part.fileName || 'file';
        const { quoted, extended } = escapeFilename(fileName);
        const disposition = extended
          ? `Content-Disposition: form-data; name="${part.key}"; filename="${quoted}"; filename*=UTF-8''${extended}\r\n`
          : `Content-Disposition: form-data; name="${part.key}"; filename="${quoted}"\r\n`;
        pushText(disposition);
        pushText(`Content-Type: ${part.mimeType || 'application/octet-stream'}\r\n`);
        pushText('\r\n');
        // 文件内容是二进制，直接追加字节（不能用 TextEncoder，会被当成 UTF-8 改写）
        chunks.push(part.fileBase64 ? base64ToBytes(part.fileBase64) : new Uint8Array());
      } else {
        pushText(`Content-Disposition: form-data; name="${part.key}"\r\n`);
        pushText('\r\n');
        pushText(part.value ?? '');
      }
      pushText('\r\n');
    });

  // 结束标记：最后一个 boundary 后面跟两个短横
  pushText(`--${bnd}--\r\n`);

  // 拼成一个大 Buffer
  const total = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
  const bytes = new Uint8Array(total);
  let offset = 0;
  chunks.forEach((chunk) => {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  });

  return { bytes, contentType: `multipart/form-data; boundary=${bnd}` };
}

/**
 * 浏览器原生发送器。
 *
 * 【为什么单独抽出来】
 * 这是"默认通道" —— 绝大多数请求都走这里。
 * 抽出来之后，执行器里就只剩一行 `sender.send(payload)`，
 * 两条通道的差异全部被隔离在这里。
 */
export function createFetchSender(options: { fetchImpl?: typeof fetch; now?: () => number } = {}): HttpSender {
  const doFetch = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
  const now = options.now ?? (() => Date.now());

  return {
    async send(payload: SendPayload): Promise<SendResult> {
      const startedAt = now();
      const controller = new AbortController();
      // 超时靠 AbortController：fetch 被 abort 后会抛 AbortError，
      // 执行器靠这个 name 识别超时（而不是笼统的"请求失败"）
      const timer = setTimeout(() => controller.abort(), payload.timeoutMs);

      try {
        const raw = await doFetch(payload.url, {
          method: payload.method,
          headers: payload.headers,
          body: buildFetchBody(payload),
          redirect: payload.followRedirects ? 'follow' : 'manual',
          credentials: payload.sendCookies ? 'include' : 'omit',
          signal: controller.signal,
        });

        const contentType = raw.headers.get('content-type') ?? '';
        const headers: Record<string, string> = {};
        raw.headers.forEach((value, key) => {
          headers[key] = value;
        });

        let body = '';
        let bodyBase64: string | null = null;
        if (isBinaryContentType(contentType)) {
          const buffer = await raw.arrayBuffer();
          bodyBase64 = bytesToBase64(new Uint8Array(buffer));
        } else {
          body = await raw.text();
        }

        return {
          status: raw.status,
          statusText: raw.statusText,
          headers,
          body,
          bodyBase64,
          elapsedMs: Math.max(0, now() - startedAt),
          finalUrl: raw.url || payload.url,
          // 浏览器这条通道**永远**是校验过的，不存在跳过校验的情况
          insecure: false,
        };
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

/**
 * 把 SendPayload 里的 body 字段还原成 fetch 能吃的形态。
 *
 * 【为什么要分三种情况】
 * - bodyBase64：二进制，fetch 接受 Uint8Array（BufferSource）
 * - body：文本，fetch 接受 string
 * - 都没有：GET / HEAD 这类没有请求体的方法，必须传 undefined
 *   （传空字符串会被 Chrome 报 "Request with GET/HEAD method cannot have body"）
 */
function buildFetchBody(payload: SendPayload): BodyInit | undefined {
  if (payload.bodyBase64) {
    return base64ToBytes(payload.bodyBase64) as unknown as BodyInit;
  }
  if (payload.body !== undefined) {
    return payload.body;
  }
  return undefined;
}
