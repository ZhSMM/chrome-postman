# Chrome Postman —— Native Messaging 伴生程序

> 目录里的三个文件是一套东西，缺一不可：
> `bridge.mjs`（伴生程序本体）、`com.chrome_postman.bridge.json`（host manifest）、
> `install-host.ps1` / `install-host.sh`（安装脚本）。
> 扩展通过 `chrome.runtime.sendNativeMessage('com.chrome_postman.bridge', ...)` 和它说话。

---

## 1. 这是什么，为什么需要它

### 1.1 一句话

**浏览器的沙箱里关不掉 TLS 证书校验，但沙箱外的 Node 可以。**

### 1.2 展开讲

你在 Postman / Chrome Postman 里最想干的一件事是「这个接口用的是自签证书 / 过期证书 /
公司内部 CA 签的证书，能不能先别拦我，让我把请求打通」。

但扩展跑在浏览器进程里，受 Web 平台的安全约束：

| 能力 | 浏览器里的扩展 | Node 的 https 模块 |
| --- | --- | --- |
| `rejectUnauthorized: false`（关闭证书校验） | ❌ **没有这个选项** | ✅ 有 |
| 读取对端证书链 | ❌ `fetch` 不给 | ✅ `socket.getPeerCertificate(true)` |
| 算 SPKI 指纹 | ❌ 拿不到证书就算不出 | ✅ 有证书就能算 |

浏览器不是"忘了"给你这个开关，是**刻意不给**的。任何扩展只要能关掉证书校验，
就等于给了恶意扩展一个中间人攻击的起点。所以 Chrome 官方唯一提供的越界通道
就是 **Native Messaging**：扩展可以通过它启动一个**不在沙箱里**的本地程序。

于是就有了这个伴生程序：

```
扩展（沙箱内）
   │  chrome.runtime.sendNativeMessage('com.chrome_postman.bridge', msg)
   │  stdin: [4 字节小端长度][UTF-8 JSON]
   ▼
本机伴生程序（Node 进程，沙箱外）
   │  https.request({ rejectUnauthorized: false })   ← 浏览器给不了的开关在这里
   ▼
目标服务器
```

### 1.3 它的第二个职责：证书体检

扩展**读不到**对端证书（这是 Web 平台的硬限制），但伴生程序可以。于是伴生程序
不只是一个"关校验的通道"，还是一个**证书探针**：

扩展发一个 `inspect-cert`，就能拿到：

- 签发者（Issuer）、使用者（Subject）、组织名
- 有效期（还剩多少天过期）
- SAN 域名列表（证书到底覆盖哪些域名）
- 是否自签名
- 完整证书链
- 证书指纹 + **SPKI 指纹**

有了这些，扩展才能画出「证书体检报告」，并且在用户装 CA 之前就告诉他
「你这张证书是自签的，装之前请确认签发者」。

---

## 2. 消息协议

### 2.1 帧格式（Chrome native messaging 标准）

```
[4 字节小端长度][UTF-8 JSON 载荷]
```

- 长度 = JSON 载荷的**字节数**（不是字符数）
- 单条消息上限 **1MB**（Chrome 的硬限制）
- **stdout 只能输出协议帧**，所有日志必须走 stderr（否则 Chrome 会直接报通信错误）

### 2.2 三种 action

| action | 请求 | 成功响应 | 失败响应 |
| --- | --- | --- | --- |
| `ping` | `{ id, action: 'ping' }` | `{ id, ok: true, version: '1.0.0' }` | — |
| `http` | `{ id, action: 'http', req: {...} }` | `{ id, ok: true, res: {...} }` | `{ id, ok: false, error: { code, message, cert? } }` |
| `inspect-cert` | `{ id, action: 'inspect-cert', req: { url, timeoutMs } }` | `{ id, ok: true, cert: {...} }` | `{ id, ok: false, error: { code, message } }` |

