/**
 * 脚本编辑器（CodeMirror 6）。
 *
 * 【为什么用 CodeMirror 而不是 textarea】
 * 写脚本时括号配对、语法高亮、缩进非常影响体验。
 * CodeMirror 6 是模块化的现代代码编辑器，按需加载语言包。
 *
 * 【用到的包】
 *   @uiw/react-codemirror —— React 封装
 *   @codemirror/lang-javascript —— JS 语言支持
 */
import CodeMirror from '@uiw/react-codemirror';
import { javascript } from '@codemirror/lang-javascript';

interface Props {
  value: string;
  onChange: (value: string) => void;
  height?: string;
  readOnly?: boolean;
}

export default function ScriptEditor({ value, onChange, height = '260px', readOnly = false }: Props) {
  return (
    <div className="editor-shell">
      <CodeMirror
        value={value}
        height={height}
        theme="dark"
        extensions={[javascript()]}
        readOnly={readOnly}
        onChange={onChange}
        basicSetup={{
          lineNumbers: true,
          foldGutter: false,
          highlightActiveLine: false,
          autocompletion: true,
          bracketMatching: true,
        }}
      />
    </div>
  );
}
