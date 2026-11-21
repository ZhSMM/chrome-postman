/**
 * 发送网关（http-sender）的单元测试。
 *
 * 【测试策略】
 * 这一层是"请求真正发出去"的地方，所以重点测三件事：
 * 1. multipart 序列化 —— 两条通道发出去的字节必须一致；
 * 2. 二进制响应 —— 不能被当成 UTF-8 文本解码损坏；
 * 3. 超时 —— 必须抛 AbortError，执行器靠这个 name 识别超时。
 */
import { describe, expect, it, vi } from 'vitest';
import {
  createFetchSender,
  isBinaryContentType,
  serializeMultipartBody,
  type SendPayload,
} from '../src/core/http-sender';

/** 造一个默认的发送参数 */
function makePayload(overrides: Partial<SendPayload> = {}): SendPayload {
  return {
    method: 'GET',
    url: 'https://api.example.com/users',
    headers: {},
    timeoutMs: 5000,
    followRedirects: true,
    sendCookies: true,
    ssl: { mode: 'strict', allowInsecure: false },
    ...overrides,
  };
}

/** 把字节数组按 latin1 转成字符串（字节 → 字符 1:1，方便断言原始字节） */
function toLatin1(bytes: Uint8Array): string {
  return String.fromCharCode(...bytes);
}

/**
 * 按 UTF-8 解码。
 *
 * 【为什么要两种解码】
 * 文本段（字段值、文件名）是 UTF-8 编码的，用 latin1 看会是一堆乱码；
 * 而二进制文件内容必须用 latin1 看才能一字节一字符地定位。
 */
function toUtf8(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes);
}

describe('isBinaryContentType —— 判断响应是不是二进制', () => {
  it('图片 / 压缩包 / PDF 算二进制', () => {
    expect(isBinaryContentType('image/png')).toBe(true);
    expect(isBinaryContentType('application/zip')).toBe(true);
    expect(isBinaryContentType('application/pdf')).toBe(true);
    expect(isBinaryContentType('application/octet-stream')).toBe(true);
  });

  it('JSON / 文本 / HTML 不算二进制', () => {
    expect(isBinaryContentType('application/json')).toBe(false);
    expect(isBinaryContentType('text/plain')).toBe(false);
    expect(isBinaryContentType('text/html; charset=utf-8')).toBe(false);
  });

  it('空内容类型不算二进制', () => {
    expect(isBinaryContentType('')).toBe(false);
  });
});

describe('serializeMultipartBody —— multipart 序列化', () => {
  it('普通字段与文件字段都会被写进去', () => {
    const { bytes, contentType } = serializeMultipartBody(
      [
        { id: 'p1', key: 'title', value: '周报', isFile: false, enabled: true },
        {
          id: 'p2',
          key: 'file',
          value: '',
          isFile: true,
          fileBase64: btoa('hello'),
          fileName: 'a.txt',
          mimeType: 'text/plain',
          enabled: true,
        },
      ],
      'TESTBOUNDARY',
    );

    const text = toUtf8(bytes);
    expect(text).toContain('--TESTBOUNDARY');
    expect(text).toContain('Content-Disposition: form-data; name="title"');
    expect(text).toContain('周报');
    expect(text).toContain('filename="a.txt"');
    expect(text).toContain('Content-Type: text/plain');
    expect(text).toContain('hello');
    // 结束标记必须是两个短横
    expect(text.endsWith('--TESTBOUNDARY--\r\n')).toBe(true);
    // Content-Type 里要带上 boundary，否则服务端解析不出分段
    expect(contentType).toBe('multipart/form-data; boundary=TESTBOUNDARY');
  });

  it('被禁用的分段不会写进去', () => {
    const { bytes } = serializeMultipartBody(
      [
        { id: 'p1', key: 'shown', value: 'yes', isFile: false, enabled: true },
        { id: 'p2', key: 'hidden', value: 'no', isFile: false, enabled: false },
      ],
      'B',
    );
    const text = toUtf8(bytes);
    expect(text).toContain('shown');
    expect(text).not.toContain('hidden');
  });

  it('文件内容的二进制字节不会被当成 UTF-8 改写', () => {
    // 0x00 0xFF 0x10 是典型的"非 UTF-8 合法序列"字节
    const raw = new Uint8Array([0x00, 0xff, 0x10]);
    const base64 = btoa(String.fromCharCode(...raw));

    const { bytes } = serializeMultipartBody(
      [
        {
          id: 'p1',
          key: 'file',
          value: '',
          isFile: true,
          fileBase64: base64,
          fileName: 'x.bin',
          mimeType: 'application/octet-stream',
          enabled: true,
        },
      ],
      'B',
    );

    // latin1 映射是 1:1 的，所以能原样找到这三个字节
    expect(toLatin1(bytes)).toContain('\x00\xff\x10');
  });

  it('文件名含非 ASCII 时会额外给出 RFC 5987 扩展名', () => {
    const { bytes } = serializeMultipartBody(
      [
        {
          id: 'p1',
          key: 'file',
          value: '',
          isFile: true,
          fileBase64: btoa('x'),
          fileName: '周报.pdf',
          mimeType: 'application/pdf',
          enabled: true,
        },
      ],
      'B',
    );
    const text = toUtf8(bytes);
    expect(text).toContain("filename*=UTF-8''");
    expect(text).toContain('%E5%91%A8%E6%8A%A5');
  });

  it('没给 boundary 时会自动生成一个', () => {
    const { contentType } = serializeMultipartBody([]);
    expect(contentType).toMatch(/^multipart\/form-data; boundary=----ChromePostmanBoundary[0-9a-f]{24}$/);
  });
});

