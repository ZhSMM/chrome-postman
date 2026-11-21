/**
 * ============================================================
 * 变量引用检查器（Variable Lint）
 * ============================================================
 *
 * 【在架构中的位置】
 * 位于"UI 编辑器"与"变量引擎"之间。UI 在用户输入时调用本模块，
 * 找出文本里所有的 {{变量}} 占位符，并判断它们是否有值。
 *
 * 【它解决的核心问题】
 * 变量引擎（variables.ts）的 interpolate() 在发送请求时才会算出
 * "哪些变量没解析出来"（missing 字段）。但那个时机太晚了 ——
 * 用户已经把请求发出去了，才知道变量名写错了。
 *
 * 本模块把同一套解析规则抽出来，让 UI 在**输入时**就能告诉用户：
 *   "你写的 {{host}} 在任何作用域里都不存在"。
 *
 * 【为什么要和 variables.ts 共用同一个正则】
 * 如果这里写一套正则、那里写另一套，迟早会出现
 * "引擎认为能解析、UI 认为不能"（或反过来）的诡异 bug。
 * 所以正则定义在 variables.ts 里，本模块直接引用。
 */

import type { VariableScope } from '../shared/types';
import { VARIABLE_PATTERN, lookupVariable, hasBuiltinVariable } from './variables';

/** 变量来源作用域 */
export type VariableScopeName = 'environment' | 'collection' | 'globals' | 'session' | 'builtin';

/** 文本里的一个 {{变量}} 引用 */
export interface VariableRef {
  /** 变量名（不含大括号，已 trim） */
  name: string;
  /** 在原文中的起始位置 */
  index: number;
  /** 整段占位符的长度（含两个大括号） */
  length: number;
  /** 是否能解析出值 */
  defined: boolean;
  /** 解析出的值（未定义时为 undefined） */
  value?: string;
  /** 值来自哪个作用域 */
  scope?: VariableScopeName;
}

/**
 * 提取文本里所有的 {{变量}} 引用。
 *
 * 【为什么不用简单的字符串查找】
 * 因为占位符里可以有空格（{{ host }} 等价于 {{host}}），
 * 而且同一个变量可能出现多次 —— 每个出现位置都要单独报出来，
 * 这样 UI 才能精确高亮/定位。
 *
 * @param text 任意文本（URL / Header 值 / Body 等）
 * @returns 引用列表，按出现顺序
 */
export function extractVariableRefs(text: string): VariableRef[] {
  if (!text || text.indexOf('{{') === -1) return [];

  const refs: VariableRef[] = [];
  // 用同一个正则，但要拿到 match.index，所以这里手动 new 一个
  const pattern = new RegExp(VARIABLE_PATTERN.source, 'g');
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text)) !== null) {
    const name = match[1].trim();
    refs.push({
      name,
      index: match.index,
      length: match[0].length,
      defined: false,
    });
  }
  return refs;
}

/**
 * 判断一个变量名来自哪个作用域。
 *
 * 【优先级】
 * 与变量引擎 lookupVariable 完全一致：环境 > 集合 > 全局 > 会话 > 内置。
 * 这里单独实现一次，是为了让 UI 能显示"这个值来自哪一层"，
 * 帮用户知道该去哪里改。
 */
export function resolveScopeOf(name: string, scope: VariableScope): VariableScopeName | undefined {
  const key = name.trim();
  if (!key) return undefined;
  if (Object.prototype.hasOwnProperty.call(scope.environment, key)) return 'environment';
  if (Object.prototype.hasOwnProperty.call(scope.collection, key)) return 'collection';
  if (Object.prototype.hasOwnProperty.call(scope.globals, key)) return 'globals';
  if (Object.prototype.hasOwnProperty.call(scope.session, key)) return 'session';
  if (hasBuiltinVariable(key)) return 'builtin';
  return undefined;
}

/**
 * 检查文本里的变量引用，把"能不能解析出来"填进结果。
 *
 * @param text 待检查文本
 * @param scope 当前生效的变量作用域
 */
export function lintVariables(text: string, scope: VariableScope): VariableRef[] {
  const refs = extractVariableRefs(text);
  for (const ref of refs) {
    const value = lookupVariable(ref.name, scope);
    if (value === undefined) {
      ref.defined = false;
      continue;
    }
    ref.defined = true;
    ref.value = value;
    ref.scope = resolveScopeOf(ref.name, scope);
  }
  return refs;
}

