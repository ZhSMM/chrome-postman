/**
 * 补全引擎（completion）的单元测试。
 *
 * 【为什么这些测试重要】
 * 补全的"手感"全靠触发规则和排序。
 * 触发错了（比如占位符已经闭合了还在弹候选）会非常烦人，
 * 排序错了会让常用项排到后面去。
 */
import { describe, expect, it } from 'vitest';
import {
  computeCompletions,
  detectContext,
  isSubsequence,
  matchScore,
  type CompletionSources,
} from '../src/core/completion';

function makeSources(patch: Partial<CompletionSources> = {}): CompletionSources {
  return {
    variables: [],
    builtins: [],
    apis: [],
    headers: [],
    history: [],
    ...patch,
  };
}

describe('detectContext —— 判断光标处的补全语境', () => {
  it('识别 {{ 触发的变量补全', () => {
    // 光标位置要对：'https://api.{{ho' 长度 16，光标在 16
    const ctx = detectContext('https://api.{{ho', 16);
    expect(ctx?.trigger).toBe('brace');
    expect(ctx?.query).toBe('ho');
    // 替换区间从 {{ 开始，插入时才能补全成 {{host}}
    expect(ctx?.range.start).toBe(12);
    expect(ctx?.range.end).toBe(16);
  });

  it('占位符里有空格也能识别', () => {
    // '{{ host }}' 长度 10，光标在 8（还没碰到结尾的 }）
    const ctx = detectContext('{{ host }}', 8);
    expect(ctx?.trigger).toBe('brace');
    expect(ctx?.query).toBe('host');
  });

  it('占位符已经闭合时不再触发变量补全', () => {
    // 'https://{{host}}' 长度 16，光标在 16（整段写完了）
    const ctx = detectContext('https://{{host}}', 16);
    expect(ctx?.trigger).not.toBe('brace');
  });

  it('点号触发 API 补全，并带出路径前缀', () => {
    const ctx = detectContext('pm.res', 6);
    expect(ctx?.trigger).toBe('dot');
    expect(ctx?.query).toBe('res');
    expect(ctx?.prefix).toBe('pm');
  });

  it('刚打完点号时前缀完整、查询为空', () => {
    const ctx = detectContext('pm.', 3);
    expect(ctx?.trigger).toBe('dot');
    expect(ctx?.query).toBe('');
    expect(ctx?.prefix).toBe('pm');
  });

  it('支持链式 API 的前缀', () => {
    const ctx = detectContext('pm.response.jo', 14);
    expect(ctx?.trigger).toBe('dot');
    expect(ctx?.query).toBe('jo');
    expect(ctx?.prefix).toBe('pm.response');
  });

  it('普通词触发普通补全', () => {
    const ctx = detectContext('Autho', 5);
    expect(ctx?.trigger).toBe('word');
    expect(ctx?.query).toBe('Autho');
    expect(ctx?.range).toEqual({ start: 0, end: 5 });
  });

  it('刚打完协议时也能触发（用于列出历史 URL）', () => {
    const ctx = detectContext('https://', 8);
    expect(ctx?.trigger).toBe('word');
    expect(ctx?.query).toBe('');
  });

  it('URL 里的点号路径也能触发（没有 API 匹配时会回退到历史 URL）', () => {
    // 'https://api.' 语法上和 pm. 一样是点号结尾，
    // 但它不是 API 路径 —— computeCompletions 会在无匹配时回退到普通词
    const ctx = detectContext('https://api.', 12);
    expect(ctx).not.toBeNull();
    const items = computeCompletions(ctx!, makeSources({
      history: [{ url: 'https://api.example.com/', method: 'GET', lastUsed: Date.now(), useCount: 1 }],
    }));
    expect(items.map((i) => i.label)).toContain('https://api.example.com/');
  });

  it('越界的光标位置返回 null', () => {
    expect(detectContext('abc', -1)).toBeNull();
    expect(detectContext('abc', 99)).toBeNull();
  });
});

describe('isSubsequence —— 缩写匹配', () => {
  it('按顺序出现的字符算匹配', () => {
    expect(isSubsequence('hs', 'host')).toBe(true);
    expect(isSubsequence('hst', 'host')).toBe(true);
    expect(isSubsequence('ost', 'host')).toBe(true);
  });

  it('顺序不对就不算匹配', () => {
    // 'th' 要求先出现 t 再出现 h，而 'host' 里 h 在前面
    expect(isSubsequence('th', 'host')).toBe(false);
  });

  it('空查询总是匹配', () => {
    expect(isSubsequence('', 'anything')).toBe(true);
  });
});

