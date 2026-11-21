/**
 * 脚本错误定位（script-error）的单元测试。
 *
 * 【为什么这些测试重要】
 * "错误行号定位"这个功能的全部价值都建立在"行号算得对"之上。
 * 行号算错一点，用户跳过去看到的是错误的代码，比不跳还糟。
 */
import { describe, expect, it } from 'vitest';
import { buildScriptError, formatScriptError, parseScriptErrorLocation } from '../src/core/script-error';

describe('parseScriptErrorLocation —— 从堆栈解析行列号', () => {
  it('解析运行期错误的堆栈格式', () => {
    // QuickJS 运行期错误：at <eval> (user-post-script.js:3:11)
    const location = parseScriptErrorLocation(
      '    at <eval> (user-post-script.js:3:11)\n',
      'pre',
    );
    expect(location).toEqual({ line: 3, column: 11, phase: 'post' });
  });

  it('解析语法错误的堆栈格式', () => {
    // 语法错误没有 <eval> 和括号：at user-post-script.js:1:11
    const location = parseScriptErrorLocation('    at user-post-script.js:1:11\n', 'post');
    expect(location).toEqual({ line: 1, column: 11, phase: 'post' });
  });

  it('能从文件名里认出是哪个阶段的脚本', () => {
    expect(parseScriptErrorLocation('at <eval> (user-pre-script.js:2:5)', 'post')?.phase).toBe('pre');
    expect(parseScriptErrorLocation('at <eval> (user-post-script.js:2:5)', 'pre')?.phase).toBe('post');
  });

  it('堆栈里有多行时取第一个带位置的', () => {
    const stack = [
      '    at <eval> (user-post-script.js:5:9)',
      '    at <eval> (user-post-script.js:9:1)',
    ].join('\n');
    expect(parseScriptErrorLocation(stack, 'post')?.line).toBe(5);
  });

  it('没有位置的堆栈返回 null（例如死循环被超时中断）', () => {
    expect(parseScriptErrorLocation('    at <eval> (anonymous)', 'pre')).toBeNull();
    expect(parseScriptErrorLocation('', 'pre')).toBeNull();
    expect(parseScriptErrorLocation('undefined', 'pre')).toBeNull();
  });

  it('不是字符串时返回 null', () => {
    expect(parseScriptErrorLocation(undefined as any, 'pre')).toBeNull();
    expect(parseScriptErrorLocation(null as any, 'pre')).toBeNull();
  });
});

describe('buildScriptError —— 构造结构化错误', () => {
  it('把 name / message / stack / location 都填好', () => {
    const error = buildScriptError(
      {
        name: 'ReferenceError',
        message: "'notDefinedVar' is not defined",
        stack: '    at <eval> (user-post-script.js:3:11)\n',
      },
      'post',
    );
    expect(error.name).toBe('ReferenceError');
    expect(error.message).toContain('notDefinedVar');
    expect(error.location?.line).toBe(3);
    expect(error.location?.column).toBe(11);
  });

  it('缺少 stack 时 location 为 undefined，但错误本身仍然可用', () => {
    const error = buildScriptError({ name: 'Error', message: '内存超限' }, 'pre');
    expect(error.location).toBeUndefined();
    expect(error.message).toBe('内存超限');
  });

  it('缺少 name 时默认用 Error', () => {
    expect(buildScriptError({ message: 'x' }, 'pre').name).toBe('Error');
  });
});

describe('formatScriptError —— 生成一行可读摘要', () => {
  it('带行号时会显示阶段和行号', () => {
    const error = buildScriptError(
      { name: 'TypeError', message: 'x is not a function', stack: 'at <eval> (user-pre-script.js:4:2)' },
      'pre',
    );
    const text = formatScriptError(error);
    expect(text).toContain('前置脚本');
    expect(text).toContain('第 4 行');
    expect(text).toContain('TypeError');
  });

  it('没有行号时只显示阶段和错误信息', () => {
    const error = buildScriptError({ name: 'Error', message: '超时' }, 'post');
    const text = formatScriptError(error);
    expect(text).toContain('后置脚本');
    expect(text).not.toContain('第');
  });

  it('undefined 时返回空串', () => {
    expect(formatScriptError(undefined)).toBe('');
  });
});
