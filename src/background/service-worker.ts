/**
 * ============================================================
 * Service Worker —— 扩展的后台大脑
 * ============================================================
 *
 * 【在架构中的位置】
 * MV3 里后台脚本不再是常驻的"后台页"，而是一个 **Service Worker**：
 *   - 没有可见界面
 *   - 空闲 30 秒左右会被 Chrome 休眠（下次有事件再唤醒）
 *   - 不能用 DOM，不能用 window，但可以用 fetch / WebAssembly / IndexedDB
 *
 * 【为什么请求要放在这里发】
 *   1. 生命周期长：用户切走标签页、收起面板，请求照样跑完；
 *   2. 只有一份逻辑：UI 和后台不会跑出两套不同的请求行为；
 *   3. 脚本沙箱（QuickJS/WASM）在这里执行，不受页面 CSP 影响。
 *
 * 【本文件负责的事】
 *   ① 接收 UI 的"发送请求"指令，调用执行器
 *   ② 维护会话变量（内存态，随 SW 休眠丢失）
 *   ③ 把脚本写入的变量持久化回 chrome.storage
 *   ④ 写历史记录到 IndexedDB
 *   ⑤ 右键菜单：在任意页面用本工具打开该 URL
 */

import { MSG } from '../shared/messages';
import type { ExecutionResult, HttpRequest, VariableScope } from '../shared/types';
import { executeRequest } from '../core/request-executor';
import { NetErrorBuffer } from '../core/network-diagnostics';
import {
  getActiveEnvironmentId,
  getCollections,
  getEnvironments,
  getGlobals,
  getSettings,
  keyValuesToRecord,
  setVariables,
} from '../core/storage';
import { addHistory, pruneHistory } from '../core/db';
import { uid } from '../shared/utils';

/**
 * 会话变量：只存在于 Service Worker 内存里。
 *
 * 注意：SW 被休眠后这段内存就没了。所以 pm.variables.set 的值
 * 适合放"临时 token"，不适合放需要长期保留的变量 ——
 * 需要长期保留请用 pm.environment.set（会落到 chrome.storage）。
 */
const sessionVariables: Record<string, string> = {};

/**
 * 网络层错误记录缓冲。
 *
 * 数据来自 chrome.webRequest.onErrorOccurred —— 那是浏览器网络层才知道的
 * 真实错误码（net::ERR_PROXY_CONNECTION_FAILED 等），
 * fetch 抛给 JS 的只有一句 "Failed to fetch"。
 */
const netErrors = new NetErrorBuffer();

/** 是否已经注册了 webRequest 监听器 */
let webRequestWatching = false;
/** 注册过程本身的 Promise，避免并发重复注册（权限授予事件与 SW 唤醒可能同时触发） */
let watcherPromise: Promise<void> | null = null;

/** 检查是否已获得可选的 webRequest 权限 */
async function hasWebRequestPermission(): Promise<boolean> {
  try {
    return await chrome.permissions.contains({ permissions: ['webRequest'] });
  } catch {
    return false;
  }
}

/**
 * 注册网络错误监听器。
 *
 * 【为什么要有权限才注册】
 * webRequest 是可选权限，用户没授予时调用 addListener 会直接抛错，
 * 而且我们只想在用户明确开启诊断时才监听（最小权限原则）。
 */
function startNetworkWatcher(): Promise<void> {
  if (watcherPromise) return watcherPromise;

  watcherPromise = (async () => {
    if (!(await hasWebRequestPermission())) {
      watcherPromise = null; // 允许后续重试
      return;
    }
    if (!chrome.webRequest?.onErrorOccurred) {
      watcherPromise = null;
      return;
    }

    try {
      chrome.webRequest.onErrorOccurred.addListener(
        (details) => {
          netErrors.add({
            url: details.url,
            method: details.method,
            error: details.error,
            time: Date.now(),
            tabId: details.tabId,
            initiator: details.initiator,
          });
        },
        { urls: ['<all_urls>'] },
      );
      webRequestWatching = true;
      console.info('[sw] 网络诊断已启用');
    } catch (err) {
      console.warn('[sw] 注册网络诊断监听失败', err);
      watcherPromise = null;
    }
  })();

  return watcherPromise;
}

// Service Worker 每次被唤醒都会重新执行顶层代码，所以这里要重新注册监听
startNetworkWatcher();

// 用户在设置里授权后，立刻开始监听（不用等 SW 下次唤醒）
chrome.permissions.onAdded.addListener((permissions) => {
  if (permissions?.permissions?.includes('webRequest')) {
    startNetworkWatcher();
  }
});

/**
 * 组装当前请求能看到的变量作用域。
 * 优先级（高→低）：环境 > 集合 > 全局 > 会话
 */
