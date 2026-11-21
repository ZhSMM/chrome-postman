/**
 * ============================================================
 * 证书与 SSL 设置区块
 * ============================================================
 *
 * 【在架构中的位置】
 * 设置弹窗里的一个区块。负责把"要不要跳过证书校验"这件事
 * 变成用户能理解、能操作、并且**看得见后果**的界面。
 *
 * 【初学者先看这里】
 * 这里有一个浏览器绕不过去的硬约束：
 *
 *   扩展**不能**关闭 TLS 证书校验。
 *
 * 原因不在 JS 层，而在 Chromium 的网络栈 —— 校验发生在
 * `net::CertVerifier`，扩展的脚本根本摸不到那个开关。
 * 所以「跳过校验」只有一个实现路径：**换一个进程来发这个请求**，
 * 也就是本机伴生程序（Node 的 https 模块有 `rejectUnauthorized`，浏览器没有）。
 *
 * 【关键实现细节：为什么不做"假开关"】
 * 常见做法是：捕获到证书错误后伪造一个成功响应，或者悄悄按严格校验发。
 * 前者会掩盖安全问题（比不给开关更糟），后者会让用户对着
 * "Failed to fetch" 干瞪眼。所以本组件的做法是：
 *
 *   - 开关只有在本机桥接程序**真的连上了**之后才能打开；
 *   - 连不上就把"需要桥接程序"这件事和安装步骤直接摆在用户面前；
 *   - 同时给出**三条不需要装伴生程序的替代方案**（装 CA / SPKI 白名单 / 改用 http）。
 */

import { useEffect, useMemo, useState } from 'react';
import { useAppStore } from '../store';
import { MSG } from '../../shared/messages';
import {
  buildSpkiFlag,
  certificateDaysLeft,
  isCertificateExpired,
  type CertificateInfo,
} from '../../core/certificate';
import type { SslMode } from '../../shared/types';

/** 扩展 ID（安装伴生程序时 host manifest 的 allowed_origins 要用它） */
function extensionId(): string {
  try {
    return chrome.runtime.id;
  } catch {
    return '';
  }
}

/**
 * 生成安装伴生程序的命令。
 *
 * 【为什么要把扩展 ID 填进去】
 * Chrome 的 native messaging host manifest 里 `allowed_origins`
 * 必须精确到扩展 ID，**不能写通配符**。所以用户必须知道自己的扩展 ID，
 * 我们直接替他填好，省掉"他得自己去 chrome://extensions 里找"这一步。
 */
function buildInstallCommand(id: string): string {
  return [
    '# 1. 把下面这行里的 <解压目录> 换成你解压出来的 native-host 文件夹路径',
    '# 2. 在 PowerShell 里执行（当前用户，不需要管理员权限）',
    '& "<解压目录>\\native-host\\install-host.ps1" -ExtensionId ' + (id || '<扩展ID>'),
  ].join('\n');
}

