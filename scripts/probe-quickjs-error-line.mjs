/**
 * 证据脚本：QuickJS 抛错时 stack 的格式（行号 / 列号）。
 *
 * 【要证明什么】
 *   为「v1.2 设计方案 §4.4 脚本错误行号定位」提供事实依据：
 *   QuickJS 的错误堆栈里带有 `文件名:行:列`，且行号基准与
 *   编辑器里看到的行号天然对齐（因为用户脚本是整段 eval 的）。
 *
 * 【为什么每个场景都用独立的 context】
 *   同一个 context 里重复 eval 会因为 `const` 重复声明而报
 *   "redeclaration of 'a'"，测出来的不是我们想测的错误。
 *   每个场景开一个新 context，结果才干净。
 *
 * 用法：node scripts/probe-quickjs-error-line.mjs
 */
import { newQuickJSWASMModuleFromVariant } from 'quickjs-emscripten';
import { RELEASE_SYNC } from 'quickjs-emscripten/variants';

const mod = await newQuickJSWASMModuleFromVariant(RELEASE_SYNC);

/** 在独立 context 里跑一段脚本，返回可读的错误描述 */
function runIsolated(script, filename) {
  const ctx = mod.newContext();
  try {
    const r = ctx.evalCode(script, filename);
    if (r.error) {
      const dumped = ctx.dump(r.error);
      r.error.dispose();
      return dumped && typeof dumped === 'object'
        ? { name: dumped.name, message: dumped.message, stack: dumped.stack }
        : { raw: String(dumped) };
    }
    r.value.dispose();
    return null;
  } finally {
    try {
      ctx.dispose();
    } catch {
      /* ignore */
    }
  }
}

const SCENARIOS = [
  {
    title: '场景1：运行期错误 —— 第 3 行引用未定义变量',
    script: [
      'const a = 1;',
      'const b = 2;',
      'const c = notDefinedVar + a;', // ← 第 3 行是错误行
      'console.log(c);',
    ].join('\n'),
  },
  {
    title: '场景2：主动 throw —— 第 2 行',
    script: ['const a = 1;', "throw new Error('boom');"].join('\n'),
  },
  {
    title: '场景3：语法错误（编译期）—— 第 1 行',
    script: 'const a = ;',
  },
];

console.log('=== QuickJS 错误堆栈格式实测 ===\n');
for (const s of SCENARIOS) {
  console.log(s.title);
  const err = runIsolated(s.script, 'user-post-script.js');
  console.log(JSON.stringify(err, null, 2));
  console.log('');
}

console.log('结论：');
console.log('  · stack 形如 "at <eval> (user-post-script.js:3:11)"');
console.log('  · 行号从 1 开始，列号从 1 开始');
console.log('  · 语法错误没有 "<eval>" 和括号，格式为 "at user-post-script.js:1:11"');
console.log('  · 两者都需要用宽松正则解析（见 v1.2 设计方案 §4.4）');
