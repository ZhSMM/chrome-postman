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
  /**
   * 单请求级的 SSL 模式覆盖。
   * 不填（undefined）表示跟随全局设置。
   *
   * 【为什么单独留一个字段而不是改全局设置】
   * 大多数接口是正常签发的，只有个别内网服务是自签名证书。
   * 为了一个请求去改全局设置太粗放，改完还得改回来。
   */
  sslMode?: SslMode;
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

/**
 * SSL 校验模式。
 *
 * 【为什么分三种而不是一个开关】
 * 浏览器**没有**"关闭证书校验"这个能力 —— 校验发生在 Chromium 网络栈的
 * net::CertVerifier 层，扩展的 JS 根本碰不到。所以能做选择的只有"谁来发这个请求"：
 *
 * - strict       浏览器原生 fetch，浏览器按系统信任库校验（最安全，默认）
 * - system-trust 行为上与 strict 完全相同（浏览器本来就信任系统信任库），
 *                单独列出来是为了在 UI 上表达"我已经把 CA 装进系统了"这个用户意图
 * - native-bridge 交给本机伴生程序发（Node 的 https 模块有 rejectUnauthorized 选项，
 *                浏览器没有），这是唯一能真正跳过校验的路径
 */
export type SslMode = 'strict' | 'system-trust' | 'native-bridge';

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
  /** 全局 SSL 模式 */
  sslMode: SslMode;
  /**
   * 是否允许跳过证书校验（高危）。
   *
   * 【为什么默认关、且必须配桥接程序才生效】
   * 跳过校验意味着你的请求可能被中间人截获 —— 账号密码、token 全都会裸奔。
   * 而且这个开关**只在 native-bridge 模式下有效**：浏览器自己发的请求无法跳过校验。
   */
  allowInsecureTls: boolean;
}

/**
 * 本地桥接程序（伴生程序）的就绪状态。
 *
 * 【为什么不放 Settings 里】
 * 这是运行时探测出来的状态，不是用户配置，而且用户装/卸载伴生程序后它会变。
 * 放 Settings 就会和真实状态对不上。应该放运行态（store），不落盘。
 */
export interface BridgeStatus {
  /** 是否可用（伴生程序能连上并完成 ping） */
  available: boolean;
  /** 伴生程序版本 */
  version?: string;
  /** 探测失败时的错误信息 */
  error?: string;
  /** 上次探测时间 */
  checkedAt: number;
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
 * 请求的分段耗时。
 *
 * 【精度说明】
 * 这是 webRequest 能给到的最大精度 —— 三段。
 * DNS / TCP / TLS 的更细分段在 DevTools 协议里，扩展 API 拿不到
 * （详见 docs/DESIGN-v1.2.md §4.2）。
 */
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
  /** 数据来源：webRequest = 有分段；local = 只有总耗时 */
  source: 'webRequest' | 'local';
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
  /**
   * 本次响应是否**未经证书校验**。
   *
   * 【为什么必须显式标出来】
   * 跳过了证书校验，就意味着这个响应可能来自中间人。UI 必须用醒目横幅告诉用户，
   * 否则用户会以为这是一个可信的响应。
   */
  insecure?: boolean;
}

/** 单条断言结果 */
export interface TestResult {
  name: string;
  passed: boolean;
  error?: string;
  /** 断言耗时 */
  duration?: number;
}

/** 脚本执行阶段：前置（请求发出前）/ 后置（响应回来后） */
export type ScriptPhase = 'pre' | 'post';

/**
 * 错误在脚本里的位置。
 * 行列号都是 1-based，和编辑器里显示的行号一致。
 */
export interface ScriptErrorLocation {
  /** 行号，从 1 开始 */
  line: number;
  /** 列号，从 1 开始 */
  column: number;
  /** 出错的是哪个阶段的脚本 */
  phase: ScriptPhase;
}

/**
 * 结构化的脚本错误。
 *
 * 【为什么要结构化而不是一个字符串】
 * 字符串里混着类型名、消息、堆栈，UI 想"标红出错的那一行"就必须解析字符串。
 * 结构化之后，位置信息是明确字段，UI 直接用，不用猜。
 */
export interface ScriptError {
  /** 错误类型名，如 ReferenceError / TypeError / SyntaxError */
  name: string;
  /** 错误消息 */
  message: string;
  /** 原始堆栈（保留原文，方便排查） */
  stack?: string;
  /** 解析出的位置；解析不出来（超时中断等）时为 undefined */
  location?: ScriptErrorLocation;
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
  /**
   * 脚本整体抛错时的信息（结构化，含行列号）。
   *
   * 【注意】v1.2 之前这里是 string，现在是 ScriptError。
   * 改成结构化是为了让 UI 能标红出错行并支持点击跳转。
   */
  error?: ScriptError;
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
  /**
   * 分段耗时。
   * 只有开启了「网络诊断」（webRequest 权限）才会有 source='webRequest' 的分段数据；
   * 否则只有本地测的总耗时（source='local'）。
   */
  timing?: RequestTiming;
  /**
   * 本次请求是否跳过了证书校验。
   * 为 true 时 UI 必须显示醒目横幅（见 ResponsePanel）。
   */
  insecure?: boolean;
  /**
   * SSL 相关的提示文案（例如"桥接程序未就绪，本次已按严格校验发送"）。
   *
   * 【为什么要有这个字段】
   * 设计原则是「绝不静默降级」。用户以为自己开了跳过校验，但实际没有，
   * UI 必须把这件事说出来，而不是让用户面对一句毫无线索的 "Failed to fetch"。
   */
  sslNotice?: string;
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
  /** 这次请求是否跳过了证书校验（历史里要留个记号，方便回溯风险） */
  insecure?: boolean;
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
  // 默认走浏览器原生通道 + 严格校验，这是最安全的组合
  sslMode: 'strict',
  // 跳过校验是高危操作，必须由用户显式打开
  allowInsecureTls: false,
};

/** 空的请求体 */
export function emptyBody(): BodyConfig {
  return { mode: 'none', raw: '', form: [], formData: [] };
}

/** 空的鉴权 */
export function emptyAuth(): AuthConfig {
  return { type: 'none' };
}