#### `http` 的 `req` 字段

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `method` | string | 默认 `GET` |
| `url` | string | 必填，支持 `http://` 和 `https://` |
| `headers` | object \| [k,v][] | 请求头，键会被转成小写 |
| `body` | string | 文本请求体 |
| `bodyBase64` | string | 二进制请求体（base64），优先级高于 `body` |
| `timeoutMs` | number | 默认 30000 |
| `rejectUnauthorized` | boolean | **默认 true（严格校验）**；`false` 才关闭证书校验 ← 核心开关 |
| `servername` | string | SNI 覆盖，IP 直连或证书域名不一致时可能需要 |

#### `http` 成功响应的 `res` 字段

| 字段 | 说明 |
| --- | --- |
| `status` / `statusText` | HTTP 状态码 / 状态文本 |
| `headers` | 响应头对象（键为小写；`set-cookie` 之类是数组） |
| `body` | 文本响应体；**二进制响应时为 `null`** |
| `bodyBase64` | 二进制响应体（base64）；**文本响应时为 `null`** |
| `elapsedMs` | 耗时（毫秒） |
| `finalUrl` | 跟随重定向之后的最终 URL |

> `body` / `bodyBase64` 二选一，由响应的 `content-type` 判断：
> `text/*`、`application/json`、`application/xml`、`+json`、`+xml` 走文本，其余走 base64。

#### `cert` 字段

| 字段 | 说明 |
| --- | --- |
| `subject` / `issuer` | `{ commonName, organization }` |
| `validFrom` / `validTo` | ISO 8601 时间 |
| `san[]` | 证书覆盖的域名列表 |
| `sha256` | **整张证书**的 SHA-256 指纹，格式 `AB:CD:EF:...` |
| `spkiSha256Base64` | **公钥 SPKI** 的 SHA-256（base64）← 见 §5 |
| `selfSigned` | 是否自签名 |
| `chain[]` | 证书链，每项 `{ subject, issuer, validFrom, validTo, sha256 }` |

#### 错误码

| code | 含义 |
| --- | --- |
| `CERT_HAS_EXPIRED` | 证书已过期 |
| `CERT_NOT_YET_VALID` | 证书尚未生效 |
| `CERT_HOSTNAME_MISMATCH` | 证书的 SAN 不包含这个域名 |
| `SELF_SIGNED_CERT` | 自签名证书 |
| `CERT_UNTRUSTED` | 签发者不在本机信任库 |
| `CONNECTION_REFUSED` / `DNS_NOT_FOUND` / `TIMEOUT` / `CONNECTION_RESET` | 网络类错误 |
| `RESPONSE_TOO_LARGE` | 响应超过 1MB |
| `UNKNOWN_ACTION` / `INVALID_JSON` / `INTERNAL_ERROR` | 协议类错误 |

> **证书类错误会自动附带 `cert` 详情**（`error.cert`）。
> Node 自己不一定给准确的证书错误码（实测自签证书会被报成 `ECONNRESET`），
> 所以伴生程序在 HTTPS 请求失败后会再连一次（`rejectUnauthorized: false`），
> 把证书拿到手自己判断病因，扩展才能给出「装 CA / 开跳过校验 / 改域名」这些对应引导。

---

## 3. 安装

### 3.0 前置条件

- **Node.js 18 或更高版本**（`node --version` 能跑通就行）
- 先在 `chrome://extensions` 里把扩展加载好（否则拿不到扩展 ID）

### 3.1 Windows

```powershell
# 在 native-host/ 目录下执行
powershell -NoProfile -ExecutionPolicy Bypass -File .\install-host.ps1 -ExtensionId 你的扩展ID
```

脚本做了这些事：

1. 把 `bridge.mjs` + manifest 复制到 `%LOCALAPPDATA%\ChromePostman`
2. 生成 `bridge.cmd` 启动包装器
   （**为什么需要**：Chrome 在 Windows 上只会启动 `.exe` / `.bat` / `.cmd`，
   `.mjs` 不是 Windows 可执行文件，也没有 shebang 机制）
