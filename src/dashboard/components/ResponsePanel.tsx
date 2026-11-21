/**
 * 响应面板：状态栏 + Body / Headers / Tests / Console 四个视图。
 */
import { useMemo, useState } from 'react';
import type { DiagnosticReport, ExecutionResult, ScriptOutcome } from '../../shared/types';
import { formatBytes, formatMs } from '../../shared/utils';

interface Props {
  response: ExecutionResult['response'];
  outcome: ScriptOutcome | null;
  /** 最近一次失败的网络诊断报告 */
  diagnostic?: DiagnosticReport | null;
}

/** 把 JSON 美化输出；不是合法 JSON 就原样返回 */
function prettify(text: string): string {
  try {
    return JSON.stringify(JSON.parse(text), null, 2);
  } catch {
    return text;
  }
}

export default function ResponsePanel({ response, outcome, diagnostic }: Props) {
  const [tab, setTab] = useState<'body' | 'headers' | 'tests' | 'console' | 'diagnostic'>('body');
  const [pretty, setPretty] = useState(true);

  const isJson = useMemo(() => {
    const type = response?.headers?.['content-type'] ?? response?.headers?.['Content-Type'] ?? '';
    return /json/i.test(type);
  }, [response]);

  const bodyText = useMemo(() => {
    if (!response) return '';
    if (response.isBase64) return '[二进制响应，已以 Base64 存储]';
    return pretty && isJson ? prettify(response.body) : response.body;
  }, [response, pretty, isJson]);

  const tests = outcome?.tests ?? [];
  const logs = outcome?.logs ?? [];
  const failed = tests.filter((t) => !t.passed).length;

  return (
    <div className="response-area">
      <div className="response-meta">
        {response ? (
          <>
            <span
              className={`status-badge ${
                response.status >= 200 && response.status < 300
                  ? 'ok'
                  : response.status >= 400
                    ? 'err'
                    : 'warn'
              }`}
            >
              {response.status} {response.statusText}
            </span>
            <span className="muted">⏱ {formatMs(response.responseTime)}</span>
            <span className="muted">📦 {formatBytes(response.size)}</span>
            {!!tests.length && (
              <span className={failed ? 'muted' : 'muted'} style={{ color: failed ? 'var(--red)' : 'var(--green)' }}>
                断言 {tests.length - failed}/{tests.length} 通过
              </span>
            )}
            <span className="spacer" />
            {isJson && (
              <button className="btn ghost sm" onClick={() => setPretty((v) => !v)}>
                {pretty ? '原始' : '美化'}
              </button>
            )}
          </>
        ) : (
          <span className="faint">尚未发送请求</span>
        )}
      </div>

      <div className="tabs">
        <button className={`tab ${tab === 'body' ? 'active' : ''}`} onClick={() => setTab('body')}>
          Body
        </button>
        <button className={`tab ${tab === 'headers' ? 'active' : ''}`} onClick={() => setTab('headers')}>
          Headers
          {response && <span className="tab-badge">{Object.keys(response.headers).length}</span>}
        </button>
        <button className={`tab ${tab === 'tests' ? 'active' : ''}`} onClick={() => setTab('tests')}>
          断言
          {!!tests.length && (
            <span className="tab-badge" style={{ color: failed ? 'var(--red)' : 'var(--green)' }}>
              {tests.length}
            </span>
          )}
        </button>
        <button className={`tab ${tab === 'console' ? 'active' : ''}`} onClick={() => setTab('console')}>
          Console
          {!!logs.length && <span className="tab-badge">{logs.length}</span>}
        </button>
        {diagnostic && (
          <button
            className={`tab ${tab === 'diagnostic' ? 'active' : ''}`}
            onClick={() => setTab('diagnostic')}
            style={{ color: tab === 'diagnostic' ? 'var(--red)' : undefined }}
          >
            诊断
            {diagnostic.netError && <span className="tab-badge">!</span>}
          </button>
        )}
      </div>

      <div className="panel">
        {tab === 'body' &&
          (response ? (
            bodyText ? (
              <pre className="code">{bodyText}</pre>
            ) : (
              <div className="faint">（响应体为空）</div>
            )
          ) : (
            <div className="empty-state">发送一个请求，这里会显示响应</div>
          ))}

        {tab === 'headers' && (
          <table className="kv-table">
            <tbody>
              {Object.entries(response?.headers ?? {}).map(([key, value]) => (
                <tr key={key}>
                  <td style={{ width: '30%' }} className="mono">
                    {key}
                  </td>
                  <td className="mono">{value}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}

        {tab === 'tests' &&
          (tests.length ? (
            <div>
              {tests.map((test, index) => (
                <div className="test-item" key={`${test.name}_${index}`}>
                  <span className={`test-icon ${test.passed ? 'pass' : 'fail'}`}>
                    {test.passed ? '✓' : '✕'}
                  </span>
                  <div style={{ flex: 1 }}>
                    <div>{test.name}</div>
                    {!test.passed && test.error && <div className="test-error">{test.error}</div>}
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <div className="empty-state">
              还没有断言
              <div className="faint" style={{ marginTop: 6 }}>
                在「后置脚本」里用 pm.test('名称', function () {'{'} ... {'}'}) 添加
              </div>
            </div>
          ))}

        {tab === 'console' &&
          (logs.length ? (
            <div>
              {logs.map((log, index) => (
                <div key={index} className="test-item">
                  <span
                    className="test-icon"
                    style={{
                      background:
                        log.level === 'error'
                          ? 'color-mix(in srgb, var(--red) 22%, transparent)'
                          : log.level === 'warn'
                            ? 'color-mix(in srgb, var(--yellow) 22%, transparent)'
                            : 'var(--bg-hover)',
                      color:
                        log.level === 'error'
                          ? 'var(--red)'
                          : log.level === 'warn'
                            ? 'var(--yellow)'
                            : 'var(--text-dim)',
                    }}
                  >
                    {log.level === 'error' ? '!' : log.level === 'warn' ? '⚠' : 'i'}
                  </span>
                  <div className="mono" style={{ flex: 1, whiteSpace: 'pre-wrap' }}>
                    {log.message}
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <div className="empty-state">脚本里用 console.log(...) 打印的内容会出现在这里</div>
          ))}

        {tab === 'diagnostic' && diagnostic && (
          <div className="diagnostic">
            <div className="diag-head">
              <span className={`status-badge ${diagnostic.explanation?.proxyRelated ? 'warn' : 'err'}`}>
                {diagnostic.explanation?.title ?? '请求失败'}
              </span>
              {diagnostic.netError ? (
                <span className="mono faint">{diagnostic.netError}</span>
              ) : (
                <span className="faint">未获取到网络错误码</span>
              )}
              <span className="spacer" />
              <button
                className="btn sm ghost"
                onClick={() => {
                  const text = [
                    `目标地址: ${diagnostic.url}`,
                    `原始错误: ${diagnostic.rawError}`,
                    `网络错误码: ${diagnostic.netError ?? '(未捕获)'}`,
                    diagnostic.explanation ? `结论: ${diagnostic.explanation.title}` : '',
                    diagnostic.explanation?.detail ?? '',
                    '',
                    '排查建议:',
                    ...diagnostic.suggestions.map((s, i) => `${i + 1}. ${s}`),
                  ]
                    .filter(Boolean)
                    .join('\n');
                  navigator.clipboard.writeText(text).then(
                    () => alert('诊断报告已复制到剪贴板'),
                    () => alert(text),
                  );
                }}
              >
                复制报告
              </button>
            </div>

            {diagnostic.explanation ? (
              <p className="diag-detail">{diagnostic.explanation.detail}</p>
            ) : (
              <p className="diag-detail">
                这次没有拿到 Chrome 内部的网络错误码 —— 说明「网络诊断」还没开启，
                或者错误不是发生在网络层。
                <br />
                在「⋯ → 设置」里开启<b>网络诊断</b>后重试，就能看到
                <span className="mono"> net::ERR_xxx </span>
                这样的真实原因（代理问题、证书问题、DNS 问题会分别给出不同的建议）。
              </p>
            )}

            {!!diagnostic.suggestions.length && (
              <>
                <div className="muted" style={{ marginTop: 12, marginBottom: 6 }}>
                  排查建议
                </div>
                <ol className="diag-list">
                  {diagnostic.suggestions.map((item, index) => (
                    <li key={index}>{item}</li>
                  ))}
                </ol>
              </>
            )}

            {diagnostic.proxyHint && (
              <div className="muted" style={{ marginTop: 12 }}>
                你填写的代理地址：<span className="mono">{diagnostic.proxyHint}</span>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
