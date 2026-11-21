/**
 * Native 桥接协议层的单元测试。
 *
 * 【测试策略】
 * 这一层是纯逻辑（不碰 chrome.*），所以可以完整地测：
 * 1. 消息怎么组（尤其是 rejectUnauthorized 的翻译）；
 * 2. 响应怎么解析（以及遇到畸形数据时怎么优雅失败）；
 * 3. 错误怎么翻译成人话。
 */
import { describe, expect, it, vi } from 'vitest';
import {
  BRIDGE_HOST_NAME,
  BridgeError,
  buildHttpMessage,
  buildInspectCertMessage,
  buildPingMessage,
  createBridgeSender,
  describeBridgeError,
  parseBridgeResponse,
  probeBridge,
  type BridgeClient,
} from '../src/core/native-bridge';
import type { SendPayload } from '../src/core/http-sender';

function makePayload(overrides: Partial<SendPayload> = {}): SendPayload {
  return {
    method: 'GET',
    url: 'https://api.internal/health',
    headers: { Accept: 'application/json' },
    timeoutMs: 30000,
    followRedirects: true,
    sendCookies: true,
    ssl: { mode: 'native-bridge', allowInsecure: false },
    ...overrides,
  };
}

/** 造一个假的桥接客户端 */
function fakeClient(response: unknown): BridgeClient & { sent: any[] } {
  const sent: any[] = [];
  return {
    sent,
    async send(message: unknown) {
      sent.push(message);
      if (response instanceof Error) throw response;
      return response;
    },
  };
}

describe('协议常量', () => {
  it('伴生程序注册名固定', () => {
    expect(BRIDGE_HOST_NAME).toBe('com.chrome_postman.bridge');
  });
});

describe('buildHttpMessage —— 组装请求消息', () => {
  it('默认（要校验证书）时 rejectUnauthorized 为 true', () => {
    const message = buildHttpMessage(makePayload(), 'r1');
    expect(message.id).toBe('r1');
    expect(message.action).toBe('http');
    expect(message.req.method).toBe('GET');
    expect(message.req.url).toBe('https://api.internal/health');
    expect(message.req.timeoutMs).toBe(30000);
    // 这一行是整个方案的核心：Node 的 https 模块有这个开关，浏览器没有
    expect(message.req.rejectUnauthorized).toBe(true);
  });

  it('allowInsecure 为 true 时 rejectUnauthorized 变成 false', () => {
    const message = buildHttpMessage(
      makePayload({ ssl: { mode: 'native-bridge', allowInsecure: true } }),
      'r1',
    );
    expect(message.req.rejectUnauthorized).toBe(false);
  });

  it('文本请求体原样带上', () => {
    const message = buildHttpMessage(makePayload({ method: 'POST', body: '{"a":1}' }), 'r1');
    expect(message.req.body).toBe('{"a":1}');
    expect(message.req.bodyBase64).toBeUndefined();
  });

  it('二进制请求体走 bodyBase64', () => {
    const message = buildHttpMessage(makePayload({ method: 'POST', bodyBase64: 'AAEC' }), 'r1');
    expect(message.req.bodyBase64).toBe('AAEC');
    expect(message.req.body).toBeUndefined();
  });
});

describe('buildPingMessage / buildInspectCertMessage', () => {
  it('ping 消息不带 req', () => {
    const message = buildPingMessage('p1');
    expect(message).toEqual({ id: 'p1', action: 'ping' });
  });

  it('inspect-cert 消息带上地址和超时', () => {
    const message = buildInspectCertMessage('https://api.internal', 8000, 'c1');
    expect(message.id).toBe('c1');
    expect(message.action).toBe('inspect-cert');
    expect(message.req.url).toBe('https://api.internal');
    expect(message.req.timeoutMs).toBe(8000);
  });
});

describe('parseBridgeResponse —— 解析伴生程序的回复', () => {
  it('ok=true 时能取到响应体', () => {
    const parsed = parseBridgeResponse({
      id: 'r1',
      ok: true,
      res: { status: 200, statusText: 'OK', headers: {}, body: 'hi', bodyBase64: null, elapsedMs: 5 },
    });
    expect(parsed.ok).toBe(true);
    expect(parsed.res?.status).toBe(200);
  });

  it('ok=false 时抛出 BridgeError，并带上错误码', () => {
    expect(() =>
      parseBridgeResponse({ id: 'r1', ok: false, error: { code: 'CERT_HAS_EXPIRED', message: 'expired' } }),
    ).toThrow(BridgeError);

    try {
      parseBridgeResponse({ id: 'r1', ok: false, error: { code: 'CERT_HAS_EXPIRED', message: 'expired' } });
    } catch (err) {
      expect((err as BridgeError).code).toBe('CERT_HAS_EXPIRED');
      expect((err as BridgeError).message).toBe('expired');
    }
  });

  it('返回的不是对象时报一个能看懂的错', () => {
    expect(() => parseBridgeResponse(null)).toThrow(/无法识别的数据/);
    expect(() => parseBridgeResponse('boom')).toThrow(/无法识别的数据/);
  });
});