3. 把 manifest 里的 `allowed_origins` 换成你的扩展 ID、`path` 换成 `bridge.cmd` 的绝对路径
4. 写注册表 `HKCU\Software\Google\Chrome\NativeMessagingHosts\com.chrome_postman.bridge`
   （**当前用户，不需要管理员权限**）

其它浏览器换一个参数即可：

```powershell
.\install-host.ps1 -ExtensionId 你的扩展ID -Browser Edge      # Edge
.\install-host.ps1 -ExtensionId 你的扩展ID -Browser Chromium  # Chromium
```

**装完必须完全退出并重启 Chrome** —— Chrome 只在启动时读注册表，运行中改不生效。

> `install-host.ps1` 保存为 **UTF-8 with BOM**（Windows PowerShell 5.1 按 ANSI 读无 BOM 的
> `.ps1` 会让中文变乱码）。如果你手工改过这个文件，记得另存为「UTF-8 with BOM」。

### 3.2 Linux

```bash
cd native-host
chmod +x install-host.sh
./install-host.sh -ExtensionId 你的扩展ID
```

默认装到：

- Chrome → `~/.config/google-chrome/NativeMessagingHosts/`
- Chromium → `~/.config/chromium/NativeMessagingHosts/`
- Edge → `~/.config/microsoft-edge/NativeMessagingHosts/`

脚本会自动挑一个已存在的那个（看你到底在用哪个浏览器），并给 `bridge.mjs` 加可执行权限。

### 3.3 macOS

同一个脚本，目录不同：

- Chrome → `~/Library/Application Support/Google/Chrome/NativeMessagingHosts/`
- Chromium → `~/Library/Application Support/Chromium/NativeMessagingHosts/`
- Edge → `~/Library/Application Support/Microsoft Edge/NativeMessagingHosts/`

```bash
./install-host.sh -ExtensionId 你的扩展ID
```

### 3.4 手工安装（想自己控制放哪）

```bash
# Linux
mkdir -p ~/.config/google-chrome/NativeMessagingHosts
cp bridge.mjs ~/.config/google-chrome/NativeMessagingHosts/
chmod +x ~/.config/google-chrome/NativeMessagingHosts/bridge.mjs
# 然后把 com.chrome_postman.bridge.json 复制过去，改成：
#   "path": "/你的绝对路径/bridge.mjs"
#   "allowed_origins": ["chrome-extension://你的扩展ID/"]
```

```powershell
# Windows
$dir = "$env:LOCALAPPDATA\ChromePostman"
New-Item -ItemType Directory -Force -Path $dir | Out-Null
Copy-Item .\bridge.mjs "$dir\bridge.mjs"
Copy-Item .\com.chrome_postman.bridge.json "$dir\"
reg add "HKCU\Software\Google\Chrome\NativeMessagingHosts\com.chrome_postman.bridge" /ve /d "$dir\com.chrome_postman.bridge.json" /f
# 注意：Windows 还要额外建一个 bridge.cmd，并让 manifest 的 path 指向它
```

---

## 4. `allowed_origins` 必须是精确的扩展 ID

```json
"allowed_origins": ["chrome-extension://abcdefghijklmnopabcdefghijklmnop/"]
```

**Chrome 不允许通配符。** 写 `chrome-extension://*` 是无效的，Chrome 会直接拒绝连接。
仓库里的 manifest 故意留了占位符 `REPLACE_WITH_YOUR_EXTENSION_ID`，
就是为了提醒你：**这个值必须由你填成真实的 ID**，安装脚本会自动帮你填。

### 怎么拿到扩展 ID

1. 浏览器打开 `chrome://extensions`
2. 右上角打开「开发者模式」
3. 找到 "Chrome Postman" 卡片，复制上面的 **ID**（32 位，字符范围 `a-p`）

