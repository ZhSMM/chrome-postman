/**
 * ============================================================
 * Native 桥接实机验证（真实 Chrome + 真实伴生程序 + 自签证书）
 * ============================================================
 *
 * 【为什么需要这个脚本】
 * 单元测试只能证明"代码按设计工作"，证明不了"浏览器真的愿意跟伴生程序说话"。
 * 批次 5 的验收标准写的是**实机验证**：
 *   Windows 装伴生程序 → 访问自签证书 HTTPS → 成功 + 证书体检正确 + 不安全模式有横幅
 * 这个脚本就是那条验收标准。
 *
 * 【验证链路】
 *   1. 用 .NET 的 CertificateRequest 生成一张自签证书（SAN 含 127.0.0.1）
 *   2. 起一个 HTTPS 服务（Node），用的是那张自签证书
 *   3. 复制一份 dist/ 当"测试变体"，把 nativeMessaging 从可选权限提成必需权限
 *      【为什么要测试变体】
 *      chrome.permissions.request() 只能在真实用户手势里调用，
 *      自动化测试里的合成手势不算数。所以这里绕过权限申请环节，
 *      直接把权限写死 —— 验证的是"装了伴生程序之后到底能不能用"。
 *   4. 第一次跑 Chrome：加载扩展，拿到它的真实 ID
 *   5. 用真实扩展 ID 跑 install-host.ps1（写 HKCU 注册表，不需要管理员）
 *   6. 第二次跑 Chrome：重新加载同一个路径的扩展（未打包扩展的 ID 由路径决定，
 *      所以两次的 ID 相同）
 *   7. 在工作台页面里真的发一次请求：
 *      - 跳过校验 → 应该拿到 200，且 result.insecure === true
 *      - 严格校验 → 应该失败，且错误是证书相关
 *      - 证书体检 → 应该拿到颁发者 / 有效期 / SPKI 指纹
 *
 * 【注意：会写注册表】
 * 脚本会往 HKCU\Software\Google\Chrome\NativeMessagingHosts 下写一个键。
 * 跑完可以手工删除，或者用 --uninstall 参数跑一次清理。
 *
 * 用法：
 *   node scripts/native-bridge-e2e.mjs
 */
import { spawn, spawnSync } from 'node:child_process';
import { createHash, X509Certificate } from 'node:crypto';
import { createServer } from 'node:https';
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const ROOT = resolve(process.cwd());
const DIST = resolve(ROOT, 'dist');
const NATIVE_HOST = resolve(ROOT, 'native-host');

/**
 * 工作目录用固定路径，不用随机临时目录。
 * 【为什么】未打包扩展的 ID 是由**绝对路径**算出来的，
 * 路径变了 ID 就变了 —— 第一次拿到的 ID 和第二次装注册表时用的 ID 对不上，
 * Chrome 会直接拒绝连接伴生程序。
 */
const WORK = join(tmpdir(), 'cp-native-e2e');
const EXT_DIR = join(WORK, 'ext');
const CERT_DIR = join(WORK, 'cert');
const HOST_DIR = join(WORK, 'host');
const PROFILE_DIR = join(WORK, 'profile');

const PORT = 8766;
const CDP_PORT = 9446;

/* ------------------------------------------------------------------
 * 0. 前置检查
 * ---------------------------------------------------------------- */
for (const [label, p] of [
  ['dist/', DIST],
  ['native-host/bridge.mjs', join(NATIVE_HOST, 'bridge.mjs')],
  ['native-host/install-host.ps1', join(NATIVE_HOST, 'install-host.ps1')],
  ['scripts/make-test-cert.ps1', join(ROOT, 'scripts', 'make-test-cert.ps1')],
]) {
  if (!existsSync(p)) {
    console.error(`✗ 缺少 ${label}`);
    process.exit(1);
  }
}

/* ------------------------------------------------------------------
 * 1. 准备测试变体扩展
 * ---------------------------------------------------------------- */
rmSync(WORK, { recursive: true, force: true });
mkdirSync(WORK, { recursive: true });
cpSync(DIST, EXT_DIR, { recursive: true });

