/**
 * ============================================================
 * 证书与 SSL 策略
 * ============================================================
 *
 * 【在架构中的位置】
 * 站在"发送网关"的分叉口上，负责回答一个问题：
 * **这次请求到底该怎么发？**
 *
 * 【初学者先看这里】
 * 扩展**不能**关闭证书校验。所以「跳过校验」不是一个开关，
 * 而是「换一个进程来发这个请求」—— 由本机 Node 程序发，
 * Node 的 https 模块有 rejectUnauthorized 选项，浏览器没有。
 *
 * 【关键实现细节：为什么降级一定要出声】
 * 最糟糕的做法是：用户开了"跳过证书校验"，但没装伴生程序，
 * 于是扩展悄悄按严格校验发出去，然后报一句 "Failed to fetch"。
 * 用户完全不知道发生了什么 —— 这正是 v1.0 的糟糕体验。
 *
 * 所以本文件的核心原则是：**绝不静默降级**。
 * 任何"用户以为 A、实际做了 B"的情况，都必须带一条 notice 出去，
 * 由 UI 原样显示给用户。
 */

import type { SslMode } from '../shared/types';

/**
 * SSL 决策的结果。
 */
export interface SslDecision {
  /** 是否走 native 通道（false = 走浏览器原生 fetch） */
  useBridge: boolean;
  /** 是否真正跳过证书校验 */
  allowInsecure: boolean;
  /**
   * 降级提示文案。
   * 有值就代表"用户以为的配置"和"实际做的事"不一致，必须让用户知道。
   */
  notice?: string;
}

/** 桥接不可用 + 用户要求跳过校验时的提示 */
export const NOTICE_INSECURE_UNAVAILABLE =
  '此请求配置了跳过证书校验，但本地桥接程序未就绪。本次已按严格校验发送，若失败请先安装桥接程序。';

/** 桥接不可用 + 用户选了桥接模式（但没要求跳过校验）时的提示 */
export const NOTICE_BRIDGE_UNAVAILABLE =
  '本地桥接程序未就绪，已改用浏览器原生请求发送（证书校验正常）。';

/**
 * 决定这次请求该怎么发。
 *
 * 【为什么这是纯函数】
 * 它是整个 SSL 特性里最容易出安全问题的判断逻辑 —— 一个 if 写错就可能
 * 让本该校验的连接变成不校验。所以做成纯函数，用单测把所有分支钉死。
 *
 * @param mode            请求级或全局的 SSL 模式
 * @param allowInsecure   用户是否要求跳过证书校验
 * @param bridgeAvailable 桥接程序当前是否就绪
 */
export function decideSsl(options: {
  mode: SslMode;
  allowInsecure: boolean;
  bridgeAvailable: boolean;
}): SslDecision {
  const { mode, allowInsecure, bridgeAvailable } = options;

  // 用户要求跳过校验 —— 这是唯一需要 native 通道的场景
  if (allowInsecure) {
    if (bridgeAvailable) {
      return { useBridge: true, allowInsecure: true };
    }
    // 桥接没装：不能假装跳过校验，也不能静默退回 —— 必须出声
    return { useBridge: false, allowInsecure: false, notice: NOTICE_INSECURE_UNAVAILABLE };
  }

  // 用户没要求跳过校验，但选了桥接模式
  if (mode === 'native-bridge') {
    if (bridgeAvailable) {
      return { useBridge: true, allowInsecure: false };
    }
    return { useBridge: false, allowInsecure: false, notice: NOTICE_BRIDGE_UNAVAILABLE };
  }

  // strict / system-trust：一律走浏览器原生通道
  return { useBridge: false, allowInsecure: false };
}

/**
 * 证书体检信息（由本机伴生程序读出）。
 *
 * 【为什么扩展自己读不到】
 * F3 实测确认：`chrome.webRequest.onHeadersReceived` 的 'securityInfo'
 * extraInfoSpec 在 Chrome 156 上返回 null。而且逻辑上它也帮不上忙 ——
 * 证书校验失败会导致 TLS 握手失败，根本不会有 onHeadersReceived 事件。
 * Node 的 TLS socket 提供 `getPeerCertificate()`，所以只能靠伴生程序。
 */
export interface CertificateInfo {
  /** 证书主体 */
  subject: { commonName: string; organization: string };
  /** 签发者 */
  issuer: { commonName: string; organization: string };
  /** 生效时间 */
  validFrom: string;
  /** 过期时间 */
  validTo: string;
  /** 备用名称（域名列表） */
  san: string[];
  /** 证书指纹（SHA-256，冒号分隔的大写 hex） */
  sha256: string;
  /**
   * SPKI 的 SHA-256（Base64）。
   *
   * 【这是干什么用的】
   * Chrome 启动参数 `--ignore-certificate-errors-spki-list` 吃的就是这个值。
   * 有了它，用户可以只信任这一个服务的公钥，而不用把 CA 装进系统信任库。
   */
  spkiSha256Base64: string;
  /** 是否自签名（颁发者 == 使用者） */
  selfSigned: boolean;
  /** 完整证书链 */
  chain: CertificateChainItem[];
}

/** 证书链上的一个节点 */
export interface CertificateChainItem {
  subject: { commonName: string; organization: string };
  issuer: { commonName: string; organization: string };
  validFrom: string;
  validTo: string;
  sha256: string;
}

/**
 * 生成 Chrome 的 SPKI 白名单启动参数。
 *
 * 【为什么提供这个】
 * 装 CA 进系统信任库会影响整台机器（任何程序都信任那个 CA 了）。
 * 而 SPKI 白名单只对**这一个服务的公钥**放行，范围小得多。
 * 两者都是"不装伴生程序"的替代方案，SPKI 这个更精确。
 */
export function buildSpkiFlag(spkiSha256Base64: string): string {
  return `--ignore-certificate-errors-spki-list=${spkiSha256Base64}`;
}

/**
 * 判断证书是否已过期。
 *
 * @param validTo 过期时间（ISO 字符串）
 * @param now     当前时间（毫秒时间戳），默认取当前时间
 */
export function isCertificateExpired(validTo: string, now: number = Date.now()): boolean {
  const deadline = Date.parse(validTo);
  if (Number.isNaN(deadline)) return false;
  return deadline < now;
}

/**
 * 计算证书剩余有效天数（负数表示已过期）。
 */
export function certificateDaysLeft(validTo: string, now: number = Date.now()): number {
  const deadline = Date.parse(validTo);
  if (Number.isNaN(deadline)) return 0;
  return Math.floor((deadline - now) / 86_400_000);
}
