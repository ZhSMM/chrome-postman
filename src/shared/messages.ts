/**
 * UI 与 Service Worker 之间的消息协议定义。
 *
 * 【为什么单独抽一个文件】
 * 消息协议是"跨环境的接口定义"。把它独立出来的好处：
 *   1. 改协议时只有一个地方要动；
 *   2. TypeScript 会在两边同时报错，不会出现"UI 发 A、SW 收 B"这种静默 bug；
 *   3. 以后加 WebSocket / GraphQL 通道时，有统一的地方写。
 */

export const MSG = {
  /** UI 请求后台发一次 HTTP 请求 */
  EXECUTE_REQUEST: 'EXECUTE_REQUEST' as const,
  /** 后台返回执行结果 */
  EXECUTE_RESULT: 'EXECUTE_RESULT' as const,
  /** 心跳（用于确认后台 SW 已唤醒） */
  PING: 'PING' as const,
  PONG: 'PONG' as const,
  /** 通用错误 */
  ERROR: 'ERROR' as const,
} as const;

export type MsgType = (typeof MSG)[keyof typeof MSG];
