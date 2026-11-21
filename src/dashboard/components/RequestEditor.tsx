/**
 * 请求编辑器：URL 栏下方的六个标签页。
 *
 *   Params / Headers / Body / Auth / 前置脚本 / 后置脚本
 *
 * 【脚本标签页是本扩展的"拦截"能力入口】
 *   前置脚本 —— 请求发出**之前**执行，可改写 URL / 头 / 体 / 方法
 *   后置脚本 —— 响应回来**之后**执行，可读响应、写断言、提取变量
 */
import { useEffect, useState } from 'react';
import { useAppStore } from '../store';
import { useCompletionSources } from '../useCompletionSources';
import KeyValueTable from './KeyValueTable';
import BodyEditor from './BodyEditor';
import ScriptEditor from './ScriptEditor';
import type { AuthType } from '../../shared/types';

type TabKey = 'params' | 'headers' | 'body' | 'auth' | 'pre' | 'post';

const TABS: { key: TabKey; label: string }[] = [
  { key: 'params', label: 'Params' },
  { key: 'headers', label: 'Headers' },
  { key: 'body', label: 'Body' },
  { key: 'auth', label: 'Auth' },
  { key: 'pre', label: '前置脚本' },
  { key: 'post', label: '后置脚本' },
];

const AUTH_TYPES: { value: AuthType; label: string }[] = [
  { value: 'none', label: '无' },
  { value: 'basic', label: 'Basic Auth' },
  { value: 'bearer', label: 'Bearer Token' },
  { value: 'apikey', label: 'API Key' },
  { value: 'oauth2', label: 'OAuth 2.0' },
  { value: 'digest', label: 'Digest' },
];

