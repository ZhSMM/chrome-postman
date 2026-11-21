import { describe, expect, it } from 'vitest';
import { runSandbox, type SandboxRequestState, type SandboxScope } from '../src/core/sandbox';

/** 构造一个基础请求状态 */
function makeRequest(overrides: Partial<SandboxRequestState> = {}): SandboxRequestState {
  return {
    method: 'GET',
    url: 'https://api.example.com/users',
    headers: [{ key: 'Accept', value: 'application/json', enabled: true }],
    body: { mode: 'none', raw: '' },
    auth: { type: 'none' },
    ...overrides,
  };
}

function makeScope(overrides: Partial<SandboxScope> = {}): SandboxScope {
  return {
    environment: { host: 'api.example.com', token: 'abc' },
    collection: {},
    globals: {},
    session: {},
    ...overrides,
  };
}

describe('sandbox / pm SDK', () => {
  it('能读取环境变量并写回新变量', async () => {
    const out = await runSandbox({
      script: `
        const t = pm.environment.get('token');
        pm.environment.set('seen', t + '-1');
      `,
      phase: 'pre',
      request: makeRequest(),
      scope: makeScope(),
    });

    expect(out.error).toBeUndefined();
    expect(out.variables.environment.seen).toBe('abc-1');
  });

  it('能通过 pm.request.headers.upsert 改写请求头', async () => {
    const out = await runSandbox({
      script: `pm.request.headers.upsert({ name: 'Authorization', value: 'Bearer ' + pm.environment.get('token') });`,
      phase: 'pre',
      request: makeRequest(),
      scope: makeScope(),
    });

    expect(out.error).toBeUndefined();
    expect(out.request?.headers).toEqual(
      expect.arrayContaining([{ key: 'Authorization', value: 'Bearer abc', enabled: true }]),
    );
  });

  it('能改写请求 URL 与方法', async () => {
    const out = await runSandbox({
      script: `
        pm.request.url.raw = pm.request.url.toString() + '/1';
        pm.request.method = 'POST';
      `,
      phase: 'pre',
      request: makeRequest(),
      scope: makeScope(),
    });

    expect(out.request?.url).toBe('https://api.example.com/users/1');
    expect(out.request?.method).toBe('POST');
  });

  it('pm.test 能正确记录通过与失败', async () => {
    const out = await runSandbox({
      script: `
        pm.test('状态码为 200', function () {
          pm.response.to.have.status(200);
        });
        pm.test('状态码为 404（故意失败）', function () {
          pm.response.to.have.status(404);
        });
      `,
      phase: 'post',
      request: makeRequest(),
      response: {
        code: 200,
        status: 'OK',
        headers: [{ key: 'Content-Type', value: 'application/json' }],
        body: '{"ok":true}',
        responseTime: 12,
        size: 11,
      },
      scope: makeScope(),
    });

    expect(out.tests).toHaveLength(2);
    expect(out.tests[0].passed).toBe(true);
    expect(out.tests[1].passed).toBe(false);
    expect(out.tests[1].error).toContain('404');
  });

  it('pm.response.json() 能解析响应体', async () => {
    const out = await runSandbox({
      script: `
        const data = pm.response.json();
        pm.environment.set('userId', data.data.id);
      `,
      phase: 'post',
      request: makeRequest(),
      response: {
        code: 200,
        status: 'OK',
        headers: [],
        body: '{"data":{"id":42}}',
        responseTime: 5,
        size: 16,
      },
      scope: makeScope(),
    });

    expect(out.error).toBeUndefined();
    expect(out.variables.environment.userId).toBe('42');
  });

  it('console.log 会被收集为日志', async () => {
    const out = await runSandbox({
      script: `console.log('hello', 123); console.warn('careful');`,
      phase: 'pre',
      request: makeRequest(),
      scope: makeScope(),
    });

    expect(out.logs.length).toBeGreaterThanOrEqual(2);
    expect(out.logs[0].message).toContain('hello');
    expect(out.logs[0].message).toContain('123');
  });

  it('脚本抛错时返回结构化错误信息而不是抛出异常', async () => {
    const out = await runSandbox({
      script: `throw new Error('boom');`,
      phase: 'pre',
      request: makeRequest(),
      scope: makeScope(),
    });

    // v1.2 起 error 从字符串升级为结构化对象（为了标红出错行）
    expect(out.error?.message).toContain('boom');
    expect(out.error?.name).toBe('Error');
    // 行列号来自 QuickJS 的堆栈，基准与编辑器里的行号一致
    expect(out.error?.location?.line).toBe(1);
    expect(out.error?.location?.phase).toBe('pre');
  });

  it('死循环会被超时中断', async () => {
    const out = await runSandbox({
      script: `while (true) {}`,
      phase: 'pre',
      request: makeRequest(),
      scope: makeScope(),
      timeoutMs: 300,
    });

    expect(out.error).toBeTruthy();
  });

  it('沙箱内拿不到 chrome API 与 DOM', async () => {
    const out = await runSandbox({
      script: `
        pm.environment.set('hasChrome', String(typeof chrome));
        pm.environment.set('hasDocument', String(typeof document));
      `,
      phase: 'pre',
      request: makeRequest(),
      scope: makeScope(),
    });

    expect(out.variables.environment.hasChrome).toBe('undefined');
    expect(out.variables.environment.hasDocument).toBe('undefined');
  });
});
