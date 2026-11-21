/**
 * 伴生程序自测脚本（放在 native-host/ 目录，不进 tests/）。
 *
 * 【它验证什么】
 *   1. 协议帧收发：喂一帧进去，能读回一帧（4 字节小端长度 + UTF-8 JSON）
 *   2. stdout 里除了协议帧没有别的东西（这是 Chrome 通信失败的头号原因）
 *   3. stderr 有日志（说明日志确实走的是 stderr）
 *   4. ping 返回 ok:true 且带 version
 *   5. 未知 action 返回 ok:false + UNKNOWN_ACTION
 *   6. 非法 JSON 返回 ok:false + INVALID_JSON
 *   7. http 动作：重定向、二进制响应、POST 请求体、超时、连接被拒
 *
 * 【为什么不测真实外网】
 *   外网站点会抖（证书过期、限流），测出来的结果不稳定。
 *   所以 http 的用例全部打本地 127.0.0.1 的临时服务，确定性高。
 *   想验证证书相关功能（inspect-cert / spki 指纹），用 badssl 之类的站点手动测。
 *
 * 用法：node native-host/selftest.mjs
 */
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const BRIDGE = resolve(__dirname, 'bridge.mjs');

let passed = 0;
let failed = 0;

function check(name, condition, extra = '') {
  if (condition) {
    passed += 1;
    console.log(`  ✓ ${name}`);
  } else {
    failed += 1;
    console.error(`  ✗ ${name}${extra ? ` —— ${extra}` : ''}`);
  }
}

/** 把对象编码成 native messaging 帧 */
function encodeFrame(obj) {
  const body = Buffer.from(JSON.stringify(obj), 'utf8');
  const header = Buffer.alloc(4);
  header.writeUInt32LE(body.length, 0);
  return Buffer.concat([header, body]);
}

/**
 * 从 stdout 的字节流里切出一帧。
 * @returns {{ size: number, text: string, rest: Buffer } | null} 还不够一帧时返回 null
 */
function decodeFrame(buffer) {
  if (buffer.length < 4) return null;
  const size = buffer.readUInt32LE(0);
  if (buffer.length < 4 + size) return null;
  return {
    size,
    text: buffer.subarray(4, 4 + size).toString('utf8'),
    rest: buffer.subarray(4 + size),
  };
}

/** 启动伴生程序，跑完一组用例后关掉它 */
async function withBridge(run) {
  const child = spawn(process.execPath, [BRIDGE], { stdio: ['pipe', 'pipe', 'pipe'] });
  const outChunks = [];
  const errChunks = [];
  child.stdout.on('data', (c) => outChunks.push(c));
  child.stderr.on('data', (c) => errChunks.push(c));

  const send = (obj) => child.stdin.write(encodeFrame(obj));
  const sendRaw = (buf) => child.stdin.write(buf);

  /** 等到能切出一帧为止 */
  const nextFrame = async (timeoutMs = 5000) => {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const frame = decodeFrame(Buffer.concat(outChunks));
      if (frame) {
        // 把已消费的部分从缓冲里去掉
        outChunks.length = 0;
        outChunks.push(frame.rest);
        return frame;
      }
      if (Date.now() > deadline) return null;
      await new Promise((r) => setTimeout(r, 20));
    }
  };

  try {
    await run({ send, sendRaw, nextFrame, outChunks, errChunks });
  } finally {
    child.stdin.end();
    child.kill();
  }
}

console.log('=== native-host 自测 ===');

/* ---------- 1. ping ---------- */
await withBridge(async ({ send, nextFrame, outChunks, errChunks }) => {
  send({ id: 'r1', action: 'ping' });
  const frame = await nextFrame();
  check('ping 能收到响应帧', frame !== null);
  if (!frame) return;

  const msg = JSON.parse(frame.text);
  check('ping 返回 ok:true', msg.ok === true, JSON.stringify(msg));
  check('ping 回显 id', msg.id === 'r1', JSON.stringify(msg));
  check('ping 带 version 字段', typeof msg.version === 'string' && msg.version.length > 0, JSON.stringify(msg));

  // stdout 里除了这一帧不能有别的字节
  const leftover = Buffer.concat(outChunks);
  check('stdout 只有协议帧（无多余输出）', leftover.length === 0, `剩余 ${leftover.length} 字节`);

  await new Promise((r) => setTimeout(r, 100));
  check('stderr 有日志输出', Buffer.concat(errChunks).length > 0);
});

/* ---------- 2. 未知 action ---------- */
await withBridge(async ({ send, nextFrame }) => {
  send({ id: 'r2', action: 'nope' });
  const frame = await nextFrame();
  check('未知 action 有响应', frame !== null);
  if (!frame) return;
  const msg = JSON.parse(frame.text);
  check('未知 action 返回 ok:false', msg.ok === false, JSON.stringify(msg));
  check('未知 action 错误码是 UNKNOWN_ACTION', msg.error?.code === 'UNKNOWN_ACTION', JSON.stringify(msg));
});

/* ---------- 3. 非法 JSON ---------- */
await withBridge(async ({ sendRaw, nextFrame }) => {
  const body = Buffer.from('{ not json', 'utf8');
  const header = Buffer.alloc(4);
  header.writeUInt32LE(body.length, 0);
  sendRaw(Buffer.concat([header, body]));
  const frame = await nextFrame();
  check('非法 JSON 有响应', frame !== null);
  if (!frame) return;
  const msg = JSON.parse(frame.text);
  check('非法 JSON 返回 ok:false', msg.ok === false, JSON.stringify(msg));
  check('非法 JSON 错误码是 INVALID_JSON', msg.error?.code === 'INVALID_JSON', JSON.stringify(msg));
});

