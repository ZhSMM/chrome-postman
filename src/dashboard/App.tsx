/**
 * 应用主布局。
 *
 * ┌──────────────────────────────────────────────────────────┐
 * │ 顶栏：Logo │ 环境选择 │ 保存 │ 发送 │ 更多                 │
 * ├────────┬─────────────────────────────────────────────────┤
 * │ 侧边栏  │ 请求栏：Method | URL | 名称 | 发送              │
 * │ 集合/历史├─────────────────────────────────────────────────┤
 * │        │ 请求编辑器（Params/Headers/Body/Auth/脚本）       │
 * │        ├─────────────────────────────────────────────────┤
 * │        │ 响应面板（Body/Headers/断言/Console）             │
 * └────────┴─────────────────────────────────────────────────┘
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { useAppStore } from './store';
import Sidebar from './components/Sidebar';
import RequestEditor from './components/RequestEditor';
import ResponsePanel from './components/ResponsePanel';
import EnvManager from './components/EnvManager';
import VariableHints from './components/VariableHints';
import SmartInput from './components/SmartInput';
import SslSettings from './components/SslSettings';
import { useCompletionSources } from './useCompletionSources';
import type { HttpMethod, VariableScope } from '../shared/types';
import { toCurl, toHar } from '../core/codelib';
import { keyValuesToRecord } from '../core/storage';

const METHODS: HttpMethod[] = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'];

export default function App() {
  const store = useAppStore();
  const [showEnv, setShowEnv] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  /* 启动时加载持久化数据 */
  useEffect(() => {
    store.bootstrap();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /* 主题跟随设置 */
  useEffect(() => {
    const theme =
      store.settings.theme === 'system'
        ? window.matchMedia('(prefers-color-scheme: light)').matches
          ? 'light'
          : 'dark'
        : store.settings.theme;
    document.documentElement.dataset.theme = theme;
  }, [store.settings.theme]);

  /* Ctrl+Enter 发送请求 */
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
        e.preventDefault();
        store.send();
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /* 点击别处关闭"更多"菜单 */
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setMenuOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  /** 当前可用于变量替换的作用域（给 cURL / HAR 用） */
  const scope: VariableScope = useMemo(() => {
    const env = store.environments.find((item) => item.id === store.activeEnvId);
    const collection = store.collections.find((item) => item.id === store.currentRequest.collectionId);
    return {
      environment: env ? keyValuesToRecord(env.values) : {},
      collection: collection ? keyValuesToRecord(collection.variables) : {},
      globals: store.globals,
      session: {},
    };
  }, [store.environments, store.activeEnvId, store.collections, store.currentRequest.collectionId, store.globals]);

  const copyCurl = async () => {
    const curl = toCurl(store.currentRequest, scope);
    try {
      await navigator.clipboard.writeText(curl);
      store.pushToast('cURL 已复制到剪贴板', 'success');
    } catch {
      store.pushToast(curl, 'info');
    }
    setMenuOpen(false);
  };

  const exportHar = () => {
    const har = toHar([{ request: store.currentRequest, response: store.response }], scope);
    const blob = new Blob([JSON.stringify(har, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'chrome-postman.har';
    a.click();
    URL.revokeObjectURL(url);
    setMenuOpen(false);
    store.pushToast('HAR 已导出', 'success');
  };

  const activeEnv = store.environments.find((item) => item.id === store.activeEnvId);

  /** 补全候选源（变量、内置变量、pm API、常用请求头、历史 URL） */
  const sources = useCompletionSources();

  return (
    <div className="app">
      {/* ---------------- 顶栏 ---------------- */}
      <header className="app-header">
        <div className="logo">
          <span className="logo-mark">CP</span>
          <span>Chrome Postman</span>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <span className="muted">环境</span>
          <select
            className="select"
            value={store.activeEnvId ?? ''}
            onChange={(e) => store.setActiveEnvironment(e.target.value || null)}
          >
            <option value="">无</option>
            {store.environments.map((env) => (
              <option key={env.id} value={env.id}>
                {env.name}
              </option>
            ))}
          </select>
          <button className="btn ghost sm" onClick={() => setShowEnv(true)} title="管理环境">
            ⚙
          </button>
          {activeEnv && (
            <span className="faint" style={{ fontSize: 11 }}>
              {activeEnv.values.filter((v) => v.enabled && v.key).length} 变量
            </span>
          )}
        </div>

        <span className="spacer" />

        <button className="btn" onClick={() => store.saveCurrentRequest()} title="保存到集合 (Ctrl+S)">
          保存
        </button>
        <button
          className="btn primary"
          onClick={() => store.send()}
          disabled={store.sending}
          title="发送请求 (Ctrl+Enter)"
        >
          {store.sending ? '发送中…' : '发送'}
        </button>

        <div ref={menuRef} style={{ position: 'relative' }}>
          <button className="btn ghost" onClick={() => setMenuOpen((v) => !v)}>
            ⋯
          </button>
          {menuOpen && (
            <div
              style={{
                position: 'absolute',
                right: 0,
                top: 34,
                background: 'var(--bg-elevated)',
                border: '1px solid var(--border)',
                borderRadius: 6,
                minWidth: 180,
                padding: 4,
                zIndex: 50,
                boxShadow: '0 10px 30px rgba(0,0,0,.4)',
              }}
            >
              <button className="btn ghost sm" style={{ width: '100%', justifyContent: 'flex-start' }} onClick={copyCurl}>
                复制为 cURL
              </button>
              <button className="btn ghost sm" style={{ width: '100%', justifyContent: 'flex-start' }} onClick={exportHar}>
                导出 HAR
              </button>
              <button
                className="btn ghost sm"
                style={{ width: '100%', justifyContent: 'flex-start' }}
                onClick={() => {
                  setShowSettings(true);
                  setMenuOpen(false);
                }}
              >
                设置
              </button>
              <button
                className="btn ghost sm"
                style={{ width: '100%', justifyContent: 'flex-start' }}
                onClick={() => {
                  store.exportAll();
                  setMenuOpen(false);
                }}
              >
                导出工作区
              </button>
            </div>
          )}
        </div>
      </header>

      {/* ---------------- 主体 ---------------- */}
      <div className="app-body">
        <aside className="app-sidebar">
          <Sidebar />
        </aside>

        <main className="app-main">
          <div className="request-bar">
            <select
              className="select method-select"
              value={store.currentRequest.method}
              onChange={(e) =>
                store.patchCurrentRequest({ method: e.target.value as HttpMethod })
              }
            >
              {METHODS.map((method) => (
                <option key={method} value={method}>
                  {method}
                </option>
              ))}
            </select>

            <div className="url-field">
              <SmartInput
                className="url-input"
                placeholder="输入请求地址，支持 {{变量}}"
                value={store.currentRequest.url}
                onChange={(v) => store.patchCurrentRequest({ url: v })}
                onEnter={() => store.send()}
                enterSends
                sources={sources}
              />
              {/*
                变量缺失提示。
                放在 URL 框正下方，用户一眼就能看到"哪个变量没定义"，
                不用等发送失败才发现。
              */}
              <VariableHints
                text={store.currentRequest.url}
                scope={scope}
                onApply={(name, value) => {
                  // 把 URL 里的 {{name}} 全部替换成候选变量的实际值
                  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
                  const next = store.currentRequest.url.replace(
                    new RegExp(`\\{\\{\\s*${escaped}\\s*\\}\\}`, 'g'),
                    value,
                  );
                  store.patchCurrentRequest({ url: next });
                  store.pushToast(`已把 {{${name}}} 替换为「${value}」`, 'success');
                }}
              />
            </div>

            <input
              style={{ width: 160 }}
              placeholder="请求名称"
              value={store.currentRequest.name}
              onChange={(e) => store.patchCurrentRequest({ name: e.target.value })}
            />
          </div>

          <RequestEditor />
          <ResponsePanel
            response={store.response}
            outcome={store.outcome}
            diagnostic={store.diagnostic}
            timing={store.timing}
            insecure={store.insecure}
            sslNotice={store.sslNotice}
            onFocusScriptError={store.focusScriptError}
          />
        </main>
      </div>

      {/* ---------------- 弹窗与提示 ---------------- */}
      {showEnv && <EnvManager onClose={() => setShowEnv(false)} />}
      {showSettings && <SettingsModal onClose={() => setShowSettings(false)} />}

      {store.toasts.map((toast) => (
        <div
          key={toast.id}
          className={`toast ${toast.kind}`}
          onClick={() => store.dismissToast(toast.id)}
        >
          {toast.message}
        </div>
      ))}
    </div>
  );
}

/** 设置弹窗 */
function SettingsModal({ onClose }: { onClose: () => void }) {
  const store = useAppStore();
  const settings = store.settings;

  /** 是否已授予 webRequest 可选权限（网络诊断能力） */
  const [diagGranted, setDiagGranted] = useState<boolean | null>(null);

  useEffect(() => {
    chrome.permissions
      .contains({ permissions: ['webRequest'] })
      .then(setDiagGranted)
      .catch(() => setDiagGranted(false));
  }, []);

  /** 开启网络诊断：必须由用户手势触发 */
  const enableDiagnostics = async () => {
    try {
      const granted = await chrome.permissions.request({ permissions: ['webRequest'] });
      setDiagGranted(granted);
      store.pushToast(
        granted ? '网络诊断已开启' : '未获得权限，诊断功能保持关闭',
        granted ? 'success' : 'error',
      );
    } catch (err) {
      store.pushToast(`申请权限失败：${(err as Error).message}`, 'error');
    }
  };

  const disableDiagnostics = async () => {
    try {
      await chrome.permissions.remove({ permissions: ['webRequest'] });
      setDiagGranted(false);
      store.pushToast('网络诊断已关闭', 'success');
    } catch (err) {
      store.pushToast(`关闭失败：${(err as Error).message}`, 'error');
    }
  };

  return (
    <div className="modal-mask" onClick={onClose}>
      <div className="modal" style={{ width: 'min(560px, 92vw)' }} onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          设置
          <span className="spacer" />
          <button className="btn ghost sm" onClick={onClose}>
            ✕
          </button>
        </div>
        <div className="modal-body" style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          <label style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={{ width: 90 }}>主题</span>
            <select
              className="select"
              value={settings.theme}
              onChange={(e) => store.updateSettings({ theme: e.target.value as 'light' | 'dark' | 'system' })}
            >
              <option value="system">跟随系统</option>
              <option value="dark">深色</option>
              <option value="light">浅色</option>
            </select>
          </label>

          <label style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={{ width: 90 }}>超时(ms)</span>
            <input
              type="number"
              min={1000}
              step={1000}
              value={settings.timeout}
              onChange={(e) => store.updateSettings({ timeout: Number(e.target.value) || 30000 })}
            />
          </label>

          <label style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={{ width: 90 }}>历史条数</span>
            <input
              type="number"
              min={10}
              step={10}
              value={settings.historyLimit}
              onChange={(e) => store.updateSettings({ historyLimit: Number(e.target.value) || 200 })}
            />
          </label>

          <label style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <input
              type="checkbox"
              checked={settings.followRedirects}
              onChange={(e) => store.updateSettings({ followRedirects: e.target.checked })}
            />
            <span>自动跟随重定向</span>
          </label>

          <label style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <input
              type="checkbox"
              checked={settings.sendCookies}
              onChange={(e) => store.updateSettings({ sendCookies: e.target.checked })}
            />
            <span>携带 Cookie</span>
          </label>

          <div className="divider" />

          {/* ---------- 网络诊断 ---------- */}
          <div className="perm-card">
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <span className="title">网络诊断</span>
              <span className={`perm-state ${diagGranted ? 'on' : ''}`}>
                {diagGranted === null ? '检测中…' : diagGranted ? '已开启' : '未开启'}
              </span>
            </div>
            <div className="desc">
              开启后，工具会读取 Chrome 网络层的真实错误码（例如
              <span className="mono">net::ERR_PROXY_CONNECTION_FAILED</span>），
              从而判断请求是卡在代理、证书、DNS 还是目标服务器，
              并给出对应的解决步骤。
              <br />
              该能力需要「webRequest」权限，属于<b>可选权限</b> —— 只有你点下面的按钮才会授予，
              默认不授予。
            </div>
            <div style={{ display: 'flex', gap: 8 }}>
              {diagGranted ? (
                <button className="btn sm" onClick={disableDiagnostics}>
                  关闭网络诊断
                </button>
              ) : (
                <button className="btn sm primary" onClick={enableDiagnostics}>
                  开启网络诊断
                </button>
              )}
            </div>
          </div>

          <label style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={{ width: 90 }}>代理地址</span>
            <input
              className="mono"
              style={{ flex: 1 }}
              placeholder="可选，如 http://127.0.0.1:7890"
              value={settings.proxyHint ?? ''}
              onChange={(e) => store.updateSettings({ proxyHint: e.target.value })}
            />
          </label>
          <div className="faint" style={{ fontSize: 11.5, lineHeight: 1.7 }}>
            填写后，代理相关的报错会额外提醒你检查这个代理地址。
            工具本身<b>不会修改</b>你的代理设置。
          </div>

          {/* ---------- 证书与 SSL ---------- */}
          <SslSettings />

          <div className="divider" />
          <div className="faint" style={{ fontSize: 12, lineHeight: 1.8 }}>
            快捷键：<span className="kbd">Ctrl</span> + <span className="kbd">Enter</span> 发送请求
            <br />
            变量写法：<span className="mono">{'{{变量名}}'}</span>
          </div>
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
