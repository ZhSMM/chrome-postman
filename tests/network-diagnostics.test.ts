import { describe, expect, it } from 'vitest';
import {
  buildDiagnosticReport,
  explainNetError,
  findRecentError,
  NetErrorBuffer,
  type NetErrorEntry,
} from '../src/core/network-diagnostics';

describe('错误码翻译', () => {
  it('能翻译代理连接失败', () => {
    const result = explainNetError('net::ERR_PROXY_CONNECTION_FAILED');
    expect(result?.title).toBe('代理服务器连不上');
    expect(result?.proxyRelated).toBe(true);
    expect(result?.suggestions.length).toBeGreaterThan(0);
  });

  it('能翻译隧道建立失败', () => {
    const result = explainNetError('net::ERR_TUNNEL_CONNECTION_FAILED');
    expect(result?.proxyRelated).toBe(true);
  });

  it('能翻译证书不受信任', () => {
    const result = explainNetError('net::ERR_CERT_AUTHORITY_INVALID');
    expect(result?.title).toContain('证书');
    expect(result?.proxyRelated).toBe(true);
  });

  it('能翻译被客户端拦截', () => {
    const result = explainNetError('net::ERR_BLOCKED_BY_CLIENT');
    expect(result?.proxyRelated).toBe(false);
    expect(result?.suggestions.join('')).toContain('广告拦截');
  });

  it('不带 net:: 前缀也能识别', () => {
    expect(explainNetError('ERR_CONNECTION_REFUSED')?.code).toBe('net::ERR_CONNECTION_REFUSED');
  });

  it('未知错误码返回兜底解释而不是抛错', () => {
    const result = explainNetError('net::ERR_SOMETHING_NEW');
    expect(result?.title).toBe('未知网络错误');
    expect(result?.code).toBe('net::ERR_SOMETHING_NEW');
  });

  it('空值返回 null', () => {
    expect(explainNetError(null)).toBeNull();
    expect(explainNetError(undefined)).toBeNull();
  });
});

describe('错误记录匹配', () => {
  const now = Date.now();
  const entries: NetErrorEntry[] = [
    { url: 'https://a.com/api?x=1', method: 'GET', error: 'net::ERR_TUNNEL_CONNECTION_FAILED', time: now },
    { url: 'https://b.com/api', method: 'GET', error: 'net::ERR_CONNECTION_REFUSED', time: now - 100 },
  ];

  it('忽略 query 差异能匹配上', () => {
    const found = findRecentError(entries, 'https://a.com/api?x=2');
    expect(found?.error).toBe('net::ERR_TUNNEL_CONNECTION_FAILED');
  });

  it('超出时间窗口的不匹配', () => {
    const old: NetErrorEntry[] = [
      { url: 'https://a.com/api', method: 'GET', error: 'net::ERR_OLD', time: now - 60000 },
    ];
    expect(findRecentError(old, 'https://a.com/api', 4000)).toBeUndefined();
  });

  it('多个候选时取最新的', () => {
    const dup: NetErrorEntry[] = [
      { url: 'https://a.com/api', method: 'GET', error: 'net::ERR_OLD', time: now - 2000 },
      { url: 'https://a.com/api', method: 'GET', error: 'net::ERR_NEW', time: now - 100 },
    ];
    expect(findRecentError(dup, 'https://a.com/api')?.error).toBe('net::ERR_NEW');
  });
});

describe('NetErrorBuffer', () => {
  it('记录并按时间倒序返回', () => {
    const buffer = new NetErrorBuffer();
    buffer.add({ url: 'https://a.com', method: 'GET', error: 'net::ERR_A', time: Date.now() - 1000 });
    buffer.add({ url: 'https://b.com', method: 'GET', error: 'net::ERR_B', time: Date.now() });
    const recent = buffer.recent();
    expect(recent[0].error).toBe('net::ERR_B');
    expect(recent.length).toBe(2);
  });

  it('超出上限时丢弃最旧的', () => {
    const buffer = new NetErrorBuffer(3);
    for (let i = 0; i < 10; i += 1) {
      buffer.add({ url: `https://a${i}.com`, method: 'GET', error: `net::ERR_${i}`, time: Date.now() });
    }
    expect(buffer.recent(100).length).toBe(3);
  });

  it('find 能按 URL 找到错误', () => {
    const buffer = new NetErrorBuffer();
    buffer.add({
      url: 'https://api.test/users',
      method: 'GET',
      error: 'net::ERR_PROXY_CONNECTION_FAILED',
      time: Date.now(),
    });
    expect(buffer.find('https://api.test/users')?.error).toBe('net::ERR_PROXY_CONNECTION_FAILED');
  });

  it('clear 会清空全部', () => {
    const buffer = new NetErrorBuffer();
    buffer.add({ url: 'https://a.com', method: 'GET', error: 'net::ERR_A', time: Date.now() });
    buffer.clear();
    expect(buffer.recent().length).toBe(0);
  });
});

describe('诊断报告', () => {
  it('拿到错误码时给出解释与建议', () => {
    const report = buildDiagnosticReport(
      'https://api.test/x',
      'Failed to fetch',
      'net::ERR_PROXY_CONNECTION_FAILED',
    );
    expect(report.netError).toBe('net::ERR_PROXY_CONNECTION_FAILED');
    expect(report.explanation?.title).toBe('代理服务器连不上');
    expect(report.suggestions.length).toBeGreaterThan(0);
  });

  it('没拿到错误码时给出启用诊断的指引', () => {
    const report = buildDiagnosticReport('https://api.test/x', 'Failed to fetch', null);
    expect(report.netError).toBeNull();
    expect(report.explanation).toBeNull();
    expect(report.suggestions.join('')).toContain('网络诊断');
  });

  it('填写了代理地址且与代理相关时，会把代理提示放在第一条', () => {
    const report = buildDiagnosticReport(
      'https://api.test/x',
      'Failed to fetch',
      'net::ERR_PROXY_CONNECTION_FAILED',
      'http://127.0.0.1:7890',
    );
    expect(report.proxyHint).toBe('http://127.0.0.1:7890');
    expect(report.suggestions[0]).toContain('127.0.0.1:7890');
  });

  it('与代理无关的错误不会硬塞代理提示', () => {
    const report = buildDiagnosticReport(
      'https://api.test/x',
      'Failed to fetch',
      'net::ERR_CONNECTION_REFUSED',
      'http://127.0.0.1:7890',
    );
    expect(report.suggestions[0]).not.toContain('127.0.0.1:7890');
  });
});