export default function RequestEditor() {
  const store = useAppStore();
  const [tab, setTab] = useState<TabKey>('params');
  const request = store.currentRequest;

  /** 补全候选源（Params / Headers / Body / 脚本都靠它） */
  const sources = useCompletionSources();

  const auth = request.auth ?? { type: 'none' as AuthType };

  /** 最近一次脚本错误（结构化，带行列号） */
  const scriptError = store.outcome?.error;
  /** 错误跳转请求 */
  const focus = store.scriptFocus;

  /**
   * 收到跳转请求时，自动切到对应的脚本标签页。
   * 否则用户点了 Console 里的"第 3 行"，但当前停在 Params 页，
   * 什么都不会发生 —— 那就等于没做这个功能。
   */
  useEffect(() => {
    if (!focus) return;
    if (focus.phase === 'pre') setTab('pre');
    else setTab('post');
    // 只在 token 变化时触发
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focus?.token]);

  return (
    <div className="editor-area">
      <div className="tabs">
        {TABS.map((item) => (
          <button
            key={item.key}
            className={`tab ${tab === item.key ? 'active' : ''}`}
            onClick={() => setTab(item.key)}
          >
            {item.label}
            {item.key === 'params' && !!request.params.length && (
              <span className="tab-badge">{request.params.length}</span>
            )}
            {item.key === 'headers' && !!request.headers.length && (
              <span className="tab-badge">{request.headers.length}</span>
            )}
            {item.key === 'pre' && request.preScript?.trim() && <span className="tab-badge">JS</span>}
            {item.key === 'post' && request.postScript?.trim() && <span className="tab-badge">JS</span>}
          </button>
        ))}
      </div>

      {tab === 'params' && (
        <div className="panel">
          <KeyValueTable
            value={request.params ?? []}
            onChange={(params) => store.patchCurrentRequest({ params })}
            keyPlaceholder="参数名"
            valuePlaceholder="参数值"
            emptyHint="还没有 query 参数"
            sources={sources}
          />
        </div>
      )}

      {tab === 'headers' && (
        <div className="panel">
          <KeyValueTable
            value={request.headers ?? []}
            onChange={(headers) => store.patchCurrentRequest({ headers })}
            keyPlaceholder="Header 名"
            valuePlaceholder="Header 值"
            emptyHint="还没有自定义请求头"
            sources={sources}
          />
        </div>
      )}

      {tab === 'body' && (
        <BodyEditor
          value={request.body}
          onChange={(body) => store.patchCurrentRequest({ body })}
          sources={sources}
        />
      )}

      {tab === 'auth' && (
        <div className="panel" style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <span className="muted">类型</span>
            <select
              className="select"
              value={auth.type}
              onChange={(e) =>
                store.patchCurrentRequest({ auth: { ...auth, type: e.target.value as AuthType } })
              }
            >
              {AUTH_TYPES.map((item) => (
                <option key={item.value} value={item.value}>
                  {item.label}
                </option>
              ))}
            </select>
          </div>

          {auth.type === 'basic' && (
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              <input
                placeholder="用户名"
                value={auth.username ?? ''}
                onChange={(e) => store.patchCurrentRequest({ auth: { ...auth, username: e.target.value } })}
              />
              <input
                placeholder="密码"
                type="password"
                value={auth.password ?? ''}
                onChange={(e) => store.patchCurrentRequest({ auth: { ...auth, password: e.target.value } })}
              />
            </div>
          )}

          {auth.type === 'bearer' && (
            <input
              className="mono"
              placeholder="Token"
              value={auth.token ?? ''}
              onChange={(e) => store.patchCurrentRequest({ auth: { ...auth, token: e.target.value } })}
            />
          )}

          {auth.type === 'oauth2' && (
            <input
              className="mono"
              placeholder="Access Token"
              value={auth.oauthToken ?? ''}
              onChange={(e) => store.patchCurrentRequest({ auth: { ...auth, oauthToken: e.target.value } })}
            />
          )}

          {auth.type === 'apikey' && (
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              <input
                placeholder="Key 名"
                value={auth.apiKey ?? ''}
                onChange={(e) => store.patchCurrentRequest({ auth: { ...auth, apiKey: e.target.value } })}
              />
              <input
                className="mono"
                placeholder="Key 值"
                value={auth.apiValue ?? ''}
                onChange={(e) => store.patchCurrentRequest({ auth: { ...auth, apiValue: e.target.value } })}
              />
              <select
                className="select"
                value={auth.apiKeyIn ?? 'header'}
                onChange={(e) =>
                  store.patchCurrentRequest({ auth: { ...auth, apiKeyIn: e.target.value as 'header' | 'query' } })
                }
              >
                <option value="header">放在 Header</option>
                <option value="query">放在 Query</option>
              </select>
            </div>
          )}

          {auth.type === 'digest' && (
            <div className="muted">
              Digest 鉴权需要与服务端做一次 challenge 往返，本工具暂未实现。
              <br />
              你可以改用 Bearer Token，或在「前置脚本」里手动设置 Authorization 头。
            </div>
          )}

          {auth.type === 'none' && <div className="faint">当前请求不带鉴权信息。</div>}
        </div>
      )}

      {tab === 'pre' && (
        <div className="panel" style={{ padding: 0 }}>
          <ScriptEditor
            value={request.preScript ?? ''}
            onChange={(preScript) => store.patchCurrentRequest({ preScript })}
            error={scriptError?.location?.phase === 'pre' ? scriptError : undefined}
            focus={focus?.phase === 'pre' ? { line: focus.line, token: focus.token } : null}
            sources={sources}
          />
          <div className="muted" style={{ padding: '8px 12px', fontSize: 12 }}>
            请求发出<b>之前</b>执行。可用：<span className="mono">pm.request.headers.upsert()</span>、
            <span className="mono">pm.request.url.raw</span>、
            <span className="mono">pm.environment.set()</span>
          </div>
        </div>
      )}

      {tab === 'post' && (
        <div className="panel" style={{ padding: 0 }}>
          <ScriptEditor
            value={request.postScript ?? ''}
            onChange={(postScript) => store.patchCurrentRequest({ postScript })}
            error={scriptError?.location?.phase === 'post' ? scriptError : undefined}
            focus={focus?.phase === 'post' ? { line: focus.line, token: focus.token } : null}
            sources={sources}
          />
          <div className="muted" style={{ padding: '8px 12px', fontSize: 12 }}>
            响应返回<b>之后</b>执行。可用：<span className="mono">pm.response.json()</span>、
            <span className="mono">pm.test()</span>、
            <span className="mono">pm.environment.set()</span>
          </div>
        </div>
      )}
    </div>
  );
}
