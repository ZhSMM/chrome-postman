/**
 * 扩展图标弹窗（Popup）。
 *
 * 【Popup 的定位】
 * 它只是"启动器 + 环境速切"，不承担请求编辑（那样太挤）。
 * 想干活请点「打开工作台」。
 */
import React, { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import type { Environment } from '../shared/types';
import {
  getActiveEnvironmentId,
  getCollections,
  getEnvironments,
  getRequests,
  setActiveEnvironmentId,
} from '../core/storage';

function Popup() {
  const [environments, setEnvironments] = useState<Environment[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [stats, setStats] = useState({ collections: 0, requests: 0 });

  useEffect(() => {
    (async () => {
      const [envs, active, collections, requests] = await Promise.all([
        getEnvironments(),
        getActiveEnvironmentId(),
        getCollections(),
        getRequests(),
      ]);
      setEnvironments(envs);
      setActiveId(active);
      setStats({ collections: collections.length, requests: requests.length });
    })();
  }, []);

  const openDashboard = () => {
    chrome.tabs.create({ url: chrome.runtime.getURL('dashboard/index.html') });
    window.close();
  };

  return (
    <div>
      <div className="head">
        <span className="mark">CP</span>
        <strong>Chrome Postman</strong>
      </div>

      <div className="row">
        <label>当前环境</label>
        <select
          value={activeId ?? ''}
          onChange={async (e) => {
            const value = e.target.value || null;
            await setActiveEnvironmentId(value);
            setActiveId(value);
          }}
        >
          <option value="">无</option>
          {environments.map((env) => (
            <option key={env.id} value={env.id}>
              {env.name}
            </option>
          ))}
        </select>

        <button onClick={openDashboard}>打开工作台</button>
        <button className="ghost" onClick={openDashboard}>
          在新标签页打开
        </button>
      </div>

      <div className="stats">
        {stats.collections} 个集合 · {stats.requests} 个请求
        <br />
        快捷键：工作台里 Ctrl + Enter 发送请求
      </div>
    </div>
  );
}

const container = document.getElementById('root');
if (container) {
  createRoot(container).render(
    <React.StrictMode>
      <Popup />
    </React.StrictMode>,
  );
}
