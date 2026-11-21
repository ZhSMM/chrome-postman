#!/usr/bin/env node
/**
 * Chrome Postman —— Native Messaging 伴生程序（native messaging host）
 *
 * 【在架构中的位置】
 *   扩展（浏览器沙箱内）--chrome.runtime.sendNativeMessage()--> 本文件（沙箱外的 Node 进程）
 *   本文件 --https.request()--> 目标服务器
 *
 * 【初学者先看这里】
 *   1. 为什么需要它？
 *      浏览器出于安全设计，**不允许扩展关闭 TLS 证书校验**（扩展的 fetch 没有
 *      rejectUnauthorized 这个选项）。而 Node 的 https 模块有这个选项，
 *      所以「跳过证书校验」这个需求只能由沙箱外的伴生程序来满足。
 *      —— 这就是整个方案存在的唯一理由。
 *   2. 它的第二个职责：证书体检。
 *      扩展读不到对端证书（fetch 的 TLS 信息里没有证书链），
 *      但 Node 的 TLS socket 提供了 socket.getPeerCertificate()，
 *      能拿到完整证书链、有效期、SAN、指纹、自签判定。
 *   3. 通信协议：Chrome native messaging 标准帧 = 4 字节小端长度 + UTF-8 JSON。
 *      stdin 逐帧读、stdout 逐帧写。
 *
 * 【关键实现细节（踩坑点）】
 *   - stdout 只能输出协议帧。任何调试/日志输出必须走 stderr，
 *     否则 Chrome 会直接报 "Error when communicating with the native messaging host"。
 *   - 二进制读写：帧里有 4 字节长度前缀，**不能用 readline**（它是按行解码文本的，
 *     遇到 JSON 里的 \n 就会错位）；Node 的 stdin 流在 Windows 上同样是按二进制读入的，
 *     不存在 C 语言那种 \n → \r\n 的文本模式转换。
 *   - 不用 fs.readSync(0) 阻塞读：同步读会把事件循环卡死，
 *     正在等待的 HTTP 响应永远拿不到回调 → 死锁。
 *     所以用 'data' 事件 + Buffer 累积来切帧。
 *   - 单条消息上限 1MB（Chrome 的硬限制），超了要报错，而不是崩溃。
 *   - SPKI 指纹：Chrome 的 --ignore-certificate-errors-spki-list 要的是
 *     「证书公钥 SPKI 的 SHA-256」，**不是**「整张证书的 SHA-256」。两者不同，别搞混。
 *
 * 用法：node native-host/bridge.mjs
 */
import { createHash, createPublicKey, X509Certificate } from 'node:crypto';
import http from 'node:http';
import https from 'node:https';
import { isIP } from 'node:net';
import tls from 'node:tls';

/* ------------------------------------------------------------------
 * 1. 常量
 * ---------------------------------------------------------------- */

/** host 名字，必须和 host manifest 里的 "name" 完全一致 */
const HOST_NAME = 'com.chrome_postman.bridge';

/** 协议版本，扩展用 ping 动作探测伴生程序是否就绪 */
const PROTOCOL_VERSION = '1.0.0';

/** Chrome 对单条 native messaging 消息（不含 4 字节长度前缀）的上限：1MB */
const MAX_MESSAGE_BYTES = 1024 * 1024;

/** 跟随重定向的最大跳数，防止 A→B→A 这种死循环 */
const MAX_REDIRECTS = 10;

/** 默认超时（毫秒） */
const DEFAULT_TIMEOUT_MS = 30000;

/* ------------------------------------------------------------------
 * 2. 日志
 *
 * 【为什么单独强调】
 *   stdout 是协议通道，上面只能有协议帧。任何 console.log 都会让 Chrome
 *   把整个消息解析失败，然后报 "Error when communicating with the native messaging host"。
 *   所以本文件里所有日志一律走 stderr。
 * ---------------------------------------------------------------- */
function log(...parts) {
  process.stderr.write(`[bridge] ${parts.join(' ')}\n`);
}

/* ------------------------------------------------------------------
 * 3. 帧的写出
 * ---------------------------------------------------------------- */

/**
 * 串行化的写队列。
 * 【为什么需要】
 *   process.stdout.write 在部分平台（macOS 的管道）是异步的，
 *   如果同时写多帧，必须保证写入顺序，否则帧会交叉、协议就废了。
 *   用一条 Promise 链把每次写入串起来即可。
 */
let writeQueue = Promise.resolve();

