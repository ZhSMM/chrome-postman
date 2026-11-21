/**
 * 变量引用检查器（variable-lint）的单元测试。
 *
 * 【为什么这些测试重要】
 * 变量检查器和变量引擎必须对"什么是变量名"有完全一致的判断。
 * 一旦不一致，用户就会看到"UI 说没定义、发送时却解析出来了"这种鬼故事。
 */
import { describe, expect, it } from 'vitest';
import {
  collectMissing,
  collectRequestMissing,
  extractVariableRefs,
  lintVariables,
  resolveScopeOf,
  suggestVariables,
} from '../src/core/variable-lint';
import { interpolate } from '../src/core/variables';
import type { VariableScope } from '../src/shared/types';

function makeScope(patch: Partial<VariableScope> = {}): VariableScope {
  return {
    environment: {},
    collection: {},
    globals: {},
    session: {},
    ...patch,
  };
}

describe('extractVariableRefs —— 提取变量引用', () => {
  it('识别单个占位符', () => {
    const refs = extractVariableRefs('https://{{host}}/api');
    expect(refs).toHaveLength(1);
    expect(refs[0].name).toBe('host');
    expect(refs[0].index).toBe(8);
    expect(refs[0].length).toBe('{{host}}'.length);
  });

  it('占位符里允许有空格', () => {
    const refs = extractVariableRefs('{{ host }}');
    expect(refs).toHaveLength(1);
    expect(refs[0].name).toBe('host');
  });

  it('一个文本里的多个占位符都能提取', () => {
    const refs = extractVariableRefs('{{a}}/{{b}}/{{c}}');
    expect(refs.map((r) => r.name)).toEqual(['a', 'b', 'c']);
  });

  it('同一个变量出现多次时，每次都单独报出来', () => {
    const refs = extractVariableRefs('{{id}}-{{id}}-{{id}}');
    expect(refs).toHaveLength(3);
    expect(refs.every((r) => r.name === 'id')).toBe(true);
    // 位置必须各不相同，否则 UI 高亮会串位
    expect(new Set(refs.map((r) => r.index)).size).toBe(3);
  });

  it('没有占位符时返回空数组', () => {
    expect(extractVariableRefs('https://example.com')).toEqual([]);
    expect(extractVariableRefs('')).toEqual([]);
  });

  it('嵌套大括号时与变量引擎保持一致', () => {
    // {{{a}}} 实际会匹配到内层的 {{a}}（前两个 { 是占位符的开头，
    // 后两个 } 是结尾）。这和变量引擎 interpolate 的行为完全一致 ——
    // 检查器和引擎必须对"什么是变量名"有同样的判断。
    const refs = extractVariableRefs('{{{a}}}');
    expect(refs).toHaveLength(1);
    expect(refs[0].name).toBe('a');
  });

  it('与变量引擎的解析结果完全一致（一致性回归测试）', () => {
    // 这是本模块最重要的一条断言：
    // 检查器和引擎如果对同一段文本给出不同的变量名集合，
    // 用户就会遇到"UI 说没定义、发送时却解析出来了"的鬼故事。
    const samples = [
      'https://{{host}}/api/{{id}}',
      '{{ host }}',
      '{{{a}}}',
      'no variables here',
      '{{a}}{{a}}{{b}}',
      '{{ }}',
    ];
    for (const text of samples) {
      const fromLint = extractVariableRefs(text).map((r) => r.name);
      const fromEngine = [...new Set(interpolate(text, makeScope()).missing)];
      // 引擎的 missing 只包含"没定义"的变量；这里用全空作用域，
      // 所以所有变量都该出现在 missing 里（去重后）
      const uniqueLint = [...new Set(fromLint)].sort();
      const uniqueEngine = [...fromEngine].sort();
      expect(uniqueLint).toEqual(uniqueEngine);
    }
  });
});