const manifestPath = join(EXT_DIR, 'manifest.json');
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
// 把 nativeMessaging 提成必需权限，跳过 chrome.permissions.request 的用户手势限制
manifest.optional_permissions = (manifest.optional_permissions ?? []).filter((p) => p !== 'nativeMessaging');
manifest.permissions = [...(manifest.permissions ?? []), 'nativeMessaging'];
writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
console.log('[1/7] 测试变体扩展已就绪（nativeMessaging 提为必需权限）');

/* ------------------------------------------------------------------
 * 2. 生成自签证书
 * ---------------------------------------------------------------- */
function runPowerShell(script, extraArgs) {
  // pwsh (PowerShell 7) 优先；没有就退回 Windows PowerShell 5.1。
  // 脚本是纯 ASCII 的，两个版本都能跑。
  for (const shell of ['pwsh', 'powershell']) {
    const probe = spawnSync(shell, ['-NoProfile', '-Command', '$PSVersionTable.PSVersion.Major'], {
      encoding: 'utf8',
    });
    if (probe.status === 0) {
      return spawnSync(
        shell,
        ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script, ...extraArgs],
        { encoding: 'utf8' },
      );
    }
  }
  throw new Error('找不到 pwsh / powershell');
}

const certRun = runPowerShell(join(ROOT, 'scripts', 'make-test-cert.ps1'), ['-OutDir', CERT_DIR]);
if (certRun.status !== 0) {
  console.error('✗ 生成自签证书失败：');
  console.error(certRun.stdout);
  console.error(certRun.stderr);
  process.exit(1);
}
console.log('[2/7] 自签证书已生成');

/* ------------------------------------------------------------------
 * 3. 起一个用自签证书的 HTTPS 服务
 * ---------------------------------------------------------------- */
const httpsServer = createServer(
  {
    key: readFileSync(join(CERT_DIR, 'key.pem')),
    cert: readFileSync(join(CERT_DIR, 'cert.pem')),
  },
  (req, res) => {
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ ok: true, path: req.url, via: 'https-selfsigned' }));
  },
);
await new Promise((r) => httpsServer.listen(PORT, '127.0.0.1', r));
console.log(`[3/7] 自签 HTTPS 服务已启动：https://127.0.0.1:${PORT}`);

/* ------------------------------------------------------------------
 * 4. CDP 小工具
 * ---------------------------------------------------------------- */
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

/** 启动一次 Chrome（独立 profile），返回 { chrome, version } */
async function launchChrome() {
  mkdirSync(PROFILE_DIR, { recursive: true });
  const chrome = spawn(
    CHROME,
    [
      '--headless=new',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-gpu',
      `--user-data-dir=${PROFILE_DIR}`,
      `--remote-debugging-port=${CDP_PORT}`,
      'about:blank',
    ],
    { stdio: 'ignore' },
  );
  const version = await waitForDevTools();
  return { chrome, version };
}

/**
 * 彻底干掉 Chrome 进程树。
 * 【为什么不能只用 chrome.kill()】
 * Chrome 会 fork 出渲染进程 / GPU 进程，杀掉主进程后子进程还活着，
 * 会一直占着 user-data-dir 的锁 —— 下一次启动就失败。
 */
function killChromeTree(chrome) {
  try {
    spawnSync('taskkill', ['/PID', String(chrome.pid), '/T', '/F'], { stdio: 'ignore' });
  } catch {
    /* ignore */
  }
  try {
    chrome.kill();
  } catch {
    /* ignore */
  }
}

/* ------------------------------------------------------------------
 * 5. 第一次跑 Chrome：拿到扩展 ID
 * ---------------------------------------------------------------- */
let extId = null;
{
  const { chrome, version } = await launchChrome();
  console.log('[4/7] Chrome 已启动：', version['Browser']);
  const browserClient = connect(version.webSocketDebuggerUrl);
  await browserClient.ready;
  await browserClient.send('Extensions.loadUnpacked', { path: EXT_DIR });
  const list = await browserClient.send('Extensions.getExtensions');
  const ours = (list.extensions ?? []).find((e) => e.name === 'Chrome Postman');
  browserClient.close();
  killChromeTree(chrome);
  if (!ours) {
    console.error('✗ 扩展没加载成功：', JSON.stringify(list));
    process.exit(1);
  }
  extId = ours.id;
  console.log(`[5/7] 扩展 ID：${extId}`);
}

