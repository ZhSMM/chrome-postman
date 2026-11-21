/**
 * ============================================================
 * 领域模型定义（Domain Model）
 * ============================================================
 *
 * 【在架构中的位置】
 * 这是整个扩展的"数据契约层"。UI（React）、后台 Service Worker、存储层
 * 全部通过这里的类型来交换数据。任何跨层传递的数据都必须在这里声明形状。
 *
 * 【初学者先看这里】
 * 扩展本质上是"多个独立运行的 JS 环境"：
 *   - Dashboard（主界面，运行在普通标签页）
 *   - Popup（扩展图标小窗）
 *   - Service Worker（后台常驻，负责发请求 + 跑脚本）
 * 它们之间靠 chrome.storage / chrome.runtime.sendMessage 通信。
 * 类型就是"通信协议"，写错了运行时才会报错，所以这里要一次写清楚。
 *
 * 【用到的 Chrome API】
 *   chrome.storage.local —— 持久化这些结构
 *   chrome.runtime.sendMessage —— UI ↔ Service Worker 传递 ExecuteResult
 */

/** 支持的 HTTP 方法。注意 GET/HEAD 不能带 body，这是协议限制不是我们的限制。 */
export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'HEAD' | 'OPTIONS';

/**
 * 键值对 —— 表格编辑器（Headers / Query Params / 环境变量）的统一数据结构。
 * enabled 用来做"临时禁用一行"，Postman 里叫 eye 图标。
 */
export interface KeyValue {
  id: string;
  key: string;
  value: string;
  enabled: boolean;
  description?: string;
}

/** 请求体模式 */
export type BodyMode =
  | 'none' // 不带 body
  | 'json' // application/json
  | 'text' // text/plain
  | 'xml' // application/xml
  | 'html' // text/html
  | 'form-urlencoded' // 表单 urlencoded
  | 'form-data' // multipart/form-data
  | 'binary'; // 二进制文件（Base64 存储）

/** multipart/form-data 的一个分段 */
export interface MultipartPart {
  id: string;
  /** 普通字段 */
  key: string;
  value: string;
  /** 文件字段 */
  isFile: boolean;
  /** Base64 编码的文件内容 */
  fileBase64?: string;
  fileName?: string;
  mimeType?: string;
  enabled: boolean;
}

/** 请求体配置 */
export interface BodyConfig {
  mode: BodyMode;
  /** json/text/xml/html 模式下的原始报文 */
  raw: string;
  /** form-urlencoded 模式的键值表 */
  form: KeyValue[];
  /** form-data 模式的分段列表 */
  formData: MultipartPart[];
  /** binary 模式下的 Base64 内容 */
  binaryBase64?: string;
  binaryFileName?: string;
  binaryMimeType?: string;
}

/** 鉴权类型 */
export type AuthType = 'none' | 'basic' | 'bearer' | 'apikey' | 'digest' | 'oauth2';

/** 鉴权配置 */
export interface AuthConfig {
  type: AuthType;
  /** basic */
  username?: string;
  password?: string;
  /** bearer */
  token?: string;
  /** apikey */
  apiKey?: string;
  apiValue?: string;
  /** apikey 放在哪 */
  apiKeyIn?: 'header' | 'query';
  /** digest */
  digestUsername?: string;
  digestPassword?: string;
  /** oauth2 */
  oauthToken?: string;
}

/**
 * 一个 HTTP 请求（草稿）。
 * 注意：这里的 url / headers / body 里可能含有 {{variable}} 占位符，
 * 真正发送前会在「变量引擎」里做插值替换。
 */
export interface HttpRequest {
  id: string;
  name: string;
  method: HttpMethod;
  /** 可能含 {{var}}，也可能含 ?a=1 这样的内联 query */
  url: string;
  /** Query 参数表（与 url 内联的 query 会合并） */
  params: KeyValue[];
  headers: KeyValue[];
  body: BodyConfig;
  auth: AuthConfig;
  /** 请求前拦截脚本（沙箱内执行） */
  preScript: string;
  /** 请求后拦截脚本（沙箱内执行） */
  postScript: string;
  /** 归属：集合与文件夹（null = 不在任何文件夹下） */
  collectionId?: string;
  folderId?: string | null;
  /** 绑定的环境 id，undefined 表示跟随全局激活环境 */
  environmentId?: string | null;
  createdAt: number;
  updatedAt: number;
}

/** 集合（Postman 的 Collection） */
export interface Collection {
  id: string;
  name: string;
  description?: string;
  /** 集合级变量，优先级低于环境变量 */
  variables: KeyValue[];
  createdAt: number;
  updatedAt: number;
}

/** 文件夹（可嵌套） */
export interface Folder {
  id: string;
  name: string;
  collectionId: string;
  parentId: string | null;
  createdAt: number;
}

/** 环境（Postman 的 Environment） */
export interface Environment {
  id: string;
  name: string;
  /** 变量表 */
  values: KeyValue[];
  /** 敏感变量：界面上显示成 ••••，导出时仍然保留明文 */
  secret?: boolean;
  createdAt: number;
  updatedAt: number;
}

/** 全局设置 */
export interface Settings {
  /** 主题 */
  theme: 'light' | 'dark' | 'system';
  /** 请求超时（毫秒） */
  timeout: number;
  /** 是否跟随 30x 自动跳转 */
  followRedirects: boolean;
  /** 是否携带 Cookie */
  sendCookies: boolean;
  /** 是否在 UI 里显示断言结果 */
  historyLimit: number;
  /** 代理地址（仅用于诊断提示，填写后报错信息会附带代理相关的排查建议） */
  proxyHint?: string;
}

