/**
 * 证据脚本：webRequest 的可见范围、extraInfoSpec 行为、securityInfo 可用性。
 *
 * 【要证明什么】
 *   为「v1.2 设计方案 §1 事实基线」提供可复现的实测依据：
 *     F3 —— securityInfo 在 Chrome 156 上返回 null（拿不到服务器证书）
 *     F4 —— webRequest 能看到扩展自己发出的请求
 *     F5 —— 想看外部站点的请求，必须有 host_permissions
 *     F6 —— onHeadersReceived 的 extraInfoSpec 不能随便混搭，
 *           组合非法时监听器静默失效
 *
 * 【实验装置】
 *   1. 复制一份 dist/ 作为「测试变体」：把 webRequest 提为必需权限，
 *      并加上 <all_urls> 的 host_permissions（否则看不到外部站点）。
 *      被测逻辑与正式产物完全一致，只有授权方式不同。
 *   2. 用 CDP 把扩展加载进真实 Chrome。
 *   3. 通过 CDP 在扩展的 dashboard 页面上下文里注册监听器 ——
 *      扩展页面本身就是扩展 origin，拥有完整 chrome.webRequest 访问权，
 *      因此无需改动任何生产代码。
 *   4. 分别用「页面发起」和「Service Worker 发起」两种方式各打一个
 *      真实 HTTPS 请求，观察事件流。
 *
 * 用法：
 *   node scripts/probe-security-info.mjs            # headless
 *   node scripts/probe-security-info.mjs --headful  # 有头（窗口挪到屏幕外）
 */
import { spawn } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const DIST = resolve(process.cwd(), 'dist');
const CDP_PORT = 9479;

function prepareTestExtension() {
  const dir = mkdtempSync(join(tmpdir(), 'cp-secinfo-ext-'));
  cpSync(DIST, dir, { recursive: true });
  const manifestPath = join(dir, 'manifest.json');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  manifest.permissions = [...(manifest.permissions ?? []), 'webRequest'];
  manifest.optional_permissions = (manifest.optional_permissions ?? []).filter((p) => p !== 'webRequest');
  // webRequest 只能看到扩展有 host 权限的请求，所以这里必须补 host_permissions
  manifest.host_permissions = ['<all_urls>'];
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
  return dir;
}

