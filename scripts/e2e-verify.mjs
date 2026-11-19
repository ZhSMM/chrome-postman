/**
 * 端到端验证脚本（真实 Chrome + 真实扩展）。
 *
 * 【为什么不用 --load-extension】
 * Google Chrome 品牌版从 137 起在命令行层面禁用了 --load-extension
 * （日志里会明确打印 "is not allowed in Google Chrome, ignoring."）。
 * 正解是用 DevTools Protocol 的 Extensions 域：
 *   Extensions.loadUnpacked { path }  →  加载未打包扩展
 *   Extensions.getExtensions          →  查扩展列表（含真实 id）
 *
 * 【验证链路】
 *   1. 起一个本地 HTTP 服务（模拟被调接口）
 *   2. 启动 Chrome（headless）+ 远程调试
 *   3. 通过 CDP 加载 dist/ 扩展
 *   4. 打开扩展的 dashboard 页面
 *   5. 在页面里调用 chrome.runtime.sendMessage，让 Service Worker 真正执行一次请求：
 *        前置脚本改写请求头 → 真实 fetch → 后置脚本解析响应 + 写断言 + 提取变量
 *   6. 校验返回结果
 *
 * 用法：node scripts/e2e-verify.mjs
 */
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const DIST = resolve(process.cwd(), 'dist');
const SHOT_DIR = resolve(process.cwd(), 'docs/screenshots');
const PORT = 8765;
const CDP_PORT = 9444;

/* ---------- 1. 本地被调服务 ---------- */
const server = createServer((req, res) => {
  res.setHeader('content-type', 'application/json');
  res.setHeader('access-control-allow-origin', '*');
  res.end(
    JSON.stringify({
      ok: true,
      path: req.url,
      method: req.method,
      token: req.headers['x-token'] ?? null,
      auth: req.headers['authorization'] ?? null,
    }),
  );
});
await new Promise((r) => server.listen(PORT, '127.0.0.1', r));
console.log(`[1/5] local API up on http://127.0.0.1:${PORT}`);

/* ---------- 2. 启动 Chrome ---------- */
const profile = mkdtempSync(join(tmpdir(), 'cp-e2e-'));
const chrome = spawn(
  CHROME,
  [
    '--headless=new',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-gpu',
    `--user-data-dir=${profile}`,
    `--remote-debugging-port=${CDP_PORT}`,
    'about:blank',
  ],
  { stdio: 'ignore' },
);
console.log('[2/5] chrome launched');

/* ---------- 3. CDP 客户端 ---------- */
async function waitForDevTools() {
  for (let i = 0; i < 60; i += 1) {
    try {
      const res = await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`);
      if (res.ok) return await res.json();
    } catch {
      /* 还没起来 */
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error('devtools endpoint not reachable');
}

/** 极简 CDP 客户端 */
function connect(wsUrl) {
  const ws = new WebSocket(wsUrl);
  const pending = new Map();
  const events = [];
  let seq = 0;
  const ready = new Promise((resolveReady, rejectReady) => {
    ws.onopen = () => resolveReady();
    ws.onerror = () => rejectReady(new Error('ws connection failed'));
  });
  ws.onmessage = (event) => {
    const msg = JSON.parse(event.data);
    if (msg.id && pending.has(msg.id)) {
      const { resolve: res, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) reject(new Error(msg.error.message ?? JSON.stringify(msg.error)));
      else res(msg.result);
    } else if (msg.method) {
      // 收集事件（console / exception / load）
      events.push(msg);
    }
  };
  return {
    ready,
    events,
    send(method, params = {}) {
      seq += 1;
      const id = seq;
      return new Promise((res, reject) => {
        pending.set(id, { resolve: res, reject });
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
  const result = await client.send('Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true,
  });
  if (result.exceptionDetails) {
    const desc =
      result.exceptionDetails.exception?.description ?? JSON.stringify(result.exceptionDetails);
    throw new Error('page exception: ' + desc);
  }
  return result.result.value;
}

async function openPage(url) {
  const res = await fetch(`http://127.0.0.1:${CDP_PORT}/json/new?${encodeURIComponent(url)}`, {
    method: 'PUT',
  });
  if (!res.ok) throw new Error(`cannot open page: ${res.status}`);
  return res.json();
}