/* ------------------------------------------------------------------
 * 6. 安装伴生程序（真实写注册表）
 * ---------------------------------------------------------------- */
{
  const ps = runPowerShell(join(NATIVE_HOST, 'install-host.ps1'), [
    '-ExtensionId',
    extId,
    '-InstallDir',
    HOST_DIR,
  ]);
  console.log('    安装脚本输出：');
  (ps.stdout ?? '')
    .split('\n')
    .filter(Boolean)
    .forEach((line) => console.log('      ' + line));
  if (ps.status !== 0) {
    console.error('✗ 安装伴生程序失败：');
    console.error(ps.stderr);
    process.exit(1);
  }
}
console.log('[6/7] 伴生程序已注册（HKCU，无需管理员权限）');

/* ------------------------------------------------------------------
 * 7. 第二次跑 Chrome：真的用起来
 * ---------------------------------------------------------------- */
let exitCode = 0;
let browserClient = null;
let pageClient = null;
let chromeProc = null;
try {
  const { chrome, version } = await launchChrome();
  chromeProc = chrome;
  browserClient = connect(version.webSocketDebuggerUrl);
  await browserClient.ready;
  await browserClient.send('Extensions.loadUnpacked', { path: EXT_DIR });

  const blank = await openPage('about:blank');
  pageClient = connect(blank.webSocketDebuggerUrl);
  await pageClient.ready;
  await pageClient.send('Runtime.enable');
  await pageClient.send('Page.enable');
  await pageClient.send('Page.navigate', { url: `chrome-extension://${extId}/dashboard/index.html` });

  // 等 React 挂载
  let mounted = false;
  for (let i = 0; i < 50; i += 1) {
    await new Promise((r) => setTimeout(r, 200));
    try {
      mounted = await evaluate(pageClient, `!!document.querySelector('.app-header')`);
    } catch {
      /* 还在导航 */
    }
    if (mounted) break;
  }
  if (!mounted) {
    pageClient.events.forEach((e) => {
      if (e.method === 'Runtime.exceptionThrown') {
        console.error('    EXCEPTION:', e.params.exceptionDetails?.exception?.description);
      }
    });
    throw new Error('工作台没有渲染出来');
  }

  /*
   * 三个场景：
   *   loose  —— 跳过校验，走桥接，应当成功且 insecure=true
   *   strict —— 严格校验，走桥接，应当因证书失败
   *   cert   —— 证书体检，应当拿到颁发者 / SPKI
   */
  const script = `
    (async () => {
      const KEY = 'cp.settings';
      const stored = await chrome.storage.local.get(KEY);
      const base = stored[KEY] || {};

      const request = {
        id: 'req_nb', name: 'native-bridge', method: 'GET',
        url: 'https://127.0.0.1:${PORT}/secure',
        params: [], headers: [], body: { mode: 'none', raw: '', form: [], formData: [] },
        auth: { type: 'none' }, preScript: '', postScript: '',
        createdAt: Date.now(), updatedAt: Date.now()
      };

      // --- 1. 跳过校验 ---
      await chrome.storage.local.set({ [KEY]: { ...base, sslMode: 'native-bridge', allowInsecureTls: true } });
      const looseRes = await chrome.runtime.sendMessage({
        type: 'EXECUTE_REQUEST', payload: { request, requestId: 'nb-loose' }
      });
      const looseR = looseRes?.payload?.result;

      // --- 2. 严格校验 ---
      await chrome.storage.local.set({ [KEY]: { ...base, sslMode: 'native-bridge', allowInsecureTls: false } });
      const strictRes = await chrome.runtime.sendMessage({
        type: 'EXECUTE_REQUEST', payload: { request, requestId: 'nb-strict' }
      });
      const strictR = strictRes?.payload?.result;

      // --- 3. 证书体检 ---
      const certRes = await chrome.runtime.sendMessage({
        type: 'INSPECT_CERT', payload: { url: 'https://127.0.0.1:${PORT}', timeoutMs: 8000 }
      });

      return JSON.stringify({
        loose: {
          status: looseR?.response?.status ?? null,
          body: looseR?.response?.body ?? null,
          error: looseR?.error ?? null,
          insecure: looseR?.insecure ?? null,
          notice: looseR?.sslNotice ?? null
        },
        strict: {
          status: strictR?.response?.status ?? null,
          error: strictR?.error ?? null
        },
        cert: certRes?.payload ?? null
      });
    })()
  `;

  const raw = await evaluate(pageClient, script);
  const data = JSON.parse(raw);

  console.log('');
  console.log('=== NATIVE BRIDGE RESULT ===');
  console.log('跳过校验 → 状态 :', data.loose.status);
  console.log('跳过校验 → 响应 :', data.loose.body);
  console.log('跳过校验 → 错误 :', data.loose.error ?? '(none)');
  console.log('跳过校验 → insecure 标记 :', data.loose.insecure);
  console.log('跳过校验 → 降级提示 :', data.loose.notice ?? '(none)');
  console.log('严格校验 → 状态 :', data.strict.status ?? '(none)');
  console.log('严格校验 → 错误 :', data.strict.error ?? '(none)');
  console.log('证书体检 → 颁发者 :', data.cert?.cert?.issuer?.commonName);
  console.log('证书体检 → 自签名 :', data.cert?.cert?.selfSigned);
  console.log('证书体检 → 有效期至 :', data.cert?.cert?.validTo);
  console.log('证书体检 → SPKI :', data.cert?.cert?.spkiSha256Base64);
  console.log('证书体检 → 错误 :', data.cert?.error ?? '(none)');

  const certInfo = data.cert?.cert ?? null;
  /*
   * SPKI 交叉校验：伴生程序算出来的指纹，必须和 Node 自己从证书算出来的一致。
   * 【为什么必须交叉校验】
   * SPKI 指纹是要喂给 Chrome 的 --ignore-certificate-errors-spki-list 的。
   * 如果算错了（比如误用了整张证书的哈希），参数看着像模像样，
   * 但 Chrome 会静默不生效 —— 用户会以为"配了白名单就能用了"，其实一直不行。
   */
  const expectedSpki = createHash('sha256')
    .update(new X509Certificate(readFileSync(join(CERT_DIR, 'cert.pem'))).publicKey.export({
      type: 'spki',
      format: 'der',
    }))
    .digest('base64');

  const checks = [
    ['桥接通道请求成功（跳过校验拿到 200）', data.loose.status === 200],
    ['响应体来自 HTTPS 服务', String(data.loose.body).includes('https-selfsigned')],
    ['insecure 标记已置位（UI 会显示横幅）', data.loose.insecure === true],
    ['没有出现"静默降级"提示', !data.loose.notice],
    ['严格校验时因证书失败', !data.strict.status && /证书|certificate|SELF_SIGNED/i.test(String(data.strict.error))],
    ['证书体检拿到了颁发者', Boolean(certInfo?.issuer?.commonName)],
    ['证书体检判定为自签名', certInfo?.selfSigned === true],
    ['证书体检算出了 SPKI 指纹', typeof certInfo?.spkiSha256Base64 === 'string' && certInfo.spkiSha256Base64.length > 20],
    ['SPKI 指纹与 Node 独立计算一致', certInfo?.spkiSha256Base64 === expectedSpki],
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
  console.error('NATIVE BRIDGE E2E ERROR:', err.message);
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
  if (chromeProc) killChromeTree(chromeProc);
  httpsServer.close();

  /*
   * 清理注册表。
   * 【为什么要清】这个脚本往用户的 HKCU 里写了一个键。
   * 测试脚本不应该在用户机器上留残留 —— 不清理的话，
   * 用户下次装伴生程序时可能困惑"为什么已经装过了"。
   * 想保留下来手动体验的话，加 --keep-host 参数。
   */
  if (!process.argv.includes('--keep-host')) {
    const result = spawnSync(
      'reg',
      ['delete', 'HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\com.chrome_postman.bridge', '/f'],
      { encoding: 'utf8' },
    );
    console.log('');
    console.log(
      result.status === 0
        ? '（已清理测试用的注册表项；加 --keep-host 可保留供手动体验）'
        : '（注册表项清理失败，可手工执行：reg delete "HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\com.chrome_postman.bridge" /f）',
    );
    // 连同工作目录一起清掉，别在临时目录里留一堆残留
    try {
      rmSync(WORK, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
}

process.exit(exitCode);
