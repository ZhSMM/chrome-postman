/**
 * 代理故障诊断回归测试（真实 Chrome + 真实故障代理）。
 *
 * 【要验证什么】
 *   当浏览器配置了代理、而代理把请求搞挂时，工具应该：
 *     1. 仍然发出请求（走代理）—— 证明扩展遵循浏览器代理设置
 *     2. 拿到 Chrome 网络层的真实错误码（net::ERR_xxx）
 *     3. 给出中文解释与针对性的排查建议
 *   而不是只丢一句 "Failed to fetch"。
 *
 * 【实验装置】
 *   本地起一个"坏代理"：明文 HTTP 直接回 200（能证明流量经过代理），
 *   HTTPS 的 CONNECT 隧道直接回 502（模拟代理侧故障）。
 *
 * 用法：node scripts/proxy-diagnosis-test.mjs
 */
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const DIST = resolve(process.cwd(), 'dist');
const PROXY_PORT = 8898;
const CDP_PORT = 9478;

/**
 * 准备一个"测试变体"扩展目录。
 *
 * 【为什么要变体】
 * 正式产物里 webRequest 是 optional_permissions，需要用户点按钮授权。
 * 而 headless Chrome 弹不出权限气泡（会被自动拒绝），没法走授权流程。
 * 所以这里复制一份 dist，把 webRequest 临时提为必需权限 ——
 * 被测的逻辑（webRequest 捕获错误码 → 生成诊断报告）完全一致，
 * 只有"授权方式"不同。
 */
function prepareTestExtension() {
  const dir = mkdtempSync(join(tmpdir(), 'cp-proxdiag-ext-'));
  cpSync(DIST, dir, { recursive: true });
  const manifestPath = join(dir, 'manifest.json');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  manifest.permissions = [...(manifest.permissions ?? []), 'webRequest'];
  manifest.optional_permissions = (manifest.optional_permissions ?? []).filter((p) => p !== 'webRequest');
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
  return dir;
}

/* ---------- 坏代理 ---------- */
const proxyLog = [];

const proxy = createServer((req, res) => {
  proxyLog.push({ kind: 'http', url: req.url });
  res.writeHead(200, { 'content-type': 'application/json', 'x-via': 'cp-bad-proxy' });
  res.end(JSON.stringify({ viaProxy: true, sawUrl: req.url }));
});

proxy.on('connect', (req, socket) => {
  proxyLog.push({ kind: 'connect', url: req.url });
  // 模拟代理侧故障：隧道建立失败
  socket.end('HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\n\r\n');
});

await new Promise((r) => proxy.listen(PROXY_PORT, '127.0.0.1', r));
console.log(`[1/5] 坏代理已启动 127.0.0.1:${PROXY_PORT}`);

/* ---------- Chrome ---------- */
const profile = mkdtempSync(join(tmpdir(), 'cp-proxdiag-'));
const chrome = spawn(
  CHROME,
  [
    '--headless=new',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-gpu',
    `--proxy-server=http://127.0.0.1:${PROXY_PORT}`,
    `--user-data-dir=${profile}`,
    `--remote-debugging-port=${CDP_PORT}`,
    'about:blank',
  ],
  { stdio: 'ignore' },
);
console.log('[2/5] chrome 已启动（走坏代理）');

