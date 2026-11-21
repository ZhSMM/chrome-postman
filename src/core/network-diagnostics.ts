/**
 * ============================================================
 * 网络诊断（Network Diagnostics）—— 把 "Failed to fetch" 翻译成人话
 * ============================================================
 *
 * 【在架构中的位置】
 * Service Worker 里 fetch 失败时，Chrome 抛给 JS 的只有一句
 *   TypeError: Failed to fetch
 * 这句话没有任何诊断价值：域名写错、网络不通、代理挂了、证书有问题，
 * 在开发者控制台里长得一模一样。
 *
 * 真正的错误码（net::ERR_PROXY_CONNECTION_FAILED 之类）在浏览器网络层，
 * JS 拿不到 —— 唯一的办法是用 chrome.webRequest.onErrorOccurred 监听。
 * 本模块负责：
 *   1. 记录网络层报出的真实错误码
 *   2. 把错误码翻译成中文说明 + 可执行的解决步骤
 *   3. 把一次失败的请求和对应的错误记录对上号
 *
 * 【权限设计】
 *   webRequest 声明在 manifest 的 optional_permissions 里，
 *   用户在设置里点一下「启用网络诊断」才授予。
 *   好处：默认安装零额外警告，只有需要诊断的人才会拿到这个权限。
 *   （Chrome 允许 webRequest 作为可选权限；proxy 不行，它必须放在
 *     permissions 里，会触发"管理代理设置"的安装警告，所以本项目不要它。）
 *
 * 【实测依据】
 *   scripts/proxy-probe.mjs 用一个本地代理实测过：
 *   扩展的请求**确实会走浏览器代理**（代理收到了 absolute-URI 的
 *   GET 请求和 CONNECT 隧道请求），失败发生在代理侧，
 *   而 Chrome 把原因吞成了 "Failed to fetch"。
 *   所以本模块要抓的就是"代理侧到底报了什么"。
 */

import type { DiagnosticReport, ErrorExplanation } from '../shared/types';

export type { DiagnosticReport, ErrorExplanation };

/** 一条网络层错误记录 */
export interface NetErrorEntry {
  /** 出错的完整 URL */
  url: string;
  /** 请求方法 */
  method: string;
  /** Chrome 的网络错误码，例如 net::ERR_PROXY_CONNECTION_FAILED */
  error: string;
  /** 发生时间戳 */
  time: number;
  /** 发起方标签页 id（-1 表示不是标签页发起） */
  tabId?: number;
  /** 触发来源，如 chrome-extension://xxx */
  initiator?: string;
}

/**
 * 错误码知识库。
 *
 * 只收录"用户能自己动手解决"的那些 —— 工具的价值不在于展示
 * 一个看不懂的码，而在于告诉用户下一步做什么。
 */