/* ---------- 4. 一帧里塞多个动作（验证流式切帧） ---------- */
await withBridge(async ({ send, nextFrame }) => {
  send({ id: 'a', action: 'ping' });
  send({ id: 'b', action: 'ping' });
  const f1 = await nextFrame();
  const f2 = await nextFrame();
  check('连续两帧都能收到', f1 !== null && f2 !== null);
  if (f1 && f2) {
    const m1 = JSON.parse(f1.text);
    const m2 = JSON.parse(f2.text);
    check('两帧的 id 分别是 a / b', m1.id === 'a' && m2.id === 'b', `${m1.id}/${m2.id}`);
  }
});

/* ---------- 5. http 动作（打本地临时服务，确定性高） ---------- */

// 起一个只有几种路由的本地服务
const server = createServer((req, res) => {
  if (req.url === '/redirect') {
    res.writeHead(302, { Location: '/final' });
    res.end();
    return;
  }
  if (req.url === '/final') {
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('重定向之后的内容');
    return;
  }
  if (req.url === '/bin') {
    res.writeHead(200, { 'Content-Type': 'application/octet-stream' });
    res.end(Buffer.from([0, 1, 2, 250, 251, 252]));
    return;
  }
  if (req.url === '/echo') {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ method: req.method, body, probe: req.headers['x-probe'] ?? null }));
    });
    return;
  }
  if (req.url === '/slow') {
    return; // 故意不响应，用来测超时
  }
  res.writeHead(404);
  res.end();
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;

await withBridge(async ({ send, nextFrame }) => {
  send({ id: 'r1', action: 'http', req: { method: 'GET', url: `${base}/redirect`, timeoutMs: 5000 } });
  const f = await nextFrame();
  check('重定向请求有响应', f !== null);
  if (f) {
    const m = JSON.parse(f.text);
    check('重定向后拿到 200', m.ok === true && m.res?.status === 200, JSON.stringify(m).slice(0, 200));
    check('finalUrl 指向重定向后的地址', m.res?.finalUrl === `${base}/final`, String(m.res?.finalUrl));
    check('拿到的是重定向后的内容', m.res?.body === '重定向之后的内容', String(m.res?.body));
  }

  send({ id: 'r2', action: 'http', req: { method: 'GET', url: `${base}/bin`, timeoutMs: 5000 } });
  const f2 = await nextFrame();
  check('二进制请求有响应', f2 !== null);
  if (f2) {
    const m = JSON.parse(f2.text);
    check('二进制响应 body 为 null', m.res?.body === null, String(m.res?.body));
    check('二进制响应走 bodyBase64', m.res?.bodyBase64 === 'AAEC+vv8', String(m.res?.bodyBase64));
  }

  send({
    id: 'r3',
    action: 'http',
    req: { method: 'POST', url: `${base}/echo`, headers: { 'X-Probe': 'hello' }, body: '{"a":1}', timeoutMs: 5000 },
  });
  const f3 = await nextFrame();
  check('POST 请求有响应', f3 !== null);
  if (f3) {
    const m = JSON.parse(f3.text);
    const echoed = JSON.parse(m.res?.body ?? '{}');
    check('POST 方法传到了服务端', echoed.method === 'POST', String(echoed.method));
    check('POST 请求体传到了服务端', echoed.body === '{"a":1}', String(echoed.body));
    check('自定义请求头传到了服务端', echoed.probe === 'hello', String(echoed.probe));
  }

  send({ id: 'r4', action: 'http', req: { method: 'GET', url: `${base}/slow`, timeoutMs: 1200 } });
  const f4 = await nextFrame();
  check('超时请求有响应', f4 !== null);
  if (f4) {
    const m = JSON.parse(f4.text);
    check('超时错误码是 TIMEOUT', m.ok === false && m.error?.code === 'TIMEOUT', JSON.stringify(m).slice(0, 200));
  }

  send({ id: 'r5', action: 'http', req: { method: 'GET', url: 'http://127.0.0.1:1/', timeoutMs: 3000 } });
  const f5 = await nextFrame();
  check('连接被拒有响应', f5 !== null);
  if (f5) {
    const m = JSON.parse(f5.text);
    check('连接被拒错误码是 CONNECTION_REFUSED', m.ok === false && m.error?.code === 'CONNECTION_REFUSED', JSON.stringify(m).slice(0, 200));
  }

  send({ id: 'r6', action: 'http', req: { method: 'GET', url: 'ftp://example.com/', timeoutMs: 3000 } });
  const f6 = await nextFrame();
  check('不支持的协议有响应', f6 !== null);
  if (f6) {
    const m = JSON.parse(f6.text);
    check('不支持的协议错误码是 UNSUPPORTED_PROTOCOL', m.ok === false && m.error?.code === 'UNSUPPORTED_PROTOCOL', JSON.stringify(m).slice(0, 200));
  }
});
server.close();

console.log(`=== 结果：${passed} 通过 / ${failed} 失败 ===`);
process.exit(failed === 0 ? 0 : 1);