async function waitForDevTools() {
  for (let i = 0; i < 60; i += 1) {
    try {
      const res = await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`);
      if (res.ok) return await res.json();
    } catch {
      /* wait */
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
  const r = await client.send('Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true,
  });
  if (r.exceptionDetails) {
    throw new Error(r.exceptionDetails.exception?.description ?? JSON.stringify(r.exceptionDetails));
  }
  return r.result.value;
}

const HEADFUL = process.argv.includes('--headful');

const profile = mkdtempSync(join(tmpdir(), 'cp-secinfo-'));
const chrome = spawn(
  CHROME,
  [
    ...(HEADFUL ? [] : ['--headless=new']),
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-gpu',
    ...(HEADFUL ? ['--window-position=-32000,-32000', '--window-size=800,600'] : []),
    `--user-data-dir=${profile}`,
    `--remote-debugging-port=${CDP_PORT}`,
    'about:blank',
  ],
  { stdio: 'ignore' },
);

let browser = null;
let page = null;
let exitCode = 0;
try {
  const version = await waitForDevTools();
  browser = connect(version.webSocketDebuggerUrl);
  await browser.ready;

  const testExtDir = prepareTestExtension();
  await browser.send('Extensions.loadUnpacked', { path: testExtDir });
  const list = await browser.send('Extensions.getExtensions');
  const ext = (list.extensions ?? []).find((e) => e.name === 'Chrome Postman');
  if (!ext) throw new Error('extension not loaded');
  console.log('扩展已加载：', ext.id);

  const res = await fetch(`http://127.0.0.1:${CDP_PORT}/json/new?about:blank`, { method: 'PUT' });
  const target = await res.json();
  page = connect(target.webSocketDebuggerUrl);
  await page.ready;
  await page.send('Runtime.enable');
  await page.send('Page.enable');
  await page.send('Page.navigate', { url: `chrome-extension://${ext.id}/dashboard/index.html` });
  await new Promise((r) => setTimeout(r, 2500));

  // 在扩展页面上下文注册 securityInfo 监听器并触发一个 HTTPS 请求
  const script = `
    (async () => {
      const captured = [];
      const events = [];
      let registerError = null;
      const onErr = (e) => { registerError = String(e && e.message ? e.message : e); };

      // A/B/C：同一个事件，三种 extraInfoSpec，定位到底是哪一项让监听器失效
      const specs = [
        { tag: 'A:responseHeaders', spec: ['responseHeaders'] },
        { tag: 'B:securityInfo', spec: ['securityInfo'] },
        { tag: 'C:securityInfoRawDer', spec: ['securityInfoRawDer'] },
      ];
      for (const s of specs) {
        try {
          chrome.webRequest.onHeadersReceived.addListener(
            (d) => {
              events.push({ ev: 'headers[' + s.tag + ']', url: d.url, hasSecInfo: !!d.securityInfo });
              captured.push({
                tag: s.tag,
                url: d.url,
                statusCode: d.statusCode,
                securityInfo: d.securityInfo ?? null,
              });
            },
            { urls: ['<all_urls>'] },
            s.spec,
          );
        } catch (e) {
          events.push({ ev: 'register-failed[' + s.tag + ']', url: String(e && e.message ? e.message : e) });
        }
      }

      try {
        chrome.webRequest.onBeforeRequest.addListener(
          (d) => events.push({ ev: 'beforeRequest', url: d.url }),
          { urls: ['<all_urls>'] },
        );
        chrome.webRequest.onCompleted.addListener(
          (d) => events.push({ ev: 'completed', url: d.url }),
          { urls: ['<all_urls>'] },
        );
      } catch (e) { onErr(e); }

      // 1) 页面自己发一个请求
      try { await fetch('https://example.com/', { mode: 'no-cors' }); } catch (e) { /* ignore */ }
      await new Promise(r => setTimeout(r, 2000));

      // 2) 让 Service Worker 发一个请求（走扩展自己的执行管线）
      try {
        await chrome.runtime.sendMessage({
          type: 'EXECUTE_REQUEST',
          payload: {
            requestId: 'probe1',
            request: {
              id: 'probe', name: 'probe', method: 'GET',
              url: 'https://www.baidu.com/',
              params: [], headers: [],
              body: { mode: 'none', raw: '', form: [], formData: [] },
              auth: { type: 'none' }, preScript: '', postScript: '',
              createdAt: Date.now(), updatedAt: Date.now(),
            },
          },
        });
      } catch (e) { /* ignore */ }
      await new Promise(r => setTimeout(r, 2500));

      return JSON.stringify({ captured, events, registerError });
    })()
  `;

  const raw = await evaluate(page, script);
  const parsed = JSON.parse(raw);
  const captured = parsed.captured ?? [];

  console.log('\n=== 监听器注册 ===');
  console.log('registerError:', parsed.registerError ?? '(无)');

  console.log('\n=== 事件流 ===');
  for (const e of parsed.events ?? []) {
    console.log(`  [${e.ev}] ${e.url}${e.hasSecInfo !== undefined ? '  hasSecurityInfo=' + e.hasSecInfo : ''}`);
  }
  if (!(parsed.events ?? []).length) console.log('  （没有任何事件）');

  console.log('\n=== 捕获到的 onHeadersReceived 事件 ===');
  if (!captured.length) {
    console.log('（没有捕获到任何事件）');
  }
  for (const item of captured) {
    console.log('\nURL:', item.url);
    console.log('statusCode:', item.statusCode);
    console.log('securityInfo 原始结构:');
    console.log(
      JSON.stringify(
        item.securityInfo,
        (k, v) => (k === 'rawDER' ? `<ArrayBuffer ${v?.byteLength ?? '?'} bytes>` : v),
        2,
      ),
    );
  }

  const ok = captured.some((c) => c.securityInfo && c.securityInfo.certificates?.length);
  console.log('\n结论：' + (ok ? '能拿到证书信息（sha256 指纹 + rawDER + state）' : '没拿到证书信息'));
  exitCode = ok ? 0 : 1;
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
  try {
    rmSync(profile, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
}

process.exit(exitCode);