### 开发模式下 ID 会变

unpacked 扩展的 ID 是根据**目录路径**算出来的，所以换个目录、换个盘符，
ID 就变了。三个应对办法：

| 办法 | 做法 | 评价 |
| --- | --- | --- |
| A. 固定 ID | 在扩展 `manifest.json` 里加 `"key"` 字段（用商店版扩展的公钥） | ★★★ 最干净，ID 永久固定 |
| B. 重新注册 | ID 变了就重跑一次安装脚本 | ★★ 简单 |
| C. 扩展内一键生成 | 设置页提供「复制注册命令」按钮，自动填 `chrome.runtime.id` | ★★★ 用户体验最好 |

推荐 **A + C**：正式发布用 A 固定 ID，开发时用 C 免得每次重装。

---

## 5. `spkiSha256Base64` 是干什么的

这是本目录里最容易被忽略、但最有用的一个字段。

Chrome 有一个启动参数：

```
--ignore-certificate-errors-spki-list=<base64 指纹1>,<base64 指纹2>,...
```

它的意思是：**只对公钥指纹在名单里的站点关闭证书校验**，其它站点照常严格校验。
比 `--ignore-certificate-errors`（全站放行）安全得多。

而这个参数要的值，就是 **`spkiSha256Base64`**：

```
SPKI = SubjectPublicKeyInfo（证书里的公钥部分，带算法标识）
SHA-256(SPKI 的 DER 字节) → base64
```

**注意别和证书指纹搞混：**

| 字段 | 算的是 | 用途 |
| --- | --- | --- |
| `sha256` | **整张证书** DER 的 SHA-256 | 人工比对、装 CA 时核对 |
| `spkiSha256Base64` | **公钥 SPKI** DER 的 SHA-256 | 喂给 `--ignore-certificate-errors-spki-list` |

同一张证书续期后（换了有效期），`sha256` 会变，但 `spkiSha256Base64` 不变 ——
因为公钥没换。这就是为什么白名单要用 SPKI。

用起来长这样：

```bash
# macOS / Linux
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
  --ignore-certificate-errors-spki-list=toyMGpiThuoVaTygu6QeCcnum2PKJknnGOsHalH7BzU=
```

```powershell
# Windows
& "C:\Program Files\Google\Chrome\Application\chrome.exe" `
  --ignore-certificate-errors-spki-list=toyMGpiThuoVaTygu6QeCcnum2PKJknnGOsHalH7BzU=