/** 把一个 JS 对象编码成 native messaging 帧并写到 stdout */
function writeFrame(payload) {
  const json = typeof payload === 'string' ? payload : JSON.stringify(payload);
  const body = Buffer.from(json, 'utf8');
  const frame = Buffer.allocUnsafe(4 + body.length);
  frame.writeUInt32LE(body.length, 0); // 4 字节小端长度前缀
  body.copy(frame, 4);

  writeQueue = writeQueue
    .then(() => new Promise((resolve, reject) => {
      process.stdout.write(frame, (err) => (err ? reject(err) : resolve()));
    }))
    .catch((err) => {
      log('stdout 写入失败：', err?.message ?? String(err));
    });
  return writeQueue;
}

/**
 * 发送一条响应。
 * 【为什么要先量大小】
 *   Chrome 对「伴生程序 → 浏览器」方向的单条消息也限制 1MB。
 *   超了 Chrome 会把连接掐掉，扩展那边看到的是莫名其妙的通信错误。
 *   所以这里主动拦截，换成一条明确的错误帧。
 */
async function sendResponse(payload) {
  const json = JSON.stringify(payload);
  const size = Buffer.byteLength(json, 'utf8');
  if (size > MAX_MESSAGE_BYTES) {
    log(`响应体 ${size} 字节，超过 Chrome 的 1MB 上限，改发错误帧`);
    return writeFrame({
      id: payload?.id ?? null,
      ok: false,
      error: {
        code: 'RESPONSE_TOO_LARGE',
        message: `响应体 ${size} 字节，超过 Chrome native messaging 的 1MB 上限`,
      },
    });
  }
  return writeFrame(json);
}

/* ------------------------------------------------------------------
 * 4. 帧的读入
 *
 * 【为什么用 'data' 事件而不是 fs.readSync(0)】
 *   fs.readSync 是同步调用，会阻塞整个事件循环。
 *   本程序是「一边收帧、一边发 HTTP 请求」的模型：如果卡在同步读上等新帧，
 *   那些已经发出的 HTTP 请求的回调就永远排不上队 → 死锁。
 *   'data' 事件是异步的，而且回调里拿到的就是原始 Buffer（没有 setEncoding，
 *   就没有任何文本解码，不存在 Windows 的 \r\n 转换问题）。
 * ---------------------------------------------------------------- */

const reader = {
  /** 还没切出完整帧的残余字节 */
  buffer: Buffer.alloc(0),
  /** 需要丢弃的字节数（收到超长帧时用来跳过它的载荷） */
  skip: 0,
};

/** stdin 收到一块数据 → 累积 → 尝试切帧 */
function onStdinChunk(chunk) {
  reader.buffer = reader.buffer.length
    ? Buffer.concat([reader.buffer, chunk])
    : chunk;
  drainFrames();
}

/** 从残余字节里切出一个个完整帧 */
function drainFrames() {
  for (;;) {
    // 上一帧超长，正在丢弃它的载荷
    if (reader.skip > 0) {
      const drop = Math.min(reader.skip, reader.buffer.length);
      reader.buffer = reader.buffer.subarray(drop);
      reader.skip -= drop;
      if (reader.skip > 0) return;
      continue;
    }

    // 长度前缀还没收全
    if (reader.buffer.length < 4) return;

    const size = reader.buffer.readUInt32LE(0);

    // 超长帧：Chrome 自己不会发这种帧，属于防御性分支。
    // 我们仍然能把它的载荷跳过（长度已知），然后回一条错误帧。
    if (size > MAX_MESSAGE_BYTES) {
      log(`收到超长帧：${size} 字节（上限 ${MAX_MESSAGE_BYTES}），丢弃载荷`);
      reader.buffer = reader.buffer.subarray(4);
      reader.skip = size;
      void sendResponse({
        id: null,
        ok: false,
        error: { code: 'MESSAGE_TOO_LARGE', message: `消息体 ${size} 字节，超过 1MB 上限` },
      });
      continue;
    }

    // 载荷还没收全，等下一块
    if (reader.buffer.length < 4 + size) return;

    const body = reader.buffer.subarray(4, 4 + size);
    reader.buffer = reader.buffer.subarray(4 + size);
    void handleFrame(body.toString('utf8'));
  }
}

/** 处理一帧（一个 JSON 文本） */
async function handleFrame(text) {
  let msg;
  try {
    msg = JSON.parse(text);
  } catch (err) {
    log('JSON 解析失败：', err?.message ?? String(err));
    await sendResponse({
      id: null,
      ok: false,
      error: { code: 'INVALID_JSON', message: err?.message ?? 'invalid json' },
    });
    return;
  }

  const id = msg?.id ?? null;
  try {
    const result = await dispatch(msg);
    await sendResponse({ id, ...result });
  } catch (err) {
    log('处理消息失败：', err?.stack ?? err?.message ?? String(err));
    await sendResponse({ id, ok: false, error: toErrorPayload(err) });
  }
}

/**
 * 按 action 分发。
 * 【返回值的约定】
 *   只返回「除 id 以外」的部分，id 由 handleFrame 统一回填，保证请求/响应能对上。
 */
