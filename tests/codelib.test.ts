import { describe, expect, it } from 'vitest';
import { fromHar, toCurl, toHar } from '../src/core/codelib';
import { emptyAuth, emptyBody, type HttpRequest } from '../src/shared/types';

function makeRequest(overrides: Partial<HttpRequest> = {}): HttpRequest {
  const now = Date.now();
  return {
    id: 'req_1',
    name: '测试',
    method: 'GET',
    url: 'https://api.example.com/users',
    params: [],
    headers: [],
    body: emptyBody(),
    auth: emptyAuth(),
    preScript: '',
    postScript: '',
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

const scope = {
  environment: { host: 'api.example.com', token: 'secret' },
  collection: {},
  globals: {},
  session: {},
};

describe('cURL 生成', () => {
  it('生成基本命令', () => {
    const curl = toCurl(makeRequest(), scope);
    expect(curl).toContain("curl -X GET");
    expect(curl).toContain("'https://api.example.com/users'");
  });

  it('把变量替换成真实值', () => {
    const curl = toCurl(makeRequest({ url: 'https://{{host}}/users' }), scope);
    expect(curl).toContain('https://api.example.com/users');
    expect(curl).not.toContain('{{host}}');
  });

  it('带上了请求头', () => {
    const curl = toCurl(
      makeRequest({
        headers: [{ id: 'h1', key: 'Content-Type', value: 'application/json', enabled: true }],
      }),
      scope,
    );
    expect(curl).toContain("-H 'Content-Type: application/json'");
  });

  it('Bearer 鉴权生成 Authorization 头', () => {
    const curl = toCurl(makeRequest({ auth: { type: 'bearer', token: 'abc' } }), scope);
    expect(curl).toContain("-H 'Authorization: Bearer abc'");
  });

  it('JSON 请求体用 -d', () => {
    const curl = toCurl(
      makeRequest({
        method: 'POST',
        body: { mode: 'json', raw: '{"a":1}', form: [], formData: [] },
      }),
      scope,
    );
    expect(curl).toContain(`-d '{"a":1}'`);
  });

  it('单引号会被正确转义', () => {
    const curl = toCurl(
      makeRequest({ headers: [{ id: 'h1', key: 'X-A', value: "it's", enabled: true }] }),
      scope,
    );
    expect(curl).toContain(`'X-A: it'\\''s'`);
  });
});

describe('HAR 生成与解析', () => {
  it('生成合法的 HAR 结构', () => {
    const har = toHar(
      [
        {
          request: makeRequest({ headers: [{ id: 'h1', key: 'Accept', value: 'application/json', enabled: true }] }),
          response: {
            status: 200,
            statusText: 'OK',
            headers: { 'content-type': 'application/json' },
            body: '{"ok":true}',
            size: 11,
            responseTime: 25,
          },
        },
      ],
      scope,
    );

    expect(har.log.version).toBe('1.2');
    expect(har.log.entries).toHaveLength(1);
    expect(har.log.entries[0].request.method).toBe('GET');
    expect(har.log.entries[0].response.status).toBe(200);
    expect((har.log.entries[0].response.content as any).text).toBe('{"ok":true}');
  });

  it('能把 HAR 还原成请求列表', () => {
    const har = toHar([{ request: makeRequest(), response: null }], scope);
    const restored = fromHar(har);
    expect(restored).toHaveLength(1);
    expect(restored[0].method).toBe('GET');
    expect(restored[0].url).toBe('https://api.example.com/users');
  });
});