```

**这条路径完全不需要伴生程序** —— 扩展里的「查看证书体检」能直接把指纹复制给你，
你贴到启动参数里，浏览器自己就放行了。伴生程序只负责「帮你算出这个值」。

---

## 6. 安全边界

这个程序是**高权限**的（Chrome 把 native messaging 列在「能启动本机程序」那一档），
所以它的行为被刻意收得很窄：

| 边界 | 说明 |
| --- | --- |
| **只被动响应** | 不主动外联。只有扩展发来请求时才发起对应的 HTTP 请求 |
| **不开端口** | 不监听任何 TCP/UDP 端口，没有本地服务 |
| **不读用户文件** | 不读磁盘上的任何文件（配置文件、日志、浏览器数据都不碰） |
| **不执行外部命令** | 不 `spawn` / `exec` 任何子进程 |
| **不带浏览器 Cookie** | 发出去的请求只有你在扩展里填的 headers，没有 Cookie、没有登录态 |
| **只走 stdin/stdout** | 唯一的对外通道就是 Chrome 给的那两根管道 |
| **不落盘** | 响应内容、请求内容都不写文件 |
| **有超时** | 默认 30 秒；重定向最多 10 跳；消息体上限 1MB |

它的能力边界就是「以你的名义发一个 HTTP 请求」。没有它做不到的事。

> 顺带一提：Chrome 侧还可以用 `NativeMessagingAllowlist` 企业策略
> 限制哪些扩展能连哪些伴生程序。

---

## 7. 故障排查

### 7.1 `Error when communicating with the native messaging host`

按出现频率从高到低排查：

1. **stdout 混进了别的东西**
   伴生程序的 stdout 只能有协议帧。如果往 stdout 打了日志，Chrome 解析失败就报这个。
   本目录的 `bridge.mjs` 所有日志都走 stderr。

2. **`allowed_origins` 里的扩展 ID 不对**
   扩展 ID 变了（换目录加载的 unpacked 扩展）却没重跑安装脚本，最常见。
   核对：装好的 manifest 里是不是你**当前**的扩展 ID。

3. **注册表没写对 / Chrome 没重启**
   Chrome 只在启动时读注册表。装完必须**完全退出** Chrome 再打开。

4. **`path` 指向的文件不存在**
   Windows 查：`Get-Content "$env:LOCALAPPDATA\ChromePostman\com.chrome_postman.bridge.json"`
   里面的 `path` 字段指向的文件必须真的在。

5. **Windows 上 `path` 指向了 `.mjs`**
   Chrome 在 Windows 上不会执行 `.mjs`。必须指向 `bridge.cmd` 或某个 `.exe`。

6. **Node 没装 / 不在 PATH 上**
   伴生程序需要 `node`。Windows 上 `bridge.cmd` 里写的是安装时探测到的 node 绝对路径，
   如果你后来重装了 Node，路径可能变了，重跑一次安装脚本即可。

7. **manifest 不是合法 JSON**
   `JSON.parse` 一下就知道。常见原因是手工编辑时漏了逗号。

### 7.2 `Specified native messaging host not found`

说明 Chrome 根本没找到 host：注册表项没写 / 目录不对 / 名字对不上。
名字必须**精确**是 `com.chrome_postman.bridge`。

### 7.3 扩展里显示「本地桥接未就绪」但程序装了

扩展靠 `ping` 判断伴生程序是否可用。手动试一下：

```bash
# Linux / macOS
printf '' | ~/.config/google-chrome/NativeMessagingHosts/bridge.mjs
# 正常的话 stderr 会打印一行 [bridge] com.chrome_postman.bridge v1.0.0 已启动
```

```powershell
# Windows
& "$env:LOCALAPPDATA\ChromePostman\bridge.cmd" < NUL
```

---

## 8. 自测

```bash
node native-host/selftest.mjs
```

覆盖：帧的收发、`ping` 握手、未知 action、非法 JSON、连续多帧、
重定向、二进制响应、超时、连接被拒。

```bash
node --check native-host/bridge.mjs     # 语法检查
```

---

## 9. 想改 X，该动哪里

| 想做的事 | 改哪儿 |
| --- | --- |
| 加一个新 action | `bridge.mjs` 的 `dispatch()` + 写一个 `handleXxx()` |
| 改协议版本号 | `bridge.mjs` 顶部的 `PROTOCOL_VERSION` |
| 改超时默认值 | `bridge.mjs` 的 `DEFAULT_TIMEOUT_MS` |
| 改最大重定向跳数 | `bridge.mjs` 的 `MAX_REDIRECTS` |
| 改消息体上限 | `bridge.mjs` 的 `MAX_MESSAGE_BYTES`（不要超过 1MB） |
| 改伴生程序名字 | `bridge.mjs` 的 `HOST_NAME` + manifest 的 `name` + 两个安装脚本 |
| 改安装目录 | `install-host.ps1` 的 `$InstallDir` / `install-host.sh` 的 `detect_target_dir()` |
| 加日志 | `bridge.mjs` 的 `log()`，**永远别用 `console.log`**（会污染 stdout） |

---

## 10. 参考

- Chrome Native Messaging 官方文档：
  <https://developer.chrome.com/docs/extensions/develop/concepts/native-messaging>
- 设计文档：`docs/DESIGN-v1.2.md` §2.4（方案 4 详解）、§5.3（权限变化）