export default function SslSettings() {
  const store = useAppStore();
  const settings = store.settings;

  /** 是否已授予 nativeMessaging 可选权限 */
  const [nativeGranted, setNativeGranted] = useState<boolean | null>(null);
  /** 证书体检的输入地址 */
  const [certUrl, setCertUrl] = useState('');
  /** 证书体检结果 */
  const [cert, setCert] = useState<CertificateInfo | null>(null);
  const [certError, setCertError] = useState<string | null>(null);
  const [certLoading, setCertLoading] = useState(false);

  const bridgeStatus = store.bridgeStatus;
  const isBridgeMode = settings.sslMode === 'native-bridge';

  useEffect(() => {
    chrome.permissions
      .contains({ permissions: ['nativeMessaging'] })
      .then(setNativeGranted)
      .catch(() => setNativeGranted(false));
  }, []);

  /**
   * 开启本地桥接：先申请 nativeMessaging 权限，再探测伴生程序。
   *
   * 【为什么必须由用户手势触发】
   * chrome.permissions.request 只能在真实用户手势里调用，
   * 自动化测试里的合成手势不算 —— 这是浏览器的硬性限制。
   */
  const enableBridge = async () => {
    try {
      const granted = await chrome.permissions.request({ permissions: ['nativeMessaging'] });
      setNativeGranted(granted);
      if (!granted) {
        store.pushToast('未获得「nativeMessaging」权限，本地桥接不可用', 'error');
        return;
      }
      await store.probeBridge();
    } catch (err) {
      store.pushToast(`申请权限失败：${(err as Error).message}`, 'error');
    }
  };

  /** 切换 SSL 模式 */
  const changeMode = async (mode: SslMode) => {
    await store.updateSettings({ sslMode: mode });
    // 选了本地桥接就顺手探一下，用户立刻能看到"装没装"
    if (mode === 'native-bridge') {
      await store.probeBridge();
    }
  };

  /** 复制安装命令 */
  const copyInstallCommand = async () => {
    const command = buildInstallCommand(extensionId());
    try {
      await navigator.clipboard.writeText(command);
      store.pushToast('安装命令已复制到剪贴板', 'success');
    } catch {
      store.pushToast('复制失败，请手动选中下方命令复制', 'error');
    }
  };

  /** 复制扩展 ID */
  const copyExtensionId = async () => {
    try {
      await navigator.clipboard.writeText(extensionId());
      store.pushToast('扩展 ID 已复制', 'success');
    } catch {
      store.pushToast('复制失败', 'error');
    }
  };

  /** 证书体检 */
  const runInspect = async () => {
    const url = certUrl.trim() || store.currentRequest.url;
    if (!url) {
      store.pushToast('请先填写要体检的地址', 'error');
      return;
    }
    setCertLoading(true);
    setCertError(null);
    setCert(null);
    try {
      const response = await chrome.runtime.sendMessage({
        type: MSG.INSPECT_CERT,
        payload: { url, timeoutMs: 10000 },
      });
      if (response?.payload?.ok) {
        setCert(response.payload.cert as CertificateInfo);
      } else {
        setCertError(response?.payload?.error ?? '证书体检失败');
      }
    } catch (err) {
      setCertError((err as Error)?.message ?? '证书体检失败');
    } finally {
      setCertLoading(false);
    }
  };

  const expired = cert ? isCertificateExpired(cert.validTo) : false;
  const daysLeft = cert ? certificateDaysLeft(cert.validTo) : 0;

  /** 当前模式的一句话说明 */
  const modeHint = useMemo(() => {
    switch (settings.sslMode) {
      case 'strict':
        return '浏览器按系统信任库校验服务器证书。最安全，也是默认选项。';
      case 'system-trust':
        return '行为与「严格校验」完全相同（浏览器本来就信任系统信任库），单独列出来是为了表达"我已把 CA 装进系统"的意图。';
      case 'native-bridge':
        return '请求交给本机伴生程序发送。只有这条通道才可能跳过证书校验。';
      default:
        return '';
    }
  }, [settings.sslMode]);

  return (
    <>
      <div className="divider" />

      {/* ---------------- SSL 模式 ---------------- */}
      <div className="perm-card">
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span className="title">证书校验</span>
        </div>
        <div className="desc">
          浏览器<b>不允许</b>扩展关闭证书校验 —— 这是 Chromium 网络层的设计，
          扩展脚本碰不到那个开关。所以「跳过校验」只有一个实现路径：
          换成本机伴生程序来发请求。
        </div>

        <label style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 4 }}>
          <span style={{ width: 92 }}>校验模式</span>
          <select
            className="select"
            style={{ flex: 1 }}
            value={settings.sslMode}
            onChange={(e) => changeMode(e.target.value as SslMode)}
          >
            <option value="strict">严格校验（推荐）</option>
            <option value="system-trust">系统信任库</option>
            <option value="native-bridge">本地桥接程序</option>
          </select>
        </label>
        <div className="faint" style={{ fontSize: 11.5, lineHeight: 1.7, marginTop: 4 }}>
          {modeHint}
        </div>

        {/*
          跳过校验开关。
          只有本地桥接模式下才能打开 —— 浏览器通道压根没有这个能力。
          开着的时候必须用警告色，一眼能看出"这是个危险开关"。
        */}
        <label
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            marginTop: 8,
            opacity: isBridgeMode ? 1 : 0.5,
          }}
        >
          <input
            type="checkbox"
            disabled={!isBridgeMode}
            checked={settings.allowInsecureTls}
            onChange={(e) => store.updateSettings({ allowInsecureTls: e.target.checked })}
          />
          <span style={{ color: settings.allowInsecureTls ? 'var(--red)' : undefined }}>
            跳过证书校验（高危，仅用于自签名 / 测试环境）
          </span>
        </label>
        {!isBridgeMode && (
          <div className="faint" style={{ fontSize: 11.5 }}>
            提示：先切到「本地桥接程序」模式才能开启这个选项。
          </div>
        )}
      </div>

      {/* ---------------- 本地桥接程序 ---------------- */}
      {isBridgeMode && (
        <div className="perm-card">
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span className="title">本地桥接程序</span>
            <span className={`perm-state ${bridgeStatus?.available ? 'on' : ''}`}>
              {bridgeStatus?.available
                ? `已就绪${bridgeStatus.version ? ` v${bridgeStatus.version}` : ''}`
                : nativeGranted === false
                  ? '未授权'
                  : '未安装'}
            </span>
          </div>

          {bridgeStatus?.error && (
            <div className="faint" style={{ fontSize: 11.5, lineHeight: 1.7, marginTop: 4 }}>
              探测结果：{bridgeStatus.error}
            </div>
          )}

          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 8 }}>
            {!nativeGranted && (
              <button className="btn sm primary" onClick={enableBridge}>
                授权并检测桥接程序
              </button>
            )}
            {nativeGranted && (
              <button className="btn sm" onClick={() => store.probeBridge()}>
                重新检测
              </button>
            )}
            <button className="btn sm ghost" onClick={copyExtensionId}>
              复制扩展 ID
            </button>
            <button className="btn sm ghost" onClick={copyInstallCommand}>
              复制安装命令
            </button>
          </div>

          {!nativeGranted && (
            <div className="faint" style={{ fontSize: 11.5, lineHeight: 1.7, marginTop: 6 }}>
              「nativeMessaging」是<b>可选权限</b>，只有点上面的按钮才会授予，默认不授予。
              Chrome 会提示"可以启动本机程序"—— 这是伴生程序机制本身的特性。
            </div>
          )}

          {/* 安装命令 */}
          <pre className="cmd-block">{buildInstallCommand(extensionId())}</pre>

          {/* ---------------- 证书体检 ---------------- */}
          <div className="divider" style={{ margin: '10px 0' }} />
          <div className="title" style={{ fontSize: 12 }}>
            证书体检
          </div>
          <div className="desc">
            扩展读不到服务器证书（F3 实测），但伴生程序可以（Node 的 TLS socket
            提供 getPeerCertificate）。体检能告诉你证书是谁签的、还有多久过期，
            并直接给出 SPKI 白名单启动参数。
          </div>
          <div style={{ display: 'flex', gap: 6, marginTop: 6 }}>
            <input
              className="mono"
              style={{ flex: 1 }}
              placeholder="https://api.example.com"
              value={certUrl}
              onChange={(e) => setCertUrl(e.target.value)}
            />
            <button className="btn sm" onClick={runInspect} disabled={certLoading}>
              {certLoading ? '体检中…' : '查看证书'}
            </button>
          </div>

          {certError && (
            <div className="faint" style={{ fontSize: 11.5, marginTop: 6, color: 'var(--red)' }}>
              {certError}
            </div>
          )}

          {cert && (
            <div className="cert-box">
              <div className="cert-row">
                <span className="cert-label">颁发者</span>
                <span>
                  {cert.issuer.commonName || '（无 CN）'}
                  {cert.issuer.organization ? ` · ${cert.issuer.organization}` : ''}
                </span>
              </div>
              <div className="cert-row">
                <span className="cert-label">使用者</span>
                <span>
                  {cert.subject.commonName || '（无 CN）'}
                  {cert.subject.organization ? ` · ${cert.subject.organization}` : ''}
                </span>
              </div>
              <div className="cert-row">
                <span className="cert-label">有效期</span>
                <span style={{ color: expired ? 'var(--red)' : undefined }}>
                  {cert.validFrom?.slice(0, 10)} → {cert.validTo?.slice(0, 10)}
                  {expired ? `（已过期 ${-daysLeft} 天）` : `（还剩 ${daysLeft} 天）`}
                </span>
              </div>
              {cert.san?.length > 0 && (
                <div className="cert-row">
                  <span className="cert-label">域名</span>
                  <span className="mono">{cert.san.join('、')}</span>
                </div>
              )}
              <div className="cert-row">
                <span className="cert-label">自签名</span>
                <span>{cert.selfSigned ? '是（Subject == Issuer）' : '否'}</span>
              </div>
              <div className="cert-row">
                <span className="cert-label">指纹</span>
                <span className="mono" style={{ wordBreak: 'break-all' }}>
                  {cert.sha256}
                </span>
              </div>
              {/*
                SPKI 白名单启动参数。
                这是"只信任这一个服务的公钥"的方案，比装 CA 到系统信任库精确得多。
              */}
              <div className="cert-row">
                <span className="cert-label">SPKI</span>
                <span className="mono" style={{ wordBreak: 'break-all' }}>
                  {buildSpkiFlag(cert.spkiSha256Base64)}
                </span>
              </div>
            </div>
          )}
        </div>
      )}

      {/* ---------------- 替代方案 ---------------- */}
      <div className="perm-card">
        <div className="title">不想装伴生程序？</div>
        <div className="desc">
          下面三条都不需要伴生程序，而且都是<b>官方支持</b>的做法。
          按推荐程度排序：
        </div>
        <ol className="alt-list">
          <li>
            <b>把签发 CA 装进系统信任库</b>（推荐）
            <br />
            <span className="faint">
              效果与「系统信任库」模式完全一致。注意要装的是<b>签发 CA</b>，
              而不是服务端那张叶子证书 —— 自签名证书 Subject == Issuer，
              导入它等于把"冒充该服务"的钥匙交给整台机器。
            </span>
          </li>
          <li>
            <b>用 SPKI 白名单启动 Chrome</b>
            <br />
            <span className="faint">
              只信任这一个服务的公钥，不影响系统其它程序。比装 CA 精确得多。
              上面的证书体检能直接生成这个参数。
            </span>
          </li>
          <li>
            <b>改用 http://</b>
            <br />
            <span className="faint">如果服务端同时提供 HTTP 端口，这是最省事的选择。</span>
          </li>
        </ol>
      </div>
    </>
  );
}