function dispatch(msg) {
  switch (msg?.action) {
    case 'ping':
      return handlePing();
    case 'http':
      return handleHttp(msg?.req ?? {});
    case 'inspect-cert':
      return handleInspectCert(msg?.req ?? {});
    default:
      return {
        ok: false,
        error: { code: 'UNKNOWN_ACTION', message: `unknown action: ${String(msg?.action)}` },
      };
  }
}

/* ------------------------------------------------------------------
 * 5. action: ping —— 握手 / 探活
 * ---------------------------------------------------------------- */

/**
 * 扩展在开启「跳过证书校验」开关前会先发一条 ping，
 * 用来确认伴生程序是否已经装好、版本是多少。
 */
function handlePing() {
  log('收到 ping');
  return { ok: true, version: PROTOCOL_VERSION };
}

/* ------------------------------------------------------------------
 * 6. action: http —— 发 HTTP 请求
 * ---------------------------------------------------------------- */

/** 把扩展传来的 headers（对象或键值对数组）统一成小写键的普通对象 */
function normalizeHeaders(input) {
  const out = {};
  if (!input) return out;
  if (Array.isArray(input)) {
    for (const pair of input) {
      if (!pair) continue;
      const [k, v] = pair;
      if (!k) continue;
      out[String(k).toLowerCase()] = String(v);
    }
  } else if (typeof input === 'object') {
    for (const [k, v] of Object.entries(input)) {
      if (v === null || v === undefined) continue;
      out[String(k).toLowerCase()] = Array.isArray(v) ? v.map(String).join(', ') : String(v);
    }
  }
  return out;
}

/**
 * 组装请求体。
 * 【优先级】bodyBase64 > body
 *   bodyBase64 用来传二进制（图片、protobuf 等），body 传文本。
 */
function buildRequestBody(req) {
  if (typeof req.bodyBase64 === 'string' && req.bodyBase64.length > 0) {
    return Buffer.from(req.bodyBase64, 'base64');
  }
  if (typeof req.body === 'string' && req.body.length > 0) {
    return Buffer.from(req.body, 'utf8');
  }
  if (req.body && typeof req.body === 'object') {
    return Buffer.from(JSON.stringify(req.body), 'utf8');
  }
  return null;
}

/** 判断某个状态码是不是重定向 */
function isRedirectStatus(status) {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308;
}

/**
 * 发一次请求（不跟随重定向）。
 * 【关键】rejectUnauthorized 直接来自请求里的同名字段 —— 这就是整个方案的核心。
 *   浏览器没有这个开关，Node 有；伴生程序在沙箱外，所以能用。
 */
function performRequestOnce({ method, url, headers, body, timeoutMs, rejectUnauthorized, servername }) {
  return new Promise((resolve, reject) => {
    let parsed;
    try {
      parsed = new URL(url);
    } catch {
      const err = new Error(`非法 URL：${url}`);
      err.code = 'INVALID_URL';
      reject(err);
      return;
    }

    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      const err = new Error(`不支持的协议：${parsed.protocol}`);
      err.code = 'UNSUPPORTED_PROTOCOL';
      reject(err);
      return;
    }

    const isHttps = parsed.protocol === 'https:';
    const agent = isHttps ? https : http;

    const options = {
      protocol: parsed.protocol,
      // 【踩坑点：必须传 host，不能只传 hostname】
      //   Node 的 TLS 层（tls.connect / checkServerIdentity）是从 options.host 取主机名的，
      //   只传 hostname 的话 SNI 不会发出去，证书也只会拿 'localhost' 去比对，
      //   结果就是握手卡死或证书校验用错名字。host 是 http/https 官方推荐的规范字段。
      host: parsed.hostname,
      hostname: parsed.hostname,
      port: parsed.port || (isHttps ? 443 : 80),
      path: `${parsed.pathname}${parsed.search}`,
      method,
      headers: { ...headers },
    };

    // URL 里带了账号密码时（https://user:pass@host/），Node 不会自动带上，这里补上
    if (parsed.username || parsed.password) {
      options.auth = `${decodeURIComponent(parsed.username)}:${decodeURIComponent(parsed.password)}`;
    }

    if (isHttps) {
      // undefined / true 都表示「严格校验」，只有显式的 false 才关闭校验
      options.rejectUnauthorized = rejectUnauthorized !== false;
      // SNI 覆盖：IP 直连、或服务端证书名与实际域名不一致时可能需要
      // 【注意】SNI 不能是 IP 地址，填了会导致握手直接失败，所以这里挡一下
      if (servername && !isIP(servername)) options.servername = servername;
    }

    // 明确给 Content-Length，避免 Node 退化成 chunked 编码
    if (body && options.headers['content-length'] === undefined) {
      options.headers['content-length'] = String(body.length);
    }

    const req = agent.request(options);

    let timedOut = false;
    req.setTimeout(timeoutMs, () => {
      timedOut = true;
      const err = new Error(`请求超时（${timeoutMs}ms）`);
      err.code = 'ETIMEDOUT';
      req.destroy(err);
    });

    req.on('error', (err) => {
      if (timedOut) {
        err.code = 'ETIMEDOUT';
      }
      reject(err);
    });

    req.on('response', (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('error', reject);
      res.on('end', () => {
        resolve({
          status: res.statusCode ?? 0,
          statusText: res.statusMessage ?? '',
          headers: res.headers,
          raw: Buffer.concat(chunks),
        });
      });
    });

    if (body) req.write(body);
    req.end();
  });
}

