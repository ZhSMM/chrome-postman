/**
 * ============================================================
 * 变量引擎（Variable Engine）
 * ============================================================
 *
 * 【在架构中的位置】
 * 位于"UI → 后台执行器"之间的第一道工序。任何字符串（URL / Header / Body /
 * Query / 鉴权）在真正使用前，都要先经过这里把 {{占位符}} 替换成真实值。
 *
 * 【核心概念】
 * 变量作用域（scope）共 4 层，优先级从高到低：
 *   1. environment  环境变量 —— 针对不同服务器（dev/test/prod）切换
 *   2. collection   集合变量 —— 某个集合内共享
 *   3. globals      全局变量 —— 所有环境共享
 *   4. session      会话变量 —— 脚本运行时临时产生，不落盘
 *
 * 另外还有一层「内置动态变量」，用 $ 开头，例如 {{$timestamp}}。
 * 它不是"存储"出来的，而是每次求值时现场生成。
 *
 * 【为什么需要这套东西】
 * 真实项目中 URL、Token、域名天天变。如果把它们写死在请求里，
 * 切换环境就要手动改一堆地方。变量引擎把"易变的部分"抽出来，
 * 只在一处（环境管理面板）维护。
 */

import type { VariableScope } from '../shared/types';

/** 插值结果：替换后的文本 + 没能解析出来的变量名列表 */
export interface InterpolateResult {
  text: string;
  /** 未定义（任何作用域都找不到）的变量名，UI 会高亮提示 */
  missing: string[];
}

/**
 * 变量占位符的匹配规则。
 *
 * 【为什么要导出成常量】
 * 变量引擎（interpolate）和变量检查器（variable-lint）必须用**同一套**规则，
 * 否则会出现"引擎认为能解析、UI 认为没定义"这类矛盾 bug。
 * 所以正则只在这里定义一次，其他地方引用。
 *
 * 规则说明：
 * - 占位符内允许空格：{{ host }} 等价于 {{host}}
 * - 不允许嵌套大括号：{{{a}}} 不会被匹配
 */
export const VARIABLE_PATTERN = /\{\{\s*([^{}]+?)\s*\}\}/g;

/**
 * 内置动态变量的描述信息。
 *
 * 【为什么用数组而不是原来的 Record】
 * 补全功能需要知道每个内置变量的名字**和说明**（要显示给用户看），
 * 原来的 `Record<string, () => string>` 只有函数，说不了明。
 * 所以改成数组作为单一事实源，再由它生成工厂表。
 */
export interface BuiltinVariable {
  /** 变量名，带 $ 前缀 */
  name: string;
  /** 中文说明 */
  description: string;
  /** 生成示例值（补全时预览给用户看） */
  preview: () => string;
}

/**
 * 内置动态变量清单。
 * 用函数而不是常量，因为动态变量的值必须"每次求值都不同"
 * （比如 {{$randomInt}} 每次都该给新值）。
 */
export const BUILTIN_VARIABLES: BuiltinVariable[] = [
  /** Unix 时间戳（秒） */
  { name: '$timestamp', description: 'Unix 时间戳（秒）', preview: () => String(Math.floor(Date.now() / 1000)) },
  /** ISO 8601 时间字符串 */
  { name: '$isoTimestamp', description: 'ISO 8601 时间字符串', preview: () => new Date().toISOString() },
  /** UUID v4 */
  { name: '$uuid', description: 'UUID v4', preview: () => generateUuid() },
  /** UUID v4（Postman 老名字） */
  { name: '$guid', description: 'UUID v4（Postman 老名字）', preview: () => generateUuid() },
  /** 0~1000 的随机整数 */
  { name: '$randomInt', description: '0~1000 的随机整数', preview: () => String(Math.floor(Math.random() * 1001)) },
];

/** 变量名 → 取值函数 */
const dynamicFactories: Record<string, () => string> = Object.fromEntries(
  BUILTIN_VARIABLES.map((item) => [item.name, item.preview]),
);

/**
 * 判断一个变量名是否是内置动态变量。
 *
 * 为什么单独提供这个函数：UI 的补全列表和变量检查器都需要
 * 判断"这个名字是不是内置变量"，但 dynamicFactories 是私有的。
 */