const ERROR_TABLE: Record<string, Omit<ErrorExplanation, 'code'>> = {
  'net::ERR_PROXY_CONNECTION_FAILED': {
    title: '代理服务器连不上',
    detail:
      '浏览器配置了代理，但无法与代理服务器建立连接。请求根本没有离开你的电脑，所以不会有任何目标服务器参与。',
    suggestions: [
      '确认代理客户端正在运行（Clash / v2rayN / 公司代理等），端口号和浏览器里配置的一致',
      '如果代理只监听 127.0.0.1，检查浏览器代理地址是否写成了 localhost:端口 而不是 127.0.0.1:端口',
      '换个端口试一下：有些代理软件的 HTTP 端口和 SOCKS 端口不是同一个',
      '如果代理需要认证，在代理客户端里配置好账号密码（扩展无法代你输入代理密码）',
    ],
    proxyRelated: true,
  },
  'net::ERR_PROXY_CONNECTION_AUTH_UNSUPPORTED': {
    title: '代理要求认证，但浏览器没能完成认证',
    detail:
      '代理服务器返回了 407 Proxy Authentication Required。当前这个代理地址与目标地址不在同一个安全域内，Chrome 出于防凭据泄漏的考虑不会自动带上你的代理凭据。',
    suggestions: [
      '在代理客户端里关闭「需要认证」或改用不校验的本地监听端口',
      '把目标域名加入代理的直连（DIRECT）规则，让它不走代理',
      '换用另一个代理端口（多数代理软件都有免认证的本地端口）',
    ],
    proxyRelated: true,
  },
  'net::ERR_TUNNEL_CONNECTION_FAILED': {
    title: 'HTTPS 隧道（CONNECT）建立失败',
    detail:
      '浏览器已经连上了代理，但用 CONNECT 建立 HTTPS 隧道时失败。常见原因是代理拒绝该目标域名、需要认证、或代理自身出故障。',
    suggestions: [
      '确认代理允许访问该域名（有些代理会拦截 CONNECT）',
      '在代理客户端把目标域名设为 DIRECT（直连）',
      '如果目标本来就该走代理，检查代理节点是否可用、是否订阅过期',
      '代理软件开了「HTTPS 解密/MITM」时，关掉它再试（见下一条证书错误）',
    ],
    proxyRelated: true,
  },
  'net::ERR_CERT_AUTHORITY_INVALID': {
    title: '证书不受信任（多半是代理在做 HTTPS 解密）',
    detail:
      '目标服务器返回的证书由一个系统不信任的机构签发。**网页访问时你可能点了"继续前往"所以没报错，但扩展请求不会弹证书警告页，会直接失败** —— 这是扩展与网页行为不一致最常见的原因。',
    suggestions: [
      '如果你的代理开启了 HTTPS 解密（MITM），把代理的 CA 证书安装到系统「受信任的根证书颁发机构」，扩展才会信任它',
      'Windows：双击 CA 证书 → 安装证书 → 本地计算机 → 受信任的根证书颁发机构',
      '不想装证书，就让代理对目标域名不解密（在代理规则里把该域名设为 DIRECT）',
      '确认系统时间正确 —— 时间偏差也会让证书看起来无效',
    ],
    proxyRelated: true,
  },
  'net::ERR_CERT_COMMON_NAME_INVALID': {
    title: '证书上的域名与实际访问的域名不一致',
    detail: '服务器返回的证书不包含你正在访问的域名。多见于 IP 直连、端口不匹配，或代理解密后签发了错误的域名。',
    suggestions: [
      '确认 URL 里的域名拼写正确、端口与证书匹配（HTTPS 默认 443）',
      '代理场景下：让代理对该域名走 DIRECT，或检查代理的 MITM 域名配置',
    ],
    proxyRelated: true,
  },
  'net::ERR_CERT_DATE_INVALID': {
    title: '证书已过期或尚未生效',
    detail: '服务器证书的有效期不在当前时间范围内。',
    suggestions: [
      '检查本机系统时间是否准确（自动同步时间）',
      '代理场景下：代理自己的证书可能过期了，更新代理客户端',
    ],
    proxyRelated: false,
  },
  'net::ERR_SOCKS_CONNECTION_FAILED': {
    title: 'SOCKS 代理连接失败',
    detail: '浏览器配置的是 SOCKS5 代理，但与 SOCKS 服务器握手失败。',
    suggestions: [
      '确认 SOCKS 端口正确（HTTP 端口和 SOCKS 端口常常不同）',
      '确认代理软件开启了 SOCKS5 监听，而不是只开了 HTTP 监听',
      '把目标域名设为 DIRECT',
    ],
    proxyRelated: true,
  },
  'net::ERR_NAME_NOT_RESOLVED': {
    title: '域名解析失败',
    detail: 'DNS 没有解析出该域名。代理场景下通常是代理侧的 DNS 出了问题。',
    suggestions: [
      '代理客户端里检查 DNS 模式（fake-ip / redir-host / 系统 DNS）',
      '试试把目标域名设为 DIRECT，用本地 DNS 解析',
      '确认域名拼写无误',
    ],
    proxyRelated: true,
  },
  'net::ERR_CONNECTION_REFUSED': {
    title: '目标服务器拒绝连接',
    detail: '网络层连到了目标地址，但对方主动关闭了连接。常见于端口写错或服务没启动。',
    suggestions: [
      '确认端口号与服务实际监听的端口一致',
      '确认服务已启动（本地服务要确认监听在 127.0.0.1 而不是 0.0.0.0 之外）',
      '代理场景下：可能是代理把连接转发到了错误的地方',
    ],
    proxyRelated: false,
  },
  'net::ERR_CONNECTION_TIMED_OUT': {
    title: '连接超时',
    detail: '在超时时间内没有完成 TCP 连接。目标不可达，或代理把流量转发到了不可达的地方。',
    suggestions: [
      '代理场景下：先确认代理节点可用，再排查目标服务',
      '把目标域名设为 DIRECT 试试，区分是代理问题还是目标问题',
      '可以在设置里调大超时时间',
    ],
    proxyRelated: true,
  },
  'net::ERR_TIMED_OUT': {
    title: '请求超时',
    detail: '连接或响应超过了设定的超时时间。',
    suggestions: [
      '在设置里调大超时时间',
      '代理场景下：代理转发本身可能很慢',
    ],
    proxyRelated: true,
  },
  'net::ERR_CONNECTION_RESET': {
    title: '连接被重置',
    detail: 'TCP 连接被对端强制断开。代理在转发过程中断开、或服务端主动踢连接。',
    suggestions: [
      '代理场景下：换节点试试，或把该域名设为 DIRECT',
      '目标服务是否对来源 IP 有访问控制策略',
    ],
    proxyRelated: true,
  },
  'net::ERR_CONNECTION_CLOSED': {
    title: '连接被关闭',
    detail: '连接在传输过程中被关闭，没有拿到完整响应。',
    suggestions: ['代理场景下换节点或改为 DIRECT', '目标服务可能主动断开了长连接'],
    proxyRelated: true,
  },
  'net::ERR_CONNECTION_FAILED': {
    title: '通用连接失败',
    detail: '网络层没能建立连接，但没能给出更具体的原因。',
    suggestions: [
      '代理场景下优先怀疑代理：换节点、把域名设为 DIRECT',
      '用 curl 在终端测一下，能区分是网络问题还是扩展问题',
    ],
    proxyRelated: true,
  },
  'net::ERR_ADDRESS_UNREACHABLE': {
    title: '目标地址不可达',
    detail: '网络栈找不到通向该地址的路由。',
    suggestions: ['检查本机网络/路由', '代理场景下确认代理是否覆盖了内网网段'],
    proxyRelated: true,
  },
  'net::ERR_INTERNET_DISCONNECTED': {
    title: '网络已断开',
    detail: '系统报告当前没有网络连接。',
    suggestions: ['确认网卡/Wi-Fi 已连接', '代理客户端是否把系统网络断开了'],
    proxyRelated: true,
  },
  'net::ERR_NETWORK_CHANGED': {
    title: '网络发生切换',
    detail: '请求进行中网络类型发生了变化（Wi-Fi ↔ 蜂窝 ↔ 有线）。',
    suggestions: ['网络稳定后重试'],
    proxyRelated: false,
  },
  'net::ERR_BLOCKED_BY_CLIENT': {
    title: '请求被客户端拦截',
    detail: '请求被浏览器侧或另一个扩展拦下了，**没有真正发出**。',
    suggestions: [
      '检查是否装了广告拦截 / 隐私保护类扩展（如 uBlock、AdGuard）',
      '在 chrome://extensions 里逐个禁用其他扩展排查',
      '在设置里关掉「携带 Cookie」排除 SameSite 拦截因素',
    ],
    proxyRelated: false,
  },
  'net::ERR_EMPTY_RESPONSE': {
    title: '服务器返回了空响应',
    detail: '连接建立成功，但服务端一个字节都没返回就断开了。',
    suggestions: ['代理场景下：代理可能不支持该协议或拦截了请求', '目标服务可能崩溃或被 WAF 拦截'],
    proxyRelated: true,
  },
  'net::ERR_INVALID_URL': {
    title: 'URL 不合法',
    detail: '请求的地址格式有问题。',
    suggestions: ['检查 URL 是否缺少协议（应写成 https://...）', '检查是否有非法字符或空格'],
    proxyRelated: false,
  },
  'net::ERR_SSL_PROTOCOL_ERROR': {
    title: 'SSL/TLS 握手失败',
    detail: '与目标服务器协商加密协议时失败。',
    suggestions: ['代理做 HTTPS 解密时常见：把域名设为 DIRECT', '目标服务只支持过时的 TLS 版本'],
    proxyRelated: true,
  },
  'net::ERR_HTTP2_PROTOCOL_ERROR': {
    title: 'HTTP/2 协议错误',
    detail: '连接在 HTTP/2 层出错。',
    suggestions: ['代理对 HTTP/2 支持不好时会出现，换节点或让代理降级到 HTTP/1.1'],
    proxyRelated: true,
  },
  'net::ERR_ACCESS_DENIED': {
    title: '访问被拒绝',
    detail: '网络层拒绝了这次访问。',
    suggestions: ['目标服务可能按来源 IP / 来源来源做了访问控制'],
    proxyRelated: false,
  },
  'net::ERR_FAILED': {
    title: '请求失败',
    detail: 'Chrome 没有给出更具体的原因。',
    suggestions: [
      '如果启用了网络诊断，展开诊断信息可以看到更细的线索',
      '用 curl 在终端复现，通常比扩展更容易拿到具体报错',
    ],
    proxyRelated: false,
  },
};