/** 判断 content-type 是不是「文本类」，决定 body 走字符串还是走 base64 */
function isTextualContentType(contentType) {
  if (!contentType) return false;
  const type = String(contentType).split(';')[0].trim().toLowerCase();
  if (type.startsWith('text/')) return true;
  if (type.endsWith('+json') || type.endsWith('+xml')) return true;
  return [
    'application/json',
    'application/xml',
    'application/javascript',
    'application/x-javascript',
    'application/ecmascript',
    'application/x-www-form-urlencoded',
    'application/graphql',
    'image/svg+xml',
  ].includes(type);
}

/** 从 content-type 里取 charset（默认 utf-8） */
function charsetOf(contentType) {
  const m = /charset=([^;]+)/i.exec(String(contentType ?? ''));
  if (!m) return 'utf8';
  const label = m[1].trim().toLowerCase().replace(/^["']|["']$/g, '');
  // Node 的 Buffer 只内置了这么几种编码，其余一律按 utf-8 处理
  const supported = ['utf8', 'utf-8', 'latin1', 'iso-8859-1', 'ascii', 'us-ascii', 'utf16le', 'utf-16le'];
  return supported.includes(label) ? label : 'utf8';
}

/**
 * Node 错误码 → 对外稳定的错误码。
 * 【为什么要翻译】
 *   扩展要按错误类型给出不同提示（比如「证书过期」要给安装 CA 的引导，
 *   「连接被拒绝」要给检查服务的引导），所以不能把 errno 原文直接丢给前端。
 */
const ERROR_CODE_MAP = {
  // —— TLS / 证书 ——
  CERT_HAS_EXPIRED: 'CERT_HAS_EXPIRED',
  CERT_NOT_YET_VALID: 'CERT_NOT_YET_VALID',
  CERT_SIGNATURE_FAILURE: 'CERT_SIGNATURE_FAILURE',
  DEPTH_ZERO_SELF_SIGNED_CERT: 'SELF_SIGNED_CERT',
  SELF_SIGNED_CERT_IN_CHAIN: 'SELF_SIGNED_CERT_IN_CHAIN',
  UNABLE_TO_VERIFY_LEAF_SIGNATURE: 'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  UNABLE_TO_GET_ISSUER_CERT: 'UNABLE_TO_GET_ISSUER_CERT',
  UNABLE_TO_GET_ISSUER_CERT_LOCALLY: 'UNABLE_TO_GET_ISSUER_CERT',
  ERR_TLS_CERT_ALTNAME_INVALID: 'CERT_HOSTNAME_MISMATCH',
  ERR_SSL_WRONG_VERSION_NUMBER: 'TLS_HANDSHAKE_FAILED',
  EPROTO: 'TLS_HANDSHAKE_FAILED',
  // —— 连接 ——
  ECONNREFUSED: 'CONNECTION_REFUSED',
  ENOTFOUND: 'DNS_NOT_FOUND',
  EAI_AGAIN: 'DNS_TEMPORARY_FAILURE',
  ETIMEDOUT: 'TIMEOUT',
  ESOCKETTIMEDOUT: 'TIMEOUT',
  ECONNRESET: 'CONNECTION_RESET',
  EHOSTUNREACH: 'HOST_UNREACHABLE',
  ENETUNREACH: 'NETWORK_UNREACHABLE',
  EHOSTDOWN: 'HOST_UNREACHABLE',
  ENETDOWN: 'NETWORK_UNREACHABLE',
  EPIPE: 'CONNECTION_RESET',
  // —— 其它 ——
  INVALID_URL: 'INVALID_URL',
  UNSUPPORTED_PROTOCOL: 'UNSUPPORTED_PROTOCOL',
  TOO_MANY_REDIRECTS: 'TOO_MANY_REDIRECTS',
  NO_CERTIFICATE: 'NO_CERTIFICATE',
};

/**
 * 把任意异常整理成协议里的 error 结构。
 * 【为什么要分两层】
 *   1. 先在错误码表里查（TLS / 网络类），查不到再退化成 INTERNAL_ERROR；
 *   2. 自造的错误码（TOO_MANY_REDIRECTS 之类）本身就是稳定码，直接用。
 */
function toErrorPayload(err) {
  const raw = err?.code ?? '';
  const message = err?.message ?? String(err);
  let code;
  if (Object.prototype.hasOwnProperty.call(ERROR_CODE_MAP, raw)) {
    code = ERROR_CODE_MAP[raw];
  } else if (/^[A-Z][A-Z0-9_]*$/.test(raw)) {
    code = raw;
  } else {
    code = 'INTERNAL_ERROR';
  }
  const payload = { code, message };
  // 证书信息一并回传，方便扩展显示「证书体检」并给出对应的修复引导
  if (err?.cert) {
    try {
      // diagnoseTlsProblem 传上来的是已经整理好的结构，直接用；
      // Node 原生 TLS 错误带的是原始证书对象，需要整理一次。
      payload.cert = err.cert.spkiSha256Base64 !== undefined
        ? err.cert
        : formatCert(err.cert);
    } catch {
      /* 证书信息整理失败就算了，不影响主错误 */
    }
  }
  return payload;
}

/**
 * HTTPS 请求失败后的「病因定位」。
 *
 * 【为什么需要】
 *   Node 在证书有问题时不一定给出准确的错误码
 *   （实测：自签证书会被报成 ECONNRESET，扩展无法区分「证书自签」和「服务端挂了」）。
 *   但扩展必须能区分「证书过期 / 自签 / 域名不匹配 / 不受信」，
 *   因为每一种都要给用户不同的引导（装 CA / 开跳过校验 / 改域名 / 换信任库）。
 *   所以这里用 rejectUnauthorized:false 再连一次，把证书拿到手，自己判断病因。
 *
 * @returns {{ code: string, message: string, cert: object } | null} 判断不出来时返回 null
 */
async function diagnoseTlsProblem(url, timeoutMs, servername) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'https:') return null;

  let socket;
  try {
    socket = await connectForCert(url, timeoutMs, servername);
  } catch {
    return null; // 连都连不上，就不是证书的问题
  }

  try {
    const peer = socket.getPeerCertificate(true);
    if (!peer?.raw) return null;
    const cert = formatCert(peer);
    const x509 = new X509Certificate(peer.raw);
    const now = Date.now();

    const validFrom = new Date(x509.validFrom).getTime();
    const validTo = new Date(x509.validTo).getTime();
    if (Number.isFinite(validFrom) && validFrom > now) {
      return { code: 'CERT_NOT_YET_VALID', message: `证书尚未生效（生效时间 ${x509.validFrom}）`, cert };
    }
    if (Number.isFinite(validTo) && validTo < now) {
      return { code: 'CERT_HAS_EXPIRED', message: `证书已过期（过期时间 ${x509.validTo}）`, cert };
    }

    // checkHost 通过 = 证书的 SAN 里包含这个域名；不通过会抛错
    try {
      x509.checkHost(parsed.hostname);
    } catch {
      return {
        code: 'CERT_HOSTNAME_MISMATCH',
        message: `证书的域名不包含 ${parsed.hostname}`,
        cert,
      };
    }

    // checkIssued(x509) = 这张证书是不是自己签发的
    let selfIssued = false;
    try {
      selfIssued = x509.checkIssued(x509);
    } catch {
      /* 判断不了就退回到 DN 比较的结果 */
    }
    if (selfIssued || cert.selfSigned) {
      return {
        code: 'SELF_SIGNED_CERT',
        message: '证书是自签名的（签发者与使用者相同）',
        cert,
      };
    }

    return {
      code: 'CERT_UNTRUSTED',
      message: '证书的签发者不在本机信任库里',
      cert,
    };
  } catch (err) {
    log('证书病因定位失败：', err?.message ?? String(err));
    return null;
  } finally {
    socket.destroy();
  }
}

