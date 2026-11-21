/**
 * 脚本编辑器（CodeMirror 6）。
 *
 * 【为什么用 CodeMirror 而不是 textarea】
 * 写脚本时括号配对、语法高亮、缩进非常影响体验。
 * CodeMirror 6 是模块化的现代代码编辑器，按需加载语言包。
 *
 * 【v1.2 新增：错误行定位】
 * 脚本执行失败时，QuickJS 会给出带行列号的错误堆栈（见 core/script-error.ts）。
 * 这里用 CodeMirror 的 lint 机制把出错的那一行标红，并支持从别处跳过来：
 *   - setDiagnostics：把错误挂到编辑器上，CodeMirror 会自动画波浪线
 *   - view.dispatch({ selection })：把光标移动到目标行
 *
 * 【用到的包】
 *   @uiw/react-codemirror —— React 封装
 *   @codemirror/lang-javascript —— JS 语言支持
 *   @codemirror/lint —— 错误标记（setDiagnostics）
 *   @codemirror/view —— EditorView 类型
 */
import { useEffect, useRef } from 'react';
import CodeMirror from '@uiw/react-codemirror';
import { javascript } from '@codemirror/lang-javascript';
import { setDiagnostics } from '@codemirror/lint';
import { EditorView } from '@codemirror/view';
import { autocompletion } from '@codemirror/autocomplete';
import type { ScriptError } from '../../shared/types';
import type { CompletionSources } from '../../core/completion';
import { useCodemirrorCompletion } from '../codemirror-completion';

interface Props {
  value: string;
  onChange: (value: string) => void;
  height?: string;
  readOnly?: boolean;
  /**
   * 脚本执行错误。传入后编辑器会把出错的那一行标红。
   * 只处理 location.phase 与当前脚本阶段匹配的错误。
   */
  error?: ScriptError;
  /**
   * 跳转请求。token 变化时把光标移到 line 行并滚动过去。
   *
   * 【为什么要带 token】
   * 只传 line 的话，"跳转到同一个行号两次"不会触发 effect
   * （React 认为依赖没变）。加一个自增 token，每次跳转都是新对象。
   */
  focus?: { line: number; token: number } | null;
  /** 补全候选源（pm API、变量等） */
  sources?: CompletionSources;
}

/**
 * 错误行的样式。
 *
 * 【为什么自己定义而不是用默认主题】
 * CodeMirror 的默认 lint 样式是红色虚线下划线，但在暗色主题下
 * 太细看不清。这里加一条淡红背景 + 波浪线，定位更直观。
 */
const lintTheme = EditorView.theme({
  '.cm-lintRange-error': {
    backgroundImage: 'none',
    backgroundColor: 'color-mix(in srgb, var(--red) 14%, transparent)',
    textDecoration: 'underline wavy var(--red) 1px',
    textDecorationSkipInk: 'none',
  },
  '.cm-lint-marker-error': {
    content: 'none',
  },
});

/** 没有传 sources 时用的空候选源（避免每次渲染都新建对象） */
const EMPTY_SOURCES: CompletionSources = {
  variables: [],
  builtins: [],
  apis: [],
  headers: [],
  history: [],
};

export default function ScriptEditor({
  value,
  onChange,
  height = '260px',
  readOnly = false,
  error,
  focus,
  sources,
}: Props) {
  /** CodeMirror 的 EditorView 实例，用来下发 diagnostics 和移动光标 */
  const viewRef = useRef<EditorView | null>(null);

  /** 补全源（函数引用稳定，不会让编辑器重建） */
  const completionSource = useCodemirrorCompletion(sources ?? EMPTY_SOURCES);

  /* ---------- 把错误挂到编辑器上 ---------- */
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;

    if (!error?.location) {
      // 没有位置信息（超时中断之类）就不标任何行
      view.dispatch(setDiagnostics(view.state, []));
      return;
    }

    // 行号可能被用户的编辑改得越界（脚本报错后又改了代码），
    // 所以要夹到合法范围内，否则 CodeMirror 会抛异常。
    const lineNumber = Math.min(Math.max(error.location.line, 1), view.state.doc.lines);
    const line = view.state.doc.line(lineNumber);

    view.dispatch(
      setDiagnostics(view.state, [
        {
          from: line.from,
          to: line.to,
          severity: 'error',
          message: `${error.name}: ${error.message}`,
        },
      ]),
    );
  }, [error]);

  /* ---------- 从别处跳到指定行 ---------- */
  useEffect(() => {
    const view = viewRef.current;
    if (!view || !focus) return;

    const lineNumber = Math.min(Math.max(focus.line, 1), view.state.doc.lines);
    const line = view.state.doc.line(lineNumber);

    view.dispatch({
      selection: { anchor: line.from },
      scrollIntoView: true,
    });
    view.focus();
    // 只在 token 变化时触发（同一个行号跳两次也要生效）
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focus?.token]);

  return (
    <div className="editor-shell">
      <CodeMirror
        value={value}
        height={height}
        theme="dark"
        extensions={[
          javascript(),
          lintTheme,
          // 用我们自己的补全源替换 CodeMirror 默认的（默认源只认 JS 关键字）
          autocompletion({ override: [completionSource] }),
        ]}
        readOnly={readOnly}
        onChange={onChange}
        onCreateEditor={(view) => {
          viewRef.current = view;
        }}
        basicSetup={{
          lineNumbers: true,
          foldGutter: false,
          highlightActiveLine: false,
          // 关闭内置自动补全，改为由上面的 override 接管
          autocompletion: false,
          bracketMatching: true,
        }}
      />
    </div>
  );
}
