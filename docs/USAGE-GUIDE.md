# Chrome Postman 使用指南

> 5 分钟上手 + 脚本手册 + 常见问题
> 配套文档：[设计文档](./DESIGN.md) · [Chrome API 详解](./CHROME-API-REFERENCE.md)

---

## 目录

1. [安装与加载](#1-安装与加载)
2. [5 分钟上手](#2-5-分钟上手)
3. [核心概念](#3-核心概念)
4. [功能操作手册](#4-功能操作手册)
5. [脚本手册](#5-脚本手册)
6. [断言参考](#6-断言参考)
7. [快捷键](#7-快捷键)
8. [常见问题](#8-常见问题)

---

## 1. 安装与加载

### 方式一：加载已解压的扩展（开发用）

```bash
# 1. 安装依赖
npm install

# 2. 生成图标 + 构建
npm run build:all

# 3. 打开扩展页
#    浏览器地址栏输入 chrome://extensions
#    右上角打开「开发者模式」
#    点「加载已解压的扩展程序」
#    选择项目的 dist/ 目录
```

### 方式二：安装打包好的 zip（分发用）

```bash
npm run pack     # 产出 release/chrome-postman-v1.0.0.zip
```

> Chrome Web Store 与 Edge Add-ons 只接受 zip。

### 开发时的热更新

改完代码后：

```bash
npm run build     # 重新构建
```

然后到 `chrome://extensions` 点扩展卡片上的 **↻ 刷新**。Chrome 不支持扩展的自动热重载。

### 从源码跑测试

```bash
npm test              # 45 条单元测试
node scripts/e2e-verify.mjs   # 真实 Chrome 端到端验证（8 项）
```

---

## 2. 5 分钟上手

### 第 1 步：建一个集合

左下角 **+ 集合** → 输入名字（如「订单服务」）。集合是组织请求的容器。

### 第 2 步：建一个环境

顶栏「环境」下拉 → 旁边的 ⚙ 打开环境管理 → **+ 新建环境**，命名为 `dev`，加两个变量：

| 变量名 | 变量值 |
|---|---|
| `baseUrl` | `https://dev-api.example.com` |
| `token` | `dev-abc123` |

### 第 3 步：写第一个请求

请求栏填：

- Method：`GET`
- URL：`{{baseUrl}}/api/orders`
- Header：加一行 `Authorization` = `Bearer {{token}}`

### 第 4 步：发送

点 **发送**（或 `Ctrl + Enter`）。下方响应区显示状态码、耗时、响应体。

### 第 5 步：加一条断言

切到 **后置脚本** 标签，写：

```js
pm.test('状态码是 200', function () {
  pm.response.to.have.status(200);
});

pm.test('返回了订单列表', function () {
  pm.expect(pm.response.json().data.length).to.be.above(0);
});
```

再点发送，切到 **断言** 标签，看到两条绿色的通过记录。

### 第 6 步：保存

点 **保存** 把请求存进集合。之后可以在左边的树里随时点开重发。

---

## 3. 核心概念

### 3.1 三个层次

| 概念 | 是什么 | 类比 |
|---|---|---|
| **集合 Collection** | 一组相关请求的容器，可以有自己的变量 | 一个「项目」 |
| **环境 Environment** | 一组变量，用来切换不同服务器/账号 | 一个「配置文件」 |
| **请求 Request** | 一次具体的 API 调用 | 一个「接口」 |

### 3.2 变量与优先级

请求里任何地方都可以写 `{{变量名}}`：

```
URL      {{baseUrl}}/api/orders
Header   Authorization: Bearer {{token}}
Query    ?page={{page}}&size=20
Body     { "userId": "{{userId}}" }
```

**优先级（高 → 低）**：环境 > 集合 > 全局 > 会话

含义：**环境变量会覆盖其他同名变量**。所以「把 token 配在环境里，所有请求自动带上」的用法最省事。

### 3.3 内置动态变量

不用配置，随取随用：

| 写法 | 结果 |
|---|---|
| `{{$timestamp}}` | `1763644800` |
| `{{$isoTimestamp}}` | `2025-11-19T15:20:00.000Z` |
| `{{$uuid}}` | `3f2504e0-4f89-41d3-9a0c-0305e82c3301` |
| `{{$randomInt}}` | `573`（0~1000） |

### 3.4 未定义的变量会保留原样

如果 `{{baseUrl}}` 没配，请求不会发出 `https:///api/orders` 这种废地址，而是原样保留 `{{baseUrl}}` 发出去 —— 这样你能一眼看出是变量没配，而不是接口返回了一个看不懂的 400。

---

## 4. 功能操作手册

### 4.1 请求体格式

在 **Body** 标签里选模式：

| 模式 | 用途 | Content-Type |
|---|---|---|
| 无 | GET / DELETE 等无体请求 | — |
| JSON | 最常用 | application/json |
| Text | 纯文本 | text/plain |
| XML | XML 报文 | application/xml |
| HTML | HTML 报文 | text/html |
| x-www-form-urlencoded | 传统表单提交 | application/x-www-form-urlencoded |
| form-data | 带文件上传的表单 | multipart/form-data |
| 二进制 | 直接发本地文件 | 按文件类型 |

JSON 模式有「格式化」按钮，可把压缩过的 JSON 美化。

**form-data 上传文件**：把某分段类型切到「文件」，然后点「选择文件…」。

### 4.2 鉴权

在 **Auth** 标签选类型：

| 类型 | 填什么 | 生成什么 |
|---|---|---|
| 无 | — | — |
| Basic Auth | 用户名、密码 | `Authorization: Basic base64(user:pass)` |
| Bearer Token | Token | `Authorization: Bearer <token>` |
| API Key | Key 名、值、放 Header 还是 Query | 自定义头或查询参数 |
| OAuth 2.0 | Access Token | `Authorization: Bearer <token>` |

> **Digest 暂不支持**。需要时用 Bearer Token，或在「前置脚本」里自己拼 Authorization 头。

### 4.3 集合与文件夹

- 左下角 **+ 集合** 新建集合；悬停集合行出现 📁（建文件夹）、✎（重命名）、✕（删除）。
- 文件夹同样可增删；请求可以拖进文件夹（当前版本通过"保存到集合/文件夹"的归属实现）。
- 顶部搜索框按**请求名或 URL** 过滤。

### 4.4 历史记录

左侧切到 **历史** 标签：

- 每次发送都会记录一条（含请求快照 + 响应 + 断言结果）；
- 点一条 → 载入编辑器，可直接改参数重发；
- 「清空历史」一键清空（默认保留最近 200 条，可在设置里调整）。

### 4.5 导入 / 导出

左下角 **导出** / **导入**：

- 导出的是**整个工作区**（集合 + 文件夹 + 请求 + 环境 + 全局变量）的 JSON；
- 导入是**合并**模式：同 id 覆盖，不同 id 追加，不会丢数据；
- 换电脑时导出 → 拷贝 → 导入即可。

### 4.6 cURL 与 HAR

右上角 **⋯** 菜单：

- **复制为 cURL**：生成可直接在终端执行的命令，变量已替换成当前环境的真实值；
- **导出 HAR**：标准 HAR 1.2 归档，可导入 Charles / Fiddler / DevTools 做对比分析。

### 4.7 设置（右上角 ⋯ → 设置）

| 设置 | 说明 | 默认 |
|---|---|---|
| 主题 | 跟随系统 / 深色 / 浅色 | 跟随系统 |
| 超时(ms) | 请求超时时间 | 30000 |
| 历史条数 | 保留多少条历史 | 200 |
| 自动跟随重定向 | 30x 是否自动跟随 | 开 |
| 携带 Cookie | 请求是否带 Cookie | 开 |

---

## 5. 脚本手册

脚本分两个时机执行，这是「请求前后拦截」的具体含义。

```
用户点发送
   │
   ├─ 前置脚本执行 ──→ 组装最终请求 ──→ 发出网络请求
   │   （可以改写请求）                        │
   │                                          ▼
   └──────────────────────────────→ 后置脚本执行
                                        （可以读响应、写断言、提取变量）
```

### 5.1 前置脚本（请求发出之前）

典型用途：动态加签、注入时间戳、算 token、改写 URL。

```js
// 加一个带时间戳的请求头
pm.request.headers.upsert({
  name: 'X-Timestamp',
  value: String(Date.now()),
});

// 改写 URL
pm.request.url.raw = pm.request.url.toString() + '&from=pre-script';

// 改写请求体
pm.request.body.raw = JSON.stringify({ hello: 'world' });

// 写入变量（会影响同一次请求的二次插值）
pm.environment.set('requestId', 'req-' + Date.now());
```

### 5.2 后置脚本（响应返回之后）

典型用途：断言、提取 token 存进环境、做数据清洗。

```js
// 断言
pm.test('状态码是 200', function () {
  pm.response.to.have.status(200);
});

pm.test('响应里有订单号', function () {
  const body = pm.response.json();
  pm.expect(body.data.orderNo).to.be.a('string');
  pm.expect(body.data.amount).to.be.above(0);
});

// 提取变量到环境，下次请求就能用 {{orderNo}}
pm.test('提取订单号', function () {
  pm.environment.set('orderNo', pm.response.json().data.orderNo);
});
```

### 5.3 pm API 速查表

#### 变量

| API | 说明 |
|---|---|
| `pm.environment.get(key)` | 读环境变量，找不到返回 `undefined` |
| `pm.environment.set(key, value)` | 写环境变量（值会被转成字符串） |
| `pm.environment.unset(key)` / `pm.environment.delete(key)` | 删除 |
| `pm.environment.has(key)` | 是否存在 |
| `pm.environment.clear()` | 清空当前环境的全部变量 |
| `pm.environment.toObject()` | 拿到全部环境变量的对象 |
| `pm.globals.get/set/unset/has/clear/toObject` | 全局变量，同上 |
| `pm.variables.get/set/unset/has/clear/toObject` | 会话变量（读取时向外层作用域兜底） |

#### 请求

| API | 说明 |
|---|---|
| `pm.request.method` | 读/写请求方法 |
| `pm.request.url.toString()` | 读 URL 字符串 |
| `pm.request.url.raw` | 读/写 URL |
| `pm.request.headers.add({name, value})` | 追加请求头 |
| `pm.request.headers.upsert({name, value})` | 有则改、无则加（**最常用**） |
| `pm.request.headers.remove(name)` | 删除请求头 |
| `pm.request.headers.get(name)` | 读单个请求头的值 |
| `pm.request.headers.has(name)` | 是否存在 |
| `pm.request.headers.all()` | 返回 `[{key, value}]` |
| `pm.request.headers.toObject()` | 返回 `{name: value}` 对象 |
| `pm.request.body.raw` | 读/写请求体原文 |
| `pm.request.body.mode` | 读/写请求体模式 |
| `pm.request.body.toString()` | 请求体字符串 |
| `pm.request.body.json()` | 请求体按 JSON 解析（非法会抛错） |

#### 响应

| API | 说明 |
|---|---|
| `pm.response.code` | 状态码（数字），可写 |
| `pm.response.status` | 状态文本，如 `OK`，可写 |
| `pm.response.responseTime` | 耗时（毫秒），可写 |
| `pm.response.size` | 响应体字节数 |
| `pm.response.headers.*` | 同请求头的 API（add/upsert/remove/get/has/all/toObject） |
| `pm.response.json()` | 解析响应体为对象（非 JSON 会抛错） |
| `pm.response.text()` | 响应体原文 |
| `pm.response.to.have.status(200)` | chai 风格状态码断言 |

#### 断言与日志

| API | 说明 |
|---|---|
| `pm.test(name, fn)` | 注册一条断言。`fn` 抛错 = 失败，不会中断脚本 |
| `pm.expect(value)` | 返回断言对象，见 §6 |
| `console.log(...)` | 输出到「Console」标签页 |
| `console.warn(...)` / `console.error(...)` | 同上，带级别标记 |

### 5.4 脚本能做什么、不能做什么

| 能 | 不能 |
|---|---|
| 读写请求 / 响应 | 访问 DOM、页面元素 |
| 读写变量 | 访问 `chrome.*` 扩展 API |
| 写断言、读日志 | 访问文件系统 |
| 发起网络请求？ → **不支持**（见下） | 无限循环（5 秒超时会被掐断） |
| | 占用过多内存（32MB 上限） |

> **`pm.sendRequest()` 暂未实现**。脚本里不能发起第二个请求。

### 5.5 脚本调试

- 脚本里的 `console.log` 输出在响应面板的 **Console** 标签页；
- 脚本报错不会让整个请求失败 —— 请求照常发出，错误信息显示在 Console 标签顶部；
- 写脚本时的坑：`Assertion.prototype.an` 这类**既想当链式词、又想当方法**的名字不能重复定义，否则报 `no setter for property`。改 SDK 时注意。

### 5.6 常用脚本模板

**动态签名（把请求头算出来）**

```js
const ts = Date.now();
const sign = pm.variables.get('signSecret') + ':' + ts;
pm.request.headers.upsert({ name: 'X-Sign', value: sign });
pm.request.headers.upsert({ name: 'X-Timestamp', value: String(ts) });
```

**登录后自动把 token 存起来**

```js
pm.test('登录成功并保存 token', function () {
  const body = pm.response.json();
  pm.expect(body.code).to.equal(0);
  pm.environment.set('token', body.data.token);
});
```

**链式登录：先登录拿 token，再调业务接口**

1. 建请求 `POST /api/login`，后置脚本存 `pm.environment.set('token', ...)`；
2. 建请求 `GET /api/profile`，Header 写 `Authorization: Bearer {{token}}`；
3. 两个请求用同一个环境。

**超时重试提示**

```js
pm.test('响应时间在 1 秒内', function () {
  pm.expect(pm.response.responseTime).to.be.below(1000);
});
```

---

## 6. 断言参考

`pm.expect(value)` 返回一个迷你 chai 断言对象。

### 6.1 链式词（可任意组合，不改变语义）

`to` `be` `been` `is` `that` `which` `and` `has` `have` `with` `the`

特殊两个：

- `.not` —— 取反
- `.deep` —— 深度比较

```js
pm.expect(body).to.not.be.empty;
pm.expect(obj).to.deep.equal({ a: 1 });
```

### 6.2 断言方法

| 方法 | 含义 | 示例 |
|---|---|---|
| `.a(type)` / `.an(type)` | 类型 | `.to.be.a('string')` |
| `.equal(v)` / `.eq(v)` / `.equals(v)` | 严格相等 | `.to.equal(200)` |
| `.eql(v)` | 深度相等 | `.to.eql({ a: 1 })` |
| `.include(v)` / `.contain(v)` | 字符串包含 / 数组包含 / 对象含键 | `.to.include('abc')` |
| `.property(name[, value])` | 对象有该属性（带 value 时还要相等） | `.to.have.property('data')` |
| `.status(code)` | 响应状态码 | `.to.have.status(200)` |
| `.ok()` | 真值 | `.to.be.ok` ← 注意这里不能加括号？**可以加**，`.to.be.ok()` |
| `.true()` / `.false()` | 布尔 | `.to.be.true` |
| `.above(n)` / `.gt(n)` | 大于 | `.to.be.above(0)` |
| `.below(n)` / `.lt(n)` | 小于 | `.to.be.below(100)` |
| `.least(n)` / `.gte(n)` | 大于等于 | `.to.be.at.least(1)` |
| `.most(n)` / `.lte(n)` | 小于等于 | `.to.be.at.most(10)` |
| `.length(n)` | 长度 | `.to.have.length(3)` |
| `.match(re)` | 正则匹配 | `.to.match(/^abc/)` |
| `.oneOf([...])` | 属于集合 | `.to.be.oneOf([1, 2])` |
| `.empty()` | 空 | `.to.be.empty` |

> 链式词 `have` / `has` 后面可以直接跟方法：`.to.have.status(200)`、`.to.have.property('x')`、`.to.have.length(3)`。

### 6.3 断言失败长什么样

```
✕ 响应里有订单号
  expected undefined to be a string
```

失败原因会直接给出"期望什么、实际是什么"，比 `true is not true` 有用得多。

---

## 7. 快捷键

| 快捷键 | 作用 |
|---|---|
| `Ctrl + Enter` | 发送当前请求（在工作台任意位置） |
| `Enter`（URL 输入框内） | 发送当前请求 |

---

## 8. 常见问题

### Q1：请求报「Failed to fetch」，到底怎么了？

本工具会把它翻译成一段可读提示。通常是这几种原因：

1. 域名不存在或拼错；
2. 本机网络不通；
3. 服务端 CORS 策略拒绝（**扩展有 host_permissions 时通常不会**）；
4. 接口地址是 `http://`，而目标页面是 `https://`，被浏览器拦截（混合内容）。

用 curl 在终端试一下，能区分是"网络问题"还是"扩展问题"：

```bash
curl -v https://api.example.com/users
```

### Q2：变量没生效，URL 里还是 `{{baseUrl}}`

按这个顺序查：

1. 顶栏「环境」下拉里，当前环境选对了吗？（显示「无」就是没选）
2. 打开环境管理 ⚙，确认变量存在且**处于启用状态**（每行左边的 👁 是开启的）。
3. 变量名拼写一致吗？`{{baseUrl}}` 和 `{{base_url}}` 是两个变量。
4. 如果变量是在**前置脚本**里 `pm.environment.set()` 的，它会影响**下一次**请求的插值（当前请求已完成插值）。要影响当前请求，用脚本直接改 `pm.request.url.raw`。

### Q3：脚本改了请求头，但服务端说没收到

- 检查脚本是不是写在了**后置脚本**（那是响应之后才跑的）；
- 确认用的是 `upsert` 而不是 `add`（同名头会重复）；
- 有些头是浏览器禁止手动设置的（`Host`、`Cookie`、`Origin`），设了也不会生效。

### Q4：断言全红，但接口明明返回了 200

- 看 Console 标签的报错信息，它会写明"期望什么、实际什么"；
- `pm.response.json()` 在响应不是合法 JSON 时会抛错 —— 检查响应体是不是被截断了；
- `pm.response.code` 是数字，`pm.response.status` 是文本（`"OK"`）。别搞混。

### Q5：切换环境后请求没变化

环境变量只在**请求保存前插入**。如果 URL 里写的是硬编码域名，改环境当然没用。要用 `{{baseUrl}}`。

### Q6：历史记录里的响应体是空的

- 请求失败时不会有响应体（看历史里有没有"失败"标记）；
- 二进制响应会被转成 Base64 存储，界面显示「二进制响应，已以 Base64 存储」。

### Q7：脚本写到一半浏览器卡住了

不会卡死。脚本沙箱有 **5 秒超时**和 **32MB 内存上限**，死循环会被自动掐断，控制台会显示中断信息。

### Q8：怎么在团队之间共享？

用 **导出 / 导入**：导出的 JSON 包含集合、文件夹、请求、环境、全局变量。直接把文件发给同事导入即可。

### Q9：能拦截网页自己的请求吗（比如给某个网站的请求加个 header）？

**不能**。本工具实现的是**应用内拦截** —— 只影响它自己发出的请求。

浏览器全局拦截在 MV3 下有硬性限制：`chrome.declarativeNetRequest` 只能改请求头/响应头、阻断、重定向，**改不了请求体和响应体**，也写不了断言。如果你需要这类能力，方案是本机起一个转发代理（类似 Fiddler/mitmproxy），那是另一个量级的工程。

### Q10：Service Worker 休眠后，我设置的会话变量没了？

对。MV3 的 Service Worker 空闲约 30 秒会被休眠，内存变量随之丢失。

- 临时值（几秒内用）→ `pm.variables.set()` 没问题；
- 需要长期保留（token 等）→ 用 `pm.environment.set()`，它会落到 `chrome.storage`，重启浏览器也在。

### Q11：怎么彻底删除扩展数据？

1. 在 `chrome://extensions` 删除扩展（会一并清掉扩展的 storage 与 IndexedDB）；
2. 或在扩展的「设置」里手动清空历史。

---

## 附录：常用 cURL 对照

在 Postman 里看到的 cURL，粘到这个工具的 URL 栏也能用：

```bash
curl 'https://api.example.com/users?page=1' \
  -H 'Authorization: Bearer abc' \
  -H 'Content-Type: application/json' \
  --data-raw '{"name":"x"}'
```

对应填法：

| cURL 片段 | 填到 |
|---|---|
| URL | URL 栏 |
| `-H 'Key: Value'` | Headers 标签 |
| `--data-raw '...'` | Body → JSON（或 Text） |
| `-u user:pass` | Auth → Basic Auth |
| `-F 'file=@a.png'` | Body → form-data |

反过来，点 **⋯ → 复制为 cURL** 可以把工具里的请求导出成 cURL。
