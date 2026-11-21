/**
 * SSL 策略与证书辅助函数的单元测试。
 *
 * 【为什么这个文件最重要】
 * `decideSsl` 是整个 SSL 特性里最容易出**安全事故**的地方 ——
 * 一个 if 写反，就可能让本该校验证书的连接变成不校验。
 * 所以这里把所有分支都钉死，包括"降级必须出声"这条铁律。
 */
import { describe, expect, it } from 'vitest';
import {
  buildSpkiFlag,
  certificateDaysLeft,
  decideSsl,
  isCertificateExpired,
  NOTICE_BRIDGE_UNAVAILABLE,
  NOTICE_INSECURE_UNAVAILABLE,
} from '../src/core/certificate';

describe('decideSsl —— 发送网关该怎么走', () => {
  it('strict 模式一律走浏览器原生通道', () => {
    const decision = decideSsl({ mode: 'strict', allowInsecure: false, bridgeAvailable: true });
    expect(decision.useBridge).toBe(false);
    expect(decision.allowInsecure).toBe(false);
    expect(decision.notice).toBeUndefined();
  });

  it('system-trust 模式同样走浏览器原生通道', () => {
    const decision = decideSsl({ mode: 'system-trust', allowInsecure: false, bridgeAvailable: true });
    expect(decision.useBridge).toBe(false);
    expect(decision.allowInsecure).toBe(false);
  });

  it('native-bridge 模式且桥接就绪 → 走桥接，但仍校验证书', () => {
    const decision = decideSsl({ mode: 'native-bridge', allowInsecure: false, bridgeAvailable: true });
    expect(decision.useBridge).toBe(true);
    expect(decision.allowInsecure).toBe(false);
    expect(decision.notice).toBeUndefined();
  });

  it('native-bridge 模式但桥接没装 → 退回浏览器，并出声提示', () => {
    const decision = decideSsl({ mode: 'native-bridge', allowInsecure: false, bridgeAvailable: false });
    expect(decision.useBridge).toBe(false);
    expect(decision.allowInsecure).toBe(false);
    // 关键：不能静默降级
    expect(decision.notice).toBe(NOTICE_BRIDGE_UNAVAILABLE);
  });

  it('要求跳过校验且桥接就绪 → 走桥接并跳过校验', () => {
    const decision = decideSsl({ mode: 'native-bridge', allowInsecure: true, bridgeAvailable: true });
    expect(decision.useBridge).toBe(true);
    expect(decision.allowInsecure).toBe(true);
    expect(decision.notice).toBeUndefined();
  });

  it('要求跳过校验但桥接没装 → 退回严格校验，并明确告知用户', () => {
    const decision = decideSsl({ mode: 'native-bridge', allowInsecure: true, bridgeAvailable: false });
    // 绝对不能出现"以为跳过了、其实没跳过"的情况
    expect(decision.allowInsecure).toBe(false);
    expect(decision.useBridge).toBe(false);
    expect(decision.notice).toBe(NOTICE_INSECURE_UNAVAILABLE);
    expect(decision.notice).toContain('严格校验');
  });

  it('即使桥接就绪，strict 模式也不会因为全局开关而跳过校验', () => {
    /*
     * 浏览器通道压根没有跳过校验的能力。
     * 如果这里返回 allowInsecure=true，执行器会把一个"假装能跳过"的
     * 标志传下去，UI 就会显示"未校验证书"的横幅 —— 那是**假的安全提示**。
     */
    const decision = decideSsl({ mode: 'strict', allowInsecure: false, bridgeAvailable: true });
    expect(decision.allowInsecure).toBe(false);
  });
});

describe('buildSpkiFlag —— 生成 Chrome 启动参数', () => {
  it('拼出 --ignore-certificate-errors-spki-list 参数', () => {
    expect(buildSpkiFlag('X3JlQ==')).toBe('--ignore-certificate-errors-spki-list=X3JlQ==');
  });
});

describe('证书有效期判断', () => {
  it('过期时间已过 → 判定为已过期', () => {
    const now = Date.parse('2026-06-01T00:00:00Z');
    expect(isCertificateExpired('2026-01-01T00:00:00Z', now)).toBe(true);
  });

  it('过期时间未到 → 判定为未过期', () => {
    const now = Date.parse('2026-06-01T00:00:00Z');
    expect(isCertificateExpired('2027-01-01T00:00:00Z', now)).toBe(false);
  });

  it('时间字符串解析不了时不当成过期（避免误报）', () => {
    expect(isCertificateExpired('not-a-date', Date.now())).toBe(false);
  });

  it('剩余天数：未过期为正数、已过期为负数', () => {
    const now = Date.parse('2026-06-01T00:00:00Z');
    expect(certificateDaysLeft('2026-06-11T00:00:00Z', now)).toBe(10);
    expect(certificateDaysLeft('2026-05-22T00:00:00Z', now)).toBe(-10);
  });
});