/** action: http 的主流程（含重定向） */
async function handleHttp(req) {
  const startedAt = Date.now();

  let method = String(req.method ?? 'GET').toUpperCase();
  let url = String(req.url ?? '');
  let headers = normalizeHeaders(req.headers);
  let body = buildRequestBody(req);
  const timeoutMs = Number.isFinite(req.timeoutMs) && req.timeoutMs > 0
    ? req.timeoutMs
    : DEFAULT_TIMEOUT_MS;
  const rejectUnauthorized = req.rejectUnauthorized !== false;
  let servername = req.servername ? String(req.servername) : null;

  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    let res;
    try {
      res = await performRequestOnce({
        method,
        url,
        headers,
        body,
        timeoutMs,
        rejectUnauthorized,
        servername,
      });
    } catch (err) {
      // 请求失败了：如果这是 HTTPS，先查一下证书到底怎么了，
      // 这样扩展能拿到「证书过期 / 自签 / 域名不匹配」这种精确原因，
      // 而不是笼统的 ECONNRESET。
      if (!rejectUnauthorized) {
        // 用户本来就要求跳过校验，失败原因多半不是证书，原样抛出即可
        throw err;
      }
      if (err?.code === 'ETIMEDOUT') {
        // 超时就是超时，再连一次只会让用户多等一轮，直接抛
        throw err;
      }
      const diag = await diagnoseTlsProblem(url, Math.min(timeoutMs, 8000), servername);
      if (diag) {
        throw Object.assign(new Error(diag.message), { code: diag.code, cert: diag.cert });
      }
      throw err;
    }

    const location = res.headers?.location;
    if (isRedirectStatus(res.status) && location) {
      if (hop >= MAX_REDIRECTS) {
        throw Object.assign(new Error(`重定向次数超过 ${MAX_REDIRECTS} 跳`), { code: 'TOO_MANY_REDIRECTS' });
      }
      let nextUrl;
      try {
        // 用当前 URL 作为 base 解析相对地址（Location 可能是相对路径）
        nextUrl = new URL(location, url).toString();
      } catch {
        throw Object.assign(new Error(`非法的重定向地址：${location}`), { code: 'INVALID_URL' });
      }

      // 浏览器惯例：303 一律降级成 GET；301/302 只有原本是 POST 时才降级
      // 307/308 保持方法和请求体不变
      if (res.status === 303 || ((res.status === 301 || res.status === 302) && method === 'POST')) {
        method = 'GET';
        body = null;
        delete headers['content-type'];
        delete headers['content-length'];
      }

      // 换主机后，Host 头要由 Node 重新计算；SNI 覆盖也不再适用
      const oldHost = new URL(url).hostname;
      const newHost = new URL(nextUrl).hostname;
      if (oldHost !== newHost) {
        delete headers.host;
        servername = null;
      }

      log(`跟随重定向 ${hop + 1}/${MAX_REDIRECTS}：${res.status} → ${nextUrl}`);
      url = nextUrl;
      continue;
    }

    // —— 正常返回 ——
    const contentType = res.headers?.['content-type'] ?? '';
    const textual = isTextualContentType(contentType);
    const bodyText = textual ? res.raw.toString(charsetOf(contentType)) : null;
    const bodyBase64 = textual ? null : res.raw.toString('base64');

    return {
      ok: true,
      res: {
        status: res.status,
        statusText: res.statusText,
        headers: res.headers ?? {},
        body: bodyText,
        bodyBase64,
        elapsedMs: Date.now() - startedAt,
        finalUrl: url,
      },
    };
  }

  /* c8 ignore next */
  throw Object.assign(new Error('重定向处理异常结束'), { code: 'TOO_MANY_REDIRECTS' });
}

