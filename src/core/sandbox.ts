/**
 * ============================================================
 * 脚本沙箱（Sandbox）—— 基于 QuickJS (WebAssembly) 的安全执行器
 * ============================================================
 *
 * 【在架构中的位置】
 * 请求执行管线的第 2、5 步会调用本模块：
 *   ① 请求前拦截（pre-request script）
 *   ② 请求后拦截（post-response script / tests）
 *
 * 【它解决的核心问题】
 * Chrome 扩展页面的 CSP 是 `script-src 'self'`，禁止 eval 与 new Function。
 * 而 Postman 这类工具的核心卖点之一就是"用户能写 JS 改请求"。
 * 直接 eval 会被 CSP 拦掉，用 iframe 绕开又会引入 origin 泄漏风险。
 *
 * 【本模块的方案】
 * 把 QuickJS（一个用 C 写的 JS 引擎）编译成 WASM，在 WASM 沙箱里跑用户脚本：
 *   - 不受扩展 CSP 限制（扩展页面允许 'wasm-unsafe-eval'）
 *   - 用户脚本只能看到我们显式注入的 __state，拿不到 DOM / chrome.* / 网络
 *   - 可设内存上限与超时，用户写 while(true) 也不会拖死扩展
 *
 * 【宿主 ↔ 沙箱的数据流】
 *   宿主  →  __state (JSON 注入)  →  沙箱
 *   沙箱  →  改写 __state         →  宿主（一次性 dump 出来）
 *
 * 【关键实现细节】
 *   1. 每个脚本执行都新建一个 context，执行完立刻 dispose —— 防止内存泄漏。
 *   2. 用 JSON 字符串注入 __state，避免在宿主侧手工构造嵌套 QuickJS 句柄。
 *   3. QuickJS 的原生函数回调只接收「来宾参数」，没有 this 句柄（0.32 版本行为）。
 */

import { newQuickJSWASMModuleFromVariant } from 'quickjs-emscripten';
import { RELEASE_SYNC } from 'quickjs-emscripten/variants';
import pmSdkSource from './pm-sdk.raw.js?raw';
import type { LogEntry, ScriptError, ScriptPhase, TestResult } from '../shared/types';
import { buildScriptError } from './script-error';

/** 注入沙箱的请求状态（与 UI 的 HttpRequest 解耦，便于单测） */
export interface SandboxRequestState {
  method: string;
  url: string;
  headers: { key: string; value: string; enabled: boolean }[];
  body: { mode: string; raw: string; form?: unknown[]; formData?: unknown[] };
  auth: Record<string, unknown>;
}

/** 注入沙箱的响应状态 */
export interface SandboxResponseState {
  code: number;
  status: string;
  headers: { key: string; value: string }[];
  body: string;
  responseTime: number;
  size: number;
}

/** 变量包 */
export interface SandboxScope {
  environment: Record<string, string>;
  collection: Record<string, string>;
  globals: Record<string, string>;
  session: Record<string, string>;
}

/** 沙箱输入 */
export interface SandboxInput {
  /** 用户脚本源码 */
  script: string;
  /** 执行阶段 */
  phase: 'pre' | 'post';
  request: SandboxRequestState;
  response?: SandboxResponseState;
  scope: SandboxScope;
  /** 超时（毫秒），默认 5000 */
  timeoutMs?: number;
}

/** 沙箱输出 */
export interface SandboxOutput {
  /** 脚本改写后的请求（仅 pre 阶段有意义） */
  request?: SandboxRequestState;
  /** 脚本改写后的响应（仅 post 阶段有意义） */
  response?: SandboxResponseState;
  /** 脚本写入的变量 */
  variables: {
    environment: Record<string, string>;
    globals: Record<string, string>;
    session: Record<string, string>;
  };
  /** 断言结果 */
  tests: TestResult[];
  /** 日志 */
  logs: LogEntry[];
  /**
   * 脚本整体抛错时的信息（结构化，含行列号）。
   * 用结构化而不是字符串，是为了让 UI 能标红出错行并支持点击跳转。
   */
  error?: ScriptError;
}

/** 内存上限：32 MB。够用，又不至于让恶意脚本把内存吃光。 */
const MEMORY_LIMIT = 32 * 1024 * 1024;
/** 栈上限：1 MB，防止深层递归爆栈。 */
const STACK_LIMIT = 1024 * 1024;
/** 默认超时：5 秒。 */
const DEFAULT_TIMEOUT = 5000;

/** QuickJS WASM 模块是全局单例：加载一次即可复用（加载本身要几百毫秒）。 */
let modulePromise: Promise<any> | null = null;

/** 获取（并缓存）QuickJS 模块实例 */
export async function getQuickJS(): Promise<any> {
  if (!modulePromise) {
    modulePromise = newQuickJSWASMModuleFromVariant(RELEASE_SYNC);
  }
  return modulePromise;
}

/** 供测试用：重置模块缓存 */
export function resetQuickJSForTesting(): void {
  modulePromise = null;
}

/** 构造空的输出骨架 */
function emptyOutput(): SandboxOutput {
  return {
    variables: { environment: {}, globals: {}, session: {} },
    tests: [],
    logs: [],
  };
}