/* ---------- 4. 主流程 ---------- */
let exitCode = 0;
let browserClient = null;
let pageClient = null;
try {
  const version = await waitForDevTools();
  console.log('[3/5] devtools ready:', version['Browser']);

  // 浏览器级连接
  browserClient = connect(version.webSocketDebuggerUrl);
  await browserClient.ready;

  // 通过 CDP 加载未打包扩展
  await browserClient.send('Extensions.loadUnpacked', { path: DIST });
  const list = await browserClient.send('Extensions.getExtensions');
  const ours = (list.extensions ?? []).find((e) => e.name === 'Chrome Postman');
  if (!ours) {
    throw new Error('extension not found in Extensions.getExtensions: ' + JSON.stringify(list));
  }
  const extId = ours.id;
  console.log(`[4/5] extension loaded: ${ours.name} (${extId})`);

  // 打开工作台页面。
  // 关键：先开一个空白页并接上 CDP，再 navigate 过去，
  // 这样才能在脚本执行前挂上 Runtime/Log 监听，捕获到加载期的报错。
  const blank = await openPage('about:blank');
  pageClient = connect(blank.webSocketDebuggerUrl);
  await pageClient.ready;
  await pageClient.send('Runtime.enable');
  await pageClient.send('Log.enable');
  await pageClient.send('Page.enable');

  const pageUrl = `chrome-extension://${extId}/dashboard/index.html`;
  await pageClient.send('Page.navigate', { url: pageUrl });

  // 等待 React 挂载（最多 10 秒）
  let mounted = false;
  for (let i = 0; i < 50; i += 1) {
    await new Promise((r) => setTimeout(r, 200));
    try {
      mounted = await evaluate(pageClient, `!!document.querySelector('.app-header')`);
    } catch {
      /* 页面还在导航中 */
    }
    if (mounted) break;
  }

  // 确认 React 已经渲染出来
  const probe = await evaluate(
    pageClient,
    `JSON.stringify({
       title: document.title,
       header: !!document.querySelector('.app-header'),
       sidebar: !!document.querySelector('.app-sidebar'),
       urlInput: !!document.querySelector('.url-input'),
       sendBtn: !!document.querySelector('.btn.primary'),
       rootChildren: document.getElementById('root')?.children.length ?? 0
     })`,
  );
  console.log('    dashboard probe:', probe);

  // 截图存档（交付物：真实运行界面）
  try {
    const shot = await pageClient.send('Page.captureScreenshot', { format: 'png' });
    mkdirSync(SHOT_DIR, { recursive: true });
    writeFileSync(join(SHOT_DIR, 'dashboard.png'), Buffer.from(shot.data, 'base64'));
    console.log('    screenshot saved: docs/screenshots/dashboard.png');
  } catch (e) {
    console.log('    screenshot skipped:', e.message);
  }

  // 若没渲染出来，把控制台报错打出来
  if (!mounted) {
    console.log('    --- console / exception events ---');
    pageClient.events.forEach((e) => {
      if (e.method === 'Runtime.exceptionThrown') {
        console.log('    EXCEPTION:', e.params.exceptionDetails?.exception?.description ?? JSON.stringify(e.params));
      } else if (e.method === 'Runtime.consoleAPICalled') {
        console.log(
          '    CONSOLE:',
          e.params.type,
          (e.params.args ?? []).map((a) => a.description ?? a.value).join(' '),
        );
      } else if (e.method === 'Log.entryAdded') {
        console.log('    LOG:', e.params.entry.level, e.params.entry.text, e.params.entry.url ?? '');
      }
    });
  }

  // 真正跑一次请求
  const script = `
    (async () => {
      const request = {
        id: 'req_e2e',
        name: 'e2e',
        method: 'POST',
        url: 'http://127.0.0.1:${PORT}/e2e?trace=1',
        params: [],
        headers: [{ id: 'h1', key: 'Content-Type', value: 'application/json', enabled: true }],
        body: { mode: 'json', raw: '{"hello":"world"}', form: [], formData: [] },
        auth: { type: 'bearer', token: 'e2e-token' },
        preScript: "pm.request.headers.upsert({ name: 'X-Token', value: 'from-script' }); pm.environment.set('scratch', 'ok');",
        postScript: "pm.test('status is 200', function () { pm.response.to.have.status(200); }); pm.test('body ok', function () { pm.expect(pm.response.json().ok).to.be.true; }); pm.environment.set('gotPath', String(pm.response.json().path));",
        createdAt: Date.now(),
        updatedAt: Date.now()
      };
      const res = await chrome.runtime.sendMessage({
        type: 'EXECUTE_REQUEST',
        payload: { request, requestId: 'e2e-1' }
      });
      return JSON.stringify({
        type: res?.type ?? null,
        status: res?.payload?.result?.response?.status ?? null,
        body: res?.payload?.result?.response?.body ?? null,
        error: res?.payload?.result?.error ?? null,
        tests: res?.payload?.result?.outcome?.tests ?? [],
        vars: res?.payload?.result?.outcome?.variables ?? null,
        scriptError: res?.payload?.result?.outcome?.error ?? null,
        logs: res?.payload?.result?.outcome?.logs ?? []
      });
    })()
  `;

  const raw = await evaluate(pageClient, script);
  const data = JSON.parse(raw);

  console.log('');
  console.log('=== E2E RESULT ===');
  console.log('message type   :', data.type);
  console.log('response status :', data.status);
  console.log('response body   :', data.body);
  console.log('network error   :', data.error ?? '(none)');
  console.log('script error    :', data.scriptError ?? '(none)');
  console.log('tests           :', JSON.stringify(data.tests));
  console.log('script vars     :', JSON.stringify(data.vars));

  const page = JSON.parse(probe);
  const checks = [
    ['React 工作台已渲染', page.header && page.sidebar && page.urlInput],
    ['Service Worker 响应消息', data.type === 'EXECUTE_RESULT'],
    ['请求真的发出并拿到 200', data.status === 200],
    ['前置脚本注入的 X-Token 生效', String(data.body).includes('from-script')],
    ['Bearer 鉴权头生效', String(data.body).includes('e2e-token')],
    [
      '后置脚本断言全部通过',
      Array.isArray(data.tests) && data.tests.length === 2 && data.tests.every((t) => t.passed),
    ],
    ['后置脚本提取的变量存在', data.vars?.environment?.gotPath?.includes('/e2e')],
    ['无脚本错误', !data.scriptError],
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
  console.error('E2E ERROR:', err.message);
  exitCode = 1;
} finally {
  try {
    pageClient?.close();
  } catch {
    /* ignore */
  }
  try {
    browserClient?.close();
  } catch {
    /* ignore */
  }
  chrome.kill();
  server.close();
  try {
    rmSync(profile, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
}

process.exit(exitCode);