describe('createBridgeSender —— 走 native 通道发请求', () => {
  it('把伴生程序的响应转成 SendResult', async () => {
    const client = fakeClient({
      id: 'r1',
      ok: true,
      res: {
        status: 201,
        statusText: 'Created',
        headers: { 'content-type': 'application/json' },
        body: '{"ok":true}',
        bodyBase64: null,
        elapsedMs: 42,
        finalUrl: 'https://api.internal/health',
      },
    });
    const sender = createBridgeSender(client);
    const result = await sender.send(makePayload());

    expect(result.status).toBe(201);
    expect(result.statusText).toBe('Created');
    expect(result.body).toBe('{"ok":true}');
    expect(result.bodyBase64).toBeNull();
    expect(result.elapsedMs).toBe(42);
    expect(result.finalUrl).toBe('https://api.internal/health');
  });

  it('跳过校验时把 insecure 标记如实传上去', async () => {
    const client = fakeClient({
      id: 'r1',
      ok: true,
      res: { status: 200, statusText: 'OK', headers: {}, body: 'ok', bodyBase64: null, elapsedMs: 1 },
    });
    const sender = createBridgeSender(client);

    const strict = await sender.send(makePayload({ ssl: { mode: 'native-bridge', allowInsecure: false } }));
    expect(strict.insecure).toBe(false);

    const loose = await sender.send(makePayload({ ssl: { mode: 'native-bridge', allowInsecure: true } }));
    expect(loose.insecure).toBe(true);
  });

  it('伴生程序报 ok=true 但没给响应体时抛错', async () => {
    const client = fakeClient({ id: 'r1', ok: true });
    const sender = createBridgeSender(client);
    await expect(sender.send(makePayload())).rejects.toThrow(/没有返回响应内容/);
  });

  it('伴生程序报错时原样抛出 BridgeError', async () => {
    const client = fakeClient({
      id: 'r1',
      ok: false,
      error: { code: 'CERT_NOT_TRUSTED', message: 'self signed certificate' },
    });
    const sender = createBridgeSender(client);
    await expect(sender.send(makePayload())).rejects.toMatchObject({ code: 'CERT_NOT_TRUSTED' });
  });

  it('二进制响应走 bodyBase64', async () => {
    const client = fakeClient({
      id: 'r1',
      ok: true,
      res: {
        status: 200,
        statusText: 'OK',
        headers: { 'content-type': 'image/png' },
        body: '',
        bodyBase64: 'AQID',
        elapsedMs: 3,
      },
    });
    const sender = createBridgeSender(client);
    const result = await sender.send(makePayload());
    expect(result.bodyBase64).toBe('AQID');
  });
});

describe('probeBridge —— 探测伴生程序', () => {
  it('ping 成功时返回可用和版本号', async () => {
    const client = fakeClient({ id: 'p1', ok: true, version: '1.0.0' });
    const result = await probeBridge(client);
    expect(result.available).toBe(true);
    expect(result.version).toBe('1.0.0');
  });

  it('ping 失败时返回不可用和错误原因', async () => {
    const client = fakeClient(
      new BridgeError({ code: 'BRIDGE_NOT_INSTALLED', message: '未检测到本地桥接程序' }),
    );
    const result = await probeBridge(client);
    expect(result.available).toBe(false);
    expect(result.error).toContain('未检测到本地桥接程序');
  });
});

describe('describeBridgeError —— 错误翻译', () => {
  it('证书过期会给出可执行的下一步', () => {
    const msg = describeBridgeError(
      new BridgeError({ code: 'CERT_HAS_EXPIRED', message: 'certificate has expired' }),
    );
    expect(msg).toContain('证书已过期');
    expect(msg).toContain('信任库');
  });

  it('自签名证书会提示装 CA 或用桥接', () => {
    const msg = describeBridgeError(
      new BridgeError({ code: 'SELF_SIGNED_CERT_IN_CHAIN', message: 'self signed' }),
    );
    expect(msg).toContain('不受信任');
    expect(msg).toContain('系统信任库');
  });

  it('域名不匹配会提示检查 URL', () => {
    const msg = describeBridgeError(
      new BridgeError({ code: 'CERT_HOSTNAME_MISMATCH', message: 'mismatch' }),
    );
    expect(msg).toContain('域名');
    expect(msg).toContain('URL');
  });

  it('没装桥接程序会明确说出来', () => {
    const msg = describeBridgeError(
      new BridgeError({ code: 'BRIDGE_NOT_INSTALLED', message: 'not found' }),
    );
    expect(msg).toContain('未检测到本地桥接程序');
  });

  it('未知错误码也会带上错误码本身', () => {
    const msg = describeBridgeError(new BridgeError({ code: 'WEIRD', message: 'boom' }));
    expect(msg).toContain('WEIRD');
    expect(msg).toContain('boom');
  });
});
