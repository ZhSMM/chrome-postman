/**
 * 可编辑的键值表（Headers / Query Params / 环境变量 共用）。
 *
 * 【设计要点】
 * - 每行有"启用"开关（Postman 里的眼睛图标），关闭的行不参与请求
 * - 增删改全部走 onChange 上抛，组件本身不持有状态（受控组件）
 * - 传入 sources 就启用智能补全，不传就是普通输入框
 */
import { useMemo } from 'react';
import type { KeyValue } from '../../shared/types';
import { uid } from '../../shared/utils';
import SmartInput from './SmartInput';
import type { CompletionSources } from '../../core/completion';

interface Props {
  value: KeyValue[];
  onChange: (next: KeyValue[]) => void;
  keyPlaceholder?: string;
  valuePlaceholder?: string;
  /** 是否把 value 显示成圆点（密钥类变量） */
  secret?: boolean;
  /** 额外的列：描述 */
  withDescription?: boolean;
  emptyHint?: string;
  /**
   * 补全候选源。
   * 传了就启用智能补全（Headers / Query 参数用）；
   * 不传就是普通输入框（环境变量表用，那里的变量名就是它自己）。
   */
  sources?: CompletionSources;
}

export default function KeyValueTable({
  value,
  onChange,
  keyPlaceholder = '键',
  valuePlaceholder = '值',
  secret = false,
  withDescription = false,
  emptyHint,
  sources,
}: Props) {
  const rows = value ?? [];

  const update = (index: number, patch: Partial<KeyValue>) => {
    const next = rows.map((row, i) => (i === index ? { ...row, ...patch } : row));
    onChange(next);
  };

  const remove = (index: number) => {
    onChange(rows.filter((_, i) => i !== index));
  };

  const add = () => {
    onChange([...rows, { id: uid('kv'), key: '', value: '', enabled: true }]);
  };

  const columnCount = useMemo(() => (withDescription ? 5 : 4), [withDescription]);

  return (
    <div>
      <table className="kv-table">
        <thead>
          <tr>
            <th style={{ width: 28 }} />
            <th style={{ width: '32%' }}>{keyPlaceholder}</th>
            <th>{valuePlaceholder}</th>
            {withDescription && <th style={{ width: '22%' }}>描述</th>}
            <th style={{ width: 32 }} />
          </tr>
        </thead>
        <tbody>
          {rows.map((row, index) => (
            <tr key={row.id} className={row.enabled ? '' : 'row-disabled'}>
              <td>
                <button
                  className="eye"
                  title={row.enabled ? '点击禁用这一行' : '点击启用这一行'}
                  onClick={() => update(index, { enabled: !row.enabled })}
                >
                  {row.enabled ? '👁' : '🚫'}
                </button>
              </td>
              <td>
                {sources ? (
                  <SmartInput
                    className="key"
                    value={row.key}
                    placeholder={keyPlaceholder}
                    onChange={(v) => update(index, { key: v })}
                    sources={sources}
                  />
                ) : (
                  <input
                    className="key"
                    value={row.key}
                    placeholder={keyPlaceholder}
                    onChange={(e) => update(index, { key: e.target.value })}
                  />
                )}
              </td>
              <td>
                {sources ? (
                  <SmartInput
                    className="mono"
                    value={row.value}
                    type={secret ? 'password' : 'text'}
                    placeholder={valuePlaceholder}
                    onChange={(v) => update(index, { value: v })}
                    sources={sources}
                  />
                ) : (
                  <input
                    className="mono"
                    value={row.value}
                    type={secret ? 'password' : 'text'}
                    placeholder={valuePlaceholder}
                    onChange={(e) => update(index, { value: e.target.value })}
                  />
                )}
              </td>
              {withDescription && (
                <td>
                  <input
                    value={row.description ?? ''}
                    placeholder="可选"
                    onChange={(e) => update(index, { description: e.target.value })}
                  />
                </td>
              )}
              <td>
                <button className="btn ghost sm danger" title="删除这一行" onClick={() => remove(index)}>
                  ✕
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      {!rows.length && emptyHint && <div className="faint" style={{ padding: '10px 4px' }}>{emptyHint}</div>}

      <div style={{ marginTop: 8, display: 'flex', gap: 8 }}>
        <button className="btn sm" onClick={add}>
          + 添加一行
        </button>
        <span className="faint" style={{ alignSelf: 'center' }}>
          共 {rows.length} 行
        </span>
      </div>
      {/* 列数占位，避免最后一行按钮换行错位 */}
      <span style={{ display: 'none' }}>{columnCount}</span>
    </div>
  );
}
