/**
 * 与 Service Worker 通信的客户端封装。
 *
 * 【初学者先看这里】
 * UI 页面和 Service Worker 是两个独立的 JS 环境，
 * 它们之间只能用 chrome.runtime.sendMessage 通信（像打电话一样）。
 * 这里把"打电话"封装成 Promise，调用方就能 await。
 */
import { MSG } from '../shared/messages';
import type { ExecutionResult, HttpRequest } from '../shared/types';
import { uid } from '../shared/utils';

/** 发送一次请求给后台执行 */
export async function sendRequestToWorker(request: HttpRequest): Promise<ExecutionResult> {
  const requestId = uid('run');
  const response = await chrome.runtime.sendMessage({
    type: MSG.EXECUTE_REQUEST,
    payload: { request, requestId },
  });

  if (!response) throw new Error('后台没有响应（Service Worker 可能正在启动，请稍后重试）');
  if (response.type === MSG.ERROR) {
    throw new Error(response.payload?.message ?? '未知错误');
  }
  if (response.type === MSG.EXECUTE_RESULT) {
    return response.payload.result as ExecutionResult;
  }
  throw new Error('后台返回了无法识别的消息');
}

/** 心跳：确认后台已就绪 */
export async function pingWorker(): Promise<boolean> {
  try {
    const response = await chrome.runtime.sendMessage({ type: MSG.PING });
    return response?.type === MSG.PONG;
  } catch {
    return false;
  }
}
