/**
 * 请求耗时面板。
 *
 * 【展示什么】
 * 三段耗时（建立连接 / 服务端等待 / 下载）+ 总耗时 + 服务器 IP。
 *
 * 【精度限制必须说清楚】
 * webRequest 没有 timing 字段，拿不到 DNS / TCP / TLS 的细分。
 * 这三段里的第一段是"DNS + TCP + TLS + 代理 CONNECT"的合计。
 * 不把这个限制写出来，用户会以为工具没测准。
 */
import type { RequestTiming } from '../../shared/types';
import { formatMs } from '../../shared/utils';

interface Props {
  timing?: RequestTiming | null;
}

/** 一行条形图 */
function Bar({ label, value, max, hint }: { label: string; value: number; max: number; hint?: string }) {
  // 宽度按最大值归一化；最小给 2% 让极短的段也能看见
  const percent = max > 0 ? Math.max(2, Math.round((value / max) * 100)) : 0;
  return (
    <div className="timing-row" title={hint}>
      <span className="timing-label">{label}</span>
      <div className="timing-track">
        <div className="timing-fill" style={{ width: `${percent}%` }} />
      </div>
      <span className="timing-value mono">{formatMs(value)}</span>
    </div>
  );
}

export default function TimingPanel({ timing }: Props) {
  if (!timing) {
    return <div className="empty-state">发送一个请求，这里会显示耗时</div>;
  }

  const { phases, total, serverIp, fromCache, source } = timing;
  const max = Math.max(phases.connect, phases.waiting, phases.download, 1);

  if (source === 'local') {
    // 没有 webRequest 权限时只有总耗时
    return (
      <div className="timing">
        <div className="timing-row">
          <span className="timing-label">总计</span>
          <div className="timing-track">
            <div className="timing-fill" style={{ width: '100%' }} />
          </div>
          <span className="timing-value mono">{formatMs(total)}</span>
        </div>
        {serverIp && (
          <div className="muted" style={{ marginTop: 10, fontSize: 12 }}>
            服务器 IP：<span className="mono">{serverIp}</span>
          </div>
        )}
        <div className="faint" style={{ marginTop: 10, fontSize: 11.5, lineHeight: 1.7 }}>
          这里只显示总耗时。在「⋯ → 设置」里开启<b>网络诊断</b>后，
          就能看到「建立连接 / 服务端等待 / 下载」三段细分。
        </div>
      </div>
    );
  }

  return (
    <div className="timing">
      <Bar label="建立连接" value={phases.connect} max={max} hint="DNS 解析 + TCP 连接 + TLS 握手 + 代理 CONNECT 的合计耗时" />
      <Bar label="服务端等待" value={phases.waiting} max={max} hint="服务端处理时间 + 网络往返" />
      <Bar label="下载" value={phases.download} max={max} hint="响应体下载耗时" />

      <div className="divider" style={{ margin: '12px 0 8px' }} />

      <div className="timing-row">
        <span className="timing-label">总计</span>
        <div className="timing-track" />
        <span className="timing-value mono" style={{ fontWeight: 600 }}>
          {formatMs(total)}
        </span>
      </div>

      <div className="muted" style={{ marginTop: 10, fontSize: 12, display: 'flex', gap: 16, flexWrap: 'wrap' }}>
        {serverIp && (
          <span>
            服务器 IP：<span className="mono">{serverIp}</span>
          </span>
        )}
        <span>缓存：{fromCache ? '命中' : '未命中'}</span>
      </div>

      {/*
        精度说明。
        这一段很重要：用户看到"建立连接 45ms"很可能以为那是 TLS 握手的时间，
        实际上里面混着 DNS 和 TCP。写清楚免得误判。
      */}
      <div className="faint" style={{ marginTop: 12, fontSize: 11.5, lineHeight: 1.7 }}>
        ⚠️ 第一段「建立连接」是 <b>DNS + TCP + TLS + 代理 CONNECT</b> 的合计，
        Chrome 的扩展接口不提供更细的拆分。
        想知道每一段具体多久，需要用 DevTools 的 Network 面板。
      </div>
    </div>
  );
}
