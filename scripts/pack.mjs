/**
 * 打包脚本：把 dist/ 压成可安装 / 可上传 Chrome Web Store 的 zip。
 *
 * 【为什么自己实现 zip 编码器】
 * 常见做法是调外部命令（tar -a / zip / PowerShell Compress-Archive），
 * 但这三个在各平台行为并不一致：
 *   - macOS 的 bsdtar 支持 `tar -a -c -f x.zip`（按扩展名自动选 zip）
 *   - Linux 的 GNU tar 虽然也认 `-a`，但它的自动压缩只支持 gzip/bzip2/xz，
 *     **不支持 zip**，会生成一个"名字叫 .zip 的 tar"，装上去直接失败
 *   - Windows 只有 PowerShell 的 Compress-Archive
 * 既然要在 GitHub Actions（ubuntu-latest）里跑，就必须有一个到处都能用的实现。
 * 所以这里用 Node 内置的 zlib 手写最小 ZIP 格式（deflate 压缩），
 * 零依赖、跨平台、行为完全确定。
 *
 * 【ZIP 格式速览】
 * 一个 zip 由三段组成：
 *   1. 每个文件的「本地文件头 + 文件名 + 压缩后的数据」，依次排列
 *   2. 「中央目录」：每个文件一条索引记录，记录它在第 1 段里的偏移
 *   3. 「中央目录结束记录」：告诉解压器中央目录在哪、有多少条目
 *
 * 用法：node scripts/pack.mjs [输出目录]
 */
import { deflateRawSync } from 'node:zlib';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const DIST = resolve(ROOT, 'dist');

/* ------------------------------------------------------------------
 * 1. 校验产物结构
 * ---------------------------------------------------------------- */

if (!existsSync(DIST)) {
  console.error('✗ 没有找到 dist/，请先执行 npm run build');
  process.exit(1);
}

const manifestPath = resolve(DIST, 'manifest.json');
if (!existsSync(manifestPath)) {
  console.error('✗ dist/manifest.json 不存在，打包中止');
  process.exit(1);
}

const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));

/** manifest 里引用到的文件都必须真实存在，否则装上去扩展会报错 */
const required = [
  manifest.background?.service_worker,
  manifest.action?.default_popup,
  ...Object.values(manifest.icons ?? {}),
  ...Object.values(manifest.action?.default_icon ?? {}),
].filter(Boolean);

const missing = required.filter((file) => !existsSync(resolve(DIST, file)));
if (missing.length) {
  console.error('✗ manifest 引用了不存在的文件：', missing.join(', '));
  process.exit(1);
}

if (!existsSync(resolve(DIST, 'dashboard/index.html'))) {
  console.error('✗ dist/dashboard/index.html 不存在，打包中止');
  process.exit(1);
}

/* ------------------------------------------------------------------
 * 2. 收集文件
 * ---------------------------------------------------------------- */

/** 递归列出目录下所有文件，返回相对路径（统一用 / 分隔） */
function collectFiles(dir, base = dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    const stat = statSync(full);
    if (stat.isDirectory()) {
      out.push(...collectFiles(full, base));
    } else {
      out.push(relative(base, full).split(sep).join('/'));
    }
  }
  return out;
}

const filePaths = collectFiles(DIST).sort();

/* ------------------------------------------------------------------
 * 3. 最小 ZIP 编码器
 * ---------------------------------------------------------------- */

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

/** CRC-32（ZIP 格式要求） */
function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i += 1) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

/** JS Date → DOS 时间/日期（ZIP 格式只支持 1980 年以后） */
function dosDateTime(date) {
  const year = Math.max(1980, date.getFullYear());
  return {
    time: ((date.getHours() & 0x1f) << 11) | ((date.getMinutes() & 0x3f) << 5) | ((date.getSeconds() >> 1) & 0x1f),
    date: ((year - 1980) << 9) | (((date.getMonth() + 1) & 0x0f) << 5) | (date.getDate() & 0x1f),
  };
}

/**
 * 把文件列表编码成 zip buffer。
 * @param entries [{ name, data: Buffer }]
 */
