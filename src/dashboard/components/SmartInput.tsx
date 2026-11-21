/**
 * 智能输入框（带补全）。
 *
 * 【解决什么问题】
 * 手写 `{{baseUrl}}`、`pm.response.json()` 这种长串又慢又容易打错。
 * 本组件在用户输入时弹出候选列表，方向键选择、Tab/回车接受。
 *
 * 【交互约定（重要，别随手改）】
 *   ↑ / ↓      移动选中项
 *   Tab        接受选中项
 *   Enter      有候选时接受候选；没有候选时才触发 onEnter
 *   Ctrl+Enter 永远触发 onEnter（发请求）
 *   Esc        关闭候选列表
 *
 * 【为什么 Enter 要这样设计】
 * 原来 URL 输入框的 Enter 是"发送请求"。加了补全后两个语义会打架：
 * 用户正看着候选列表时按 Enter，多半是想"选这个"，而不是"发出去"。
 * 所以有候选时 Enter 给补全，没候选时才是发送；Ctrl+Enter 始终发送。
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  computeCompletions,
  detectContext,
  type CompletionContext,
  type CompletionItem,
  type CompletionKind,
  type CompletionSources,
} from '../../core/completion';

interface Props {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  className?: string;
  /** 候选数据源 */
  sources: CompletionSources;
  /** 回车（无候选时）或 Ctrl+回车时触发 */
  onEnter?: () => void;
  /** 回车是否触发 onEnter。URL 框传 true，普通输入框不传 */
  enterSends?: boolean;
  /** 额外的 input 属性 */
  type?: string;
  /** autoComplete 属性 */
  autoComplete?: string;
}

/** 各类候选的图标 */
const KIND_ICON: Record<CompletionKind, string> = {
  variable: '{ }',
  builtin: '⚙',
  function: 'ƒ',
  header: 'H',
  history: '⏱',
  method: 'M',
};

export default function SmartInput({
  value,
  onChange,
  placeholder,
  className,
  sources,
  onEnter,
  enterSends,
  type,
  autoComplete = 'off',
}: Props) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState<CompletionItem[]>([]);
  const [selected, setSelected] = useState(0);
  /** 当前生效的上下文，接受候选时要用它知道替换哪一段 */
  const [ctx, setCtx] = useState<CompletionContext | null>(null);

  /** 重新计算候选 */
  const recompute = useCallback(
    (text: string, cursor: number) => {
      const context = detectContext(text, cursor);
      if (!context) {
        setCtx(null);
        setItems([]);
        setOpen(false);
        return;
      }
      const list = computeCompletions(context, sources);
      setCtx(context);
      setItems(list);
      setSelected(0);
      setOpen(list.length > 0);
    },
    [sources],
  );

  /** 接受选中的候选 */
  const accept = useCallback(
    (item: CompletionItem) => {
      if (!ctx) return;
      const next = value.slice(0, ctx.range.start) + item.insertText + value.slice(ctx.range.end);
      onChange(next);
      setOpen(false);
      setItems([]);
      // 把光标放到插入文本之后，用户可以接着往下写
      requestAnimationFrame(() => {
        const pos = ctx.range.start + item.insertText.length;
        inputRef.current?.focus();
        inputRef.current?.setSelectionRange(pos, pos);
      });
    },
    [ctx, value, onChange],
  );

  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const text = e.target.value;
    onChange(text);
    recompute(text, e.target.selectionStart ?? text.length);
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    // Ctrl+Enter 永远发请求（即使当前有候选浮层）
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      onEnter?.();
      return;
    }

    if (open && items.length) {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setSelected((s) => (s + 1) % items.length);
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        setSelected((s) => (s - 1 + items.length) % items.length);
        return;
      }
      if (e.key === 'Tab') {
        e.preventDefault();
        accept(items[selected]);
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        setOpen(false);
        return;
      }
      if (e.key === 'Enter') {
        e.preventDefault();
        accept(items[selected]);
        return;
      }
    }

    if (e.key === 'Enter' && enterSends) {
      e.preventDefault();
      onEnter?.();
    }
  };

  // 外部改了值（比如用户选了变量、或者发送后重置）时，重新算一次候选
  useEffect(() => {
    const input = inputRef.current;
    if (!input) return;
    recompute(value, input.selectionStart ?? value.length);
    // 只在 value 变化时重算；sources 变化由 recompute 的依赖处理
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);

  return (
    <div className="smart-input">
      <input
        ref={inputRef}
        className={className}
        value={value}
        placeholder={placeholder}
        type={type}
        autoComplete={autoComplete}
        onChange={handleChange}
        onKeyDown={handleKeyDown}
        onBlur={() => setOpen(false)}
      />

      {open && items.length > 0 && (
        <div className="completion-popup">
          {items.map((item, index) => (
            <div
              key={`${item.kind}_${item.label}_${index}`}
              className={`completion-item ${index === selected ? 'active' : ''}`}
              // 用 mousedown + preventDefault：既能接受候选，又不会让 input 先失焦
              onMouseDown={(e) => {
                e.preventDefault();
                accept(item);
              }}
              onMouseEnter={() => setSelected(index)}
            >
              <span className={`completion-kind ${item.kind}`}>{KIND_ICON[item.kind]}</span>
              <span className="completion-label">{item.label}</span>
              {item.detail && <span className="completion-detail">{item.detail}</span>}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