describe('resolveScopeOf —— 判断变量来自哪一层', () => {
  const scope = makeScope({
    environment: { env1: 'a' },
    collection: { col1: 'b' },
    globals: { glob1: 'c' },
    session: { sess1: 'd' },
  });

  it('各作用域都能正确识别', () => {
    expect(resolveScopeOf('env1', scope)).toBe('environment');
    expect(resolveScopeOf('col1', scope)).toBe('collection');
    expect(resolveScopeOf('glob1', scope)).toBe('globals');
    expect(resolveScopeOf('sess1', scope)).toBe('session');
  });

  it('内置动态变量也能识别', () => {
    expect(resolveScopeOf('$timestamp', scope)).toBe('builtin');
    expect(resolveScopeOf('$uuid', scope)).toBe('builtin');
  });

  it('不存在的变量返回 undefined', () => {
    expect(resolveScopeOf('nope', scope)).toBeUndefined();
  });

  it('同名时环境变量优先于集合变量', () => {
    const duplicated = makeScope({ environment: { same: '1' }, collection: { same: '2' } });
    expect(resolveScopeOf('same', duplicated)).toBe('environment');
  });
});

describe('lintVariables —— 标记变量是否有值', () => {
  it('有值的变量被标记为 defined 并带出值', () => {
    const scope = makeScope({ environment: { host: 'https://api.dev' } });
    const refs = lintVariables('{{host}}/users', scope);
    expect(refs[0].defined).toBe(true);
    expect(refs[0].value).toBe('https://api.dev');
    expect(refs[0].scope).toBe('environment');
  });

  it('没值的变量被标记为 undefined', () => {
    const refs = lintVariables('{{ghost}}', makeScope());
    expect(refs[0].defined).toBe(false);
    expect(refs[0].value).toBeUndefined();
  });

  it('内置动态变量总是有值', () => {
    const refs = lintVariables('{{$timestamp}}', makeScope());
    expect(refs[0].defined).toBe(true);
    expect(refs[0].scope).toBe('builtin');
  });
});

describe('collectMissing —— 汇总未定义变量', () => {
  it('重复出现的未定义变量只报一次', () => {
    const missing = collectMissing('{{a}}/{{a}}/{{b}}', makeScope());
    expect(missing.map((m) => m.name)).toEqual(['a', 'b']);
  });

  it('已定义的变量不会出现在结果里', () => {
    const scope = makeScope({ globals: { ok: '1' } });
    const missing = collectMissing('{{ok}}/{{bad}}', scope);
    expect(missing.map((m) => m.name)).toEqual(['bad']);
  });
});

describe('collectRequestMissing —— 检查整个请求', () => {
  it('URL / Header / Body / 鉴权里的未定义变量都能被发现', () => {
    const missing = collectRequestMissing(
      {
        url: 'https://{{host}}/api',
        params: [{ key: 'page', value: '{{pageNo}}', enabled: true }],
        headers: [{ key: 'X-Token', value: '{{token}}', enabled: true }],
        body: { raw: '{"id": {{userId}}}', form: [], formData: [] },
        auth: { token: '{{authToken}}' },
      },
      makeScope(),
    );
    const names = missing.map((m) => m.name);
    expect(names).toContain('host');
    expect(names).toContain('pageNo');
    expect(names).toContain('token');
    expect(names).toContain('userId');
    expect(names).toContain('authToken');
  });

  it('没有未定义变量时返回空数组', () => {
    const scope = makeScope({ environment: { host: 'x' } });
    const missing = collectRequestMissing({ url: 'https://{{host}}' }, scope);
    expect(missing).toEqual([]);
  });
});

describe('suggestVariables —— 相似变量候选', () => {
  const scope = makeScope({
    environment: { host: 'a', hostname: 'b' },
    collection: { hostName: 'c' },
  });

  it('拼错名字时能给出相近候选', () => {
    const candidates = suggestVariables('hosst', scope);
    expect(candidates.length).toBeGreaterThan(0);
    expect(candidates.map((c) => c.name)).toContain('host');
  });

  it('精确匹配排在最前', () => {
    const candidates = suggestVariables('host', scope);
    expect(candidates[0].name).toBe('host');
  });

  it('空查询词时列出全部变量', () => {
    const candidates = suggestVariables('', scope);
    expect(candidates.length).toBe(3);
  });

  it('完全不相关时不返回候选', () => {
    expect(suggestVariables('zzzzz', scope)).toEqual([]);
  });
});
