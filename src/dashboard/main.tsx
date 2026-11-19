/**
 * Dashboard 入口。
 *
 * 【初学者先看这里】
 * React 应用从这里"挂载"到 HTML 里的 <div id="root"> 上。
 * React 18 用 createRoot，这是官方推荐的新写法（ReactDOM.render 已废弃）。
 */
import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import './styles.css';

const container = document.getElementById('root');
if (!container) throw new Error('找不到 #root 容器');

createRoot(container).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