describe('createFetchSender —— 浏览器原生通道', () => {
  it('把 URL、方法、请求头原样交给 fetch', async () => {
    const fetchImpl = vi.fn(async () => new Response('{"ok":true}', { status: 200 }));
    const sender = createFetchSender({ fetchImpl: fetchImpl as any });

    await sender.send(
      makePayload({
        method: 'POST',
        url: 'https://api.example.com/users?a=1',
        headers: { 'X-Token': 'abc' },
        body: '{"id":1}',
      }),
    );

    const [url, init] = fetchImpl.mock.calls[0] as any;
    expect(url).toBe('https://api.example.com/users?a=1');
    expect(init.method).toBe('POST');
    expect(init.headers).toEqual({ 'X-Token': 'abc' });
    expect(init.body).toBe('{"id":1}');
  });

  it('文本响应返回 body，二进制响应返回 bodyBase64', async () => {
    const textSender = createFetchSender({
      fetchImpl: (async () =>
        new Response('{"id":42}', {
          status: 201,
          statusText: 'Created',
          headers: { 'content-type': 'application/json' },
        })) as any,
    });
    const textResult = await textSender.send(makePayload());
    expect(textResult.status).toBe(201);
    expect(textResult.statusText).toBe('Created');
    expect(textResult.body).toBe('{"id":42}');
    expect(textResult.bodyBase64).toBeNull();

    const binSender = createFetchSender({
      fetchImpl: (async () =>
        new Response(new Uint8Array([1, 2, 3]), {
          status: 200,
          headers: { 'content-type': 'image/png' },
        })) as any,
    });
    const binResult = await binSender.send(makePayload());
    expect(binResult.bodyBase64).toBe(btoa('\x01\x02\x03'));
    expect(binResult.body).toBe('');
  });

  it('浏览器通道永远不会标记为"跳过了校验"', async () => {
    const sender = createFetchSender({
      fetchImpl: (async () => new Response('ok', { status: 200 })) as any,
    });
    const result = await sender.send(makePayload({ ssl: { mode: 'strict', allowInsecure: false } }));
    expect(result.insecure).toBe(false);
  });

  it('超时时会抛 AbortError（执行器靠这个 name 识别超时）', async () => {
    const fetchImpl = vi.fn(
      (_url: string, init: any) =>
        new Promise((_resolve, reject) => {
          init.signal.addEventListener('abort', () => {
            const err = new Error('The operation was aborted.');
            err.name = 'AbortError';
            reject(err);
          });
        }),
    );
    const sender = createFetchSender({ fetchImpl: fetchImpl as any });

    await expect(sender.send(makePayload({ timeoutMs: 10 }))).rejects.toMatchObject({
      name: 'AbortError',
    });
  });

  it('followRedirects / sendCookies 会映射到 fetch 的对应选项', async () => {
    const fetchImpl = vi.fn(async () => new Response('ok', { status: 200 }));
    const sender = createFetchSender({ fetchImpl: fetchImpl as any });

    await sender.send(makePayload({ followRedirects: false, sendCookies: false }));
    const [, init] = fetchImpl.mock.calls[0] as any;
    expect(init.redirect).toBe('manual');
    expect(init.credentials).toBe('omit');

    await sender.send(makePayload({ followRedirects: true, sendCookies: true }));
    const [, init2] = fetchImpl.mock.calls[1] as any;
    expect(init2.redirect).toBe('follow');
    expect(init2.credentials).toBe('include');
  });

  it('没有请求体时不传 body（GET 带 body 会被 Chrome 拒绝）', async () => {
    const fetchImpl = vi.fn(async () => new Response('ok', { status: 200 }));
    const sender = createFetchSender({ fetchImpl: fetchImpl as any });
    await sender.send(makePayload({ method: 'GET' }));
    const [, init] = fetchImpl.mock.calls[0] as any;
    expect(init.body).toBeUndefined();
  });
});