async function buildScope(request: HttpRequest): Promise<VariableScope> {
  const environments = await getEnvironments();
  const collections = await getCollections();
  const globals = await getGlobals();

  // 请求绑定了环境就用绑定的，否则用全局激活环境
  const envId = request.environmentId ?? (await getActiveEnvironmentId());
  const env = environments.find((item) => item.id === envId);

  const collection = collections.find((item) => item.id === request.collectionId);

  return {
    environment: env ? keyValuesToRecord(env.values) : {},
    collection: collection ? keyValuesToRecord(collection.variables) : {},
    globals,
    session: { ...sessionVariables },
  };
}

/**
 * 把脚本写入的变量落盘。
 * - 环境变量：写回环境（需要知道写到哪个环境）
 * - 全局变量：写回 globals
 * - 会话变量：留在内存里
 */
async function persistVariables(
  request: HttpRequest,
  variables: { environment: Record<string, string>; globals: Record<string, string>; session: Record<string, string> },
): Promise<void> {
  if (variables.environment && Object.keys(variables.environment).length) {
    const envId = request.environmentId ?? (await getActiveEnvironmentId());
    if (envId) {
      await setVariables('environment', variables.environment);
    }
  }
  if (variables.globals && Object.keys(variables.globals).length) {
    await setVariables('globals', variables.globals);
  }
  Object.assign(sessionVariables, variables.session ?? {});
}

/** 记录一条历史 */
async function recordHistory(
  request: HttpRequest,
  result: ExecutionResult,
  duration: number,
): Promise<void> {
  const settings = await getSettings();
  const item = {
    id: uid('hist'),
    request,
    response: result.response,
    tests: result.outcome.tests,
    logs: result.outcome.logs,
    error: result.error,
    duration,
    timestamp: Date.now(),
    collectionId: request.collectionId,
  };
  await addHistory(item);
  await pruneHistory(settings.historyLimit);
}

/* ------------------------------------------------------------------
 * 消息处理
 * ---------------------------------------------------------------- */

chrome.runtime.onMessage.addListener((message: any, _sender, sendResponse) => {
  switch (message?.type) {
    case MSG.PING: {
      sendResponse({ type: MSG.PONG });
      return false;
    }

    case MSG.EXECUTE_REQUEST: {
      const request = message.payload?.request as HttpRequest;
      const requestId = message.payload?.requestId as string;
      handleExecute(request, requestId)
        .then((result) => sendResponse({ type: MSG.EXECUTE_RESULT, payload: { requestId, result } }))
        .catch((err) =>
          sendResponse({ type: MSG.ERROR, payload: { requestId, message: err?.message ?? String(err) } }),
        );
      // 返回 true 表示"稍后异步回复"，否则通道会提前关闭
      return true;
    }

    default:
      return false;
  }
});

/**
 * 执行一次请求：组装作用域 → 执行 → 落盘变量 → 写历史。
 */
async function handleExecute(request: HttpRequest, requestId: string): Promise<ExecutionResult> {
  const scope = await buildScope(request);
  const settings = await getSettings();

  const outcome = await executeRequest(request, scope, {
    timeout: settings.timeout,
    followRedirects: settings.followRedirects,
    sendCookies: settings.sendCookies,
    // 把网络错误码查询能力注入执行器，失败时才能给出精确原因
    getNetError: (url) => netErrors.find(url)?.error,
    proxyHint: settings.proxyHint,
  });

  // 变量落盘
  await persistVariables(request, outcome.outcome.variables);

  // 写历史
  try {
    await recordHistory(request, outcome, outcome.totalTime);
  } catch (err) {
    console.error('[sw] 写历史失败', err);
  }

  return {
    request: outcome.request,
    response: outcome.response,
    outcome: outcome.outcome,
    error: outcome.error,
    diagnostic: outcome.diagnostic,
    totalTime: outcome.totalTime,
  };
}

/* ------------------------------------------------------------------
 * 右键菜单
 * ---------------------------------------------------------------- */

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: 'cp-open-dashboard',
      title: 'Chrome Postman：在此 URL 上发起请求',
      contexts: ['page', 'link', 'selection'],
    });
    chrome.contextMenus.create({
      id: 'cp-open-dashboard-empty',
      title: 'Chrome Postman：打开工作台',
      contexts: ['page'],
    });
  });
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  const url = info.menuItemId === 'cp-open-dashboard' ? info.linkUrl || info.pageUrl || info.selectionText : undefined;
  chrome.tabs.create({
    url: chrome.runtime.getURL('dashboard/index.html'),
  });
  if (url) {
    // 把目标 URL 通过 storage 传给 Dashboard，由它预填请求编辑器
    chrome.storage.local.set({ 'cp.pendingUrl': url }).then(() => {
      chrome.runtime.sendMessage({ type: 'CP_PENDING_URL', payload: { url } }).catch(() => {
        /* Dashboard 可能还没打开，忽略 */
      });
    });
  }
});

/* ------------------------------------------------------------------
 * 说明
 * ------------------------------------------------------------------
 * 扩展图标配置了 default_popup，点击图标会打开 Popup，
 * 因此不会触发 chrome.action.onClicked。工作台入口由 Popup 与右键菜单提供。
 */