/* ------------------------------------------------------------------
 * 7. action: inspect-cert —— 证书体检
 *
 * 【为什么扩展自己做不到】
 *   扩展的 fetch 拿不到对端证书（这是 Web 平台刻意不给的能力）。
 *   Node 的 TLS socket 才有 getPeerCertificate()。
 * ---------------------------------------------------------------- */

/**
 * 建立一条 TLS 连接，拿到对端证书链。
 * 【关键】rejectUnauthorized: false
 *   体检的目的就是「哪怕证书有问题也要把证书读出来」，
 *   如果这里还严格校验，证书过期/自签的站点根本连不上，也就体检不了。
 */
function connectForCert(url, timeoutMs, servername) {
  return new Promise((resolve, reject) => {
    let parsed;
    try {
      parsed = new URL(url);
    } catch {
      reject(Object.assign(new Error(`非法 URL：${url}`), { code: 'INVALID_URL' }));
      return;
    }
    if (parsed.protocol !== 'https:') {
      reject(Object.assign(
        new Error('证书体检只支持 https:// 地址'),
        { code: 'UNSUPPORTED_PROTOCOL' },
      ));
      return;
    }

    const options = {
      host: parsed.hostname,
      port: Number(parsed.port || 443),
      rejectUnauthorized: false,
      timeout: timeoutMs,
    };
    // SNI 不能是 IP；不是 IP 时用 URL 里的主机名做 SNI
    const sni = servername && !isIP(servername)
      ? servername
      : (isIP(parsed.hostname) ? undefined : parsed.hostname);
    if (sni) options.servername = sni;

    const socket = tls.connect(options);
    const onError = (err) => {
      socket.destroy();
      reject(err);
    };
    socket.once('error', onError);
    socket.once('secureConnect', () => {
      socket.removeListener('error', onError);
      // 连接建立之后的错误不再影响读证书，只记日志
      socket.on('error', (err) => log('TLS socket 错误：', err?.message ?? String(err)));
      resolve(socket);
    });
  });
}

