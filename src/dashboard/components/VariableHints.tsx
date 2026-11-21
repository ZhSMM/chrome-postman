/**
 * 变量缺失提示条。
 *
 * 【解决什么问题】
 * 用户在 URL 里写了 {{host}}，但环境里根本没有 host 这个变量。
 * 如果不管，用户要到"发送请求失败 → 看诊断"才发现问题，白白浪费一轮。
 * 本组件在**输入时**就告诉他："这 2 个变量还没定义"。
 *
 * 【一键补全怎么工作】
 * 用户点了未定义变量名后，列出当前所有作用域里名字相近的变量，
 * 选中一个就把 URL 里的 {{xxx}} 直接替换成它的值。
 * （这是"临时用一下某个值"的快捷方式；想长期复用还是应该去环境管理里建变量。）
 */
import { useMemo, useState } from 'react';
import type { VariableScope } from '../../shared/types';
import { collectMissing, suggestVariables, type VariableRef } from '../../core/variable-lint';

interface Props {
  /** 要检查的文本（通常是 URL） */
  text: string;
  /** 当前生效的变量作用域 */
  scope: VariableScope;
  /**
   * 用户选中一个候选值时调用。
   * 参数：变量名、要填进去的值。
   */
  onApply?: (name: string, value: string) => void;
}

/** 作用域的中文名 */
const SCOPE_LABEL: Record<string, string> = {
  environment: '环境变量',
  collection: '集合变量',
  globals: '全局变量',
  session: '会话变量',
};

export default function VariableHints({ text, scope, onApply }: Props) {
  /** 当前展开的变量名（null = 都没展开） */
  const [expanded, setExpanded] = useState<string | null>(null);
  /** 是否展开"全部可用变量" */
  const [showAll, setShowAll] = useState(false);

  /** 没定义的变量 */
  const missing = useMemo(() => collectMissing(text, scope), [text, scope]);

  /** 当前展开的变量的候选 */
  const candidates = useMemo(
    () => (expanded ? suggestVariables(expanded, scope, 8) : []),
    [expanded, scope],
  );

  /** 所有可用变量（给"查看可用变量"用） */
  const allVariables = useMemo(() => {
    const list: VariableRef[] = [];
    const push = (name: string, scopeName: string) => {
      list.push({ name, index: 0, length: name.length, defined: true, scope: scopeName as never });
    };
    Object.keys(scope.environment ?? {}).forEach((k) => push(k, 'environment'));
    Object.keys(scope.collection ?? {}).forEach((k) => push(k, 'collection'));
    Object.keys(scope.globals ?? {}).forEach((k) => push(k, 'globals'));
    Object.keys(scope.session ?? {}).forEach((k) => push(k, 'session'));
    return list;
  }, [scope]);

  // 没有未定义变量时，只有在用户主动展开"全部可用变量"时才显示
  if (!missing.length && !showAll) return null;

  return (
    <div className="var-hints">
      {missing.length > 0 && (
        <div className="var-hints-line">
          <span className="var-hints-warn">⚠ {missing.length} 个未定义变量：</span>
          {missing.map((item) => (
            <button
              key={item.name}
              className={`var-chip ${expanded === item.name ? 'active' : ''}`}
              title="点击查看可替换的相近变量"
              onClick={() => setExpanded(expanded === item.name ? null : item.name)}
            >
              {item.name}
            </button>
          ))}
          <span className="spacer" />
          <button className="btn ghost sm" onClick={() => setShowAll((v) => !v)}>
            {showAll ? '收起变量' : `可用变量 ${allVariables.length}`}
          </button>
        </div>
      )}

      {/* 未定义变量的候选 */}
      {expanded && (
        <div className="var-hints-line">
          <span className="faint">把 {'{{'}{expanded}{'}}'} 替换成：</span>
          {candidates.length ? (
            candidates.map((item) => (
              <button
                key={item.name}
                className="var-chip ok"
                title={`${SCOPE_LABEL[item.scope ?? ''] ?? ''} · ${item.value ?? ''}`}
                onClick={() => {
                  onApply?.(item.name, item.value ?? '');
                  setExpanded(null);
                }}
              >
                {item.name}
              </button>
            ))
          ) : (
            <span className="faint">没有相近的变量，去「⚙ 环境」里新建一个</span>
          )}
        </div>
      )}

      {/* 全部可用变量 */}
      {showAll && allVariables.length > 0 && (
        <div className="var-hints-line">
          <span className="faint">当前可用：</span>
          {allVariables.map((item) => (
            <span key={item.name} className="var-chip static" title={SCOPE_LABEL[item.scope ?? ''] ?? ''}>
              {item.name}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}