describe('matchScore —— 匹配打分', () => {
  it('精确匹配得分最高', () => {
    expect(matchScore('host', 'host')).toBe(100);
    expect(matchScore('host', 'hostname')).toBe(100);
  });

  it('连续包含比缩写匹配更精确，分数更高', () => {
    // 'ost' 是 'host' 的连续子串 → 70
    expect(matchScore('ost', 'host')).toBe(70);
    // 'hs' 只是缩写 → 50
    expect(matchScore('hs', 'host')).toBe(50);
  });

  it('不匹配返回 0', () => {
    expect(matchScore('zzz', 'host')).toBe(0);
  });
});

describe('computeCompletions —— 计算候选', () => {
  it('{{ 触发时给出变量和内置变量', () => {
    const sources = makeSources({
      variables: [{ name: 'host', scope: 'environment', value: 'https://api.dev' }],
      builtins: [{ name: '$timestamp', description: 'Unix 时间戳', preview: '1700000000' }],
    });
    const ctx = detectContext('{{', 2)!;
    const items = computeCompletions(ctx, sources);
    expect(items.map((i) => i.label)).toContain('host');
    expect(items.map((i) => i.label)).toContain('$timestamp');
    // 变量候选插入的是完整的占位符
    expect(items.find((i) => i.label === 'host')?.insertText).toBe('{{host}}');
  });

  it('同名变量只保留作用域优先级最高的那个', () => {
    const sources = makeSources({
      variables: [
        { name: 'host', scope: 'globals', value: 'global' },
        { name: 'host', scope: 'environment', value: 'env' },
        { name: 'host', scope: 'collection', value: 'col' },
      ],
    });
    const ctx = detectContext('{{', 2)!;
    const items = computeCompletions(ctx, sources);
    const hostItems = items.filter((i) => i.label === 'host');
    expect(hostItems).toHaveLength(1);
    // 环境变量优先级最高
    expect(hostItems[0].detail).toContain('环境变量');
  });

  it('点号触发时只给出前缀匹配的 API', () => {
    const sources = makeSources({
      apis: [
        { path: 'pm.response.json', signature: '()', description: '解析 JSON' },
        { path: 'pm.environment.set', signature: '(k,v)', description: '写环境变量' },
      ],
    });
    const ctx = detectContext('pm.', 3)!;
    const items = computeCompletions(ctx, sources);
    expect(items).toHaveLength(2);

    const ctx2 = detectContext('pm.res', 6)!;
    const items2 = computeCompletions(ctx2, sources);
    expect(items2.map((i) => i.label)).toEqual(['response']);
  });

  it('普通词触发时给出请求头和历史 URL', () => {
    const sources = makeSources({
      headers: [{ name: 'Authorization', description: '认证凭据' }],
      history: [{ url: 'https://api.example.com/users', method: 'GET', lastUsed: Date.now(), useCount: 3 }],
    });
    const ctx = detectContext('Auth', 4)!;
    const items = computeCompletions(ctx, sources);
    expect(items.map((i) => i.label)).toContain('Authorization');
  });

  it('最近用过的历史 URL 排在前面', () => {
    const now = Date.now();
    const sources = makeSources({
      history: [
        { url: 'https://old.example.com/', method: 'GET', lastUsed: now - 100000, useCount: 1 },
        { url: 'https://new.example.com/', method: 'GET', lastUsed: now, useCount: 5 },
      ],
    });
    const ctx = detectContext('https://', 8)!;
    const items = computeCompletions(ctx, sources);
    expect(items[0].label).toBe('https://new.example.com/');
  });

  it('没有任何匹配时返回空数组', () => {
    // 未闭合的占位符里输入了一个不存在的变量名
    const ctx = detectContext('{{zzz', 5)!;
    expect(ctx.trigger).toBe('brace');
    expect(computeCompletions(ctx, makeSources())).toEqual([]);
  });

  it('结果按分数降序排列', () => {
    const sources = makeSources({
      headers: [
        { name: 'X-Token', description: '' },
        { name: 'Authorization', description: '' },
      ],
    });
    const ctx = detectContext('A', 1)!;
    const items = computeCompletions(ctx, sources);
    // Authorization 是前缀匹配（100），X-Token 不匹配（0）会被过滤
    expect(items).toHaveLength(1);
    expect(items[0].label).toBe('Authorization');
  });
});