/**
 * 在沙箱中执行一段用户脚本。
 *
 * @param input 脚本 + 上下文
 * @returns 脚本产出（改写后的请求/响应、变量、断言、日志）
 */
export async function runSandbox(input: SandboxInput): Promise<SandboxOutput> {
  const output = emptyOutput();

  // 空脚本直接返回，省掉一次 WASM 上下文创建
  if (!input.script || !input.script.trim()) return output;

  let context: any = null;
  try {
    const quickjs = await getQuickJS();
    context = quickjs.newContext();

    // --- 沙箱加固：内存 / 栈 / 超时 ---
    applyLimits(context, input.timeoutMs ?? DEFAULT_TIMEOUT);

    // --- 注入 __state ---
    const state = {
      request: input.request,
      response: input.response ?? null,
      env: { ...input.scope.environment },
      collection: { ...input.scope.collection },
      globals: { ...input.scope.globals },
      session: { ...input.scope.session },
      tests: [] as TestResult[],
      logs: [] as LogEntry[],
    };
    const stateJson = JSON.stringify(state);
    const injectResult = context.evalCode(`globalThis.__state = ${stateJson};`);
    if (injectResult.error) {
      output.error = describeError(context, injectResult.error, input.phase);
      injectResult.error.dispose();
      return output;
    }
    injectResult.value.dispose();

    // --- 装入 pm SDK ---
    const sdkResult = context.evalCode(pmSdkSource, 'pm-sdk.js');
    if (sdkResult.error) {
      output.error = describeError(context, sdkResult.error, input.phase);
      sdkResult.error.dispose();
      return output;
    }
    sdkResult.value.dispose();

    // --- 执行用户脚本 ---
    const scriptResult = context.evalCode(input.script, `user-${input.phase}-script.js`);
    if (scriptResult.error) {
      output.error = describeError(context, scriptResult.error, input.phase);
      scriptResult.error.dispose();
    } else {
      scriptResult.value.dispose();
    }

    // --- 读回 __state ---
    const stateHandle = context.getProp(context.global, '__state');
    const dumped = context.dump(stateHandle);
    stateHandle.dispose();

    if (dumped && typeof dumped === 'object') {
      const d = dumped as any;
      if (d.request && typeof d.request === 'object') output.request = d.request as SandboxRequestState;
      if (d.response && typeof d.response === 'object') output.response = d.response as SandboxResponseState;
      if (d.env && typeof d.env === 'object') output.variables.environment = d.env;
      if (d.globals && typeof d.globals === 'object') output.variables.globals = d.globals;
      if (d.session && typeof d.session === 'object') output.variables.session = d.session;
      if (Array.isArray(d.tests)) output.tests = d.tests;
      if (Array.isArray(d.logs)) output.logs = d.logs;
    }
  } catch (err) {
    // 这里捕获的是宿主侧的异常（比如 WASM 内存超限），不是用户脚本的语法错误，
    // 所以没有行列号 —— buildScriptError 会把 location 留空，UI 只显示文字。
    output.error = buildScriptError(
      { name: err instanceof Error ? err.name : 'Error', message: err instanceof Error ? err.message : String(err) },
      input.phase,
    );
  } finally {
    // 无论成功失败都要释放上下文，否则 WASM 堆会一直涨
    if (context) {
      try {
        context.dispose();
      } catch {
        /* ignore */
      }
    }
  }

  return output;
}

/**
 * 给沙箱设置资源上限。
 * - 内存上限：超出后 QuickJS 抛出内存错误，脚本终止
 * - 栈上限：防止深递归
 * - 中断处理器：到达 deadline 就中断脚本（解决 while(true) 死循环）
 */
function applyLimits(context: any, timeoutMs: number): void {
  const runtime = context.runtime;
  const target = runtime && typeof runtime.setMemoryLimit === 'function' ? runtime : context;

  if (target && typeof target.setMemoryLimit === 'function') {
    try {
      target.setMemoryLimit(MEMORY_LIMIT);
    } catch {
      /* ignore */
    }
  }
  if (target && typeof target.setMaxStackSize === 'function') {
    try {
      target.setMaxStackSize(STACK_LIMIT);
    } catch {
      /* ignore */
    }
  }
  if (runtime && typeof runtime.setInterruptHandler === 'function') {
    const deadline = Date.now() + timeoutMs;
    runtime.setInterruptHandler(() => Date.now() > deadline);
  }
}

/**
 * 把 QuickJS 的错误句柄转成结构化的 ScriptError。
 * 注意：错误句柄用完必须 dispose，否则句柄表会泄漏。
 *
 * @param phase 脚本阶段，用来给堆栈里的文件名兜底
 */
function describeError(context: any, errorHandle: any, phase: ScriptPhase): ScriptError {
  try {
    const dumped = context.dump(errorHandle);
    if (dumped && typeof dumped === 'object') {
      const e = dumped as any;
      return buildScriptError(
        {
          name: e.name || 'Error',
          message: e.message || '',
          stack: e.stack ? String(e.stack) : undefined,
        },
        phase,
      );
    }
    return buildScriptError({ name: 'Error', message: String(dumped) }, phase);
  } catch {
    return buildScriptError({ name: 'Error', message: '脚本执行失败（无法读取错误信息）' }, phase);
  }
}