/** 把 Node 的 subject/issuer 对象整理成 { commonName, organization } */
function formatDn(dn) {
  if (!dn) return { commonName: null, organization: null };
  const pick = (v) => (Array.isArray(v) ? (v[0] ?? null) : (v ?? null));
  return {
    commonName: pick(dn.CN),
    organization: pick(dn.O),
  };
}

/** 把 subject/issuer 拼成可比较的完整 DN 字符串 */
function dnString(dn) {
  if (!dn) return '';
  return Object.keys(dn)
    .sort()
    .map((k) => `${k}=${[].concat(dn[k]).join('+')}`)
    .join(',');
}

/**
 * 证书指纹：整张证书 DER 的 SHA-256，格式化成 AB:CD:EF:... 大写冒号分隔。
 * 【注意】这不是 SPKI 指纹，两者用途不同，别混用。
 */
function formatFingerprint(der) {
  return createHash('sha256')
    .update(der)
    .digest('hex')
    .toUpperCase()
    .match(/.{2}/g)
    .join(':');
}

/**
 * SPKI 指纹（base64）—— 这才是 Chrome --ignore-certificate-errors-spki-list 要的值。
 *
 * 【算法，别搞混】
 *   1. 从证书 DER 里取出公钥，得到 SPKI（SubjectPublicKeyInfo）的 DER 字节
 *   2. 对这段 SPKI DER 求 SHA-256，再 base64
 *   注意：不是对「整张证书 DER」求哈希 —— 那是上面的 sha256 字段。两者不同。
 *
 * 【踩坑点：公钥从哪来】
 *   Node 的 tls socket.getPeerCertificate() 里 **没有** publicKey 字段，
 *   它只给：pubkey（EC 的未压缩点 / RSA 没有）、modulus + exponent（RSA，且是十六进制字符串）。
 *   所以不能想当然地写 createPublicKey(cert.publicKey)。
 *   正确姿势是用 node:crypto 的 X509Certificate：
 *     new X509Certificate(cert.raw).publicKey  →  真正的 KeyObject
 *   再 export({ type: 'spki', format: 'der' }) 就是证书里嵌着的那段 SPKI 字节
 *   （已实测：导出的字节能在证书 DER 里原样找到，与 Chrome 的算法一致）。
 */
function computeSpkiSha256Base64(cert) {
  const raw = cert?.raw;
  if (!raw) return null;

  // —— 主路线：直接从证书 DER 里解析出公钥 ——
  try {
    const x509 = new X509Certificate(raw);
    const spkiDer = x509.publicKey.export({ type: 'spki', format: 'der' });
    return createHash('sha256').update(spkiDer).digest('base64');
  } catch (err) {
    log('X509Certificate 解析失败，改用备用路线：', err?.message ?? String(err));
  }

  // —— 备用路线：自己用 modulus/exponent（RSA）或原始点（EC）拼 JWK ——
  try {
    const jwk = buildJwkFromPeerCert(cert);
    if (!jwk) return null;
    const spkiDer = createPublicKey({ key: jwk, format: 'jwk' }).export({ type: 'spki', format: 'der' });
    return createHash('sha256').update(spkiDer).digest('base64');
  } catch (err) {
    log('SPKI 备用路线也失败：', err?.message ?? String(err));
    return null;
  }
}

/**
 * 备用路线：用 getPeerCertificate() 给的碎片自己拼一个 JWK。
 * 【细节】
 *   - RSA：cert.modulus / cert.exponent 是**十六进制字符串**（不是 Buffer），
 *           要先 Buffer.from(hex, 'hex') 再转 base64url
 *   - EC ：cert.pubkey 是未压缩点 0x04 || X || Y，X 和 Y 各占一半
 */
function buildJwkFromPeerCert(cert) {
  const b64url = (buf) => Buffer.from(buf).toString('base64url');
  if (cert.modulus && cert.exponent) {
    return {
      kty: 'RSA',
      n: b64url(Buffer.from(cert.modulus, 'hex')),
      e: b64url(Buffer.from(cert.exponent, 'hex')),
    };
  }
  const crvMap = { prime256v1: 'P-256', secp384r1: 'P-384', secp521r1: 'P-521' };
  const crv = cert.nistCurve ?? crvMap[cert.asn1Curve];
  if (crv && Buffer.isBuffer(cert.pubkey) && cert.pubkey[0] === 0x04) {
    const raw = cert.pubkey;
    const half = (raw.length - 1) / 2;
    return {
      kty: 'EC',
      crv,
      x: b64url(raw.subarray(1, 1 + half)),
      y: b64url(raw.subarray(1 + half)),
    };
  }
  return null;
}