/* ---------- CDP ---------- */
async function waitForDevTools() {
  for (let i = 0; i < 60; i += 1) {
    try {
      const res = await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`);
      if (res.ok) return await res.json();
    } catch {
      /* 等 */
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error('devtools not reachable');
}

function connect(wsUrl) {
  const ws = new WebSocket(wsUrl);
  const pending = new Map();
  let seq = 0;
  const ready = new Promise((res, rej) => {
    ws.onopen = () => res();
    ws.onerror = () => rej(new Error('ws failed'));
  });
  ws.onmessage = (e) => {
    const msg = JSON.parse(e.data);
    if (msg.id && pending.has(msg.id)) {
      const { resolve: res, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) reject(new Error(msg.error.message));
      else res(msg.result);
    }
  };
  return {
    ready,
    send(method, params = {}) {
      seq += 1;
      const id = seq;
      return new Promise((res, rej) => {
        pending.set(id, { resolve: res, reject: rej });
        ws.send(JSON.stringify({ id, method, params }));
      });
    },
    close: () => {
      try {
        ws.close();
      } catch {
        /* ignore */
      }
    },
  };
}

async function evaluate(client, expression, userGestures = false) {
  await client.ready;
  const r = await client.send('Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true,
    userGestures,
  });
  if (r.exceptionDetails) {
    throw new Error(r.exceptionDetails.exception?.description ?? JSON.stringify(r.exceptionDetails));
  }
  return r.result.value;
}

/* ---------- 主流程 ---------- */
let browser = null;
let page = null;
let exitCode = 0;
// 声明在 try 外面：finally 块要拿它来清理临时目录
let testExtDir = null;
try {
  const version = await waitForDevTools();
  browser = connect(version.webSocketDebuggerUrl);
  await browser.ready;

  testExtDir = prepareTestExtension();
  console.log(`[3/5] 测试变体扩展目录：${testExtDir}`);

  await browser.send('Extensions.loadUnpacked', { path: testExtDir });
  const list = await browser.send('Extensions.getExtensions');
  const ext = (list.extensions ?? []).find((e) => e.name === 'Chrome Postman');
  if (!ext) throw new Error('extension not loaded');
  console.log(`      扩展已加载：${ext.id}（webRequest 为必需权限）`);

  const res = await fetch(`http://127.0.0.1:${CDP_PORT}/json/new?about:blank`, { method: 'PUT' });
  const target = await res.json();
  page = connect(target.webSocketDebuggerUrl);
  await page.ready;
  await page.send('Runtime.enable');
  await page.send('Page.enable');
  await page.send('Page.navigate', { url: `chrome-extension://${ext.id}/dashboard/index.html` });
  await new Promise((r) => setTimeout(r, 2500));

  console.log('[4/5] 网络诊断监听已随权限就位');

  // 发起一个必然失败的 HTTPS 请求（代理侧 502）
  const script = `
    (async () => {
      const request = {
        id: 'proxdiag', name: 'proxdiag', method: 'GET',
        url: 'https://proxy-probe.test/api/tls',
        params: [], headers: [],
        body: { mode: 'none', raw: '', form: [], formData: [] },
        auth: { type: 'none' }, preScript: '', postScript: '',
        createdAt: Date.now(), updatedAt: Date.now()
      };
      const r = await chrome.runtime.sendMessage({
        type: 'EXECUTE_REQUEST', payload: { request, requestId: 'pd1' }
      });
      const res = r?.payload?.result;
      return JSON.stringify({
        error: res?.error ?? null,
        diagnostic: res?.diagnostic ?? null
      });
    })()
  `;

  const raw = await evaluate(page, script);
  const data = JSON.parse(raw);

  console.log('[5/5] 结果：');
  console.log('');
  console.log('  --- 错误文案 ---');
  console.log((data.error ?? '(无)').split('\n').map((l) => '    ' + l).join('\n'));
  console.log('');
  console.log('  --- 诊断报告 ---');
  console.log('    netError   :', data.diagnostic?.netError ?? '(未捕获)');
  console.log('    title      :', data.diagnostic?.explanation?.title ?? '(无)');
  console.log('    proxyRelated:', data.diagnostic?.explanation?.proxyRelated ?? '(无)');
  console.log('    建议条数   :', data.diagnostic?.suggestions?.length ?? 0);

  const checks = [
    ['请求确实经过了代理（代理收到 CONNECT）', proxyLog.some((e) => e.kind === 'connect')],
    ['拿到了网络层真实错误码', !!data.diagnostic?.netError],
    ['错误码被判定为代理相关', data.diagnostic?.explanation?.proxyRelated === true],
    ['给出了中文结论', !!data.diagnostic?.explanation?.title],
    ['给出了可执行的排查建议', (data.diagnostic?.suggestions?.length ?? 0) > 0],
    ['错误文案里包含真实错误码', String(data.error ?? '').includes(data.diagnostic?.netError ?? '@@')],
  ];

  console.log('');
  let failed = 0;
  for (const [label, ok] of checks) {
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`);
    if (!ok) failed += 1;
  }
  exitCode = failed ? 1 : 0;
  console.log(failed ? `\n${failed} check(s) failed` : '\nAll checks passed');
} catch (err) {
  console.error('TEST ERROR:', err.message);
  exitCode = 1;
} finally {
  try {
    page?.close();
  } catch {
    /* ignore */
  }
  try {
    browser?.close();
  } catch {
    /* ignore */
  }
  chrome.kill();
  proxy.close();
  try {
    rmSync(profile, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
  // 测试变体扩展目录也要清掉 —— 之前只清了 profile，
  // 结果临时目录里每次跑都多留一份 dist/ 的副本。
  try {
    if (typeof testExtDir === 'string') rmSync(testExtDir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
}

process.exit(exitCode);
