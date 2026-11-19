/**
 * 打包脚本：把 dist/ 压成可上传到 Chrome Web Store 的 zip。
 *
 * 【为什么单独打包】
 * Chrome 扩展的分发单位是 zip，解压后必须保证 manifest.json 在根目录。
 * 这个脚本会先校验结构，避免打出"装不上"的包。
 *
 * 【打包方式】
 * 优先用 tar（Windows 10+ / macOS / Linux 都自带，且支持 -a 自动按扩展名选 zip）；
 * 没有 tar 就退回 PowerShell 的 Compress-Archive。
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const DIST = resolve(ROOT, 'dist');
const OUT_DIR = resolve(ROOT, 'release');

/* ---------- 1. 校验产物结构 ---------- */

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
const required = [
  manifest.background?.service_worker,
  manifest.action?.default_popup,
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

/* ---------- 2. 打包 ---------- */

mkdirSync(OUT_DIR, { recursive: true });
const zipPath = resolve(OUT_DIR, `chrome-postman-v${manifest.version}.zip`);
if (existsSync(zipPath)) rmSync(zipPath);

function run(cmd, args) {
  return spawnSync(cmd, args, { cwd: ROOT, stdio: 'inherit', shell: false });
}

// tar -a 会根据 .zip 扩展名选择 zip 格式
let done = false;
if (process.platform !== 'win32' || existsSync('/usr/bin/tar') || existsSync('/bin/tar')) {
  const result = run('tar', ['-a', '-c', '-f', zipPath, '-C', 'dist', '.']);
  done = result.status === 0;
}

// Windows 上退回 PowerShell
if (!done) {
  const result = run('powershell', [
    '-NoProfile',
    '-Command',
    `Compress-Archive -Path 'dist\\*' -DestinationPath '${zipPath}' -Force`,
  ]);
  done = result.status === 0;
}

if (!done) {
  console.error('✗ 打包失败：tar 与 Compress-Archive 都不可用');
  process.exit(1);
}

const size = statSync(zipPath).size;
console.log(`✓ 打包完成：${zipPath} (${(size / 1024).toFixed(1)} KB)`);
console.log('  在 chrome://extensions 打开「开发者模式」→「加载已解压的扩展程序」→ 选择 dist/');
