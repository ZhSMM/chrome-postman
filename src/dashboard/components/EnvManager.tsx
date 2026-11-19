/**
 * 环境管理面板（模态框）。
 *
 * 【环境是什么】
 * 一组"名字 → 值"的映射，用来把易变的部分（域名、Token、账号）从请求里抽出来。
 * 例如：
 *   dev  环境：baseUrl = https://dev.api.com
 *   prod 环境：baseUrl = https://api.com
 * 请求里写 {{baseUrl}}/users，切换环境即可整体切换。
 *
 * 【变量优先级】（高 → 低）
 *   环境 > 集合 > 全局 > 会话
 */
import { useEffect, useState } from 'react';
import { useAppStore } from '../store';
import KeyValueTable from './KeyValueTable';
import { uid } from '../../shared/utils';

interface Props {
  onClose: () => void;
}

export default function EnvManager({ onClose }: Props) {
  const store = useAppStore();
  const [selectedId, setSelectedId] = useState<string | null>(store.activeEnvId ?? store.environments[0]?.id ?? null);

  useEffect(() => {
    if (!selectedId && store.environments.length) setSelectedId(store.environments[0].id);
  }, [store.environments, selectedId]);

  const selected = store.environments.find((item) => item.id === selectedId);

  /** 修改环境变量的值 */
  const patchVariables = (values: typeof store.environments[number]['values']) => {
    if (!selected) return;
    store.updateEnvironment(selected.id, { values });
  };

  return (
    <div className="modal-mask" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          环境管理
          <span className="spacer" />
          <button className="btn ghost sm" onClick={onClose}>
            ✕
          </button>
        </div>

        <div className="modal-body">
          <div className="env-list">
            {store.environments.map((env) => (
              <div
                key={env.id}
                className={`env-item ${env.id === selectedId ? 'active' : ''}`}
                onClick={() => setSelectedId(env.id)}
              >
                <input
                  type="radio"
                  checked={store.activeEnvId === env.id}
                  title="设为当前激活环境"
                  onClick={(e) => e.stopPropagation()}
                  onChange={() => store.setActiveEnvironment(env.id)}
                />
                <span style={{ flex: 1 }}>{env.name}</span>
                <span className="meta">
                  {env.values.filter((v) => v.enabled && v.key).length} 个变量
                </span>
                <button
                  className="btn ghost sm"
                  title="重命名"
                  onClick={(e) => {
                    e.stopPropagation();
                    const name = prompt('环境名称', env.name);
                    if (name) store.updateEnvironment(env.id, { name });
                  }}
                >
                  ✎
                </button>
                <button
                  className="btn ghost sm danger"
                  title="删除环境"
                  onClick={(e) => {
                    e.stopPropagation();
                    if (confirm(`删除环境「${env.name}」？`)) store.deleteEnvironment(env.id);
                  }}
                >
                  ✕
                </button>
              </div>
            ))}
            {!store.environments.length && (
              <div className="faint">还没有环境，点下面的按钮创建一个。</div>
            )}
          </div>

          <div style={{ display: 'flex', gap: 8, marginBottom: 12 }}>
            <button
              className="btn sm"
              onClick={() => {
                const name = prompt('环境名称', '新环境');
                if (!name) return;
                store.createEnvironment(name).then(() => {
                  const list = useAppStore.getState().environments;
                  if (list.length) setSelectedId(list[list.length - 1].id);
                });
              }}
            >
              + 新建环境
            </button>
            {selected && (
              <button
                className="btn sm"
                onClick={() => store.setActiveEnvironment(store.activeEnvId === selected.id ? null : selected.id)}
              >
                {store.activeEnvId === selected.id ? '取消激活' : '设为当前环境'}
              </button>
            )}
          </div>

          {selected && (
            <>
              <div className="muted" style={{ marginBottom: 8 }}>
                变量（值里可以写 {'{{变量名}}'} 引用其他变量）
              </div>
              <KeyValueTable
                value={selected.values}
                onChange={patchVariables}
                keyPlaceholder="变量名"
                valuePlaceholder="变量值"
                withDescription
                emptyHint="这个环境还没有变量"
              />
            </>
          )}

          <div className="divider" />

          <div className="muted" style={{ marginBottom: 8 }}>
            全局变量（所有环境共享，优先级低于环境变量）
          </div>
          <KeyValueTable
            value={Object.entries(store.globals).map(([key, value]) => ({
              id: `g_${key}`,
              key,
              value,
              enabled: true,
            }))}
            onChange={(rows) => {
              const next: Record<string, string> = {};
              rows.forEach((row) => {
                if (row.enabled && row.key) next[row.key] = row.value;
              });
              chrome.storage.local.set({ 'cp.globals': next });
              useAppStore.setState({ globals: next });
            }}
            keyPlaceholder="变量名"
            valuePlaceholder="变量值"
            emptyHint="还没有全局变量"
          />

          <div className="divider" />
          <details>
            <summary className="muted" style={{ cursor: 'pointer' }}>
              内置动态变量（无需定义，随取随用）
            </summary>
            <ul className="muted" style={{ fontSize: 12, lineHeight: 1.9 }}>
              <li>
                <span className="mono">{'{{$timestamp}}'}</span> —— 当前 Unix 时间戳（秒）
              </li>
              <li>
                <span className="mono">{'{{$isoTimestamp}}'}</span> —— 当前 ISO 时间字符串
              </li>
              <li>
                <span className="mono">{'{{$uuid}}'}</span> —— 随机 UUID v4
              </li>
              <li>
                <span className="mono">{'{{$randomInt}}'}</span> —— 0~1000 随机整数
              </li>
            </ul>
          </details>
        </div>

        <div className="modal-footer">
          <button className="btn primary" onClick={onClose}>
            完成
          </button>
        </div>
      </div>
    </div>
  );
}

/** 供外部复用的空变量行工厂 */
export function newVariableRow() {
  return { id: uid('kv'), key: '', value: '', enabled: true };
}
