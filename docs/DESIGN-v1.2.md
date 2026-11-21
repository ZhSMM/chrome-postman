# Chrome Postman v1.2 设计方案

> 状态：**设计稿**（未实现）
> 适用范围：`chrome-postman` v1.2.0
> 上一版设计：[`DESIGN.md`](./DESIGN.md)（v1.0 已实现，63 条单测 + 8 条端到端）
> 本文档回答三个方向的问题：**① SSL 验证开关　② 输入框智能补全　③ 其他易用与定位能力**

---

## 0. 这份文档怎么读

本文档面向想继续开发这个扩展的人，尤其是刚接触 Chrome 扩展的同学。每个技术判断都标注了依据等级：

| 标记 | 含义 |
|---|---|
| `[实测]` | 我在本机真实 Chrome 156 上跑过，有可复现的脚本（见 §8.4） |
| `[文档]` | Chrome 官方文档明确写明 |
| `[推理]` | 基于前两者的逻辑推导，没有直接实验 |

**为什么要有这个分级**：这轮设计里有好几个"看起来能做、其实做不到"的判断。如果不标依据，后人很容易在错误的前提上写代码。比如"扩展能不能读取服务器证书"——Chrome 文档里写着 `SecurityInfo` 类型、标着 Chrome 144+，看起来能用，**但实测返回 `null`**。

**术语约定**：文中出现的 Chrome 专有名词（Service Worker、native messaging、host_permissions 等）首次出现时都会展开解释，附录 B 有完整术语表。

---

## 1. 事实基线

**这一节是全文的地基。** 三个方向的所有设计都建立在这几条实测结论上，跳过这一节直接看设计方案会得到错误的预期。

### 1.1 事实总表

| 编号 | 事实 | 依据 | 对设计的影响 |
|---|---|---|---|
| **F1** | MV3 扩展的 `fetch` **无法**关闭 TLS 证书校验 | `[文档]`+`[推理]` | 方向一不能做"真开关"，必须换架构 |
| **F2** | `chrome.webRequest` 的事件详情里**没有** timing 字段 | `[文档]` | 方向三-2 拿不到 DNS/TCP/TLS 分段耗时 |
| **F3** | `webRequest` 的 `securityInfo`（证书信息）在 Chrome 156 上**返回 `null`** | `[实测]` | 扩展读不到服务器证书 → 做不了"证书体检" |
| **F4** | `webRequest` **能**看到扩展自己发出的请求 | `[实测]` | v1.1.0 的网络诊断功能成立 |
| **F5** | `webRequest` 想看**外部站点**的请求，必须有 `host_permissions` | `[实测]` | 不能为了诊断去申请 `<all_urls>`，与权限克制原则冲突 |
| **F6** | `onHeadersReceived` 的 `extraInfoSpec` **不能随便混搭**，组合非法时监听器**静默失效** | `[实测]` | 踩坑点，必须写进开发注意事项 |
| **F7** | QuickJS 抛错时 stack 形如 `at <eval> (user-post-script.js:3:11)`，**带行号和列号** | `[实测]` | 方向三-4「错误行号定位」可行 |
| **F8** | `nativeMessaging` 是 Chrome 官方**唯一**的扩展越界通道 | `[文档]` | 方向一唯一的"真开关"实现路径 |

### 1.2 F1 展开：为什么浏览器不让扩展关掉证书

**这是方向一最关键的一条约束，值得讲透。**

一次 HTTPS 请求的完整链路：

```
你的代码
  ↓  fetch('https://api.example.com')
扩展运行时（Service Worker）
  ↓  交给 Chromium 网络栈
Chromium 网络栈
  ↓  DNS 解析 → TCP 连接 → TLS 握手  ← 证书在这里被校验
  ↓  net::CertVerifier 模块（进程级，扩展代码碰不到）
服务器
```

三个关键点：

1. **TLS 握手发生在扩展代码根本触不到的层。** 扩展的 `fetch` 最终调用的是浏览器网络栈，证书校验由 Chromium 的 `net::CertVerifier` 模块执行。这是进程级的安全模块，没有任何扩展 API 能配置它。

2. **`rejectUnauthorized: false` 是 Node.js 的 API，浏览器不提供这个概念。** 在浏览器里写 `fetch(url, { rejectUnauthorized: false })` 不会报错，但这个选项会被静默忽略——请求照常走完整的证书校验。

3. **Chrome 自己的"忽略证书错误"开关是启动参数，不是运行时 API。**
   `--ignore-certificate-errors` 和 `--ignore-certificate-errors-spki-list` 必须在启动浏览器时传入，扩展无法在运行中修改。

**推论**：任何宣称"浏览器扩展能关掉证书校验"的说法，只有三种可能——

- 它其实在用 **native messaging**（Postman Desktop 就是桌面应用，因为桌面应用能用 Node 的 TLS 栈）；
- 它在**修改系统信任库**（把 CA 装进操作系统）；
- 或者它在骗你。

**这个推论直接决定了方向一的架构**：想要真开关，就必须让请求**走出浏览器进程**。

> **一个延伸的哲学问题**：浏览器不让扩展关证书，是**故意的**。如果能关，任意一个恶意扩展就能中间人你访问的所有站点（改你的网银转账金额、偷你的 OAuth token）。这是浏览器的核心安全承诺之一。所以这不是"限制"，是"保护"，我们做设计时应该尊重它，而不是想办法绕开。

### 1.3 F3 展开：为什么读不到证书

Chrome 文档在 `webRequest` 里定义了 `SecurityInfo` 类型（Chrome 144+），可通过 `onHeadersReceived` 的 `'securityInfo'` extraInfoSpec 请求，内容包括：

- `certificates[]`：证书链，每项含 `fingerprint.sha256` 和 `rawDER`（原始 DER 字节）
- `state`：`secure` / `insecure` / `broken`

**实测结果**：Chrome 156 上，无论 headless 还是有头模式，无论请求 `example.com`（Let's Encrypt 证书）还是 `baidu.com`（公共 CA 证书），`details.securityInfo` **一律为 `null`**。

复现命令：
```bash
node scripts/probe-security-info.mjs          # headless
node scripts/probe-security-info.mjs --headful  # 有头
```

**但更关键的是：即使它能用，也帮不上自签名证书的忙。** 这是一个逻辑必然：

```
证书校验失败 → TLS 握手失败 → 连接根本建立不起来
             → 不可能有 onHeadersReceived 事件（这个事件在"收到响应头"时触发）
             → 所以 securityInfo 拿不到
```

`securityInfo` 只在**证书有效**时才有值。也就是说，它能告诉你"这个证书是好的/坏的"，但**不能告诉你"怎么跳过坏的"**。

**设计结论**：扩展内没有"显示并跳过证书错误"的路径。自签名证书的解法必须从**外部**切入（§2.2）。

### 1.4 F4 / F5 展开：webRequest 的可见范围

这两条实测结果一起，划定了 `webRequest` 能干什么的边界：

| 场景 | 是否可见 | 依据 |
|---|---|---|
| 扩展 **Service Worker** 自己发出的请求 | ✅ 可见 | `[实测]` `onBeforeRequest`/`onCompleted`/`onHeadersReceived` 全部触发 |
| 扩展**页面**（dashboard）自己发出的请求 | ✅ 可见 | `[实测]` 同上 |
| **外部站点**的请求（无 `host_permissions`） | ❌ 不可见 | `[实测]` 加上 `<all_urls>` 后立刻可见 |
| 扩展发起的**失败**请求 | ✅ 可见（`onErrorOccurred`） | `[实测]` v1.1.0 诊断功能 6/6 通过 |

**设计含义**：

1. v1.1.0 的网络诊断功能**站得住**——它只关心扩展自己发的请求，而扩展对自己的请求天然有观察权。**不需要**为了诊断去申请 `host_permissions` 或 `<all_urls>`。这与项目一贯的"最小权限"原则一致。

2. 方向三-2 的耗时分段同样成立——我们只需要观测自己的请求。

3. 反过来，**我们永远不该申请 `<all_urls>`**。那意味着能看用户所有网站的所有流量，是商店审核的重灾区（"Purple Potassium" 拒审码），也违背了项目原则。

### 1.5 F6 展开：extraInfoSpec 的静默失效

这是一个真实踩到的坑，值得单独记下来。

`onHeadersReceived` 的 `extraInfoSpec` 支持 `'responseHeaders'`、`'securityInfo'`、`'securityInfoRawDer'` 等多种取值。**实测发现：当传入的组合不被接受时，Chrome 不会抛异常，监听器也不会注册成功，只是永远不触发。**

```js
// ❌ 静默失效：事件永远不触发，也没有任何报错
chrome.webRequest.onHeadersReceived.addListener(cb, filter,
  ['securityInfo', 'responseHeaders']);

// ✅ 单独使用任何一项都正常触发
chrome.webRequest.onHeadersReceived.addListener(cb, filter, ['responseHeaders']);
chrome.webRequest.onHeadersReceived.addListener(cb, filter, ['securityInfo']);
```

**开发建议**：注册监听器后**必须有一个自检机制**——比如发一个探测请求确认监听器活着，或者在 Service Worker 启动时用 `console.info` 打印注册结果。我倾向于在 `startNetworkWatcher()` 里加一个断言，把"监听器注册成功"这件事变成可观测的状态。

### 1.6 F7 展开：QuickJS 的错误栈