function encodeZip(entries) {
  const localChunks = [];
  const centralChunks = [];
  let offset = 0;

  for (const entry of entries) {
    const nameBuf = Buffer.from(entry.name, 'utf8');
    const compressed = deflateRawSync(entry.data, { level: 9 });
    const crc = crc32(entry.data);
    const { time, date } = dosDateTime(entry.date ?? new Date());
    // 通用标志位 bit11 = 文件名是 UTF-8
    const flags = 0x0800;

    // --- 本地文件头（30 字节）---
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); // 本地文件头签名
    local.writeUInt16LE(20, 4); // 解压所需版本 2.0
    local.writeUInt16LE(flags, 6);
    local.writeUInt16LE(8, 8); // 压缩方法 8 = deflate
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(entry.data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28); // extra 长度

    localChunks.push(local, nameBuf, compressed);

    // --- 中央目录记录（46 字节）---
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0); // 中央目录签名
    central.writeUInt16LE(20, 4); // 生成版本
    central.writeUInt16LE(20, 6); // 解压所需版本
    central.writeUInt16LE(flags, 8);
    central.writeUInt16LE(8, 10);
    central.writeUInt16LE(time, 12);
    central.writeUInt16LE(date, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(compressed.length, 20);
    central.writeUInt32LE(entry.data.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt16LE(0, 30); // extra
    central.writeUInt16LE(0, 32); // comment
    central.writeUInt16LE(0, 34); // 起始磁盘号
    central.writeUInt16LE(0, 36); // 内部属性
    central.writeUInt32LE(0, 38); // 外部属性
    central.writeUInt32LE(offset, 42); // 本地头在文件中的偏移

    centralChunks.push(central, nameBuf);

    offset += local.length + nameBuf.length + compressed.length;
  }

  const centralBuf = Buffer.concat(centralChunks);

  // --- 中央目录结束记录（22 字节）---
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0); // EOCD 签名
  eocd.writeUInt16LE(0, 4); // 当前磁盘号
  eocd.writeUInt16LE(0, 6); // 中央目录起始磁盘号
  eocd.writeUInt16LE(entries.length, 8); // 本磁盘条目数
  eocd.writeUInt16LE(entries.length, 10); // 总条目数
  eocd.writeUInt32LE(centralBuf.length, 12); // 中央目录大小
  eocd.writeUInt32LE(offset, 16); // 中央目录偏移
  eocd.writeUInt16LE(0, 20); // 注释长度

  return Buffer.concat([...localChunks, centralBuf, eocd]);
}

/* ------------------------------------------------------------------
 * 4. 打包
 * ---------------------------------------------------------------- */

const OUT_DIR = resolve(ROOT, process.argv[2] ?? 'release');
mkdirSync(OUT_DIR, { recursive: true });

const zipPath = resolve(OUT_DIR, `chrome-postman-v${manifest.version}.zip`);
if (existsSync(zipPath)) rmSync(zipPath);

const entries = filePaths.map((relPath) => ({
  name: relPath,
  data: readFileSync(resolve(DIST, relPath)),
}));

const zip = encodeZip(entries);
writeFileSync(zipPath, zip);

const sizeKb = (zip.length / 1024).toFixed(1);
console.log(`✓ 打包完成：${zipPath} (${sizeKb} KB, ${entries.length} 个文件)`);
console.log(`  在 chrome://extensions 打开「开发者模式」→「加载已解压的扩展程序」→ 选择 dist/`);
console.log(`  上传商店时直接用这个 zip（解压后 manifest.json 必须在根目录）`);

/* ------------------------------------------------------------------
 * 5. 本地桥接程序（可选产物）
 * ---------------------------------------------------------------- */

/*
 * 【为什么伴生程序要单独打包，不塞进扩展包】
 *
 * 1. 伴生程序是**独立进程**，不是扩展的一部分。
 *    Chrome 的 native messaging 要求它躺在磁盘上某个固定位置，
 *    由注册表（或约定目录）指向它 —— 放在扩展包里没有意义。
 * 2. 绝大多数用户**不需要**它（浏览器本来就能校验证书）。
 *    让它进扩展包，商店审核会看到一堆可执行脚本，反而增加麻烦。
 * 3. 单独打包后，Release 页面上就是两个附件：
 *    - chrome-postman-v1.2.0.zip          ← 扩展本体，人人都会装
 *    - chrome-postman-native-host-v1.2.0.zip ← 只有需要跳过证书校验的人才下载
 *
 * 解压后的结构是扁平的（bridge.mjs / install-host.ps1 直接在根目录），
 * 这样用户执行 install-host.ps1 时，脚本能用自己的 $PSScriptRoot 找到 bridge.mjs。
 */
const NATIVE_HOST_DIR = resolve(ROOT, 'native-host');
if (existsSync(NATIVE_HOST_DIR)) {
  const nativeFiles = collectFiles(NATIVE_HOST_DIR).sort();
  const nativeEntries = nativeFiles.map((relPath) => ({
    name: relPath,
    data: readFileSync(resolve(NATIVE_HOST_DIR, relPath)),
  }));

  const nativeZipPath = resolve(OUT_DIR, `chrome-postman-native-host-v${manifest.version}.zip`);
  if (existsSync(nativeZipPath)) rmSync(nativeZipPath);
  const nativeZip = encodeZip(nativeEntries);
  writeFileSync(nativeZipPath, nativeZip);

  console.log(
    `✓ 打包完成：${nativeZipPath} (${(nativeZip.length / 1024).toFixed(1)} KB, ${nativeEntries.length} 个文件)`,
  );
  console.log(`  只有需要跳过证书校验的用户才需要它；不装也能正常用扩展`);
}