/**
 * 翻译一个网络错误码。
 * @param code 例如 net::ERR_PROXY_CONNECTION_FAILED
 */
export function explainNetError(code?: string | null): ErrorExplanation | null {
  if (!code) return null;
  const key = code.startsWith('net::') ? code : `net::${code}`;
  const hit = ERROR_TABLE[key];
  if (!hit) {
    return {
      code: key,
      title: '未知网络错误',
      detail: `Chrome 报告了网络错误 ${key}，但没有内置的解释。`,
      suggestions: [
        '启用「网络诊断」获取更完整的信息',
        '用 curl 在终端复现，可以拿到更具体的报错',
      ],
      proxyRelated: key.includes('PROXY') || key.includes('TUNNEL') || key.includes('SOCKS'),
    };
  }
  return { code: key, ...hit };
}

/**
 * 从错误记录里找出与某个 URL 对应的最近一条错误。
 *
 * 【为什么要按"最近 + URL 相似"匹配】
 * fetch 的 Promise 和 webRequest 的事件是两条独立通路，JS 拿不到 requestId，
 * 所以只能按 URL + 时间窗口做近似匹配。
 * 去掉 query 再比较路径，可以容忍重定向与参数顺序变化。
 */
export function findRecentError(
  entries: NetErrorEntry[],
  url: string,
  withinMs = 4000,
): NetErrorEntry | undefined {
  const now = Date.now();
  const target = stripQuery(url);
  const candidates = entries
    .filter((entry) => now - entry.time <= withinMs)
    .filter((entry) => {
      const candidate = stripQuery(entry.url);
      return candidate === target || candidate.includes(target) || target.includes(candidate);
    })
    .sort((a, b) => b.time - a.time);
  return candidates[0];
}