实测三种错误场景：

| 场景 | name | message | stack |
|---|---|---|---|
| 第 3 行引用未定义变量 | `ReferenceError` | `'notDefinedVar' is not defined` | `    at <eval> (user-post-script.js:3:11)` |
| 语法错误（编译期） | `SyntaxError` | `unexpected token in expression: ';'` | `    at user-post-script.js:1:11` |

**关键**：行号基准与编辑器完全对齐。

原因在 `src/core/sandbox.ts:179`：

```ts
const scriptResult = context.evalCode(input.script, `user-${input.phase}-script.js`);
```

用户脚本是**整段作为一个字符串**交给 `evalCode` 的，QuickJS 报的行号就是这段字符串里的第几行。而编辑器里显示的也是这段字符串的行号。**两者天然一致，中间不需要任何偏移量补偿**。

**这是方向三-4「错误行号定位」能低成本实现的根本原因**。

---

## 2. 方向一：SSL 验证

### 2.1 先拆解需求：用户说的"开关"其实是三种东西

用户提出"支持 ssl 验证的开启与关闭"，但落到具体场景，至少是三种不同诉求，技术路径完全不同：

| 编号 | 真实诉求 | 典型场景 | 扩展内可行？ |
|---|---|---|---|
| **A** | 访问**自签名证书**的 API | 内网服务、开发测试环境用自签证书 | ❌ |
| **B** | 绕过**代理 MITM** 的证书 | 公司代理做 HTTPS 解密 | ❌ |
| **C** | 想知道**为什么失败了** | 排查连接问题 | ✅ 已在 v1.1.0 实现 |

A 和 B 在技术上**是同一件事**：都是"目标站的证书不被当前信任库接受"。B 还要多一层：代理的 CA 是公开的，装进信任库反而危险（§2.2 的警告）。

**设计原则**：先把 A/B 引导到正确解法去，扩展内只保留一个**真开关**（需要用户主动配置 + 明确风险），并且这个真开关必须走 §1.2 说的"走出浏览器进程"的路子。

### 2.2 自签名证书访问方案决策树

> **这一节直接回答你的问题：「服务器自签名证书时，如何访问呢？」**

```
目标：让 Chrome Postman 能访问 HTTPS 自签名证书的 API
│
├─ Q1：服务端能不能换成公共 CA 签发的证书？
│   │   （Let's Encrypt 免费，10 分钟自动续期）
│   ├─ 能 ──────────────────────────► 【方案 0】换证书，问题消失 ★★★★★
│   │                                  零成本、零风险、永久有效
│   └─ 不能（内网 / 测试环境 / 遗留系统）
│       │
│       ├─ Q2：操作系统允许你导入根证书吗？
│       │   （Windows / macOS 个人机器都可以；公司托管设备可能锁了）
│       │   ├─ 能 ──────────────────► 【方案 1】把 CA 装进系统信任库 ★★★★
│       │   │                          一次性操作，之后浏览器 / curl / Java /
│       │   │                          Python / Postman 全部一次性信任
│       │   └─ 不能（无管理员权限 / 不允许改系统 / 设备受管）
│       │       │
│       │       ├─ Q3：服务端能不能同时开一个 HTTP 端口？
│       │       │   ├─ 能 ──────────► 【方案 2】改用 http:// ★★★
│       │       │   │                  内网开发常见做法，零配置
│       │       │   └─ 不能
│       │       │       │
│       │       │       ├─ Q4：这个"忽略错误"是临时调试还是长期工作流？
│       │       │       │   ├─ 临时 ──► 【方案 3】Chrome 启动参数 ★★
│       │       │       │   │            --ignore-certificate-errors-spki-list
│       │       │       │   │            只忽略这一张证书，不是全局关闭
│       │       │       │   │            代价：要改快捷方式、每次启动都带
│       │       │       │   └─ 长期 ──► 【方案 4】本地伴生程序 ★★★
│       │       │       │                扩展外跑一个 Node 进程，
│       │       │       │                用 Node 的 https（能设 rejectUnauthorized:false）
│       │       │       │                代价：装伴生程序 + 注册 native host
│       │       │       │                Postman Desktop 走的就是这条路
│       │       │       │
│       │       │       └─→ 无论选哪个方案，都用【方案 1】的"信任该证书"
│       │       │           作为兜底，这是唯一对所有工具都生效的正解
│       │       │
│       │       └─→ 但【方案 4】多一个独有能力：
│       │           它能主动连一次并**把证书细节抓回来**
│       │           （签发者/有效期/SAN/指纹），
│       │           扩展就能给你一个"证书体检报告"
│       │
└─ ⚠️ 绝对不要做的：
    把一个**公开的** CA（比如代理的 MITM 根证书、任何公开根 CA）
    装进「受信任的根证书颁发机构」
    → 那等于把「任何人都能冒充这个 CA 签发证书」的钥匙交给了整台机器
```

### 2.3 方案 1 详解：把 CA 装进系统信任库

这是**推荐的主线方案**。核心优势：装完之后，**扩展本身一行代码都不用改**，功能自动获得。

#### Windows

```
1. 双击 server.crt（或 .cer）文件
2. 点击「安装证书…」
3. 选择「本地计算机」（需要管理员权限）或「当前用户」（不需要，推荐）
4. 选择「将所有证书放入下列存储」
5. 点击「浏览…」→ 选择「受信任的根证书颁发机构」
6. 「下一步」→「完成」
7. 重启 Chrome（必须）
```

命令行等价（当前用户，无需管理员）：
```powershell
Import-Certificate -FilePath .\server.cer -CertStoreLocation Cert:\CurrentUser\Root
```

#### macOS

```
1. 双击 .crt → 打开「钥匙串访问」
2. 把证书拖到左侧「系统」钥匙串
3. 双击刚拖进去的证书 → 「信任」下拉 → 选「始终信任」
4. 输入管理员密码 → 确认
```

命令行：
```bash
sudo security add-trusted-cert -d -r trustRoot \
  -k /Library/Keychains/System.keychain server.crt
```

#### Linux

```bash
sudo cp server.crt /usr/local/share/ca-certificates/myapi.crt
sudo update-ca-certificates
```

#### 验证是否生效

```bash
curl -v https://api.internal.example.com/ 2>&1 | grep -i "issuer"
# 应该能看到自签 CA 的名字，而不是 "unable to get local issuer certificate"
```

#### ⚠️ 重要警告（必须在扩展里原样呈现）

> **只导入你信任的签发者（Issuer）证书，不要导入服务端叶子证书。**
>
> 如果你导入的是服务端那张自签证书本身（而不是它的签发 CA），那么任何人都可以复制这张证书来冒充你的服务——因为你把"这张证书"变成了全局信任锚。
>
> **判断方法**：打开证书 → 「详细信息」→ 看「颁发者」和「使用者」两栏。
> - 两者**相同** → 这是自签名证书（自己签自己），导入它 = 危险
> - 两者**不同** → 这是由某个 CA 签的，应该导入那个 **CA 证书**（颁发者那张）

### 2.4 方案 4 详解：Native Messaging 伴生程序

这是**唯一能提供"真开关"**的方案。核心思想：请求**不经过浏览器进程**，而是由扩展发送给一个本地 Node 程序执行——Node 的 `https` 模块有 `rejectUnauthorized` 选项，浏览器没有。

#### 2.4.1 为什么必须走 native messaging

Chrome 对扩展的能力边界划得很清楚，`nativeMessaging` 是**唯一**的官方越界通道：

```
扩展进程（沙箱内）
   │  chrome.runtime.sendNativeMessage('com.chrome_postman.bridge', msg)
   ↓  stdin: [4字节小端长度][UTF-8 JSON]
本机伴生程序（Node 进程，不在沙箱内）
   │  Node https.request({ rejectUnauthorized: false })
   ↓
目标服务器
```

伴生程序**不在浏览器沙箱内**，所以能用浏览器的 TLS 栈。但也正因如此，它的权限很大——能读写文件、能启动进程。Chrome 因此把它列为**高敏感权限**。

#### 2.4.2 伴生程序的第二个职责：证书体检

F3 证明扩展读不到证书。但**伴生程序可以**——Node 的 TLS socket 提供了 `getPeerCertificate()`。

这让伴生程序的价值从"只能跳过校验"升级为"**证书探针 + 请求通道**"二合一：

```
用户问："这个 https://api.internal 到底是谁签的？证书还有效吗？"
        │
        ├─ 扩展直接查 → 读不到（F3）
        └─ 伴生程序查 → Node https.connect + rejectUnauthorized:false
                       + socket.getPeerCertificate()
                       → 完整的证书链、Subject、Issuer、有效期、SAN
```

拿到证书后，扩展可以：

1. 显示"证书体检报告"（签发者、有效期、SAN 域名列表、是否自签、过期天数）
2. 算出 **SPKI 的 SHA-256**（`--ignore-certificate-errors-spki-list` 需要的 base64 值），直接给用户一条可复制的启动参数
3. 校验用户装进系统信任库的 CA 对不对（对比指纹）

**这是一个完整的闭环**：用户不必自己去下载证书、自己去算指纹。

#### 2.4.3 消息协议

沿用 Chrome native messaging 标准帧格式：**4 字节小端长度 + UTF-8 JSON**。