/** 把 Node 的 'Jan 1 00:00:00 2026 GMT' 转成 ISO 8601 */
function toIso(value) {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/**
 * 解析 SAN 列表。
 * Node 给的是 'DNS:example.com, DNS:*.example.com, IP Address:1.2.3.4'，
 * 这里把类型前缀去掉，只留域名/IP 本身。
 */
function parseSan(subjectAltName) {
  if (!subjectAltName) return [];
  return String(subjectAltName)
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((entry) => {
      const idx = entry.indexOf(':');
      return idx === -1 ? entry : entry.slice(idx + 1).trim();
    })
    .filter(Boolean);
}

/**
 * 自签判定。
 * 【为什么用完整 DN 比较】
 *   只比 CN 的话，「同名但不同组织」的两个证书会被误判。
 *   完整 DN（subject 与 issuer 全部字段一致）才是严谨的判定。
 *   规格里的简化规则（CN 相等即视为自签）在这里被完整 DN 覆盖，
 *   CN 相等但 DN 不同的情况按「非自签」处理，更安全。
 */
function isSelfSigned(cert) {
  const subject = dnString(cert?.subject);
  const issuer = dnString(cert?.issuer);
  if (!subject) return false;
  return subject === issuer;
}

/** 顺着 issuerCertificate 把整条证书链走一遍 */
function buildChain(leaf) {
  const chain = [];
  let current = leaf;
  const seen = new Set();
  while (current && !seen.has(current)) {
    seen.add(current);
    chain.push({
      subject: formatDn(current.subject),
      issuer: formatDn(current.issuer),
      validFrom: toIso(current.valid_from),
      validTo: toIso(current.valid_to),
      sha256: current.raw ? formatFingerprint(Buffer.from(current.raw)) : null,
    });
    const next = current.issuerCertificate;
    // 根证书的 issuerCertificate 指向自己，这里停住
    if (!next || next === current) break;
    current = next;
  }
  return chain;
}

/** 把一张 Node 证书整理成协议里的 cert 结构 */
function formatCert(cert) {
  if (!cert) return null;
  const raw = cert.raw ? Buffer.from(cert.raw) : null;
  return {
    subject: formatDn(cert.subject),
    issuer: formatDn(cert.issuer),
    validFrom: toIso(cert.valid_from),
    validTo: toIso(cert.valid_to),
    san: parseSan(cert.subjectaltname),
    sha256: raw ? formatFingerprint(raw) : null,
    spkiSha256Base64: computeSpkiSha256Base64(cert),
    selfSigned: isSelfSigned(cert),
    chain: buildChain(cert),
  };
}

/** action: inspect-cert 的主流程 */
async function handleInspectCert(req) {
  const url = String(req.url ?? '');
  const timeoutMs = Number.isFinite(req.timeoutMs) && req.timeoutMs > 0
    ? req.timeoutMs
    : DEFAULT_TIMEOUT_MS;
  const servername = req.servername ? String(req.servername) : null;

  let socket;
  try {
    socket = await connectForCert(url, timeoutMs, servername);
  } catch (err) {
    // 统一翻译成稳定错误码，扩展才能据此给出「证书过期 / 域名不匹配 / 连不上」等不同提示
    throw Object.assign(new Error(err?.message ?? String(err)), { code: err?.code ?? 'INTERNAL_ERROR' });
  }

  try {
    // true = 同时返回完整证书链（叶子 + 中间 CA + 根）
    const peer = socket.getPeerCertificate(true);
    if (!peer || !peer.raw) {
      throw Object.assign(new Error('服务端没有提供证书'), { code: 'NO_CERTIFICATE' });
    }
    log(`已读取 ${url} 的证书：${formatDn(peer.subject).commonName}`);
    return { ok: true, cert: formatCert(peer) };
  } finally {
    socket.destroy();
  }
}

/* ------------------------------------------------------------------
 * 8. 启动
 * ---------------------------------------------------------------- */

log(`${HOST_NAME} v${PROTOCOL_VERSION} 已启动（等待 stdin 帧）`);

// 【踩坑点】不能设置 setEncoding('utf8')，一设置就变成字符串流，帧边界就找不回来了
process.stdin.on('data', onStdinChunk);
process.stdin.on('end', () => {
  log('stdin 已关闭，退出');
  process.exit(0);
});
process.stdin.on('error', (err) => {
  log('stdin 错误：', err?.message ?? String(err));
});
process.stdin.resume();

// 单个请求出错不应该拖垮整个伴生程序（Chrome 会复用这个进程）
process.on('uncaughtException', (err) => {
  log('未捕获异常：', err?.stack ?? err?.message ?? String(err));
});
process.on('unhandledRejection', (err) => {
  log('未处理的 Promise 拒绝：', err?.stack ?? err?.message ?? String(err));
});
process.stdout.on('error', (err) => {
  log('stdout 错误：', err?.message ?? String(err));
});
