/**
 * 请求执行管线的单元测试。
 *
 * 【测试策略】
 * 不真的联网，而是注入一个假的 fetch（deps.fetchImpl），
 * 这样可以确定性地验证：变量插值 → 鉴权 → 前置脚本 → 请求 → 后置脚本 → 结果。
 */
import { describe, expect, it, vi } from 'vitest';
import { composeRequest, executeRequest, resolveRequest } from '../src/core/request-executor';
import { emptyAuth, emptyBody, type HttpRequest, type VariableScope } from '../src/shared/types';

/** 造一个请求草稿 */
function makeRequest(overrides: Partial<HttpRequest> = {}): HttpRequest {
  const now = Date.now();
  return {
    id: 'req_1',
    name: '测试请求',
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

const scope: VariableScope = {
  environment: { host: 'api.example.com', token: 'secret' },
  collection: {},
  globals: {},
  session: {},
};

/** 造一个假 fetch */
function fakeFetch(body = '{"ok":true}', init: { status?: number; headers?: Record<string, string> } = {}) {
  return vi.fn(async () =>
    new Response(body, {
      status: init.status ?? 200,
      statusText: 'OK',
      headers: { 'content-type': 'application/json', ...(init.headers ?? {}) },
    }),
  );
}

describe('resolveRequest —— 变量插值', () => {
  it('替换 URL 与请求头里的变量', () => {
    const resolved = resolveRequest(
      makeRequest({
        url: 'https://{{host}}/users',
        headers: [{ id: 'h1', key: 'Authorization', value: 'Bearer {{token}}', enabled: true }],
      }),
      scope,
    );

    expect(resolved.url).toBe('https://api.example.com/users');
    expect(resolved.headers.Authorization).toBe('Bearer secret');
  });

  it('记录未解析的变量', () => {
    const resolved = resolveRequest(makeRequest({ url: 'https://{{host}}/{{missing}}' }), scope);
    expect(resolved.missing).toEqual(['missing']);
  });

  it('禁用（enabled=false）的请求头不参与插值', () => {
    const resolved = resolveRequest(
      makeRequest({
        headers: [{ id: 'h1', key: 'X-Off', value: '{{token}}', enabled: false }],
      }),
      scope,
    );
    expect(resolved.headers).toEqual({});
  });
});

describe('composeRequest —— 合成最终请求', () => {
  it('拼接内联 query 与参数表', () => {
    const resolved = resolveRequest(
      makeRequest({
        url: 'https://api.example.com/users?a=1',
        params: [{ id: 'p1', key: 'b', value: '2', enabled: true }],
      }),
      scope,
    );
    const composed = composeRequest(resolved);
    expect(composed.url).toBe('https://api.example.com/users?a=1&b=2');
  });

  it('Bearer 鉴权会生成 Authorization 头', () => {
    const resolved = resolveRequest(
      makeRequest({ auth: { type: 'bearer', token: 'abc' } }),
      scope,
    );
    expect(composeRequest(resolved).headers.Authorization).toBe('Bearer abc');
  });

  it('Basic 鉴权会做 Base64 编码', () => {
    const resolved = resolveRequest(
      makeRequest({ auth: { type: 'basic', username: 'u', password: 'p' } }),
      scope,
    );
    const auth = composeRequest(resolved).headers.Authorization;
    expect(auth.startsWith('Basic ')).toBe(true);
    expect(atob(auth.slice(6))).toBe('u:p');
  });

  it('API Key 放在 query 时会追加到 URL', () => {
    const resolved = resolveRequest(
      makeRequest({ auth: { type: 'apikey', apiKey: 'k', apiValue: 'v', apiKeyIn: 'query' } }),
      scope,
    );
    expect(composeRequest(resolved).url).toContain('k=v');
  });

  it('JSON 请求体会校验合法性并补上 Content-Type', () => {
    const resolved = resolveRequest(
      makeRequest({ method: 'POST', body: { mode: 'json', raw: '{"a":1}', form: [], formData: [] } }),
      scope,
    );
    const composed = composeRequest(resolved);
    expect(composed.body).toBe('{"a":1}');
    expect(composed.headers['Content-Type']).toBe('application/json');
  });

  it('JSON 语法错误时抛出可读异常', () => {
    const resolved = resolveRequest(
      makeRequest({ method: 'POST', body: { mode: 'json', raw: '{bad}', form: [], formData: [] } }),
      scope,
    );
    expect(() => composeRequest(resolved)).toThrow(/不是合法 JSON/);
  });

  it('form-urlencoded 会序列化成 urlencoded 字符串', () => {
    const resolved = resolveRequest(
      makeRequest({
        method: 'POST',
        body: {
          mode: 'form-urlencoded',
          raw: '',
          form: [{ id: 'f1', key: 'a', value: '1', enabled: true }],
          formData: [],
        },
      }),
      scope,
    );
    expect(composeRequest(resolved).body).toBe('a=1');
  });
});

describe('executeRequest —— 完整管线', () => {
  it('能发出请求并返回响应', async () => {
    const fetchImpl = fakeFetch('{"id":42}');
    const result = await executeRequest(makeRequest(), scope, { fetchImpl: fetchImpl as any });

    expect(result.error).toBeUndefined();
    expect(result.response?.status).toBe(200);
    expect(result.response?.body).toBe('{"id":42}');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('前置脚本能改写请求头，改动会真正发出去', async () => {
    const fetchImpl = fakeFetch();
    await executeRequest(
      makeRequest({
        preScript: `pm.request.headers.upsert({ name: 'X-Token', value: pm.environment.get('token') });`,
      }),
      scope,
      { fetchImpl: fetchImpl as any },
    );

    const [, init] = fetchImpl.mock.calls[0] as any;
    expect(init.headers['X-Token']).toBe('secret');
  });

  it('前置脚本写入的变量会影响二次插值', async () => {
    const fetchImpl = fakeFetch();
    await executeRequest(
      makeRequest({
        url: 'https://api.example.com/users?token={{newToken}}',
        preScript: `pm.environment.set('newToken', 'from-script');`,
      }),
      scope,
      { fetchImpl: fetchImpl as any },
    );

    const [url] = fetchImpl.mock.calls[0] as any;
    expect(url).toBe('https://api.example.com/users?token=from-script');
  });

  it('后置脚本能读响应并写出断言', async () => {
    const result = await executeRequest(
      makeRequest({
        postScript: `
          pm.test('状态码 200', function () { pm.response.to.have.status(200); });
          pm.test('取 id', function () { pm.expect(pm.response.json().id).to.equal(42); });
        `,
      }),
      scope,
      { fetchImpl: fakeFetch('{"id":42}') as any },
    );

    expect(result.outcome.tests).toHaveLength(2);
    expect(result.outcome.tests.every((t) => t.passed)).toBe(true);
  });

  it('后置脚本能提取变量到环境', async () => {
    const result = await executeRequest(
      makeRequest({
        postScript: `pm.environment.set('userId', String(pm.response.json().id));`,
      }),
      scope,
      { fetchImpl: fakeFetch('{"id":42}') as any },
    );

    expect(result.outcome.variables.environment.userId).toBe('42');
  });

  it('脚本抛错不会中断整个请求', async () => {
    const result = await executeRequest(
      makeRequest({ preScript: `throw new Error('脚本炸了');` }),
      scope,
      { fetchImpl: fakeFetch() as any },
    );

    expect(result.outcome.error).toContain('脚本炸了');
    expect(result.response?.status).toBe(200);
  });

  it('网络失败时给出可读的错误提示', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new TypeError('Failed to fetch');
    });
    const result = await executeRequest(makeRequest(), scope, { fetchImpl: fetchImpl as any });

    expect(result.error).toContain('无法连接');
    expect(result.response).toBeNull();
  });

  it('超时会被 AbortController 中断', async () => {
    const fetchImpl = vi.fn(
      (_url: string, init: RequestInit) =>
        new Promise((_resolve, reject) => {
          init.signal?.addEventListener('abort', () => {
            const err = new Error('aborted');
            err.name = 'AbortError';
            reject(err);
          });
        }),
    );
    const result = await executeRequest(makeRequest(), scope, {
      fetchImpl: fetchImpl as any,
      timeout: 50,
    });

    expect(result.error).toContain('超时');
  });

  it('console.log 会进入日志列表', async () => {
    const result = await executeRequest(
      makeRequest({ preScript: `console.log('hello');` }),
      scope,
      { fetchImpl: fakeFetch() as any },
    );
    expect(result.outcome.logs[0].message).toContain('hello');
  });
});