```jsonc
// ── 请求 ────────────────────────────────────────────
{ "id": "r1", "action": "http", "req": {
    "method": "GET",
    "url": "https://api.internal/health",
    "headers": { "Accept": "application/json" },
    "body": null,          // 或 base64 字符串
    "timeoutMs": 30000,
    "rejectUnauthorized": false,   // ← 关键：这里就是"关闭 SSL 验证"
    "servername": null             // SNI 覆盖（IP 直连时可能需要）
}}

// ── 响应（成功）────────────────────────────────────
{ "id": "r1", "ok": true, "res": {
    "status": 200,
    "statusText": "OK",
    "headers": { "content-type": "application/json" },
    "body": "{\"ok\":true}",
    "bodyBase64": null,     // 二进制响应时用这个
    "elapsedMs": 123
}}

// ── 响应（失败）────────────────────────────────────
{ "id": "r1", "ok": false, "error": {
    "code": "CERT_HAS_EXPIRED",
    "message": "certificate has expired",
    "cert": { /* 证书详情，见 2.4.2 */ }
}}

// ── 证书体检 ───────────────────────────────────────
{ "id": "c1", "action": "inspect-cert", "req": { "url": "https://api.internal", "timeoutMs": 10000 } }
{ "id": "c1", "ok": true, "cert": {
    "subject":   { "commonName": "api.internal", "organization": "Example Ltd" },
    "issuer":    { "commonName": "Example Internal CA" },
    "validFrom": "2026-01-01T00:00:00Z",
    "validTo":   "2027-01-01T00:00:00Z",
    "san": ["api.internal", "*.internal"],
    "sha256": "AB:CD:EF:...",
    "spkiSha256Base64": "X3JlQ...",
    "selfSigned": true,
    "chain": [ /* 证书链，每项同上 */ ]
}}
```

**协议约束（踩坑点）**：

- 伴生程序的 **stdout 只能输出协议帧**，任何调试输出必须走 **stderr**。写错会导致 Chrome 报 "Error when communicating with the native messaging host"。
- 消息体上限 1 MB（Chrome 限制）。
- Windows 上要用二进制模式（`O_BINARY`），否则 `\n` → `\r\n` 会让长度前缀和内容错位。
- 伴生程序被 Chrome 启动时，**当前工作目录是伴生程序所在目录**，不是用户目录。

#### 2.4.4 注册（Windows）

Chrome 在 Windows 上**通过注册表**查找 native host：

```powershell
# 当前用户，无需管理员权限
$dir = "$env:LOCALAPPDATA\ChromePostman"
New-Item -ItemType Directory -Force -Path $dir | Out-Null
Copy-Item .\bridge.mjs "$dir\bridge.mjs"
Copy-Item .\com.chrome_postman.bridge.json "$dir\"

reg add "HKCU\Software\Google\Chrome\NativeMessagingHosts\com.chrome_postman.bridge" `
    /ve /d "$dir\com.chrome_postman.bridge.json" /f
```

host manifest：
```json
{
  "name": "com.chrome_postman.bridge",
  "description": "Chrome Postman 本地桥接程序",
  "path": "bridge.mjs",
  "type": "stdio",
  "allowed_origins": ["chrome-extension://<你的扩展ID>/"]
}
```

**关键坑：`allowed_origins` 必须是精确的扩展 ID，不能用通配符。** 而**开发模式下（unpacked）扩展 ID 是随机的**，每次加载都可能变（取决于目录路径和 manifest 的 `key` 字段）。

三种解法：

| 方案 | 做法 | 评价 |
|---|---|---|
| A. 固定扩展 ID | 在 `manifest.json` 里加 `"key"` 字段（从商店版扩展的公钥算） | ★★★ 最干净，ID 永久固定 |
| B. 安装时传参 | `install-host.ps1 -ExtensionId <id>` | ★★ 简单，但每次重装要重来 |
| C. 扩展内一键生成 | 设置页提供「复制注册命令」按钮，自动填入 `chrome.runtime.id` | ★★★ 用户体验最好 |

**推荐 A + C 组合**：正式发布时用 `key` 固定 ID；开发时用 C。

#### 2.4.5 降级 UX（这是设计的关键细节）

设想用户打开了"跳过证书校验"开关，但没装伴生程序，然后点发送。**最糟糕的做法**是：静默降级成严格校验，然后报一句 `Failed to fetch`——这正是 v1.0 的糟糕体验。

正确做法：

```
用户打开「跳过证书校验」开关
   ↓
扩展立刻探测桥接程序是否就绪
   ├─ 已连接 → 状态栏显示「本地桥接 v1.0.0 已就绪」，开关可用
   └─ 未连接 → 开关保持关闭，展开「需要本地桥接程序」面板：
                · 一句话说明：浏览器不允许扩展关闭证书校验，
                  这是浏览器的安全设计
                · 「复制安装命令」按钮（已填好正确的扩展 ID 和路径）
                · 「查看证书体检」入口（若已装则可用）
                · 【无需安装的替代方案】区块：
                    - 装 CA 到系统信任库（含三平台步骤 + 复制命令）
                    - 用 SPKI 白名单启动 Chrome
                    - 改用 http://（如果服务端支持）
   ↓
用户仍然点了发送（开关是关的）
   → 正常按严格校验发送，不特殊处理
```

**另一条路径**：用户在请求级别打开"跳过校验"，但桥接不可用 →

> 「此请求配置了跳过证书校验，但本地桥接程序未就绪。本次已按**严格校验**发送，若失败请先安装桥接程序。」

**绝不静默**。

### 2.5 方向一的完整数据模型

```ts
// ── src/shared/types.ts ────────────────────────────────

/**
 * SSL 校验模式。
 * - strict        浏览器原生校验（默认，最安全）
 * - system-trust  信任系统信任库。行为上与 strict 相同
 *                  （浏览器本来就信任系统信任库），单独列出是为了
 *                  在 UI 上表达"我已经把 CA 装进系统了"这个用户意图
 * - native-bridge 走本地伴生程序，可选择跳过证书校验
 */
export type SslMode = 'strict' | 'system-trust' | 'native-bridge';

export interface Settings {
  // ...现有字段
  /** 全局 SSL 模式 */
  sslMode: SslMode;
  /**
   * 是否允许跳过证书校验（高危）。
   * 只有 sslMode === 'native-bridge' 时才生效。
   * 默认 false，且 UI 上永远带警告样式。
   */
  allowInsecureTls: boolean;
  /** 本地桥接程序是否已就绪（运行时探测结果，不持久化） */
  // ↑ 这个不该放 Settings，应该放运行态
}

/** 单请求级覆盖：不填则跟随全局设置 */
export interface HttpRequest {
  // ...现有字段
  /** 覆盖全局 SSL 模式 */
  sslMode?: SslMode;
}
```

运行态（放 store，不落盘）：
```ts
export interface BridgeStatus {
  /** 是否可用 */
  available: boolean;
  /** 伴生程序版本 */
  version?: string;
  /** 探测时的错误信息 */
  error?: string;
  /** 上次探测时间 */
  checkedAt: number;
}
```

### 2.6 执行链路：插入"发送网关"

现有管线是 8 步（`src/core/request-executor.ts`）。方向一在第 5 步（发请求）插入一个可替换的**发送网关**：

```
① 解析草稿 → ② 变量插值 → ③ 构建头/体 → ④ 前置脚本
        ↓
   ⑤ 【发送网关】 ← 唯一的分叉点
        ├─ strict / system-trust
        │     └─ fetchSender：浏览器原生 fetch（带超时/重定向/cookie 策略）
        └─ native-bridge
              └─ bridgeSender：sendNativeMessage → Node https
        ↓
   ⑥ 读取响应 → ⑦ 后置脚本 → ⑧ 落库
```

**核心抽象**（保持核心层不碰 `chrome.*` 的既有原则）：

```ts
// src/core/http-sender.ts
export interface SendPayload {
  method: string;
  url: string;
  headers: Record<string, string>;
  body?: string;
  bodyBase64?: string;
  timeoutMs: number;
  followRedirects: boolean;
  sendCookies: boolean;
  /** SSL 决策 */
  ssl: { mode: SslMode; allowInsecure: boolean };
}

export interface SendResult {
  status: number;
  statusText: string;
  headers: Record<string, string>;
  body: string;
  bodyBase64: string | null;
  elapsedMs: number;
  finalUrl?: string;
  /** 本次是否跳过了证书校验（用于 UI 横幅和历史标记） */
  insecure: boolean;
}

