/**
 * 代理行为探针（实证用）。
 *
 * 【要回答的问题】
 *   浏览���设置了代理之后，扩展 Service Worker 里发起的 fetch，
 *   到底会不会走这个代理？走代理时又会在哪一步失败？
 *
 * 【为什么必须实测】
 *   网上关于"扩展请求是否遵循系统代理"的说法互相矛盾，
 *   而且失败原因有好几种（代理认证 407 / HTTPS 解密证书不受信任 /
 *   代理连不上），表现都是笼统的 "Failed to fetch"。
 *   与其猜，不如起一个本地代理，把链路看清楚。
 *
 * 【实验设计】
 *   1. 起一个最小 HTTP 代理，记录收到的所有请求
 *   2. 用 --proxy-server 让 Chrome 走这个代理
 *   3. 通过 CDP 加载扩展，让 Service Worker 发起一次请求
 *   4. 看代理有没有收到请求、扩展拿到什么响应
 *
 * 用法：node scripts/proxy-probe.mjs
 */
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const DIST = resolve(process.cwd(), 'dist');
const PROXY_PORT = 8899;
const CDP_PORT = 9477;

/* ---------- 1. 迷你代理 ---------- */
const proxyLog = [];

const proxy = createServer((req, res) => {
  // 明文 HTTP：浏览器会把完整 URL 放在请求行里（absolute-URI 形式）
  proxyLog.push({ kind: 'http', url: req.url, host: req.headers.host });
  res.writeHead(200, { 'content-type': 'application/json', 'x-via': 'cp-proxy-probe' });
  res.end(JSON.stringify({ viaProxy: true, sawUrl: req.url, host: req.headers.host }));
});

// HTTPS：浏览器发 CONNECT 隧道请求
proxy.on('connect', (req, socket) => {
  proxyLog.push({ kind: 'connect', url: req.url });
  // 不做真正的隧道，直接回 502，让浏览器看到"代理侧失败"
  socket.end('HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\n\r\n');
});

await new Promise((r) => proxy.listen(PROXY_PORT, '127.0.0.1', r));
console.log(`[1/4] 本地代理已启动 127.0.0.1:${PROXY_PORT}`);

/* ---------- 2. 启动 Chrome（走代理） ---------- */
const profile = mkdtempSync(join(tmpdir(), 'cp-proxy-'));
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
console.log(`[2/4] chrome 已启动（--proxy-server=http://127.0.0.1:${PROXY_PORT}）`);

/* ---------- 3. CDP 工具 ---------- */
async function waitForDevTools() {
  for (let i = 0; i < 60; i += 1) {
    try {
      const res = await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`);
      if (res.ok) return await res.json();
    } catch {
      /* 等待中 */
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

async function evaluate(client, expression) {
  await client.ready;
  const r = await client.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) {
    throw new Error(r.exceptionDetails.exception?.description ?? JSON.stringify(r.exceptionDetails));
  }
  return r.result.value;
}

/* ---------- 4. 主流程 ---------- */
let browser = null;
let page = null;
try {
  const version = await waitForDevTools();
  browser = connect(version.webSocketDebuggerUrl);
  await browser.ready;
  await browser.send('Extensions.loadUnpacked', { path: DIST });
  const list = await browser.send('Extensions.getExtensions');
  const ext = (list.extensions ?? []).find((e) => e.name === 'Chrome Postman');
  if (!ext) throw new Error('extension not loaded');
  console.log(`[3/4] 扩展已加载：${ext.id}`);

  const res = await fetch(`http://127.0.0.1:${CDP_PORT}/json/new?about:blank`, { method: 'PUT' });
  const target = await res.json();
  page = connect(target.webSocketDebuggerUrl);
  await page.ready;
  await page.send('Runtime.enable');
  await page.send('Page.enable');
  await page.send('Page.navigate', { url: `chrome-extension://${ext.id}/dashboard/index.html` });
  await new Promise((r) => setTimeout(r, 2500));

  // 让 Service Worker 发两个请求：一个明文 HTTP，一个 HTTPS
  const script = `
    (async () => {
      async function run(url) {
        const request = {
          id: 'probe_' + url, name: 'probe', method: 'GET', url,
          params: [], headers: [], body: { mode: 'none', raw: '', form: [], formData: [] },
          auth: { type: 'none' }, preScript: '', postScript: '',
          createdAt: Date.now(), updatedAt: Date.now()
        };
        const r = await chrome.runtime.sendMessage({
          type: 'EXECUTE_REQUEST', payload: { request, requestId: 'p1' }
        });
        const res = r?.payload?.result;
        return {
          url,
          status: res?.response?.status ?? null,
          body: (res?.response?.body ?? '').slice(0, 200),
          error: res?.error ?? null
        };
      }
      return JSON.stringify([
        await run('http://proxy-probe.test/api/plain'),
        await run('https://proxy-probe.test/api/tls')
      ]);
    })()
  `;

  const raw = await evaluate(page, script);
  const results = JSON.parse(raw);

  console.log('[4/4] 结果：');
  console.log('');
  console.log('  明文 HTTP 请求 →', JSON.stringify(results[0], null, 0));
  console.log('  HTTPS 请求     →', JSON.stringify(results[1], null, 0));
  console.log('');
  console.log('  代理收到的请求：');
  proxyLog.forEach((entry) => console.log(`    - ${entry.kind}  ${entry.url}`));

  const httpWentThroughProxy = proxyLog.some((e) => e.kind === 'http');
  const httpsReachedProxy = proxyLog.some((e) => e.kind === 'connect');
  console.log('');
  console.log(`  扩展的明文 HTTP 请求是否经过代理：${httpWentThroughProxy ? '是 ✅' : '否 ❌'}`);
  console.log(`  扩展的 HTTPS 请求是否到达代理：  ${httpsReachedProxy ? '是 ✅' : '否 ❌'}`);
  console.log(
    `  结论：扩展请求${httpWentThroughProxy ? '遵循' : '不遵循'}浏览器代理设置`,
  );
} catch (err) {
  console.error('PROBE ERROR:', err.message);
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
}
