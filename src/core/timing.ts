/**
 * ============================================================
 * 请求耗时分段（Request Timing）
 * ============================================================
 *
 * 【在架构中的位置】
 * 位于 Service Worker 的 webRequest 监听器与 UI 的耗时面板之间。
 * SW 采集各阶段的时间戳，这里负责算出各段耗时。
 *
 * 【为什么只能分三段，不能像 DevTools 那样分五段】
 * chrome.webRequest 的事件详情里**没有** timing 字段 ——
 * DNS / TCP / TLS 的细分耗时是 DevTools 协议的 Network.responseReceived.timing
 * 才有的东西，而扩展 API 拿不到。
 *
 * 我们能拿到的四个事件时间戳，能算出三段：
 *
 *   onBeforeRequest   t0  请求即将发出
 *   onSendHeaders     t1  请求头已就绪
 *                        → t1-t0 = 建立连接（DNS + TCP + TLS + 代理 CONNECT 合计）
 *   onResponseStarted t2  首字节到达
 *                        → t2-t1 = 服务端处理 + 网络往返
 *   onCompleted       t3  响应体下载完成
 *                        → t3-t2 = 下载
 *
 * 【关键：时间戳只能用它们之间的差值】
 * Chrome 文档明确说 webRequest 的 timeStamp "只保证内部一致"，
 * 拿它和 Date.now() 比较可能得到离谱的结果。
 * 所以本模块只做差值运算，绝不混用两套时钟。
 */

/** webRequest 的阶段 */
export type TimingPhase = 'beforeRequest' | 'sendHeaders' | 'responseStarted' | 'completed';

/** 一个采集到的 webRequest 事件 */
export interface TimingEvent {
  requestId: string;
  url: string;
  method: string;
  phase: TimingPhase;
  /** webRequest 给的时间戳（只保证内部一致） */
  timeStamp: number;
  /** 实际连接到的服务器 IP */
  ip?: string;
  /** 是否命中了缓存 */
  fromCache?: boolean;
}

/** 算出来的分段耗时 */
export interface RequestTiming {
  phases: {
    /** 建立连接：DNS + TCP + TLS + 代理 CONNECT 的合计耗时 */
    connect: number;
    /** 服务端处理 + 网络往返 */
    waiting: number;
    /** 响应体下载 */
    download: number;
  };
  /** 总耗时 */
  total: number;
  /** 实际连接到的服务器 IP */
  serverIp?: string;
  /** 是否命中缓存 */
  fromCache: boolean;
  /** 发生了几次重定向 */
  redirects: number;
  /**
   * 数据来源。
   * 'webRequest' = 拿到了分段数据；'local' = 只有本地测的总耗时。
   */
  source: 'webRequest' | 'local';
}

/**
 * 从一组事件算出分段耗时。
 *
 * @param events 同一个 requestId 的事件（顺序不限）
 * @param fallbackTotal 本地测到的总耗时（webRequest 没数据时用它兜底）
 */
export function buildTiming(events: TimingEvent[], fallbackTotal?: number): RequestTiming {
  const pick = (phase: TimingPhase): TimingEvent | undefined =>
    events.find((event) => event.phase === phase);

  const t0 = pick('beforeRequest')?.timeStamp;
  const t1 = pick('sendHeaders')?.timeStamp;
  const t2 = pick('responseStarted')?.timeStamp;
  const t3 = pick('completed')?.timeStamp;

  const ip = pick('completed')?.ip ?? pick('responseStarted')?.ip;
  const fromCache = pick('completed')?.fromCache ?? false;

  // 缺任何一个关键时间戳，就没法分段
  if (t0 === undefined || t3 === undefined) {
    return {
      phases: { connect: 0, waiting: 0, download: 0 },
      total: fallbackTotal ?? 0,
      serverIp: ip,
      fromCache,
      redirects: 0,
      source: 'local',
    };
  }

  const diff = (a: number | undefined, b: number | undefined): number => {
    if (a === undefined || b === undefined) return 0;
    // 时间戳理论上递增，做个下限保护防止负数
    return Math.max(0, b - a);
  };

  const connect = diff(t0, t1);
  const waiting = diff(t1, t2);
  const download = diff(t2, t3);

  return {
    phases: { connect, waiting, download },
    total: Math.max(0, t3 - t0),
    serverIp: ip,
    fromCache,
    redirects: 0,
    source: 'webRequest',
  };
}

/**
 * 采集缓冲区。
 *
 * 【为什么按 requestId 分组】
 * 一次请求会触发多个事件，它们靠 requestId 关联。
 * 同时 URL 可能重复（重试、并发），所以 find 要能挑出"最近的那次"。
 */
export class TimingBuffer {
  /** requestId → 该请求的所有事件 */
  private records = new Map<string, TimingEvent[]>();

  /** URL → 最近一次用这个 URL 的 requestId（用于按 URL 查找） */
  private byUrl = new Map<string, string>();

  /** 记录一个事件 */
  add(event: TimingEvent): void {
    const list = this.records.get(event.requestId) ?? [];
    // 同一阶段可能触发多次（重定向），只保留最早的那个
    if (!list.some((item) => item.phase === event.phase)) {
      list.push(event);
    }
    this.records.set(event.requestId, list);
    this.byUrl.set(event.url, event.requestId);
  }

  /** 取某个 requestId 的全部事件 */
  getEvents(requestId: string): TimingEvent[] {
    return this.records.get(requestId) ?? [];
  }

  /**
   * 按 URL 查找最近一次请求的耗时。
   *
   * @param url 目标 URL
   * @param fallbackTotal 本地测到的总耗时
   */
  find(url: string, fallbackTotal?: number): RequestTiming | null {
    const requestId = this.byUrl.get(url);
    if (!requestId) return null;
    const events = this.records.get(requestId);
    if (!events || !events.length) return null;
    return buildTiming(events, fallbackTotal);
  }

  /**
   * 清理过期的记录，防止内存无限增长。
   *
   * 【为什么按条数而不是按时间清理】
   * webRequest 的时间戳不能和本地时钟比较（文档明确说它只保证内部一致），
   * 所以没法用"超过 N 分钟的记录删掉"这种方式判断过期。
   * 干脆按条数上限控制：只保留最近 N 个请求。
   *
   * @param maxRecords 最多保留多少个请求
   */
  prune(maxRecords = 200): void {
    if (this.records.size <= maxRecords) return;

    const ids = Array.from(this.records.keys());
    const overflow = ids.length - maxRecords;
    for (let i = 0; i < overflow; i += 1) {
      const id = ids[i];
      this.records.delete(id);
      for (const [url, rid] of Array.from(this.byUrl.entries())) {
        if (rid === id) this.byUrl.delete(url);
      }
    }
  }

  /** 清空（测试用） */
  clear(): void {
    this.records.clear();
    this.byUrl.clear();
  }

  /** 当前记录的条数（测试用） */
  get size(): number {
    return this.records.size;
  }
}
