/**
 * pm API 清单与 SDK 实现的一致性测试。
 *
 * 【为什么必须有这个测试】
 * PM_API_CATALOG 是手工维护的清单，而 pm-sdk.raw.js 是真实实现。
 * 两边很容易走散：改了 SDK 忘了改清单，补全就会给出不存在的 API
 * （用户一选就报错），或者 SDK 加了新方法但清单里没有（用户看不到）。
 *
 * 这个测试把清单里的每条路径都拿到沙箱里真跑一遍，
 * 保证"补全里有的，SDK 里一定也有"。
 */
import { describe, expect, it } from 'vitest';
import { runSandbox } from '../src/core/sandbox';
import { PM_API_CATALOG } from '../src/core/pm-api-catalog';

/** 造一个最小的沙箱输入 */
function makeInput(script: string) {
  return {
    script,
    phase: 'post' as const,
    request: {
      method: 'GET',
      url: 'https://api.example.com/users',
      headers: [],
      body: { mode: 'none', raw: '', form: [], formData: [] },
      auth: { type: 'none' },
    },
    scope: { environment: {}, collection: {}, globals: {}, session: {} },
  };
}

/**
 * 在沙箱里检查所有路径是否存在，把缺失的清单打到日志里。
 *
 * 【为什么用 console.log 而不是直接返回】
 * runSandbox 的输出只有 tests / logs / variables / error 四个字段，
 * 没有任意返回值通道。日志是最直接的"往宿主带数据"的方式。
 */
const PROBE_SCRIPT = `
  const paths = ${JSON.stringify(PM_API_CATALOG.map((item) => item.path))};
  const missing = [];
  const found = [];

  // 【关键】路径的第一段永远是 'pm'，而 pm 对象本身不需要再查属性，
  // 所以属性检查要从第 1 段（下标 1）开始。
  function resolve(path) {
    const parts = path.split('.');
    let cur = pm;
    for (let i = 1; i < parts.length; i += 1) {
      const part = parts[i];
      if (cur === null || cur === undefined) return null;
      if (typeof cur !== 'object' && typeof cur !== 'function') return null;
      if (!(part in cur)) return null;
      cur = cur[part];
    }
    return cur;
  }

  for (const p of ['pm', 'pm.test', 'pm.response.json']) {
    if (resolve(p) !== null && resolve(p) !== undefined) found.push(p);
  }
  for (const p of paths) {
    if (resolve(p) === null || resolve(p) === undefined) missing.push(p);
  }
  console.log('FOUND:' + JSON.stringify(found));
  console.log('MISSING:' + JSON.stringify(missing));
`;

describe('PM_API_CATALOG —— 与 pm SDK 实现保持一致', () => {
  it('清单里的每条 API 在 SDK 里都真实存在', async () => {
    const out = await runSandbox(makeInput(PROBE_SCRIPT));
    expect(out.error).toBeUndefined();

    const foundLine = out.logs.find((log) => log.message.startsWith('FOUND:'));
    expect(foundLine, '探针脚本没有输出 FOUND 日志').toBeDefined();
    // 先确认探针本身是有效的：几个基准路径必须能被找到
    expect(JSON.parse(foundLine!.message.replace('FOUND:', ''))).toEqual([
      'pm',
      'pm.test',
      'pm.response.json',
    ]);

    const logLine = out.logs.find((log) => log.message.startsWith('MISSING:'));
    expect(logLine, '沙箱没有输出 MISSING 日志，说明探针脚本本身有问题').toBeDefined();

    const missing = JSON.parse(logLine!.message.replace('MISSING:', ''));
    expect(missing, `PM_API_CATALOG 里有 SDK 未实现的 API：${missing.join(', ')}`).toEqual([]);
  });

  it('pm.response.to.have.status 这类断言方法真的能跑', async () => {
    const out = await runSandbox({
      ...makeInput(`
        pm.test('状态码断言可用', function () {
          pm.response.to.have.status(200);
        });
      `),
      // post 阶段必须给一个真实响应，否则 pm.response 是空壳，断言必然失败
      response: {
        code: 200,
        status: 'OK',
        headers: [{ key: 'content-type', value: 'application/json' }],
        body: '{"ok":true}',
        responseTime: 12,
        size: 11,
      },
    });
    expect(out.error).toBeUndefined();
    expect(out.tests).toHaveLength(1);
    expect(out.tests[0].passed).toBe(true);
  });

  it('pm.environment.set 之后能用 get 读回来', async () => {
    const out = await runSandbox(
      makeInput(`
        pm.environment.set('token', 'abc');
        pm.test('变量可读写', function () {
          if (pm.environment.get('token') !== 'abc') throw new Error('读不回来');
        });
      `),
    );
    expect(out.error).toBeUndefined();
    expect(out.tests[0].passed).toBe(true);
  });

  it('清单里的路径都不重复', () => {
    const paths = PM_API_CATALOG.map((item) => item.path);
    expect(new Set(paths).size).toBe(paths.length);
  });

  it('每条 API 都有说明文字和签名', () => {
    for (const item of PM_API_CATALOG) {
      expect(item.path, 'API 路径不能为空').toBeTruthy();
      expect(item.description, `${item.path} 缺少说明`).toBeTruthy();
      expect(typeof item.signature).toBe('string');
    }
  });
});
