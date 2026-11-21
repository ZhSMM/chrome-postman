/**
 * CodeMirror 补全源。
 *
 * 【为什么需要单独一层】
 * CodeMirror 有自己的补全机制（@codemirror/autocomplete），
 * 但我们的候选来自核心层的纯函数补全引擎（core/completion.ts）。
 * 这一层负责把两者对接起来：
 *   CodeMirror 的 CompletionContext  →  我们的 detectContext
 *   我们的 CompletionItem[]          →  CodeMirror 的 CompletionResult
 *
 * 【关键点：替换范围要用 CodeMirror 给的 from/to】
 * 我们的 detectContext 返回的 range 适合原生 input（精确到变量名）。
 * 但在 CodeMirror 里，输入 `pm.res` 时应该把整个 `pm.res` 换成
 * `pm.response`，所以替换范围要用 CodeMirror 匹配出来的那个词，
 * 而不是 detectContext 里的 range。
 */
import { useCallback, useRef } from 'react';
import type { CompletionContext, CompletionResult } from '@codemirror/autocomplete';
import { computeCompletions, detectContext, type CompletionSources } from '../core/completion';

/**
 * 匹配"一个可以被打断的词"。
 *
 * 【字符类里为什么要有 { }】
 * 因为变量占位符是 {{name}}，如果只匹配 \w，那 `{{ho` 会被切成
 * `ho`，detectContext 就找不到 `{{` 了，变量补全永远不触发。
 *
 * 【为什么要有 .】
 * pm.response.json 这种链式 API，`.` 必须是词的一部分，
 * 否则输入 `pm.res` 时词被截断成 `res`，前缀丢了。
 */
const WORD_PATTERN = /[\w$.{}\-]*/;

/**
 * 创建一个 CodeMirror 补全源。
 *
 * @param sourcesRef 当前最新的候选源。用 ref 传是为了让补全函数本身
 *                   保持稳定引用（否则每次 store 更新都会重建扩展，
 *                   CodeMirror 会闪烁并丢失光标位置）。
 */
export function createCodemirrorCompletionSource(
  sourcesRef: React.MutableRefObject<CompletionSources>,
) {
  return (context: CompletionContext): CompletionResult | null => {
    const word = context.matchBefore(WORD_PATTERN);
    if (!word) return null;
    // 什么都没输入时，只有用户主动按了 Ctrl+Space 才提示
    if (word.from === word.to && !context.explicit) return null;

    const text = context.state.doc.toString();
    const detected = detectContext(text, word.to);
    if (!detected) return null;

    const items = computeCompletions(detected, sourcesRef.current);
    if (!items.length) return null;

    return {
      // 用 CodeMirror 匹配出来的词作为替换范围
      from: word.from,
      to: word.to,
      options: items.map((item) => ({
        label: item.label,
        detail: item.detail,
        type: item.kind,
        // apply 直接决定插入什么文本
        apply: item.insertText,
      })),
      // 用户继续打字时，只要还是合法字符就继续用这份候选
      validFor: /^[\w$.{}\-]*$/,
    };
  };
}

/**
 * React Hook：返回一个稳定的 CodeMirror 补全源函数。
 *
 * 【为什么需要 Hook 而不是直接调用工厂】
 * sources 会随 store 变化。如果每次都新建补全函数，
 * CodeMirror 的扩展数组就会变，编辑器会重建视图、丢失光标。
 * 用 ref 存最新值 + useCallback 固定函数引用就能避开这个问题。
 */
export function useCodemirrorCompletion(sources: CompletionSources) {
  const sourcesRef = useRef(sources);
  // 每次渲染都同步最新值（ref 不会触发重渲染，这是安全的）
  sourcesRef.current = sources;

  return useCallback(
    (context: CompletionContext): CompletionResult | null =>
      createCodemirrorCompletionSource(sourcesRef)(context),
    [],
  );
}