export function hasBuiltinVariable(name: string): boolean {
  return Object.prototype.hasOwnProperty.call(dynamicFactories, name.trim());
}

/** 生成 UUID v4（优先用浏览器原生 API） */
export function generateUuid(): string {
  const cryptoObj = globalThis.crypto;
  if (cryptoObj && typeof cryptoObj.randomUUID === 'function') return cryptoObj.randomUUID();
  // 兜底：手写随机实现
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

/**
 * 查找一个变量。
 * @param name 变量名（不含大括号）
 * @returns 变量值；找不到返回 undefined
 */
export function lookupVariable(name: string, scope: VariableScope): string | undefined {
  const key = name.trim();
  // 1. 环境
  if (Object.prototype.hasOwnProperty.call(scope.environment, key)) return scope.environment[key];
  // 2. 集合
  if (Object.prototype.hasOwnProperty.call(scope.collection, key)) return scope.collection[key];
  // 3. 全局
  if (Object.prototype.hasOwnProperty.call(scope.globals, key)) return scope.globals[key];
  // 4. 会话
  if (Object.prototype.hasOwnProperty.call(scope.session, key)) return scope.session[key];
  // 5. 内置动态变量
  const factory = dynamicFactories[key];
  if (factory) return factory();
  return undefined;
}

/**
 * 把字符串里的 {{var}} 全部替换成真实值。
 *
 * 规则：
 * - 占位符内允许空格：{{ host }} 等价于 {{host}}
 * - 找不到的变量 **原样保留**（不替换成空串）。
 *   原因：空串会导致请求 URL 变成 `https://api./v1` 这种诡异形态，
 *   保留原样能让用户一眼看出"这个变量没配"。
 * - 支持一个字符串里出现多个占位符。
 */
export function interpolate(input: string, scope: VariableScope): InterpolateResult {
  if (!input || input.indexOf('{{') === -1) return { text: input ?? '', missing: [] };

  const missing: string[] = [];
  // 用共享的 VARIABLE_PATTERN，但这里需要独立的 lastIndex 状态，
  // 所以用 String.replace 传入一个全新的正则实例（replace 内部会重置 lastIndex）。
  const text = input.replace(new RegExp(VARIABLE_PATTERN.source, 'g'), (match, rawName: string) => {
    const name = rawName.trim();
    const value = lookupVariable(name, scope);
    if (value === undefined) {
      if (!missing.includes(name)) missing.push(name);
      return match;
    }
    return value;
  });

  return { text, missing };
}

/** 只要替换结果，不要 missing 列表（内部便捷方法） */
export function interpolateText(input: string, scope: VariableScope): string {
  return interpolate(input, scope).text;
}

/**
 * 把 KeyValue[] 转成普通对象（只取 enabled 的行）。
 * 注意：空 key 的行会被跳过，因为它们通常是用户还没填完的半成品。
 */
export function keyValuesToRecord(list: { key: string; value: string; enabled: boolean }[]): Record<string, string> {
  const record: Record<string, string> = {};
  list.forEach((item) => {
    if (!item.enabled) return;
    const key = (item.key ?? '').trim();
    if (!key) return;
    record[key] = item.value ?? '';
  });
  return record;
}

/** 把普通对象转回 KeyValue[]（用于回填 UI） */
export function recordToKeyValues(record: Record<string, string>): { key: string; value: string; enabled: boolean }[] {
  return Object.entries(record).map(([key, value]) => ({ key, value, enabled: true }));
}

/**
 * 合并两个变量作用域（后者覆盖前者）。
 * 用于脚本执行后把新写入的变量合并回原有作用域。
 */
export function mergeScopes(base: VariableScope, patch: Partial<VariableScope>): VariableScope {
  return {
    environment: { ...base.environment, ...(patch.environment ?? {}) },
    collection: { ...base.collection, ...(patch.collection ?? {}) },
    globals: { ...base.globals, ...(patch.globals ?? {}) },
    session: { ...base.session, ...(patch.session ?? {}) },
  };
}

/** 创建一个空的变量作用域 */
export function emptyScope(): VariableScope {
  return { environment: {}, collection: {}, globals: {}, session: {} };
}
