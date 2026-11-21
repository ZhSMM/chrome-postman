/**
 * ============================================================
 * 脚本错误定位（Script Error Locator）
 * ============================================================
 *
 * 【在架构中的位置】
 * 位于"沙箱"与"UI"之间。QuickJS 抛错时给的是一段字符串堆栈，
 * 本模块把它解析成结构化的行列号，UI 才能把错误行标红并支持跳转。
 *
 * 【为什么行号能直接用】
 * src/core/sandbox.ts 里是这样执行用户脚本的：
 *     context.evalCode(input.script, `user-${phase}-script.js`)
 * 用户脚本是**整段字符串**交给 evalCode 的，所以 QuickJS 报的行号
 * 就是这段字符串里的第几行 —— 而编辑器显示的也是这段字符串的行号。
 * 两者天然对齐，中间不需要任何偏移量补偿。
 *
 * 【两种堆栈格式】
 *   运行期错误：  "    at <eval> (user-post-script.js:3:11)"
 *   语法错误：    "    at user-post-script.js:1:11"
 * 差别在于有没有 "<eval>" 和括号。幸运的是文件名部分完全一致，
 * 所以用一条正则就能同时匹配两种格式。
 */

/** 脚本执行阶段 */
import type { ScriptError, ScriptErrorLocation, ScriptPhase } from '../shared/types';

export type { ScriptError, ScriptErrorLocation, ScriptPhase };

/**
 * 从堆栈字符串里解析出行列号。
 *
 * @param stack QuickJS 的原始 stack
 * @param phase 兜底阶段（当堆栈里解析不出文件名时用它）
 * @returns 解析成功返回位置对象，失败返回 null
 *
 * 【为什么可能解析不出来】
 * 脚本超时被中断（死循环）不是异常，没有 stack；
 * 某些极端错误也可能不带位置信息。这时返回 null，UI 只显示文字。
 */
export function parseScriptErrorLocation(stack: string, phase: ScriptPhase): ScriptErrorLocation | null {
  if (!stack || typeof stack !== 'string') return null;

  // 文件名形如 user-pre-script.js / user-post-script.js
  const match = stack.match(/user-(pre|post)-script\.js:(\d+):(\d+)/);
  if (!match) return null;

  const line = Number(match[2]);
  const column = Number(match[3]);
  if (!Number.isFinite(line) || !Number.isFinite(column) || line < 1) return null;

  return {
    line,
    column,
    phase: match[1] === 'pre' ? 'pre' : 'post',
  };
}

/**
 * 把 QuickJS 抛出的错误对象转换成结构化的 ScriptError。
 *
 * @param raw 错误对象（QuickJS dump 出来的）
 * @param phase 脚本阶段
 */
export function buildScriptError(
  raw: { name?: string; message?: string; stack?: string },
  phase: ScriptPhase,
): ScriptError {
  const name = raw.name || 'Error';
  const message = raw.message || '';
  const stack = raw.stack ? String(raw.stack) : undefined;
  // parseScriptErrorLocation 失败时返回 null，这里统一转成 undefined
  const location = stack ? (parseScriptErrorLocation(stack, phase) ?? undefined) : undefined;

  return { name, message, stack, location };
}

/**
 * 生成一行人类可读的脚本错误摘要（用于 toast 提示）。
 *
 * 【为什么需要它】
 * toast 只能显示一行文字，放不下完整堆栈。
 * 但如果用户点错了阶段（前置脚本报错却跳到后置脚本），
 * 光显示 "TypeError" 用户会懵。所以这里带上阶段名和行列号。
 */
export function formatScriptError(error: ScriptError | undefined): string {
  if (!error) return '';
  const phaseLabel = error.location?.phase === 'pre' ? '前置脚本' : '后置脚本';
  const position = error.location ? `第 ${error.location.line} 行` : '';
  const parts = [error.name, error.message].filter(Boolean).join(': ');
  return position ? `${phaseLabel} ${position} — ${parts}` : `${phaseLabel} — ${parts}`;
}