export interface HttpSender {
  send(payload: SendPayload): Promise<SendResult>;
}
```

`ExecuteDeps` 增加一个可选依赖：

```ts
export interface ExecuteDeps {
  // ...现有
  /** 发送网关。默认使用浏览器原生 fetch；Service Worker 注入桥接版 */
  sender?: HttpSender;
}
```

**这个设计的好处**：
- 核心层依然不依赖 `chrome.*` → 单测在 Node 里直接跑（已有 63 条单测不受影响）
- 想测"跳过校验"路径，只需要注入一个假的 sender，不需要真的装伴生程序
- 未来想加别的传输方式（比如走系统代理）也是加一个 sender 实现

### 2.7 安全边界（必须写进代码和 UI）

| 规则 | 落地位置 |
|---|---|
| `allowInsecureTls` 默认 `false` | `DEFAULT_SETTINGS` |
| 跳过校验时，响应面板顶部显示醒目横幅"此响应未经证书校验" | `ResponsePanel` |
| 历史记录标记该次请求用了不安全模式 | `HistoryItem.insecure` 字段 |
| 打开开关时 UI 用警告色 + 一行说明"仅用于自签名/测试环境" | 设置弹窗 |
| 伴生程序只读 stdin/stdout，**不开任何端口**，不主动外联 | `bridge.mjs` |
| `allowed_origins` 精确到扩展 ID，不用通配符 | host manifest |
| 桥接请求**不携带**浏览器的 Cookie（避免跨进程泄露） | `bridge.mjs` 明确不实现 cookie jar |
| 不申请 `proxy` 权限，**绝不修改用户代理设置** | 延续 v1.1.0 的原则 |

### 2.8 方向一明确不做的事

- ❌ **不做"假开关"**：不能在扩展里捕获到证书错误后伪造一个成功响应。那会掩盖安全问题，比不给开关更糟。
- ❌ **不申请 `proxy` 权限**：Chrome 不允许它作为可选权限，且会触发"管理代理设置"的安装警告。工具只读观察，不改用户设置。
- ❌ **不自动修改系统信任库**：扩展没有这个权限，也不该有。提供引导和命令，让用户自己决定、自己执行。
- ❌ **不做全局请求拦截**（DNR）：与项目已定的"应用内拦截"边界保持一致。

---

## 3. 方向二：输入框智能补全

### 3.1 目标

用户在任何输入位置打字时，能"打两个字就出候选"，候选覆盖：

| 类别 | 触发写法 | 候选内容 |
|---|---|---|
| 环境/集合/全局变量 | `{{` | `{{host}}`、`{{token}}`… |
| 内置动态变量 | `{{$` | `{{$timestamp}}`、`{{$uuid}}`… |
| pm SDK 函数 | `pm.` | `pm.response`、`pm.environment.set`… |
| 断言方法 | `expect.` | `expect().to.have.status`… |
| 常用请求头 | 任意前缀 | `Authorization`、`Content-Type`… |
| 历史 URL | 任意前缀 | 最近用过的 URL 列表 |

### 3.2 补全引擎设计

**模块**：`src/core/completion.ts` —— **纯函数，不依赖 `chrome.*`**，可直接单测。

```ts
export type CompletionKind = 'variable' | 'builtin' | 'function' | 'header' | 'history' | 'method';

export interface CompletionItem {
  /** 实际插入输入框的文本 */
  insertText: string;
  /** 展示文本（可与 insertText 不同） */
  label: string;
  /** 右侧灰色说明 */
  detail?: string;
  kind: CompletionKind;
  /** 排序分，越大越靠前 */
  score: number;
}

/** 补全上下文：由 detectContext 从「文本 + 光标位置」推导 */
export interface CompletionContext {
  /** 触发方式 */
  trigger: 'brace' | 'dot' | 'word';
  /** 用户已输入的查询串 */
  query: string;
  /** 要被替换的文本区间 [start, end) */
  range: { start: number; end: number };
  /** 已经打开的大括号数（用于判断是否该补 `}}`） */
  needClosing: boolean;
}

/** 补全数据源 */
export interface CompletionSources {
  variables: {
    name: string;
    scope: 'environment' | 'collection' | 'globals' | 'session';
    value: string;
  }[];
  builtins: { name: string; description: string }[];
  apis: { path: string; signature: string; description: string }[];
  headers: { name: string; description: string }[];
  history: { url: string; method: string; lastUsed: number; useCount: number }[];
}

export function detectContext(text: string, cursor: number): CompletionContext | null;
export function computeCompletions(ctx: CompletionContext, sources: CompletionSources): CompletionItem[];
```

### 3.3 触发规则表

`detectContext` 的判定逻辑（从光标位置往左看）：

| 文本（`│` 是光标） | trigger | 替换区间 | 插入结果 |
|---|---|---|---|
| `https://api.{{ho│` | brace | 从 `{{` 到光标 | `https://api.{{host}}` |
| `{{$ti│` | brace | 从 `{{` 到光标 | `{{$timestamp}}` |
| `{{ host│` | brace | 从 `{{` 到光标 | `{{host}}` |
| `pm.resp│` | dot | 从 `pm.` 到光标 | `pm.response` |
| `pm.response.jo│` | dot | 从 `pm.` 到光标 | `pm.response.json()` |
| `expect(x).to.ha│` | dot | 从 `expect` 起 | `expect(x).to.have.status(200)` |
| `Autho│` | word | 光标处 | `Authorization` |
| `htt│` | word | 光标处 | `http://` |

**「往左看」的实现要点**：不能简单用 `lastIndexOf('{{')`，因为可能嵌套或跨字段。要**从光标向左扫描**，统计未闭合的 `{` 数量，找到最近的 `{{`；同时确认 `{{` 和光标之间**没有换行、没有 `}`**（有的话说明占位符已经闭合，不该触发）。

### 3.4 排序算法

```
score = kindBase + matchScore + usageScore
```

| 组成 | 规则 | 分值 |
|---|---|---|
| `kindBase` | function / builtin / variable / header / history / method | 70 / 60 / 50 / 30 / 20 / 40 |
| `matchScore` | 精确前缀匹配 | +100 |
| | 首字母缩写匹配（`hs` 匹配 `host`） | +60 |
| | 子串包含 | +40 |
| | 不匹配 | 过滤掉 |
| `usageScore` | 最近使用（`lastUsed` 越新越高） | 最高 +30 |
| | 使用频率（`useCount`） | 最高 +20 |

**去重规则**：同名变量出现在多个作用域时只保留优先级最高的（环境 > 集合 > 全局 > 会话），但 `detail` 里标注来源，例如 `环境变量 · dev`。

### 3.5 内置动态变量清单（从 `src/core/variables.ts` 导出）

现在 `dynamicFactories` 是一个私有对象，补全引擎需要它的键名和说明。建议重构为：

```ts
// src/core/variables.ts
export interface BuiltinVariable {
  name: string;
  description: string;
  /** 预览示例值（补全时展示给用户看） */
  preview: () => string;
}

export const BUILTIN_VARIABLES: BuiltinVariable[] = [
  { name: '$timestamp',    description: 'Unix 时间戳（秒）',   preview: () => String(Math.floor(Date.now() / 1000)) },
  { name: '$isoTimestamp', description: 'ISO 8601 时间字符串', preview: () => new Date().toISOString() },
  { name: '$uuid',         description: 'UUID v4',            preview: () => generateUuid() },
  { name: '$guid',         description: 'UUID v4（Postman 老名字）', preview: () => generateUuid() },
  { name: '$randomInt',    description: '0~1000 随机整数',      preview: () => String(Math.floor(Math.random() * 1001)) },
];

const dynamicFactories: Record<string, () => string> = Object.fromEntries(
  BUILTIN_VARIABLES.map((v) => [v.name, v.preview]),
);
```

**这是一个纯重构，现有行为不变**，63 条单测应全绿。

### 3.6 pm SDK API 清单

补全脚本里的 `pm.` / `expect.`，需要一个 API 描述表。建议在 `src/core/pm-sdk.raw.js` 旁边新建 `src/core/pm-api-catalog.ts`：

```ts
export interface ApiEntry {
  /** 完整路径，如 'pm.response.json' */
  path: string;
  /** 签名提示，如 'json()' */
  signature: string;
  /** 中文说明 */
  description: string;
}

export const PM_API_CATALOG: ApiEntry[] = [
  { path: 'pm.test',                    signature: '(name, fn)',  description: '注册一条断言' },
  { path: 'pm.expect',                  signature: '(value)',     description: 'chai 风格断言入口' },
  { path: 'pm.environment.get',         signature: '(key)',       description: '读环境变量' },
  { path: 'pm.environment.set',         signature: '(k, v)',      description: '写环境变量' },
  { path: 'pm.environment.unset',       signature: '(key)',       description: '删环境变量' },
  { path: 'pm.environment.has',         signature: '(key)',       description: '环境变量是否存在' },
  { path: 'pm.globals.get',             signature: '(key)',       description: '读全局变量' },
  { path: 'pm.globals.set',             signature: '(k, v)',      description: '写全局变量' },
  { path: 'pm.variables.get',           signature: '(key)',       description: '按作用域链读变量' },
  { path: 'pm.variables.set',           signature: '(k, v)',      description: '写会话变量' },
  { path: 'pm.request.method',          signature: '(get|set)',   description: '读写请求方法' },
  { path: 'pm.request.url.raw',         signature: '(get|set)',   description: '读写完整 URL' },
  { path: 'pm.request.headers.upsert',  signature: '(k, v)',      description: '新增/覆盖请求头' },
  { path: 'pm.request.headers.remove',  signature: '(k)',         description: '删除请求头' },
  { path: 'pm.request.headers.get',     signature: '(k)',         description: '读请求头' },
  { path: 'pm.request.body.raw',        signature: '(get|set)',   description: '读写请求体原文' },
  { path: 'pm.request.body.json',       signature: '()',          description: '把请求体当 JSON 解析' },
  { path: 'pm.response.code',           signature: '(get|set)',   description: '读写状态码' },
  { path: 'pm.response.status',         signature: '(get|set)',   description: '读写状态描述' },
  { path: 'pm.response.responseTime',   signature: '(get|set)',   description: '读写耗时' },
  { path: 'pm.response.size',           signature: '(get)',       description: '响应体大小' },
  { path: 'pm.response.headers.get',    signature: '(k)',         description: '读响应头' },
  { path: 'pm.response.json',           signature: '()',          description: '把响应体当 JSON 解析' },
  { path: 'pm.response.text',           signature: '()',          description: '读响应体文本' },
  { path: 'pm.response.to.have.status', signature: '(code)',      description: '断言状态码' },
  { path: 'pm.response.to.have.header', signature: '(k, v)',      description: '断言响应头' },
  { path: 'pm.response.to.have.jsonBody', signature: '(obj)',     description: '断言 JSON 字段' },
  { path: 'pm.response.to.be.json',     signature: '()',          description: '断言响应是 JSON' },
];
```

**这个清单要和 `pm-sdk.raw.js` 的实际实现保持同步**。建议加一条单测：遍历 `PM_API_CATALOG` 的每个 `path`，在沙箱里验证该路径确实存在——这样 SDK 改了而清单没改，测试会失败。

### 3.7 UI 组件设计

#### `SmartInput.tsx`

```tsx
export interface SmartInputProps {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  className?: string;
  /** 补全数据源 */
  sources: CompletionSources;
  /** 回车时（无补全候选时）触发 */
  onEnter?: () => void;
  /** 是否允许回车发送（URL 框为 true） */
  enterSends?: boolean;
}
```

**交互规范**：

| 操作 | 行为 |
|---|---|
| 输入字符 | 重新计算候选 → 有则显示浮层 |
| `↓` / `↑` | 移动选中项（循环） |
| `Tab` | 接受选中项（**不换行**，这是补全的标准键） |
| `Enter` | 有候选 → 接受候选；无候选 → 触发 `onEnter` |
| `Esc` | 关闭浮层（再按一次才允许 Esc 冒泡） |
| 鼠标悬停 | 改变选中项 |
| 鼠标点击候选项 | 接受 |
| 失焦 | 关闭浮层 |

**Enter 键的语义冲突**（必须处理）：现在 URL 输入框的 `Enter` 是"发送请求"。加了补全后，`Enter` 会和"接受补全"打架。

**解决方案**：
- `Enter` = 接受补全（若有候选）；无候选时才发送
- `Ctrl+Enter` = **始终发送**（不受候选影响）
- 发送按钮和顶栏的「发送」按钮行为不变

这一点要在 UI 上有提示（设置弹窗的快捷键说明里已经有一行，可以扩充）。

**浮层定位**：用 `position: absolute` + 输入框的 `getBoundingClientRect()` 计算，不引入第三方浮层库（避免依赖膨胀）。层级 `z-index` 要高于 `.app-main` 内的其他元素。

#### `SmartTextArea.tsx`

同理，用于 Body 的 raw 文本框和脚本编辑器。差异：
- 候选列表向上弹出（底部空间不足时）
- 脚本编辑器额外支持 `pm.` / `expect.` 的**链式**补全（如 `pm.response.to.have.` → 列出所有断言方法）

### 3.8 落点清单

| 位置 | 文件 | 组件 | 补全内容 |
|---|---|---|---|
| URL 输入框 | `src/dashboard/App.tsx` | SmartInput | 变量、内置变量、历史 URL、HTTP 方法 |
| Header 名 | `src/dashboard/components/KeyValueTable.tsx` | SmartInput | 常用请求头、变量 |
| Header 值 | 同上 | SmartInput | 变量 |
| Query 参数名/值 | 同上 | SmartInput | 变量、历史 URL |
| Body raw | `src/dashboard/components/BodyEditor.tsx` | SmartTextArea | 变量 |
| 前置/后置脚本 | `src/dashboard/components/ScriptEditor.tsx` | SmartTextArea | pm API、断言方法 |

### 3.9 与方向三-3 的联动

补全引擎的 `sources.variables` 和"变量缺失高亮"共用同一份变量清单 → 两者天然一致，不会出现"补全里有但高亮说没有"的矛盾。

用户在"未定义变量"提示上点击 → 弹出的候选就是补全引擎算出来的同一份列表。

---

## 4. 方向三：其他方便使用和定位的能力

### 4.1 Postman Collection v2.1 导入导出

#### 为什么值得做

Postman 是事实标准，用户手上大量现成集合。**导入能力 = 迁移成本归零**。这是本方向里投入产出比最高的一项。

#### 范围

| 功能 | 第一版是否做 | 说明 |
|---|---|---|
| 导入 Collection v2.1 | ✅ | 含嵌套文件夹、变量、脚本、鉴权 |
| 导出 Collection v2.1 | ✅ | 生成标准格式 |
| 导入 Environment | ✅ | Postman Environment 格式 |
| 导出 Environment | ✅ | |
| 导入 Postman v1 格式 | ❌ | 格式老旧，先不做 |
| 导入 cURL | ✅ 但已有 | `src/core/codelib.ts` 已有 cURL 解析 |
| 导入 HAR | ✅ 但已有 | 同上 |

#### 字段映射表

| Postman Collection v2.1 | 本项目 | 备注 |
|---|---|---|
| `info.name` | `Collection.name` | |
| `info.description` | `Collection.description` | |
| `info.schema` | — | 校验用，丢弃 |
| `item[].name` | `HttpRequest.name` | |
| `item[].request.method` | `HttpRequest.method` | 大写化 |
| `item[].request.url.raw` | `HttpRequest.url` | |
| `item[].request.url.host[]` + `path[]` | 拼接成 URL | Postman 用数组分段，**必须拼接** |
| `item[].request.url.query[]` | `HttpRequest.params` | `disabled` → `enabled=false` |
| `item[].request.header[]` | `HttpRequest.headers` | 同上 |
| `item[].request.body.raw` | `HttpRequest.body.raw` | |
| `item[].request.body.mode` | `HttpRequest.body.mode` | `urlencoded`→`form-urlencoded`，`file`→`binary` |
| `item[].request.auth` | `HttpRequest.auth` | 见下表 |
| `item[].event[].listen` | `preScript` / `postScript` | `prerequest`→pre，`test`→post |
| `item[].event[].script.exec` | 脚本文本 | 数组要 join 成字符串 |
| `item[].variable[]` | `Collection.variables` | 提升到集合级变量 |
| 顶层 `variable[]` | 新建 Environment | 需用户确认 |
| 嵌套 `item[]` | `Folder` | 用 `parentId` 还原层级 |
| `response[]`（示例响应） | ❌ | 本项目没有"示例响应"概念，先丢弃并计数 |

#### 鉴权映射

| Postman | 本项目 | 处理 |
|---|---|---|
| `noauth` | `none` | 直接映射 |
| `basic` | `basic` | 取 `basic[0].username/password` |
| `bearer` | `bearer` | 取 `bearer[0].token` |
| `apikey` | `apikey` | 取 `apikey[0].key/value/in` |
| `oauth2` | `oauth2` | 取 `oauth2[0].accessToken`（简化） |
| `digest` | `digest` | 映射但**提示未实现** |
| `hawk` / `awsv4` / `edgegrid` / `ntlm` | `none` | ⚠️ **降级 + 在导入报告中列出** |

**降级必须可见**：静默把 `awsv4` 变成 `none` 会让用户以为鉴权配好了，请求发出去却 403。导入报告要明确列出"3 个请求的 awsv4 鉴权不受支持，已降级为无鉴权"。

#### 模块设计

```
src/core/postman-importer.ts   纯函数，可单测
src/core/postman-exporter.ts   纯函数，可单测
```

```ts
// postman-importer.ts
export interface ImportResult {
  collections: Collection[];
  folders: Folder[];
  requests: HttpRequest[];
  environments: Environment[];
  /** 导入过程中的警告 */
  warnings: ImportWarning[];
  /** 统计 */
  stats: {
    collections: number;
    folders: number;
    requests: number;
    environments: number;
    /** 因不支持而被跳过的部分 */
    skipped: number;
  };
}

export interface ImportWarning {
  level: 'info' | 'warning';
  /** 出问题的请求名（如果有） */
  requestName?: string;
  message: string;
}

export function importPostmanCollection(json: unknown): ImportResult;
export function importPostmanEnvironment(json: unknown): ImportResult;
```

#### 导入 UX

```
用户点「导入 Postman 集合」→ 选 .json 文件
   ↓
先解析 + 预览（不写库）：
   ┌─────────────────────────────────────────┐
   │ 即将导入                                │
   │   集合   3 个                          │
   │   文件夹 5 个                          │
   │   请求   42 个                         │
   │   环境   2 个                          │
   │   ⚠ 3 个请求的 awsv4 鉴权不支持        │
   │   ⚠ 1 个请求的示例响应将被丢弃          │
   │                     [取消]  [确认导入]   │
   └─────────────────────────────────────────┘
   ↓
确认 → 写入 → 弹 toast「已导入 42 个请求」
```

**先预览后写入**很重要：导入是破坏性操作，用户需要知道会发生什么。

#### 导出

导出的 Collection 结构要与导入对称——**保证「导出 → 导入 → 导出」结果一致**，这是最好用的回归测试：往返一致性测试。

### 4.2 请求耗时瀑布图

#### 先说结论：精度受限于 API

F2 确认：`chrome.webRequest` 的事件详情里**没有** timing 字段。Chrome DevTools 的 Network 面板能显示 DNS/TCP/TLS 分段，是因为它走 DevTools 协议（`Network.responseReceived` 带 `timing`），那是**调试器专属**的接口。

所以扩展能拿到的最细粒度，是用 webRequest 各事件的时间戳做差：

```
onBeforeRequest   t0  → 请求即将发出
onSendHeaders     t1  → 请求头已就绪（t1-t0 = DNS + TCP + TLS + 代理 CONNECT，不可再分）
onResponseStarted t2  → 首字节到达（t2-t1 = 服务端处理 + 网络往返）
onCompleted       t3  → 响应体下载完成（t3-t2 = 下载）
```

画出来是三段：

```
┌─ 建立连接 ─┐┌──────── 服务端等待 ────────┐┌─ 下载 ─┐
│    45ms    ││            820ms           ││  12ms  │
└────────────┘└─────────────────────────────┘└────────┘
```

#### 一个重要的架构限制

那能不能上 `chrome.debugger` 拿真正的 5 段瀑布？**对我们的架构不适用**，原因是：

> **DevTools 协议是按标签页（tab）划分的。** `chrome.debugger.attach({ tabId }, ...)` 只能附加到某个标签页，而我们发出的请求**来自 Service Worker，不属于任何标签页**。所以即使拿到了 `debugger` 权限，也抓不到自己的请求。

（除非把请求改成"在某个标签页里发"，那会引入一整串新问题：需要开一个隐藏标签页、跨标签页传数据、用户能看到、可能被关掉。得不偿失。）

**结论：只做 webRequest 三段方案。** 诚实且正确。

**必须在 UI 上说明这个限制**，否则用户会问"为什么 DNS 和 TLS 分不开"。

#### 一个能显著提升实用性的补充：服务器 IP

`onCompleted` 和 `onBeforeRedirect` 的 `details.ip` 提供了**实际连接到的服务器 IP**。

这能回答一类高频问题："我请求的到底是哪台机器？"

- DNS 解析到了预期 IP 吗？
- 是不是被代理劫持到了别的 IP？（配合 `initiator` 和代理配置判断）
- 多机房部署时，实际落到了哪个节点？

把 `ip` 显示在耗时面板里，成本几乎为零，价值很实在。

#### 模块设计

```ts
// src/core/timing.ts
export interface RequestTiming {
  /** 各阶段耗时（毫秒） */
  phases: {
    /** 建立连接：DNS + TCP + TLS + 代理 CONNECT 合计 */
    connect: number;
    /** 服务端处理 + 网络往返 */
    waiting: number;
    /** 响应体下载 */
    download: number;
  };
  /** 实际连接到的服务器 IP */
  serverIp?: string;
  /** 是否走了缓存 */
  fromCache: boolean;
  /** 是否发生了重定向 */
  redirects: { from: string; to: string; statusCode: number }[];
  /** 数据来源：webRequest 观测 vs 纯本地计时 */
  source: 'webRequest' | 'local';
}

export function buildTiming(
  events: { onBeforeRequest?: number; onSendHeaders?: number;
            onResponseStarted?: number; onCompleted?: number },
  meta: { ip?: string; fromCache?: boolean } = {},
): RequestTiming;
```

**降级策略**：如果用户没开启"网络诊断"（也就是没授予 `webRequest` 权限），我们仍然有 Service Worker 里本地测的**总耗时**。这时耗时面板显示单段"总计 xxx ms"，并提示"开启网络诊断可看到分段耗时"。**不让可选权限成为基础功能的门槛**。

#### UI

在 `ResponsePanel` 加一个「耗时」标签页：

```
●─────────── 请求耗时 ────────────●

  建立连接      ▓▓ 45ms
  服务端等待    ▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓ 820ms
  下载          ▓ 12ms
  ─────────────────────────────
  总计          877ms
  服务器 IP     203.0.113.45
  缓存          未命中
```

### 4.3 变量缺失高亮 + 一键补全

#### 数据源已经存在，只是没人用

`src/core/variables.ts:96` 的 `interpolate()` **已经返回了 `missing: string[]`**（没解析出来的变量名列表），但当前 UI **完全没有使用**这个字段。

这是一个"数据已备好、只差 UI"的高性价比功能。

#### 模块设计

```ts
// src/core/variable-lint.ts
export interface VariableRef {
  /** 变量名（不含大括号） */
  name: string;
  /** 在文本中的位置 */
  index: number;
  /** 长度（含大括号） */
  length: number;
  /** 是否已定义 */
  defined: boolean;
  /** 已定义时的值（用于预览，敏感变量应脱敏） */
  value?: string;
  /** 已定义时的来源作用域 */
  scope?: 'environment' | 'collection' | 'globals' | 'session' | 'builtin';
}

export function extractVariableRefs(text: string): VariableRef[];
export function lintVariables(text: string, scope: VariableScope): VariableRef[];
```

`extractVariableRefs` 的正则直接复用 `interpolate` 里的 `/\{\{\s*([^{}]+?)\s*\}\}/g`，**保持两处解析规则一致**（建议抽成共享常量，避免以后改一处漏一处）。

#### UI 设计

**URL 输入框下方**（最显眼的位置）：

```
⚠ 2 个未定义变量：host、token     [一键补全]
```

点击变量名 → 弹出快速选择：

```
┌─ 选择 host 的值 ──────────────────┐
│ 环境变量  baseUrl     https://...  │
│ 环境变量  host       api.dev...   │
│ ＋ 新建变量 "host"                 │
└────────────────────────────────────┘
```

选中 → 自动把 `{{host}}` 填进 URL（如果位置已经有 `{{host}}`，则只更新值）。

**Header / Body 里的处理**：
- Body 的 raw 文本框无法在 textarea 里做富文本下划线 → 用**输入框下方的提示行**统一显示未定义变量清单（可点击定位到文本中的位置——通过 `setSelectionRange`）。
- 如果将来换用 CodeMirror 之类，可以做行内波浪线，但那是另一个量级的工程量，不在第一版范围。

**"一键补全"有两种理解，都要做**：
1. 点击未定义变量 → 从已有变量中选一个填进去
2. 批量：URL 里所有未定义变量一次性列出，点一个处理一个

#### 与敏感变量的配合

`Environment.secret` 字段（`src/shared/types.ts:158`）标记了敏感变量。显示未定义变量的预览值时，**必须对敏感变量脱敏**（显示 `••••`），否则等于在界面上泄露密码。

### 4.4 脚本错误行号定位

#### 事实基础

F7 已实测：QuickJS 的 stack 形如 `    at <eval> (user-post-script.js:3:11)`，行号与编辑器天然对齐。

现有代码 `src/core/sandbox.ts:252` 的 `describeError()` 已经把 stack 拼进了错误字符串：

```ts
return `${name}: ${message}${stack}`;
```

也就是说，**数据其实已经在错误消息里了**，只是没有结构化、没有 UI。

#### 模块设计

```ts
// src/core/script-error.ts
export interface ScriptErrorLocation {
  /** 1-based 行号 */
  line: number;
  /** 1-based 列号 */
  column: number;
  /** 脚本标识：'pre' | 'post' */
  phase: 'pre' | 'post';
}

export interface ScriptError {
  /** 错误类型名，如 'ReferenceError' */
  name: string;
  /** 错误消息 */
  message: string;
  /** 原始堆栈 */
  stack?: string;
  /** 解析出的位置（解析失败则为 undefined） */
  location?: ScriptErrorLocation;
}

/** 从 QuickJS stack 中解析行列号 */
export function parseScriptError(stack: string, phase: 'pre' | 'post'): ScriptErrorLocation | null;
```

**正则**：`/(?:at\s+<?eval>?\s*\()?user-(pre|post)-script\.js:(\d+):(\d+)/`

需要同时匹配两种格式：
- `    at <eval> (user-post-script.js:3:11)` —— 运行时错误
- `    at user-post-script.js:1:11` —— 语法错误（没有 `<eval>` 和括号）

所以正则要写成两段可选。

#### 数据模型变更（破坏性）

`ScriptOutcome.error` 和 `ExecutionResult.error` 目前都是 `string`。要带上位置，得升级为结构化：

```ts
export interface ScriptOutcome {
  // ...
  /** 脚本整体抛错时的信息 */
  error?: ScriptError;      // ← 从 string 改成 ScriptError
}

export interface ExecutionResult {
  // ...
  /** 脚本抛错（结构化，含行列号） */
  error?: ScriptError;
  /** 网络层失败（保持字符串，这类错误没有行号） */
  networkError?: string;
}
```

**影响面**（必须在实现时全局排查）：
- `src/core/request-executor.ts`：组装 `ExecutionResult` 的地方
- `src/core/sandbox.ts`：`SandboxOutput.error` 的类型
- `src/dashboard/store.ts`：`send()` 里的 `result.error` 判断与 toast
- `src/dashboard/components/ResponsePanel.tsx`：Console 面板的错误显示
- `tests/executor.test.ts`、`tests/sandbox.test.ts`：断言里的 `error` 字符串比较

**建议**：为了平滑过渡，可以保留一个 `errorText` 便捷 getter，或者在升级的同一个 PR 里一次性改完（这个项目规模不大，一次改完更干净）。

#### UI 设计

**ScriptEditor 需要重写**（现在只有 1.1 KB，非常薄）。

```
┌─ 前置脚本 ──────────────────────────────────┐
│ 1  pm.environment.set('token', 'abc');    │
│ 2                                         │
│ 3  pm.request.headers.upsert(             │
│ 4    { key: 'X-Token', value: 'abc' }     │
│ 5  );                                      │
│ 6                                         │
│ 7  pm.response.to.have.status(200);  ← 报错行标红
└────────────────────────────────────────────┘
```

**行号槽（gutter）实现方案**：

textarea 本身不支持行号。两种做法：

| 方案 | 做法 | 复杂度 | 推荐 |
|---|---|---|---|
| A. 绝对定位的 gutter div | textarea 左侧放一个 `<div>` 渲染行号，滚动时用 `onScroll` 同步 `scrollTop` | 低 | ✅ |
| B. 换用 CodeMirror 6 | 功能强大（语法高亮、折叠、跳转） | 高（+300KB 依赖） | ❌ 第一版不做 |

选 A。行号槽的宽度根据最大行号动态调整。

**错误定位交互**：
1. 脚本执行失败，Console 面板显示错误条目
2. 错误条目上显示「第 3 行」的可点击标签
3. 点击 → 自动切到对应标签页（前置/后置）→ 高亮该行 → 光标跳到该行（`textarea.setSelectionRange` + `focus()`）
4. 高亮用临时 CSS class，3 秒后淡出

**已知边界**（要写进文档）：

| 情况 | 有无行号 | 原因 |
|---|---|---|
| 运行时错误（ReferenceError、TypeError） | ✅ 有 | QuickJS stack 包含位置 |
| 语法错误 | ✅ 有 | 编译期错误也带位置（实测场景 3） |
| 超时中断（死循环） | ❌ 没有 | 中断不是异常，没有 stack |
| `console.log` 的日志 | ❌ 没有 | 日志由 SDK 的 `log()` 函数产生，栈帧在 SDK 内部 |

最后一条如果要解决，需要 QuickJS 的 `dump()` + 堆栈回溯能力，成本高、收益低，**第一版明确不做**。

---

## 5. 架构影响总览

### 5.1 新增文件

```
src/core/completion.ts               补全引擎（纯函数）
src/core/variable-lint.ts            变量引用提取与检查（纯函数）
src/core/postman-importer.ts         Postman v2.1 导入（纯函数）
src/core/postman-exporter.ts         Postman v2.1 导出（纯函数）
src/core/script-error.ts             错误行号解析（纯函数）
src/core/timing.ts                   耗时分段计算（纯函数）
src/core/pm-api-catalog.ts           pm SDK API 描述表
src/core/http-sender.ts              发送网关接口 + fetch 实现
src/core/native-bridge.ts            伴生程序客户端
src/dashboard/components/SmartInput.tsx
src/dashboard/components/SmartTextArea.tsx
src/dashboard/components/TimingPanel.tsx
native-host/bridge.mjs               伴生程序（Node，零依赖）
native-host/com.chrome_postman.bridge.json
native-host/install-host.ps1
native-host/install-host.sh
native-host/README.md
```

**注意 `src/core/` 下的新模块全部是纯函数**（不碰 `chrome.*`、不碰 DOM），这是项目既有的核心层约定——单测在 Node 里直接跑，无需浏览器。

### 5.2 修改文件

```
src/shared/types.ts                   加 SslMode / ScriptError / VariableRef / CompletionItem 等
src/core/variables.ts                 导出 BUILTIN_VARIABLES（纯重构）
src/core/sandbox.ts                   error 升级为结构化
src/core/request-executor.ts          插入发送网关；ExecuteDeps 加 sender
src/background/service-worker.ts      注入 bridgeSender；webRequest 采集 timing
src/dashboard/store.ts                加 timing / bridgeStatus / sslMode 状态
src/dashboard/App.tsx                 URL 框换 SmartInput；设置弹窗加 SSL 区块
src/dashboard/components/KeyValueTable.tsx   换 SmartInput
src/dashboard/components/BodyEditor.tsx      raw 换 SmartTextArea
src/dashboard/components/ScriptEditor.tsx    重写（行号槽 + 错误跳转）
src/dashboard/components/ResponsePanel.tsx   加「耗时」标签页
src/dashboard/styles.css              补全浮层 / 瀑布图 / 错误高亮样式
public/manifest.json                  加 nativeMessaging（可选权限，见 5.3）
```

### 5.3 权限变化

| 权限 | 方式 | 用途 | 风险 |
|---|---|---|---|
| `webRequest` | 已有（可选权限） | 网络诊断 + 耗时分段 | 低（已实现，v1.1.0） |
| `nativeMessaging` | **新增** | 连接本地伴生程序 | **高**：可启动本机程序 |
| `host_permissions` | **不申请** | —— | 避免 `<all_urls>`（商店重灾区） |

**关于 `nativeMessaging` 作为可选权限**：需要实现时验证 Chrome 是否接受它出现在 `optional_permissions` 里（而不是必须放 `permissions`）。如果只能放 `permissions`，则：

- 意味着**所有用户**在安装时都会看到"启动本机程序"的警告
- 对一个"API 调试工具"来说这个警告是合理且可解释的（Postman 类工具都需要本地代理）
- 但会降低普通用户的安装转化率

**替代方案**：把伴生程序做成**完全独立于扩展的分支/构建产物**（`native-host/` 目录单独分发），扩展在**检测到伴生程序存在时**才提示用户去安装。这样 `nativeMessaging` 权限可以放在 `optional_permissions`，只在用户真的要用时才申请。

**建议**：按上面这个方案做——**扩展的默认安装体验不受影响，需要真开关的人才去装伴生程序**。

### 5.4 消息协议变化

```ts
// WorkerRequest 新增
| { type: 'BRIDGE_PING';     payload: { requestId: string } }
| { type: 'INSPECT_CERT';    payload: { requestId: string; url: string } }

// WorkerResponse 新增
| { type: 'BRIDGE_STATUS';   payload: { requestId: string; available: boolean; version?: string; error?: string } }
| { type: 'CERT_INFO';      payload: { requestId: string; cert: CertificateInfo | null } }
```

### 5.5 数据流总图

```
┌────────────────────── Dashboard (React) ──────────────────────┐
│  SmartInput / SmartTextArea ← CompletionSources ← store        │
│  ScriptEditor  ← ScriptError.location                          │
│  ResponsePanel  ← timing / diagnostic / certificate            │
└───────────────────────────┬───────────────────────────────────┘
                            │ chrome.runtime.sendMessage
┌───────────────────────────▼───────────────────────────────────┐
│  Service Worker                                                 │
│    ├─ 消息路由                                                  │
│    ├─ 变量作用域装配                                             │
│    ├─ HttpSender 选择（fetch / bridge）                          │
│    ├─ webRequest 监听（诊断 + timing）                           │
│    └─ 历史落盘（IndexedDB）                                       │
└──────┬──────────────────────────────┬──────────────────────────┘
       │ fetch (strict)                │ sendNativeMessage
       ▼                               ▼
  浏览器网络栈                    ┌──────────────────────┐
  （证书强校验）                    │ bridge.mjs (Node)     │
                                  │ https + rejectUnauthorized:false
                                  │ socket.getPeerCertificate()
                                  └──────────┬───────────┘
                                             ▼
                                          目标服务器
```

---

## 6. 实施顺序建议

分 **5 个批次**，每批可独立发布、独立验证。排序原则：**先做零新增权限、纯本地、能立刻提升体验的**。

### 批次 1：变量缺失高亮 + 脚本错误行号（零新增权限）

| 项 | 内容 |
|---|---|
| 新增 | `src/core/variable-lint.ts`、`src/core/script-error.ts` |
| 修改 | `sandbox.ts`（error 结构化）、`ScriptEditor.tsx`（重写）、`store.ts`、`ResponsePanel.tsx` |
| 破坏性变更 | `ScriptOutcome.error` / `ExecutionResult.error` 类型变更 |
| 验收 | 单测 ≥12 条；e2e：故意写错脚本 → Console 显示「第 3 行」→ 点击跳转成功 |

### 批次 2：输入框智能补全（零新增权限）

| 项 | 内容 |
|---|---|
| 新增 | `src/core/completion.ts`、`pm-api-catalog.ts`、`SmartInput.tsx`、`SmartTextArea.tsx` |
| 修改 | `App.tsx`、`KeyValueTable.tsx`、`BodyEditor.tsx`、`ScriptEditor.tsx`、`variables.ts`（导出内置变量清单） |
| 验收 | 单测 ≥20 条（触发规则、排序、去重）；e2e：输入 `{{` 出候选、Tab 接受、`Ctrl+Enter` 仍能发送 |

### 批次 3：Postman v2.1 导入导出（零新增权限）

| 项 | 内容 |
|---|---|
| 新增 | `src/core/postman-importer.ts`、`postman-exporter.ts` |
| 测试夹具 | `tests/fixtures/postman/*.json`（3 个真实结构的样例） |
| 验收 | 单测 ≥25 条；**往返一致性测试**（导出→导入→导出，三次结果等价） |

### 批次 4：耗时分段（复用已有可选权限）

| 项 | 内容 |
|---|---|
| 新增 | `src/core/timing.ts`、`TimingPanel.tsx` |
| 修改 | `service-worker.ts`（采集事件时间戳）、`ResponsePanel.tsx` |
| 验收 | 单测 ≥8 条（各阶段差值计算）；e2e：开启诊断后看到三段耗时 |

### 批次 5：SSL 模式 + Native 伴生程序（架构性，最重）

| 项 | 内容 |
|---|---|
| 新增 | `src/core/http-sender.ts`、`native-bridge.ts`、`native-host/*`、`src/core/certificate.ts` |
| 修改 | `request-executor.ts`、`service-worker.ts`、`store.ts`、`App.tsx`（设置）、`manifest.json` |
| 验收 | 单测 ≥15 条（发送网关分叉、证书解析）；**实机验证**：Windows 装伴生程序 → 访问自签证书 HTTPS → 成功 + 证书体检信息正确 + 不安全模式有横幅 |

---

## 7. 验收标准汇总

### 通用（每批次都必须满足）

- [ ] `npm run typecheck` 零错误
- [ ] `npx vitest run` 全部通过（**不得减少现有 63 条**）
- [ ] `npm run build:all` 成功
- [ ] `node scripts/e2e-verify.mjs` 8/8 通过（现有回归不破）
- [ ] 手工验证：改完能在 Chrome 里真跑

### 方向一专项

- [ ] 扩展**不**申请 `proxy` 权限，**不**修改用户代理设置
- [ ] 开关打开但桥接未就绪时，有明确提示，**不静默降级**
- [ ] 跳过校验的响应带醒目横幅
- [ ] 伴生程序 stdout 只有协议帧（可被测试断言）
- [ ] `allowed_origins` 无通配符

### 方向二专项

- [ ] `Enter` 接受补全，`Ctrl+Enter` 始终发送
- [ ] 补全列表支持 ↑↓ / Tab / Esc / 点击
- [ ] 补全数据源与实际变量作用域一致（不会出现"补全里有、高亮说没有"）

### 方向三专项

- [ ] Postman 导入：unsupported 鉴权类型**降级可见**（导入报告里列出）
- [ ] 导入前有预览
- [ ] 导出→导入→导出一致
- [ ] 敏感变量的值在 UI 上脱敏
- [ ] 耗时分段不可用时（没开诊断）降级为单段总耗时并说明原因
- [ ] 脚本错误行号与编辑器行号一致（用同一个 10 行脚本验证两次）

---

## 8. 附录

### 8.1 想改 X 该动哪里

| 想做的事 | 要改的文件 | 大致位置 |
|---|---|---|
| 加一个新的内置动态变量 | `src/core/variables.ts` | `BUILTIN_VARIABLES` 数组 |
| 加一条新的 pm SDK API | `src/core/pm-sdk.raw.js` + `src/core/pm-api-catalog.ts` | 两处都要改（有单测盯着） |
| 改补全的排序规则 | `src/core/completion.ts` | `computeCompletions` |
| 加一个新的补全触发词 | `src/core/completion.ts` | `detectContext` |
| 让某个输入框支持补全 | 换成 `SmartInput` / `SmartTextArea` | 传 `sources` |
| 改请求的发送方式（加新传输） | `src/core/http-sender.ts` | 加一个 `HttpSender` 实现 |
| 改 SSL 模式的行为 | `src/core/http-sender.ts` + `src/core/request-executor.ts` | `SendPayload.ssl` |
| 加一条新的网络错误码 | `src/core/network-diagnostics.ts` | 错误码知识库 |
| 改诊断建议文案 | `src/core/network-diagnostics.ts` | 知识库条目的 `suggestions` |
| 支持新的 Postman 鉴权类型 | `src/core/postman-importer.ts` | 鉴权映射表 |
| 改耗时分的段方式 | `src/core/timing.ts` | `buildTiming` |
| 改脚本错误的行号解析 | `src/core/script-error.ts` | `parseScriptError` 正则 |
| 加一条新的 Worker 消息 | `src/shared/messages.ts` + `src/background/service-worker.ts` | 两处 |

### 8.2 术语表

| 术语 | 含义 |
|---|---|
| **Manifest V3 (MV3)** | Chrome 扩展的第三代清单格式。用 Service Worker 代替常驻后台页，禁止远程代码 |
| **Service Worker** | MV3 的后台脚本。**生命周期不固定**，随时可能被浏览器休眠或杀掉 |
| **host_permissions** | 声明扩展能访问哪些域名。`<all_urls>` = 所有站点，是商店审核的重灾区 |
| **optional_permissions** | 可选权限。安装时不授予，用户在用时点按钮才授予（`chrome.permissions.request`） |
| **native messaging** | Chrome 官方提供的扩展 ↔ 本机程序通信通道。**唯一**的官方越界机制 |
| **native host manifest** | 描述伴生程序位置和授权扩展的 JSON 文件。Windows 上通过注册表注册 |
| **QuickJS** | 用 C 写的 JavaScript 引擎，可编译成 WASM。本项目用它做用户脚本沙箱 |
| **WASM 沙箱** | 把用户脚本放进独立的 JS 引擎里跑，拿不到 DOM / `chrome.*` / 网络 |
| **PM SDK** | Postman 兼容的脚本 API（`pm.request` / `pm.response` / `pm.test` …） |
| **SPKI** | SubjectPublicKeyInfo，证书里的公钥部分。`--ignore-certificate-errors-spki-list` 用的就是它的 SHA-256 |
| **MITM** | Man-in-the-Middle，中间人攻击/中间人代理。代理做 HTTPS 解密时就是它 |
| **CONNECT 隧道** | HTTP 代理用来建立 HTTPS 连接的方式：客户端先发 `CONNECT host:443` |
| **CA / 根证书** | Certificate Authority。签发证书的机构。装进系统信任库后浏览器就信任它签的证书 |
| **SAN** | Subject Alternative Name。证书里的域名列表。现代浏览器**只看 SAN**，不看 CN |
| **extraInfoSpec** | webRequest 的 `addListener` 第三个参数，声明要额外拿哪些数据（如响应头） |
| **往返一致性** | 导出 → 导入 → 导出，三次结果等价。用来证明导入导出是对称的 |

### 8.3 自测题（做完实现后用来验证）

**方向一 · SSL**

1. 为什么 MV3 扩展不能在 `fetch` 里设置 `rejectUnauthorized: false`？请从 TLS 握手发生在哪一层来解释。
2. 我们实测发现 `webRequest` 的 `securityInfo` 返回 `null`。这意味着"扩展读到了证书"和"扩展能跳过证书校验"哪个是成立的？
3. 如果用户打开了"跳过证书校验"但没装伴生程序，工具应该怎么表现？为什么不能静默降级成严格校验？
4. 一个自签名证书的 Subject 和 Issuer 相同，这说明什么？如果用户把它装进「受信任的根证书颁发机构」，有什么风险？
5. `allowed_origins` 为什么不能写 `chrome-extension://*/*`？

**方向二 · 补全**

6. `detectContext` 为什么要从光标位置**往左扫描**，而不是直接用 `lastIndexOf('{{')`？
7. 用户在 URL 输入框里按 `Enter`，此时恰好有补全候选弹出，应该怎么处理？为什么 `Ctrl+Enter` 仍然要保留"总是发送"的语义？
8. 同一个变量名在环境变量和集合变量里都存在，补全列表里应该显示几条？

**方向三 · 四项能力**

9. Postman 的 `url.host` 是一个数组（`["api","example","com"]`），我们存 URL 是一个字符串，导入时该怎么处理？`url.path` 里的变量（`{{id}}`）应该怎么处理？
10. 我们的耗时方案拿不到 DNS/TCP/TLS 的细分，为什么 `chrome.debugger` 也救不了这个问题？（提示：DevTools 协议是按什么划分的？）
11. `interpolate()` 返回的 `missing` 字段现在在 UI 上完全没被使用，这属于哪一类问题？
12. QuickJS 的错误行号为什么能和编辑器里的行号天然对齐？依赖了 `sandbox.ts` 里的哪一行代码？
13. 脚本超时（死循环）被杀时，为什么拿不到行号？

### 8.4 事实基线的复现脚本

本文档 §1 的每条 `[实测]` 结论都有对应的可执行脚本：

```bash
# F7：QuickJS 错误栈的行号/列号格式
node scripts/probe-quickjs-error-line.mjs

# F3 / F4 / F5 / F6：webRequest 的可见范围与 securityInfo
node scripts/probe-security-info.mjs            # headless
node scripts/probe-security-info.mjs --headful  # 有头模式（窗口挪到屏幕外）
```

`probe-security-info.mjs` 的用法说明：它会复制一份 `dist/` 作为"测试变体"（把 `webRequest` 提为必需权限、加上 `<all_urls>` host 权限），通过 CDP 加载进真实 Chrome，然后注册四组不同的监听器并发起真实请求，最后打印每组监听器的触发情况。

**用它来验证文档里的每条结论，也用来在实现过程中回归。**

---

## 9. 未决问题

| 问题 | 影响 | 建议 |
|---|---|---|
| `nativeMessaging` 能否作为可选权限 | 决定扩展默认安装是否显示"启动本机程序"警告 | 实现批次 5 时实测 |
| Postman 环境变量导入时，是新建环境还是合并到当前环境 | 影响导入 UX | 导入预览里让用户选 |
| 是否支持 Postman 的 `prerequest`/`test` 事件里的多个脚本 | 低频 | 合并成一个脚本（用换行拼接） |
| 耗时分段是否值得为它单独申请 `webRequest` | 已经因为诊断功能申请了 | 复用，零额外成本 |

---

**文档版本**：v1.2 设计稿 · 基于 v1.1.0（已发布）
**事实基线采集环境**：Windows 11 · Chrome 156.0.8078.81 · Node v25.3.0