/**
 * 汇总一段文本里"没定义"的变量名（去重）。
 *
 * 【为什么不直接用 interpolate().missing】
 * interpolate 只给出名字，不给位置，也不区分"定义在哪个作用域"。
 * UI 需要的是位置信息（用于高亮）和作用域信息（用于提示去哪改）。
 */
export function collectMissing(text: string, scope: VariableScope): VariableRef[] {
  const seen = new Set<string>();
  const result: VariableRef[] = [];
  for (const ref of lintVariables(text, scope)) {
    if (ref.defined) continue;
    if (seen.has(ref.name)) continue;
    seen.add(ref.name);
    result.push(ref);
  }
  return result;
}

/**
 * 汇总一个请求里所有没定义的变量。
 *
 * 【检查哪些地方】
 * URL、Query 参数、Header、Body（raw + form + formData）、鉴权字段。
 * 少查一处，用户就可能在那个地方踩坑，所以宁可多查。
 */
export function collectRequestMissing(
  request: {
    url?: string;
    params?: { key: string; value: string; enabled: boolean }[];
    headers?: { key: string; value: string; enabled: boolean }[];
    body?: { raw?: string; form?: { key: string; value: string }[]; formData?: { key: string; value: string }[] };
    auth?: Record<string, string | undefined>;
  },
  scope: VariableScope,
): VariableRef[] {
  const seen = new Set<string>();
  const result: VariableRef[] = [];

  const add = (text: string | undefined) => {
    if (!text) return;
    for (const ref of collectMissing(text, scope)) {
      if (seen.has(ref.name)) continue;
      seen.add(ref.name);
      result.push(ref);
    }
  };

  add(request.url);
  (request.params ?? []).forEach((item) => {
    add(item.key);
    add(item.value);
  });
  (request.headers ?? []).forEach((item) => {
    add(item.key);
    add(item.value);
  });
  add(request.body?.raw);
  (request.body?.form ?? []).forEach((item) => {
    add(item.key);
    add(item.value);
  });
  (request.body?.formData ?? []).forEach((item) => {
    add(item.key);
    add(item.value);
  });
  Object.values(request.auth ?? {}).forEach((value) => {
    if (typeof value === 'string') add(value);
  });

  return result;
}

/**
 * 列出"与给定名字同前缀/相似"的候选变量，供 UI 做一键补全。
 *
 * 【为什么按相似度而不是精确匹配】
 * 用户拼错变量名时（比如写成 {{hosst}}），精确匹配一个候选都找不到。
 * 给出相近的候选，用户一眼就能看出自己少打/多打了一个字母。
 *
 * @param name 用户写下的变量名
 * @param scope 当前作用域
 * @param limit 最多返回几个
 */
export function suggestVariables(name: string, scope: VariableScope, limit = 8): VariableRef[] {
  const target = name.trim().toLowerCase();
  const all: VariableRef[] = [];

  const push = (varName: string, scopeName: VariableScopeName) => {
    if (!varName) return;
    all.push({
      name: varName,
      index: 0,
      length: varName.length,
      defined: true,
      value: lookupVariable(varName, scope),
      scope: scopeName,
    });
  };

  Object.keys(scope.environment ?? {}).forEach((k) => push(k, 'environment'));
  Object.keys(scope.collection ?? {}).forEach((k) => push(k, 'collection'));
  Object.keys(scope.globals ?? {}).forEach((k) => push(k, 'globals'));
  Object.keys(scope.session ?? {}).forEach((k) => push(k, 'session'));

  if (!target) return all.slice(0, limit);

  // 打分：前缀匹配 > 包含匹配 > 首个字符相同
  const scored = all
    .map((item) => {
      const lower = item.name.toLowerCase();
      let score = 0;
      if (lower === target) score = 100;
      else if (lower.startsWith(target)) score = 80;
      else if (lower.includes(target)) score = 50;
      else if (target.length > 1 && lower.startsWith(target[0])) score = 20;
      return { item, score };
    })
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score || a.item.name.localeCompare(b.item.name));

  return scored.slice(0, limit).map((entry) => entry.item);
}