/** 某个网络错误码的解释 */
export interface ErrorExplanation {
  /** 原始错误码，如 net::ERR_PROXY_CONNECTION_FAILED */
  code: string;
  /** 一句话标题 */
  title: string;
  /** 详细说明 */
  detail: string;
  /** 可执行的解决步骤 */
  suggestions: string[];
  /** 是否与代理有关 */
  proxyRelated: boolean;
}

/** 一次失败请求的诊断报告 */
export interface DiagnosticReport {
  /** 目标 URL */
  url: string;
  /** JS 层拿到的原始错误（通常是 "Failed to fetch"） */
  rawError: string;
  /** 网络层真实错误码（启用诊断后才能拿到） */
  netError: string | null;
  /** 错误码的中文解释 */
  explanation: ErrorExplanation | null;
  /** 用户配置的代理地址 */
  proxyHint?: string;
  /** 综合后的排查建议 */
  suggestions: string[];
}

/**
 * 变量作用域。
 * 优先级（从高到低）：环境变量 > 集合变量 > 全局变量 > 会话变量 > 内置动态变量
 */
export interface VariableScope {
  environment: Record<string, string>;
  collection: Record<string, string>;
  globals: Record<string, string>;
  session: Record<string, string>;
}

/**
 * 插值之后的"可直接发送"的请求。
 * 注意：这里的每个字段都已经把 {{var}} 替换成了真实值。
 */
export interface ResolvedRequest {
  method: HttpMethod;
  /** 已插值的 URL（尚未拼接 query 参数） */
  url: string;
  /** 已插值的请求头 */
  headers: Record<string, string>;
  /** 已插值的 query 参数 */
  params: [string, string][];
  /** 已插值的请求体 */
  body: BodyConfig;
  /** 已插值的鉴权配置 */
  auth: AuthConfig;
  /** 原始草稿（脚本需要看原始值时用） */
  raw: HttpRequest;
  /** 没能解析出来的变量名 */
  missing: string[];
}

/** 响应数据 */
export interface HttpResponseData {
  status: number;
  statusText: string;
  headers: Record<string, string>;
  /** 响应体文本（binary 响应会是 Base64，标记 isBase64） */
  body: string;
  isBase64?: boolean;
  /** 响应体大小（字节） */
  size: number;
  /** 耗时（毫秒） */
  responseTime: number;
  /** 最终 URL（跟随重定向后） */
  finalUrl?: string;
}

/** 单条断言结果 */
export interface TestResult {
  name: string;
  passed: boolean;
  error?: string;
  /** 断言耗时 */
  duration?: number;
}

/** 脚本日志 */
export interface LogEntry {
  level: 'log' | 'warn' | 'error';
  message: string;
  timestamp: number;
}

/** 脚本执行后的产出 */
export interface ScriptOutcome {
  /** 脚本修改过的请求（仅 pre 阶段有意义） */
  requestPatch?: Partial<HttpRequest>;
  /** 脚本修改过的响应（仅 post 阶段有意义） */
  responsePatch?: Partial<HttpResponseData>;
  /** 脚本写入的变量 */
  variables: {
    environment: Record<string, string>;
    globals: Record<string, string>;
    session: Record<string, string>;
  };
  /** 断言结果 */
  tests: TestResult[];
  /** 控制台日志 */
  logs: LogEntry[];
  /** 脚本整体抛错时的信息 */
  error?: string;
}

/** 一次请求执行的完整结果 */
export interface ExecutionResult {
  request: ResolvedRequest;
  response: HttpResponseData | null;
  /** 脚本产出的断言与日志 */
  outcome: ScriptOutcome;
  /** 真实网络错误（超时、连接失败、CORS 未授权等） */
  error?: string;
  /** 整体耗时 */
  totalTime: number;
  /** 失败时的网络诊断报告（仅在请求失败时出现） */
  diagnostic?: DiagnosticReport;
}

/** 历史记录条目 */
export interface HistoryItem {
  id: string;
  request: HttpRequest;
  response: HttpResponseData | null;
  tests: TestResult[];
  logs: LogEntry[];
  error?: string;
  duration: number;
  timestamp: number;
  /** 来自哪个集合 */
  collectionId?: string;
}

/** 消息协议：UI → Service Worker */
export type WorkerRequest =
  | { type: 'EXECUTE_REQUEST'; payload: { request: HttpRequest; requestId: string } }
  | { type: 'PING' }
  | { type: 'GET_ACTIVE_TAB' };

/** 消息协议：Service Worker → UI */
export type WorkerResponse =
  | { type: 'EXECUTE_RESULT'; payload: { requestId: string; result: ExecutionResult } }
  | { type: 'PONG' }
  | { type: 'ERROR'; payload: { requestId?: string; message: string } };

/** 存储层 key 命名规范（统一前缀，避免和别的扩展冲突） */
export const STORAGE_KEYS = {
  collections: 'cp.collections',
  folders: 'cp.folders',
  requests: 'cp.requests',
  environments: 'cp.environments',
  activeEnvironmentId: 'cp.activeEnvironmentId',
  globals: 'cp.globals',
  session: 'cp.session',
  settings: 'cp.settings',
} as const;

/** 默认设置 */
export const DEFAULT_SETTINGS: Settings = {
  theme: 'system',
  timeout: 30000,
  followRedirects: true,
  sendCookies: true,
  historyLimit: 200,
};

/** 空的请求体 */
export function emptyBody(): BodyConfig {
  return { mode: 'none', raw: '', form: [], formData: [] };
}

/** 空的鉴权 */
export function emptyAuth(): AuthConfig {
  return { type: 'none' };
}
