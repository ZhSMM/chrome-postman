/**
 * ============================================================
 * Native 伴生程序适配器（背景层）
 * ============================================================
 *
 * 【在架构中的位置】
 * 整个项目里**只有这一个文件**允许碰 native messaging 的 Chrome API。
 * 核心层（src/core/native-bridge.ts）只负责"消息怎么组、响应怎么解析"，
 * 真正的通道由本文件接上。
 *
 * 【为什么用 connectNative 而不是 sendNativeMessage】
 * - sendNativeMessage：一次消息启一个进程、收完就杀。
 *   Node 冷启动要几十毫秒，发 10 个请求就是 10 次启动。
 * - connectNative：长连接，伴生程序一直活着，请求之间零启动开销。
 *   一个 API 调试工具会连发很多请求，这条差别非常明显。
 *
 * 【关键实现细节】
 * - 连接失败（伴生程序没装）时 connectNative 会**同步抛异常**，
 *   必须转成 BridgeError，否则上层拿到的是个看不懂的英文异常。
 * - Service Worker 会被休眠，休眠时连接也会断。
 *   所以每次 send 时都会检查连接，断了就重建。
 * - 端口断开时所有还在等着的请求都要被 reject 掉，
 *   否则它们会永远挂着（UI 上就是一个转圈不结束的请求）。
 *
 * 【安全边界】
 * 伴生程序是**不受浏览器沙箱保护**的外部进程，扩展必须假设它可能异常。
 * 所以这里的每个返回值都要校验，异常要转成有意义的错误码。
 */

import {
  BRIDGE_HOST_NAME,
  BridgeError,
  probeBridge,
  type BridgeClient,
} from '../core/native-bridge';

/** 一次待回应的请求 */
interface PendingCall {
  resolve: (value: unknown) => void;
  reject: (reason: Error) => void;
  /** 超时定时器 */
  timer: ReturnType<typeof setTimeout>;
}

/**
 * 长连接版的 native messaging 客户端。
 */
export class NativeHostClient implements BridgeClient {
  /** 当前连接（断开后置空，下次用时重建） */
  private port: chrome.runtime.Port | null = null;
  /** id → 待回应的 Promise */
  private pending = new Map<string, PendingCall>();
  /** 自增的消息序号（消息里没带 id 时兜底） */
  private seq = 0;

  /**
   * 建立（或复用）到伴生程序的连接。
   *
   * 【为什么要单独抽这个方法】
   * Service Worker 休眠后连接会断，下次用的时候必须能重建。
   */
  private ensurePort(): chrome.runtime.Port {
    if (this.port) return this.port;

    let port: chrome.runtime.Port;
    try {
      port = chrome.runtime.connectNative(BRIDGE_HOST_NAME);
    } catch (err) {
      /*
       * connectNative 失败最常见的原因是"没装伴生程序"（注册表里没有这个 host）。
       * Chrome 抛的英文原文是 "Specified native messaging host not found."，
       * 直接透给用户等于没提示，所以转成自己的错误码。
       */
      const message = (err as Error)?.message ?? String(err);
      const notFound = /not found|no such|找不到/i.test(message);
      throw new BridgeError({
        code: notFound ? 'BRIDGE_NOT_INSTALLED' : 'CONNECT_FAILED',
        message: notFound ? '未检测到本地桥接程序' : `无法连接本地桥接程序：${message}`,
      });
    }

    port.onMessage.addListener((message: unknown) => {
      this.handleMessage(message);
    });
    port.onDisconnect.addListener(() => {
      this.handleDisconnect();
    });

    this.port = port;
    return port;
  }

  /** 收到伴生程序的一条回复 */
  private handleMessage(message: unknown): void {
    const id = (message as any)?.id;
    if (typeof id !== 'string') return;
    const call = this.pending.get(id);
    if (!call) return;
    this.pending.delete(id);
    clearTimeout(call.timer);
    call.resolve(message);
  }

  /**
   * 连接断了（伴生程序崩了 / 被用户关掉 / SW 休眠）。
   * 所有还在等着的请求都要立刻失败，不能让它们永远挂着。
   */
  private handleDisconnect(): void {
    this.port = null;
    const calls = Array.from(this.pending.values());
    this.pending.clear();
    calls.forEach((call) => {
      clearTimeout(call.timer);
      call.reject(
        new BridgeError({
          code: 'BRIDGE_DISCONNECTED',
          message: '与本地桥接程序的连接已断开',
        }),
      );
    });
  }

  /**
   * 发一条消息给伴生程序并等它回复。
   */
  send(message: unknown): Promise<unknown> {
    let port: chrome.runtime.Port;
    try {
      port = this.ensurePort();
    } catch (err) {
      return Promise.reject(err);
    }

    const payload = message as { id?: string };
    const id = payload?.id ?? `m${++this.seq}`;
    payload.id = id;

    // 客户端兜底超时：桥接程序自己也有超时，但万一它卡死了，我们不能跟着挂
    const timeoutMs = Number((payload as any)?.req?.timeoutMs) || 30000;
    const guard = timeoutMs + 5000;

    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(
          new BridgeError({
            code: 'BRIDGE_TIMEOUT',
            message: `等待本地桥接程序响应超时（${guard} ms）`,
          }),
        );
      }, guard);

      this.pending.set(id, { resolve, reject, timer });

      try {
        port.postMessage(payload);
      } catch (err) {
        this.pending.delete(id);
        clearTimeout(timer);
        reject(
          new BridgeError({
            code: 'SEND_FAILED',
            message: `发送消息到本地桥接程序失败：${(err as Error)?.message ?? String(err)}`,
          }),
        );
      }
    });
  }

  /** 主动断开连接（用于测试或用户关闭桥接功能时） */
  disconnect(): void {
    try {
      this.port?.disconnect();
    } catch {
      /* 忽略：断开失败无所谓 */
    }
    this.port = null;
  }
}

/**
 * 全局单例。
 *
 * 【为什么是单例】
 * 每个请求都建一条新连接的话，伴生程序会被反复启动，
 * 而且同一时刻可能有好几个伴生程序实例在跑。用一个全局实例保证只有一条连接。
 */
export const nativeHostClient = new NativeHostClient();

/**
 * 探测伴生程序是否就绪。
 *
 * 【为什么不缓存结果】
 * 用户可能随时安装/卸载伴生程序，缓存会过期。
 * 每次探测都是一次很轻量的 ping，成本可以接受。
 */
export async function probeNativeHost(): Promise<{
  available: boolean;
  version?: string;
  error?: string;
}> {
  const result = await probeBridge(nativeHostClient);
  if (!result.available) {
    // 探测失败后把连接断掉，下次重新建 —— 避免留一条僵尸连接
    nativeHostClient.disconnect();
  }
  return result;
}
