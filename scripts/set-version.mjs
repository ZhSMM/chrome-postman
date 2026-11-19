/**
 * 版本同步脚本：把命令行传入的版本号写进 public/manifest.json。
 *
 * 【为什么需要】
 * 扩展的真实版本号只有一个来源 —— manifest.json 的 version 字段。
 * Chrome 商店、已安装扩展列表、扩展自身读到的都是它。
 * 打 tag 发布时，如果 manifest 里的版本号忘了改，就会出现
 * "发布 v1.1.0 但装上去还是 1.0.0" 的情况。
 * 所以 CI 里必须先同步版本号，再构建。
 *
 * 用法：node scripts/set-version.mjs v1.1.0   →   manifest.version = "1.1.0"
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const MANIFEST = resolve(__dirname, '../public/manifest.json');

const raw = process.argv[2];
if (!raw) {
  console.error('用法：node scripts/set-version.mjs <版本号>');
  console.error('示例：node scripts/set-version.mjs v1.1.0');
  process.exit(1);
}

// 允许带 v 前缀，也允许不带
const version = raw.trim().replace(/^v/i, '');

if (!/^\d+(\.\d+){0,3}$/.test(version)) {
  console.error(`✗ 版本号格式不合法：${raw}`);
  console.error('  Chrome 要求 version 是 1~4 段用点分隔的数字，例如 1.0 / 1.0.1 / 1.0.1.2');
  process.exit(1);
}

const manifest = JSON.parse(readFileSync(MANIFEST, 'utf8'));
const previous = manifest.version;

/**
 * 只替换 version 那一行，保留文件里原有的手工排版。
 * 如果整体重新 JSON.stringify，数组会被拆成多行，
 * 每次改版本号都产生一大片无意义 diff。
 */
const text = readFileSync(MANIFEST, 'utf8');
const patched = text.replace(/("version"\s*:\s*)"[^"]*"/, `$1"${version}"`);

if (patched === text && previous !== version) {
  // 没匹配到 version 字段，退回到整体重写
  manifest.version = version;
  writeFileSync(MANIFEST, JSON.stringify(manifest, null, 2) + '\n', 'utf8');
} else {
  writeFileSync(MANIFEST, patched, 'utf8');
}

console.log(`✓ manifest 版本号：${previous} → ${version}`);
