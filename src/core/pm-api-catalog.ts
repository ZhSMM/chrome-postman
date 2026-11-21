/**
 * ============================================================
 * pm SDK API 清单
 * ============================================================
 *
 * 【在架构中的位置】
 * 补全引擎的候选来源之一。用户敲 `pm.` 或 `pm.response.` 时，
 * 下拉框里显示的就是这张表。
 *
 * 【为什么单独维护一张表，而不是运行时反射 pm 对象】
 * 1. pm 是运行在 QuickJS 沙箱里的对象，宿主侧拿不到它（每次执行才创建）
 * 2. 反射只能看到"有什么"，看不到"怎么用"（参数、含义、示例）
 * 3. 补全的价值恰恰在于那些说明文字
 *
 * 【一致性由单测保证】
 * tests/pm-api-catalog.test.ts 会把表里的每条路径拿到沙箱里跑一遍，
 * 验证该 API 真实存在。改了 SDK 却忘了改表，单测会失败。
 */
import type { CompletionApi } from './completion';

/** 一条 API 的定义 */
export type PmApiEntry = CompletionApi;

/**
 * pm SDK 的完整 API 清单。
 *
 * 路径写法与实际访问方式一致：
 *   pm.environment.set('k','v')
 *   pm.response.to.have.status(200)
 */
export const PM_API_CATALOG: PmApiEntry[] = [
  /* ---------------- 顶层 ---------------- */
  { path: 'pm.test', signature: '(name, fn)', description: '注册一条断言（失败不会中断脚本）' },
  { path: 'pm.expect', signature: '(value)', description: 'chai 风格断言入口' },
  { path: 'pm.request', signature: '', description: '当前请求对象' },
  { path: 'pm.response', signature: '', description: '当前响应对象' },
  { path: 'pm.environment', signature: '', description: '环境变量仓库' },
  { path: 'pm.globals', signature: '', description: '全局变量仓库' },
  { path: 'pm.variables', signature: '', description: '变量仓库（按作用域链查找）' },

  /* ---------------- pm.request ---------------- */
  { path: 'pm.request.method', signature: '(get|set)', description: '读写请求方法' },
  { path: 'pm.request.url', signature: '', description: '请求 URL 对象' },
  { path: 'pm.request.url.raw', signature: '(get|set)', description: '读写完整 URL 字符串' },
  { path: 'pm.request.headers', signature: '', description: '请求头列表' },
  { path: 'pm.request.headers.add', signature: '(name, value)', description: '追加请求头' },
  { path: 'pm.request.headers.upsert', signature: '(name, value)', description: '新增或覆盖请求头' },
  { path: 'pm.request.headers.remove', signature: '(name)', description: '删除请求头' },
  { path: 'pm.request.headers.get', signature: '(name)', description: '读请求头的值' },
  { path: 'pm.request.headers.has', signature: '(name)', description: '请求头是否存在' },
  { path: 'pm.request.headers.all', signature: '()', description: '取全部请求头（数组）' },
  { path: 'pm.request.headers.toObject', signature: '()', description: '取全部请求头（对象）' },
  { path: 'pm.request.headers.count', signature: '()', description: '请求头数量' },
  { path: 'pm.request.body', signature: '', description: '请求体对象' },
  { path: 'pm.request.body.raw', signature: '(get|set)', description: '读写请求体原文' },
  { path: 'pm.request.body.json', signature: '()', description: '把请求体当 JSON 解析' },
  { path: 'pm.request.body.toString', signature: '()', description: '请求体转字符串' },
  { path: 'pm.request.auth', signature: '', description: '鉴权配置' },

  /* ---------------- pm.response ---------------- */
  { path: 'pm.response.code', signature: '(get|set)', description: '读写状态码' },
  { path: 'pm.response.status', signature: '(get|set)', description: '读写状态描述' },
  { path: 'pm.response.responseTime', signature: '(get|set)', description: '读写响应耗时（毫秒）' },
  { path: 'pm.response.size', signature: '(get)', description: '响应体大小（字节）' },
  { path: 'pm.response.headers', signature: '', description: '响应头列表' },
  { path: 'pm.response.headers.get', signature: '(name)', description: '读响应头的值' },
  { path: 'pm.response.headers.has', signature: '(name)', description: '响应头是否存在' },
  { path: 'pm.response.headers.all', signature: '()', description: '取全部响应头（数组）' },
  { path: 'pm.response.headers.toObject', signature: '()', description: '取全部响应头（对象）' },
  { path: 'pm.response.json', signature: '()', description: '把响应体当 JSON 解析' },
  { path: 'pm.response.text', signature: '()', description: '读响应体文本' },
  { path: 'pm.response.toString', signature: '()', description: '响应体转字符串' },

  /* ---------------- pm.environment / pm.globals / pm.variables ---------------- */
  { path: 'pm.environment.get', signature: '(key)', description: '读环境变量' },
  { path: 'pm.environment.set', signature: '(key, value)', description: '写环境变量' },
  { path: 'pm.environment.unset', signature: '(key)', description: '删除环境变量' },
  { path: 'pm.environment.has', signature: '(key)', description: '环境变量是否存在' },
  { path: 'pm.environment.clear', signature: '()', description: '清空环境变量' },
  { path: 'pm.environment.toObject', signature: '()', description: '取全部环境变量（对象）' },
  { path: 'pm.globals.get', signature: '(key)', description: '读全局变量' },
  { path: 'pm.globals.set', signature: '(key, value)', description: '写全局变量' },
  { path: 'pm.globals.unset', signature: '(key)', description: '删除全局变量' },
  { path: 'pm.globals.has', signature: '(key)', description: '全局变量是否存在' },
  { path: 'pm.globals.clear', signature: '()', description: '清空全局变量' },
  { path: 'pm.globals.toObject', signature: '()', description: '取全部全局变量（对象）' },
  { path: 'pm.variables.get', signature: '(key)', description: '按作用域链读变量' },
  { path: 'pm.variables.set', signature: '(key, value)', description: '写会话变量' },
  { path: 'pm.variables.unset', signature: '(key)', description: '删会话变量' },
  { path: 'pm.variables.has', signature: '(key)', description: '变量是否存在' },
  { path: 'pm.variables.clear', signature: '()', description: '清空会话变量' },
  { path: 'pm.variables.toObject', signature: '()', description: '取全部会话变量（对象）' },

  /* ---------------- 断言链（pm.response.to.have.* 等） ---------------- */
  { path: 'pm.response.to.have.status', signature: '(code)', description: '断言状态码' },
  { path: 'pm.response.to.have.header', signature: '(name, value?)', description: '断言响应头' },
  { path: 'pm.response.to.have.jsonBody', signature: '(path, value?)', description: '断言 JSON 里的字段' },
  { path: 'pm.response.to.have.body', signature: '(text)', description: '断言响应体包含某段文本' },
  { path: 'pm.response.to.be.json', signature: '()', description: '断言响应是合法 JSON' },
  { path: 'pm.response.to.be.ok', signature: '()', description: '断言值为真' },
  { path: 'pm.response.to.be.true', signature: '()', description: '断言值为 true' },
  { path: 'pm.response.to.be.false', signature: '()', description: '断言值为 false' },
  { path: 'pm.response.to.be.empty', signature: '()', description: '断言值为空' },
  { path: 'pm.response.to.be.a', signature: "(type)", description: '断言类型（如 "string"）' },
  { path: 'pm.response.to.be.an', signature: "(type)", description: '断言类型（同 a）' },
  { path: 'pm.response.to.equal', signature: '(value)', description: '严格相等' },
  { path: 'pm.response.to.eql', signature: '(value)', description: '深比较相等' },
  { path: 'pm.response.to.include', signature: '(item)', description: '包含（字符串/数组/对象）' },
  { path: 'pm.response.to.have.property', signature: '(name, value?)', description: '断言对象有某属性' },
  { path: 'pm.response.to.have.length', signature: '(n)', description: '断言长度' },
  { path: 'pm.response.to.have.above', signature: '(n)', description: '断言大于' },
  { path: 'pm.response.to.have.below', signature: '(n)', description: '断言小于' },
  { path: 'pm.response.to.have.oneOf', signature: '(list)', description: '断言在列表中' },
  { path: 'pm.response.to.match', signature: '(regex)', description: '断言匹配正则' },
];

