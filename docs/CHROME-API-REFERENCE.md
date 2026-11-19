# Chrome 扩展 API 详解（教学向）

> 面向"第一次写 Chrome 扩展"的同学。每个 API 都给出：**它解决什么问题 → 参数表 → 可运行示例 → 踩坑限制**。
> 本文档只讲本项目真正用到的 API，以及理解本项目必须知道的平台约束。

---

## 目录

1. [先理解扩展的运行环境](#1-先理解扩展的运行环境)
2. [manifest.json 字段详解](#2-manifestjson-字段详解)
3. [chrome.storage —— 持久化](#3-chromestorage--持久化)
4. [chrome.runtime —— 跨上下文通信](#4-chromeruntime--跨上下文通信)
5. [chrome.contextMenus —— 右键菜单](#5-chromecontextmenus--右键菜单)
6. [chrome.tabs / chrome.action —— 标签页与图标](#6-chrometabs--chromeaction--标签页与图标)
7. [Manifest V3 的 CSP 与 WebAssembly](#7-manifest-v3-的-csp-与-webassembly)
8. [fetch 与 CORS：扩展为什么能跨域](#8-fetch-与-cors扩展为什么能跨域)
9. [IndexedDB 在 Service Worker 里的使用](#9-indexeddb-在-service-worker-里的使用)
10. [自动化加载扩展：Chrome 137+ 的变化](#10-自动化加载扩展chrome-137-的变化)
11. [踩坑清单](#11-踩坑清单)

---

## 1. 先理解扩展的运行环境

### 1.1 一个扩展 = 多个互不信任的 JS 环境

```
chrome-extension://<扩展ID>/
├── dashboard/index.html   ← 扩展页面（有自己的 window / document）
├── popup/index.html       ← 扩展页面（另一个 window）
└── background.js          ← Service Worker（没有 window，没有 document）
```

这三个环境**不共享全局变量**（不能互相访问 `window.foo`），但可以共享：

- `chrome.storage`（持久化数据）
- `chrome.runtime.sendMessage`（发消息）
- 同一个扩展的 origin（所以 `chrome-extension://<id>/xxx` 互相可以 iframe 引用）

**为什么这件事很重要**：如果你在 Service Worker 里写 `document.getElementById(...)`，会直接报错——SW 里根本没有 DOM。这也是为什么本项目把「界面」和「发请求」拆到两个环境：界面要 DOM，发请求要长生命周期。

### 1.2 Service Worker 的生命周期（MV3 最重要的一条规则）

```
事件发生 → SW 被唤醒 → 执行事件处理函数 → 空闲约 30 秒 → 被 Chrome 休眠（内存清空）
                                    ↑
                        下次有事件时重新唤醒（重新执行顶层代码）
```

**推论（新手最容易踩）**：

| 推论 | 正确做法 |
|---|---|
| SW 里定义的变量会丢 | 需要持久化的写 `chrome.storage` |
| SW 不能假设自己一直在跑 | 每次事件处理都要能"从零恢复状态" |
| SW 里的定时器不可靠 | 需要定时任务用 `chrome.alarms` |
| 顶层代码会被反复执行 | 顶层只做初始化（注册监听器），不要做重活 |

本项目里 SW 顶层的 `const sessionVariables = {}` 就是"会丢"的数据，所以会话变量的语义被明确标注为"临时"（§8 设计文档）。

---

## 2. manifest.json 字段详解

本项目的 manifest：

```json
{
  "manifest_version": 3,
  "name": "Chrome Postman",
  "version": "1.0.0",
  "permissions": ["storage", "unlimitedStorage", "contextMenus"],
  "host_permissions": ["<all_urls>"],
  "background": { "service_worker": "background.js", "type": "module" },
  "action": { "default_popup": "popup/index.html", "default_icon": {...} },
  "icons": { "16": "icons/icon16.png", "32": "...", "48": "...", "128": "..." },
  "options_ui": { "page": "dashboard/index.html", "open_in_tab": true },
  "content_security_policy": {
    "extension_pages": "script-src 'self' 'wasm-unsafe-eval'; object-src 'self'"
  }
}
```

### 字段参数表

| 字段 | 类型 | 必填 | 说明 | 本项目取值理由 |
|---|---|---|---|---|
| `manifest_version` | number | ✅ | 固定 3 | MV3 才能上架新扩展 |
| `name` | string | ✅ | 显示在扩展列表/商店 | — |
| `version` | string | ✅ | `主.次.修订`，纯数字 | 打包脚本按它命名 zip |
| `description` | string | ❌ | 商店页描述 | — |
| `permissions` | string[] | ❌ | API 权限清单 | storage / unlimitedStorage / contextMenus |
| `host_permissions` | string[] | ❌ | 域名访问权限 | `<all_urls>` 才能跨域调 API |
| `background` | object | ❌ | 后台脚本配置 | MV3 只能用 `service_worker` |
| `background.service_worker` | string | — | SW 文件路径（相对扩展根） | `background.js` |
| `background.type` | `"module"`\|`"classic"` | — | 是否支持 ES Module | `"module"` 才能写 import |
| `action` | object | ❌ | 工具栏图标 | 配置了 `default_popup` |
| `icons` | object | ❌ | 各尺寸图标 | 16/32/48/128 |
| `options_ui.page` | string | ❌ | 设置页 | 复用 dashboard |
| `options_ui.open_in_tab` | bool | ❌ | 设置页是否独立标签打开 | `true` |
| `content_security_policy.extension_pages` | string | ❌ | 扩展页面 CSP | 需含 `'wasm-unsafe-eval'` |

### 关键限制

- **`host_permissions` 与 `permissions` 是两回事**。`permissions` 管 API（storage/tabs/…），`host_permissions` 管域名访问。少了 `host_permissions`，扩展页面发 `fetch` 会被 CORS 拦死。
- **`background.page` 在 MV3 里已被移除**，只有 `service_worker`。
- **改了 manifest 必须重新加载扩展**（chrome://extensions 里点刷新按钮），否则不生效。

---

## 3. chrome.storage —— 持久化

### 3.1 三种存储区

| 区域 | 生命周期 | 配额 | 适合 |
|---|---|---|---|
| `chrome.storage.local` | 永久（除非用户清理） | 10MB（`unlimitedStorage` 解除） | 集合、环境、设置 |
| `chrome.storage.sync` | 永久 + 云端同步 | 100KB / 项，8KB / 键 | 小配置、需要跨设备 |
| `chrome.storage.session` | 浏览器会话结束即失 | 10MB | 临时状态 |

### 3.2 API 参数表

#### `chrome.storage.local.get(keys)`

| 参数 | 类型 | 说明 |
|---|---|---|
| `keys` | `string \| string[] \| object \| null` | `null` 表示取全部；传对象表示"取这些键并填默认值" |

```js
// 取全部
const all = await chrome.storage.local.get(null);

// 取指定键
const { 'cp.settings': settings } = await chrome.storage.local.get('cp.settings');

// 带默认值
const { 'cp.globals': globals = {} } = await chrome.storage.local.get({ 'cp.globals': {} });
```

#### `chrome.storage.local.set(items)`

```js
await chrome.storage.local.set({ 'cp.globals': { token: 'abc' } });
```

#### `chrome.storage.local.remove(keys)` / `.clear()`

```js
await chrome.storage.local.remove('cp.pendingUrl');
await chrome.storage.local.clear();   // 清空全部 —— 生产代码慎用
```

#### `chrome.storage.onChanged`

```js
chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName === 'local' && changes['cp.environments']) {
    console.log('环境变了', changes['cp.environments'].newValue);
  }
});
```

### 3.3 踩坑限制

| 坑 | 说明 | 本项目做法 |
|---|---|---|
| **整值覆盖** | `set` 是"这个键整体替换"，不是合并 | 改环境前先 `get` 再合并再 `set`（`storage.ts` 里的 `keyValuesToRecord` + `recordToKeyValues`） |
| **不能存函数/类实例** | 只能存 JSON 可序列化的值 | 全部用纯对象/数组 |
| **写入有延迟** | 默认惰性落盘，进程被杀可能丢最后一次写入 | 关键数据写完立刻用；需要"关闭浏览器也不丢"可加 `setAccessLevel({accessLevel:'TRUSTED_CONTEXTS'})` |
| **存储不可用会静默失败** | 隐私模式/配额满 | 封装层统一 try/catch 并打日志（`readStore`/`writeStore`） |
| **Service Worker 里没有 localStorage** | `window.localStorage` 不存在 | 只能用 `chrome.storage` |

---

## 4. chrome.runtime —— 跨上下文通信

### 4.1 `chrome.runtime.sendMessage(message, callback?)`

| 参数 | 类型 | 说明 |
|---|---|---|
| `message` | any | 要发送的消息，**必须是 JSON 可序列化** |
| `callback` | function | 旧式回调；MV3 支持返回 Promise |

```js
// 扩展页面 → Service Worker
const res = await chrome.runtime.sendMessage({
  type: 'EXECUTE_REQUEST',
  payload: { request, requestId: 'run_1' },
});
// res = { type: 'EXECUTE_RESULT', payload: { requestId, result } }
```

**要点**：`sendMessage` 会广播到**所有**扩展上下文（其他页面、SW）。所以：

- 消息必须带 `type` 字段做路由；
- 接收方如果不需要处理，要返回 `false`（表示"不异步回复"），否则 Chrome 会警告 "The message port closed before a response was received"。

### 4.2 `chrome.runtime.onMessage.addListener(callback)`

| 参数 | 类型 | 说明 |
|---|---|---|
| `callback` | `(message, sender, sendResponse) => boolean \| void` | `message` 收到的消息；`sender` 发送方信息；`sendResponse` 回复函数 |

**返回 `true` 表示"稍后异步回复"** —— 这是新手最常漏的一行。

```js
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'EXECUTE_REQUEST') {
    doWork(message.payload)
      .then((result) => sendResponse({ type: 'EXECUTE_RESULT', payload: result }))
      .catch((err) => sendResponse({ type: 'ERROR', payload: { message: err.message } }));
    return true;          // ← 必须！否则异步回复发不出去
  }
  return false;            // 其他消息不处理
});
```

### 4.3 其他常用成员

| API | 说明 | 示例 |
|---|---|---|
| `chrome.runtime.getURL(path)` | 把相对路径转成扩展内绝对 URL | `chrome.runtime.getURL('dashboard/index.html')` |
| `chrome.runtime.getManifest()` | 读自己的 manifest | `getManifest().version` |
| `chrome.runtime.onInstalled.addListener(fn)` | 首次安装 / 更新时触发 | 建右键菜单放这里 |
| `chrome.runtime.onStartup` | 浏览器启动时触发 | — |
| `chrome.runtime.lastError` | 异步 API 的错误（**必须检查，否则被吞掉**） | `if (chrome.runtime.lastError) {...}` |
| `chrome.runtime.openOptionsPage()` | 打开设置页 | — |

### 4.4 踩坑限制

- **消息不能传函数 / DOM 节点 / 类实例**。要传复杂数据，先转成纯对象。
- **SW 被休眠后，消息会把它唤醒**，但唤醒需要几百毫秒（尤其本项目要加载 WASM）。首屏第一次发送可能慢一点。
- **`sendMessage` 找不到接收方会 reject**（"Could not establish connection"），要 try/catch。本项目的 `api.ts` 里有兜底提示。

---

## 5. chrome.contextMenus —— 右键菜单

### 5.1 `chrome.contextMenus.create(properties, callback?)`

| 属性 | 类型 | 说明 |
|---|---|---|
| `id` | string | 菜单项唯一 id |
| `title` | string | 显示文字 |
| `contexts` | string[] | 出现场景：`page` `link` `selection` `image` `video` `audio` `editable` `frame` `all` |
| `parentId` | string | 父菜单 id（本项目用平铺菜单） |
| `type` | string | `"normal"` `"separator"` `"checkbox"` `"radio"` |
| `documentUrlPatterns` | string[] | 只在匹配 URL 的页面显示 |
| `enabled` | bool | 是否可用 |

```js
chrome.contextMenus.create({
  id: 'cp-open-dashboard',
  title: 'Chrome Postman：在此 URL 上发起请求',
  contexts: ['page', 'link', 'selection'],
});
```

### 5.2 `chrome.contextMenus.onClicked.addListener(info, tab)`

| 参数 | 说明 |
|---|---|
| `info.menuItemId` | 被点击的菜单 id |
| `info.linkUrl` | 右键的是链接时的 URL |
| `info.pageUrl` | 页面 URL |
| `info.selectionText` | 选中的文本 |
| `tab` | 标签页对象 |

### 5.3 踩坑限制

| 坑 | 说明 |
|---|---|
| **菜单项不会自动更新** | 改了 `create` 必须先 `removeAll()` 再重建。本项目在 `onInstalled` 里 `removeAll(() => create(...))` |
| **`onInstalled` 只在安装/更新时触发** | 开发中改代码要手动刷新扩展，否则菜单不更新 |
| **不能在回调里直接删自己** | 需要用 `chrome.contextMenus.remove(id)` |

---

## 6. chrome.tabs / chrome.action —— 标签页与图标

### 6.1 `chrome.tabs.create(createProperties)`

| 属性 | 类型 | 说明 |
|---|---|---|
| `url` | string | 要打开的地址 |
| `active` | bool | 是否立即激活 |
| `index` | number | 插入位置 |
| `windowId` | number | 在哪个窗口打开 |

```js
chrome.tabs.create({ url: chrome.runtime.getURL('dashboard/index.html') });
```

> `chrome.tabs.create` 需要 `tabs` 权限吗？**不需要** —— 创建标签页这个动作本身不需要 `tabs` 权限；只有读取标签页的 URL/标题才需要。

### 6.2 `chrome.action`

| API | 说明 |
|---|---|
| `chrome.action.onClicked` | 点击图标触发（**只有没配 `default_popup` 时才触发**） |
| `chrome.action.setBadgeText({text})` | 图标角标 |
| `chrome.action.setTitle({title})` | 悬浮提示 |

> 本项目配置了 `default_popup`，所以 `action.onClicked` **不会触发**。这是新手常见的"点了没反应"的原因。

---

## 7. Manifest V3 的 CSP 与 WebAssembly

### 7.1 默认 CSP

MV3 扩展页面的默认 CSP：

```
script-src 'self'; object-src 'self';
```

含义：

- ✅ 允许加载扩展自己包里的 JS 文件；
- ❌ 禁止 `eval()`、`new Function()`、字符串形式的 `setTimeout('code')`；
- ❌ 禁止加载远程脚本（`https://.../x.js`）；
- ❌ 禁止内联 `<script>...</script>`（HTML 里的 `<script src>` 可以）。

### 7.2 `'wasm-unsafe-eval'` 是官方开的一个口子

```json
"content_security_policy": {
  "extension_pages": "script-src 'self' 'wasm-unsafe-eval'; object-src 'self'"
}
```

有了它，`WebAssembly.instantiate()` / `WebAssembly.compile()` 才能工作。

**为什么需要它**：本项目用 QuickJS 的 WASM 版本来执行用户脚本。WASM 里的 JS 引擎不受扩展 CSP 限制（`eval` 发生在 WASM 沙箱内部，不是页面 JS 的 eval），所以这是官方认可的"在扩展里跑不可信 JS"的路径。

### 7.3 注意与普通网页的区别

| 环境 | 能否 eval |
|---|---|
| 普通网页 | 看服务器 CSP，默认可以 |
| 扩展页面（MV3） | ❌ 不行（除非 manifest 放宽，而 Chrome 不允许加 unsafe-eval） |
| 内容脚本（content script） | ❌ 不行（受扩展 CSP 约束） |
| **WASM 里的 JS 引擎** | ✅ 可以（在 WASM 沙箱内部） |

### 7.4 实操建议

想在扩展里"执行用户提供的字符串"时，优先级：

1. **WASM JS 引擎**（本项目方案）—— 功能全，隔离好，体积大；
2. **自研受限解释器** —— 无依赖，但只能支持子集语法；
3. **沙箱 iframe** —— 容易踩 origin 泄漏与 CSP 继承的坑；
4. `eval` —— MV3 下不可行，别试。

---

## 8. fetch 与 CORS：扩展为什么能跨域

### 8.1 现象

普通网页里 `fetch('https://api.other.com/x')` 会被 CORS 拦（除非对方返回 `Access-Control-Allow-Origin`）。
扩展页面 / Service Worker 里同一个请求，只要 manifest 声明了 `host_permissions`，就能发出去。

### 8.2 原理

浏览器对"发起请求的上下文"检查权限：

| 上下文 | 跨域规则 |
|---|---|
| 普通网页 | 走标准 CORS，对端必须放行 |
| 扩展页面 / SW（有 host_permissions） | 浏览器在网络层直接放行，不做 CORS 校验 |
| 扩展页面 / SW（无对应 host_permissions） | 仍然走标准 CORS |

### 8.3 示例

```json
"host_permissions": ["<all_urls>"]
```

```js
// 在 Service Worker 里
const res = await fetch('https://api.example.com/users');
const data = await res.json();   // 不需要对方配置 CORS
```

### 8.4 踩坑限制

| 坑 | 说明 |
|---|---|
| **host_permissions 粒度** | 可以只给需要的域名：`"https://api.example.com/*"`，审核更友好 |
| **混合内容** | 扩展页面是 `chrome-extension://`（算安全上下文），访问 `http://` 接口在部分版本会被拦 |
| **Cookie** | 默认 `credentials: 'same-origin'`，跨站不带 Cookie。需要带就显式 `credentials: 'include'`，本项目在设置里提供开关 |
| **被拦截的头** | `Host`、`Origin`、`Cookie` 等是 forbidden header，fetch 会静默丢弃，无法手动设置 |
| **重定向** | `redirect: 'manual'` 在扩展里可能返回状态 0 的 opaque response；本项目默认 `follow` |
| **CORS 错误不会细分** | 统一表现为 `Failed to fetch`，本项目会把它翻译成可读提示（见设计文档 §10.6） |

---

## 9. IndexedDB 在 Service Worker 里的使用

### 9.1 为什么 SW 里也能用

IndexedDB 属于"扩展源"（extension origin）的存储，SW 与页面共享同一份，所以页面写、SW 读是通的。

### 9.2 原生 API 的回调地狱

```js
const request = indexedDB.open('cp-history', 1);
request.onupgradeneeded = () => { /* 建表 */ };
request.onsuccess = () => { /* 拿到 db */ };
```

包成 Promise（项目里见 `src/core/db.ts`）：

```js
function openDb() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open('cp-history', 1);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains('history')) {
        const store = db.createObjectStore('history', { keyPath: 'id' });
        store.createIndex('timestamp', 'timestamp');
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}
```

### 9.3 常用操作速查

```js
// 写
const tx = db.transaction('history', 'readwrite');
tx.objectStore('history').put(item);

// 读全部
const tx = db.transaction('history', 'readonly');
const req = tx.objectStore('history').getAll();
req.onsuccess = () => console.log(req.result);

// 按索引查（时间倒序）
const idx = tx.objectStore('history').index('timestamp');
idx.openCursor(null, 'prev');

// 删
tx.objectStore('history').delete(id);

// 清空
tx.objectStore('history').clear();
```

### 9.4 踩坑限制

| 坑 | 说明 |
|---|---|
| **事务会自动提交** | `await` 一个非 IDB 的 Promise 会让事务失效。读写要连续同步发起 |
| **版本升级要写迁移逻辑** | `onupgradeneeded` 里按 `oldVersion` 增量改结构 |
| **`db.close()` 忘记调** | 长连接会占资源。本项目每次操作后 `db.close()` |
| **SW 休眠期间连接会断** | 每次操作重新 `open()` 更稳妥，不要长期持有连接 |

---

## 10. 自动化加载扩展：Chrome 137+ 的变化

### 10.1 变化

Google Chrome **品牌版**（不是 Chromium）从 137 起禁用了命令行加载扩展：

```
[WARNING:extension_service.cc] --load-extension is not allowed in Google Chrome, ignoring.
[WARNING:extension_service.cc] --disable-extensions-except is not allowed in Google Chrome, ignoring.
```

**注意：它是"静默忽略"** —— Chrome 照常启动，但扩展根本没加载。自动化脚本如果只检查"进程起来了"会误判成功。

### 10.2 正确做法：用 DevTools Protocol 的 Extensions 域

Chrome 156 的 CDP 已提供 `Extensions` 域：

| 命令 | 说明 |
|---|---|
| `Extensions.loadUnpacked { path }` | 加载未打包扩展 |
| `Extensions.getExtensions` | 列出扩展（含 id、name） |
| `Extensions.uninstall { id }` | 卸载 |
| `Extensions.triggerAction { id }` | 触发图标点击 |
| `Extensions.setStorageItems / getStorageItems` | 读写扩展存储 |

用 Node 25 的内置 `WebSocket` 连浏览器级 CDP：

```js
const version = await (await fetch('http://127.0.0.1:9444/json/version')).json();
const ws = new WebSocket(version.webSocketDebuggerUrl);   // 浏览器级连接
// 发送 { id: 1, method: 'Extensions.loadUnpacked', params: { path: 'C:\\...\\dist' } }
// 再发 { id: 2, method: 'Extensions.getExtensions' } 拿到真实扩展 id
```

完整实现见 `scripts/e2e-verify.mjs`。

### 10.3 手工加载扩展（给使用者）

```
chrome://extensions
  → 右上角打开「开发者模式」
  → 点「加载已解压的扩展程序」
  → 选择项目的 dist/ 目录
```

修改代码后：回到 `chrome://extensions`，点扩展卡片上的刷新按钮 ↻。

---

## 11. 踩坑清单

按本项目开发中真实踩到的顺序：

| # | 现象 | 根因 | 解法 |
|---|---|---|---|
| 1 | SW 里 `document is not defined` | Service Worker 没有 DOM | 界面与逻辑分层，SW 只做编排 |
| 2 | `new Function is not allowed` | MV3 CSP 禁止 unsafe-eval | 用 WASM JS 引擎执行用户脚本 |
| 3 | SW 里 `localStorage` undefined | SW 无 localStorage | 改用 `chrome.storage.local` |
| 4 | `sendMessage` 返回 "port closed" | 异步处理没 `return true` | 监听器里返回 `true` |
| 5 | 跨域 fetch 报 CORS | 缺 `host_permissions` | manifest 加 host_permissions |
| 6 | 改 manifest 不生效 | 没重新加载扩展 | chrome://extensions 点刷新 |
| 7 | 自动化脚本"启动成功"但扩展没加载 | Chrome 137+ 忽略 `--load-extension` | 用 CDP `Extensions.loadUnpacked` |
| 8 | `window.matchMedia` 在 SW 里不存在 | 同 #1 | 放页面侧 |
| 9 | 打包后扩展装不上 | manifest 引用的文件路径不对 | 打包前校验 manifest 里的文件是否存在 |
| 10 | QuickJS 回调拿不到参数 | 0.32 版回调不传 `this` 句柄 | 回调只接收来宾参数 |
| 11 | PowerShell 脚本报"字符串缺少终止符" | PS 5.1 按 ANSI 读无 BOM 的 .ps1 | 脚本存 UTF-8 **带 BOM**，或全用 ASCII |
| 12 | `Uint8Array` 不能传给 `new Blob()` | TS 5.7 TypedArray 泛型化 | 复制一份取 `.buffer` 再传 |

---

## 附：本项目用到的 API 一览

| API | 用途 | 代码位置 |
|---|---|---|
| `chrome.runtime.onMessage` | 接收 UI 的请求指令 | `src/background/service-worker.ts` |
| `chrome.runtime.sendMessage` | 发送结果 / 右键菜单通知 | `service-worker.ts`、`src/dashboard/api.ts` |
| `chrome.runtime.getURL` | 生成扩展内绝对 URL | `service-worker.ts`、`src/popup/main.tsx` |
| `chrome.runtime.onInstalled` | 初始化右键菜单 | `service-worker.ts` |
| `chrome.storage.local.get/set/remove` | 集合 / 环境 / 设置持久化 | `src/core/storage.ts` |
| `chrome.storage.local.set` | 变量落盘、传递待处理 URL | `storage.ts`、`service-worker.ts` |
| `chrome.contextMenus.create/onClicked` | 右键菜单 | `service-worker.ts` |
| `chrome.tabs.create` | 打开工作台 | `service-worker.ts`、`popup/main.tsx` |
| `chrome.action`（配置） | 图标与 Popup | `public/manifest.json` |
| IndexedDB | 历史记录 | `src/core/db.ts` |
| WebAssembly | QuickJS 脚本沙箱 | `src/core/sandbox.ts` |
| `fetch` | 真实请求 | `src/core/request-executor.ts` |
