/**
 * ============================================================
 * 代码生成器（Code Library）—— cURL 命令 / HAR 归档
 * ============================================================
 *
 * 【在架构中的位置】
 * 属于"输出侧"能力：把界面上的请求导出成别的工具能吃的格式。
 *
 *   - toCurl：生成一条可以直接粘贴到终端跑的 curl 命令
 *   - toHar ：生成 HAR 1.2 归档，能导入 Chrome DevTools / Charles / 抓包工具
 *
 * 【为什么这两个格式重要】
 *   - cURL：贴给同事、贴到终端、CI 里跑
 *   - HAR：交给抓包工具做对比分析，是前后端联调最常见的交换格式
 */

import type { HttpRequest, HttpResponseData, ResolvedRequest } from '../shared/types';
import { interpolateText } from './variables';
import type { VariableScope } from '../shared/types';

/** 把值用单引号包起来（shell 安全） */
function shellQuote(value: string): string {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

/** 根据请求体模式推导 Content-Type */
function contentTypeOf(request: HttpRequest): string | undefined {
  switch (request.body.mode) {
    case 'json':
      return 'application/json';
    case 'text':
      return 'text/plain';
    case 'xml':
      return 'application/xml';
    case 'html':
      return 'text/html';
    case 'form-urlencoded':
      return 'application/x-www-form-urlencoded';
    case 'form-data':
      return 'multipart/form-data';
    default:
      return undefined;
  }
}

/** 把请求体模式转成可发送的字符串 */
function bodyTextOf(request: HttpRequest): string | undefined {
  switch (request.body.mode) {
    case 'json':
    case 'text':
    case 'xml':
    case 'html':
      return request.body.raw || undefined;
    case 'form-urlencoded':
      return request.body.form
        .filter((item) => item.enabled && item.key)
        .map((item) => `${encodeURIComponent(item.key)}=${encodeURIComponent(item.value)}`)
        .join('&');
    case 'form-data':
      return undefined; // multipart 结构复杂，cURL 里用 -F 表达
    default:
      return undefined;
  }
}

/**
 * 生成 cURL 命令。
 *
 * @param request 原始请求草稿
 * @param scope   变量作用域（用于把 {{var}} 替换成真实值）
 */
export function toCurl(request: HttpRequest, scope?: VariableScope): string {
  const interpolate = (value: string): string => (scope ? interpolateText(value, scope) : value);

  const url = interpolate(request.url);
  const parts: string[] = ['curl'];

  parts.push('-X', request.method);

  // 请求头
  request.headers
    .filter((item) => item.enabled && item.key)
    .forEach((item) => {
      parts.push('-H', shellQuote(`${item.key}: ${interpolate(item.value)}`));
    });

  // 鉴权
  const auth = request.auth;
  if (auth.type === 'basic' && auth.username) {
    parts.push('-u', shellQuote(`${interpolate(auth.username)}:${interpolate(auth.password ?? '')}`));
  } else if (auth.type === 'bearer' && auth.token) {
    parts.push('-H', shellQuote(`Authorization: Bearer ${interpolate(auth.token)}`));
  } else if (auth.type === 'apikey' && auth.apiKey) {
    if (auth.apiKeyIn === 'query') {
      parts.push('-G', '--data-urlencode', shellQuote(`${auth.apiKey}=${interpolate(auth.apiValue ?? '')}`));
    } else {
      parts.push('-H', shellQuote(`${auth.apiKey}: ${interpolate(auth.apiValue ?? '')}`));
    }
  }

  // 请求体
  if (request.body.mode === 'form-data') {
    request.body.formData
      .filter((item) => item.enabled)
      .forEach((item) => {
        if (item.isFile) {
          parts.push('-F', shellQuote(`${item.key}=@${item.fileName ?? 'file'}`));
        } else {
          parts.push('-F', shellQuote(`${item.key}=${interpolate(item.value)}`));
        }
      });
  } else {
    const text = bodyTextOf(request);
    if (text !== undefined) {
      parts.push('-d', shellQuote(interpolate(text)));
    }
  }

  parts.push(shellQuote(url));
  return parts.join(' ');
}

/* ------------------------------------------------------------------
 * HAR 1.2
 * ---------------------------------------------------------------- */

export interface HarEntry {
  startedDateTime: string;
  time: number;
  request: Record<string, unknown>;
  response: Record<string, unknown>;
  cache: Record<string, unknown>;
  timings: Record<string, number>;
}

export interface HarLog {
  version: string;
  creator: { name: string; version: string };
  entries: HarEntry[];
}

/** HAR 里用的 header 结构 */
function harHeaders(record: Record<string, string>): { name: string; value: string }[] {
  return Object.entries(record).map(([name, value]) => ({ name, value }));
}

/**
 * 生成 HAR 归档。
 *
 * @param items 请求与响应的配对列表
 * @param scope 变量作用域
 */
export function toHar(
  items: Array<{ request: HttpRequest; response: HttpResponseData | null }>,
  scope?: VariableScope,
): { log: HarLog } {
  const interpolate = (value: string): string => (scope ? interpolateText(value, scope) : value);

  const entries: HarEntry[] = items.map(({ request, response }) => {
    const headers: Record<string, string> = {};
    request.headers
      .filter((item) => item.enabled && item.key)
      .forEach((item) => {
        headers[item.key] = interpolate(item.value);
      });

    const contentType = contentTypeOf(request);
    if (contentType && !Object.keys(headers).some((k) => k.toLowerCase() === 'content-type')) {
      headers['Content-Type'] = contentType;
    }

    const bodyText = bodyTextOf(request);
    const duration = response?.responseTime ?? 0;

    return {
      startedDateTime: new Date().toISOString(),
      time: duration,
      request: {
        method: request.method,
        url: interpolate(request.url),
        httpVersion: 'HTTP/1.1',
        cookies: [],
        headers: harHeaders(headers),
        queryString: request.params
          .filter((item) => item.enabled && item.key)
          .map((item) => ({ name: item.key, value: interpolate(item.value) })),
        postData: bodyText
          ? { mimeType: contentType ?? 'application/octet-stream', text: interpolate(bodyText) }
          : undefined,
        headersSize: -1,
        bodySize: bodyText ? bodyText.length : 0,
      },
      response: response
        ? {
            status: response.status,
            statusText: response.statusText,
            httpVersion: 'HTTP/1.1',
            cookies: [],
            headers: harHeaders(response.headers),
            content: {
              size: response.size,
              mimeType: response.headers['Content-Type'] ?? response.headers['content-type'] ?? 'application/octet-stream',
              text: response.isBase64 ? '' : response.body,
              encoding: response.isBase64 ? 'base64' : undefined,
            },
            redirectURL: response.headers.Location ?? response.headers.location ?? '',
            headersSize: -1,
            bodySize: response.size,
          }
        : {
            status: 0,
            statusText: '请求失败',
            httpVersion: 'HTTP/1.1',
            cookies: [],
            headers: [],
            content: { size: 0, mimeType: 'text/plain', text: '' },
            redirectURL: '',
            headersSize: -1,
            bodySize: 0,
          },
      cache: {},
      timings: { blocked: 0, dns: 0, connect: 0, send: 0, wait: duration, receive: 0, ssl: 0 },
    };
  });

  return {
    log: {
      version: '1.2',
      creator: { name: 'Chrome Postman', version: '1.0.0' },
      entries,
    },
  };
}

/**
 * 把 HAR 里的第一个请求还原成 HttpRequest（用于导入 HAR）。
 * 这是"反向"操作，让用户可以把抓包工具里的请求导入进来继续调试。
 */
export function fromHar(har: { log?: { entries?: HarEntry[] } }): HttpRequest[] {
  const entries = har.log?.entries ?? [];
  return entries.map((entry) => {
    const req = entry.request as any;
    const headers = (req.headers ?? []).map((h: any, index: number) => ({
      id: `h_${index}`,
      key: h.name ?? '',
      value: h.value ?? '',
      enabled: true,
    }));
    const params = (req.queryString ?? []).map((q: any, index: number) => ({
      id: `q_${index}`,
      key: q.name ?? '',
      value: q.value ?? '',
      enabled: true,
    }));
    const postData = req.postData;
    return {
      id: `req_${Math.random().toString(36).slice(2, 10)}`,
      name: `${req.method} ${req.url}`,
      method: (req.method ?? 'GET') as HttpRequest['method'],
      url: req.url ?? '',
      params,
      headers,
      body: {
        mode: postData?.text ? 'json' : 'none',
        raw: postData?.text ?? '',
        form: [],
        formData: [],
      },
      auth: { type: 'none' },
      preScript: '',
      postScript: '',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    } satisfies HttpRequest;
  });
}