/**
 * 常用请求头清单。
 *
 * 【为什么内置这些】
 * 用户每次都要手打 "Content-Type"、"Authorization" 这几个头，
 * 太机械。列出来让补全直接给。
 */
export const COMMON_HEADERS: { name: string; description: string }[] = [
  { name: 'Accept', description: '期望的响应类型' },
  { name: 'Accept-Encoding', description: '接受的编码（gzip, deflate, br）' },
  { name: 'Accept-Language', description: '语言偏好' },
  { name: 'Authorization', description: '认证凭据（Bearer / Basic）' },
  { name: 'Cache-Control', description: '缓存策略' },
  { name: 'Content-Type', description: '请求体类型' },
  { name: 'Cookie', description: 'Cookie 头' },
  { name: 'Idempotency-Key', description: '幂等键（防重复提交）' },
  { name: 'If-Modified-Since', description: '条件请求（基于修改时间）' },
  { name: 'If-None-Match', description: '条件请求（基于 ETag）' },
  { name: 'Origin', description: '请求来源站点' },
  { name: 'Referer', description: '引用的页面地址' },
  { name: 'User-Agent', description: '客户端标识' },
  { name: 'X-Api-Key', description: '自定义 API Key 头' },
  { name: 'X-Correlation-Id', description: '链路追踪 ID' },
  { name: 'X-Forwarded-For', description: '客户端真实 IP（代理场景）' },
  { name: 'X-Request-Id', description: '请求追踪 ID' },
  { name: 'X-Token', description: '自定义 Token 头' },
];

/** 常用 HTTP 方法（URL 输入框里可以补全） */
export const HTTP_METHODS: string[] = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'];
