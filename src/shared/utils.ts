/**
 * URL / Body 序列化相关的纯函数工具集。
 * 这些函数不依赖 chrome.* API，因此可以在单元测试里直接验证。
 */

/** 判断字符串是否为绝对 URL（带协议） */
export function isAbsoluteUrl(url: string): boolean {
  return /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(url.trim());
}

/**
 * 把裸域名补全成 http://。
 * 用户的输入习惯是 "example.com/api"，但 fetch 必须有协议。
 * 注意：https 优先，失败由调用方决定是否回落。
 */
export function normalizeUrl(rawUrl: string): string {
  const trimmed = (rawUrl ?? '').trim();
  if (!trimmed) return trimmed;
  if (isAbsoluteUrl(trimmed)) return trimmed;
  return `https://${trimmed.replace(/^\/+/, '')}`;
}

/**
 * 拆分 URL 与内联 query 参数。
 * 返回 { base, params }，params 是 URLSearchParams 的字符串数组对。
 */
export function splitUrlAndQuery(url: string): { base: string; params: [string, string][] } {
  const qIndex = url.indexOf('?');
  if (qIndex === -1) return { base: url, params: [] };
  const base = url.slice(0, qIndex);
  const query = url.slice(qIndex + 1);
  const params: [string, string][] = [];
  query.split('&').forEach((pair) => {
    if (!pair) return;
    const eq = pair.indexOf('=');
    if (eq === -1) params.push([decodeURIComponent(pair), '']);
    else params.push([decodeURIComponent(pair.slice(0, eq)), decodeURIComponent(pair.slice(eq + 1))]);
  });
  return { base, params };
}

/** 把参数对数组拼回 query string */
export function buildQueryString(params: [string, string][]): string {
  if (!params.length) return '';
  return params
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join('&');
}

/** 生成一个短 id（不依赖 crypto.randomUUID 的极端兼容场景） */
export function uid(prefix = 'id'): string {
  const rand = Math.random().toString(36).slice(2, 10);
  return `${prefix}_${Date.now().toString(36)}_${rand}`;
}

/** 把 bytes 数组转成 Base64（用于 binary body 存储） */
export function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

/** Base64 解回 bytes */
export function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/**
 * 把 Uint8Array 转成可以安全塞进 Blob 的 ArrayBuffer。
 *
 * 【为什么需要这个】
 * TS 5.7 之后 TypedArray 变成泛型了（Uint8Array<ArrayBufferLike>），
 * 而 Blob 只接受 ArrayBufferView<ArrayBuffer>，
 * 直接 new Blob([bytes]) 会被类型系统拦下。
 * 这里复制一份数据，保证 buffer 长度与视图完全一致。
 */
export function toBlobBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer as ArrayBuffer;
}

/** 人类可读的字节数 */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  let value = bytes;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  return `${value >= 10 || unitIndex === 0 ? Math.round(value) : value.toFixed(1)} ${units[unitIndex]}`;
}

/** 格式化耗时 */
export function formatMs(ms: number): string {
  if (!Number.isFinite(ms)) return '-';
  if (ms < 1000) return `${Math.round(ms)} ms`;
  return `${(ms / 1000).toFixed(2)} s`;
}