/** 去掉 query 与 hash，只留 origin + path */
function stripQuery(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    return url.split('?')[0].split('#')[0];
  }
}

/** 内存中的错误环形缓冲（Service Worker 内存态，重启即清空） */
export class NetErrorBuffer {
  private entries: NetErrorEntry[] = [];

  constructor(private readonly max = 50) {}

  /** 记一条错误 */
  add(entry: NetErrorEntry): void {
    this.entries.push(entry);
    if (this.entries.length > this.max) {
      this.entries = this.entries.slice(-this.max);
    }
  }

  /** 取最近 n 条（新的在前） */
  recent(n = 20): NetErrorEntry[] {
    return [...this.entries].reverse().slice(0, n);
  }

  /** 查与某个 URL 匹配的最近错误 */
  find(url: string, withinMs = 4000): NetErrorEntry | undefined {
    return findRecentError(this.entries, url, withinMs);
  }

  /** 清空 */
  clear(): void {
    this.entries = [];
  }
}

/**
 * 生成一份人类可读的网络诊断报告。
 * @param url        目标 URL
 * @param rawError   JS 层拿到的原始错误（通常是 "Failed to fetch"）
 * @param netError   网络层错误码（如果捕获到了）
 * @param proxyHint  用户在设置里填写的代理地址（可选）
 */
export function buildDiagnosticReport(
  url: string,
  rawError: string,
  netError?: string | null,
  proxyHint?: string,
): DiagnosticReport {
  const explanation = explainNetError(netError);
  const suggestions = explanation
    ? [...explanation.suggestions]
    : [
        '启用「网络诊断」后重试，可以拿到 Chrome 内部的网络错误码',
        '用 curl 在终端复现同一地址，通常能拿到更具体的报错',
      ];

  if (proxyHint && explanation?.proxyRelated) {
    suggestions.unshift(
      `你配置的代理是 ${proxyHint}。请确认代理客户端在运行、端口正确，并且目标域名没有被代理规则拦截。`,
    );
  }

  return {
    url,
    rawError,
    netError: netError ?? null,
    explanation,
    proxyHint,
    suggestions,
  };
}
