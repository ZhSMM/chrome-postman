/**
 * 诊断脚本：确认 Chrome 是否真的加载了 dist/ 里的扩展。
 * 保留 profile 便于事后检查。
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const DIST = resolve(process.cwd(), 'dist');
const CDP_PORT = 9455;

const profile = mkdtempSync(join(tmpdir(), 'cp-diag-'));
console.log('profile =', profile);

const chrome = spawn(
  CHROME,
  [
    '--headless=new',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-gpu',
    '--enable-logging=stderr',
    '--v=1',
    // Google Chrome 品牌版默认禁用 --load-extension 开关，
    // 必须用这个 feature flag 把它放回来（否则扩展静默不加载）
    '--disable-features=DisableLoadExtensionCommandLineSwitch',
    `--load-extension=${DIST}`,
    `--user-data-dir=${profile}`,
    `--remote-debugging-port=${CDP_PORT}`,
    'about:blank',
  ],
  { stdio: ['ignore', 'pipe', 'pipe'] },
);

let stderr = '';
chrome.stderr.on('data', (d) => {
  stderr += d.toString();
});
chrome.stdout.on('data', () => {});

await new Promise((r) => setTimeout(r, 9000));

console.log('\n=== TARGETS ===');
try {
  const targets = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json();
  targets.forEach((t) => console.log(`  ${t.type.padEnd(16)} ${t.url}`));
} catch (e) {
  console.log('  (no devtools)', e.message);
}

console.log('\n=== PROFILE DIR ===');
const defDir = join(profile, 'Default');
if (existsSync(defDir)) {
  readdirSync(defDir)
    .filter((f) => /Preferences|Extension/i.test(f))
    .forEach((f) => console.log('  ' + f));
}

for (const file of ['Preferences', 'Secure Preferences']) {
  const p = join(defDir, file);
  if (!existsSync(p)) continue;
  const text = readFileSync(p, 'utf8');
  const hit = text.toLowerCase().includes('chrome-postman') || text.includes(DIST);
  console.log(`\n=== ${file}: contains dist path = ${hit} (size ${text.length}) ===`);
  if (hit) {
    try {
      const json = JSON.parse(text);
      const settings = json?.extensions?.settings ?? {};
      for (const [id, entry] of Object.entries(settings)) {
        console.log(`  id=${id} path=${entry?.path} state=${entry?.state} manifest=${entry?.manifest?.name}`);
      }
    } catch (e) {
      console.log('  (parse failed)', e.message);
    }
  }
}

console.log('\n=== STDERR (extension-related lines) ===');
const lines = stderr.split('\n');
const interesting = lines.filter((l) => /extension|manifest|load_extension/i.test(l));
console.log(interesting.slice(0, 40).join('\n') || '(none)');

writeFileSync(join(process.cwd(), 'chrome-stderr.log'), stderr);
console.log('\nfull stderr written to chrome-stderr.log (' + stderr.length + ' chars)');

chrome.kill();
await new Promise((r) => setTimeout(r, 500));
console.log('profile kept at', profile);
