/**
 * ============================================================
 * 存储层（Storage）—— 基于 chrome.storage.local
 * ============================================================
 *
 * 【在架构中的位置】
 * UI 与 Service Worker 都能直接访问 chrome.storage.local，
 * 所以「集合 / 环境 / 设置」这类配置数据**不需要绕道后台**，
 * 两边各自读写同一份数据即可。
 *
 * 【为什么用 chrome.storage 而不是 localStorage】
 *   - 扩展页面刷新后 localStorage 会保留，但 Service Worker 里拿不到 localStorage
 *   - chrome.storage 是跨上下文共享的（页面 ↔ SW），且自带变更事件
 *   - unlimitedStorage 权限可以突破 localStorage 5MB / storage.local 10MB 的限制
 *
 * 【数据量考虑】
 *   集合 / 环境 / 设置  → chrome.storage.local（结构化 JSON）
 *   历史记录（含响应体） → IndexedDB（见 db.ts），因为响应体可能很大
 */

import {
  DEFAULT_SETTINGS,
  STORAGE_KEYS,
  type Collection,
  type Environment,
  type Folder,
  type HttpRequest,
  type KeyValue,
  type Settings,
} from '../shared/types';

/** 判断当前环境是否有 chrome.storage（单元测试里没有） */
function hasChromeStorage(): boolean {
  return typeof chrome !== 'undefined' && !!chrome.storage && !!chrome.storage.local;
}

/**
 * 通用读取。
 * @param key storage key
 * @param fallback 读不到时的默认值
 */
export async function readStore<T>(key: string, fallback: T): Promise<T> {
  if (!hasChromeStorage()) return fallback;
  try {
    const result = await chrome.storage.local.get(key);
    const value = result?.[key];
    return (value === undefined ? fallback : value) as T;
  } catch (err) {
    console.error('[storage] 读取失败', key, err);
    return fallback;
  }
}

/** 通用写入 */
export async function writeStore<T>(key: string, value: T): Promise<void> {
  if (!hasChromeStorage()) return;
  try {
    await chrome.storage.local.set({ [key]: value });
  } catch (err) {
    console.error('[storage] 写入失败', key, err);
  }
}

/* ------------------------------------------------------------------
 * 集合 / 文件夹 / 请求
 * ---------------------------------------------------------------- */

export const getCollections = () => readStore<Collection[]>(STORAGE_KEYS.collections, []);
export const saveCollections = (list: Collection[]) => writeStore(STORAGE_KEYS.collections, list);

export const getFolders = () => readStore<Folder[]>(STORAGE_KEYS.folders, []);
export const saveFolders = (list: Folder[]) => writeStore(STORAGE_KEYS.folders, list);

export const getRequests = () => readStore<HttpRequest[]>(STORAGE_KEYS.requests, []);
export const saveRequests = (list: HttpRequest[]) => writeStore(STORAGE_KEYS.requests, list);

/* ------------------------------------------------------------------
 * 环境
 * ---------------------------------------------------------------- */

export const getEnvironments = () => readStore<Environment[]>(STORAGE_KEYS.environments, []);
export const saveEnvironments = (list: Environment[]) => writeStore(STORAGE_KEYS.environments, list);

/** 当前激活的环境 id（null 表示没有激活环境） */
export async function getActiveEnvironmentId(): Promise<string | null> {
  return readStore<string | null>(STORAGE_KEYS.activeEnvironmentId, null);
}

export async function setActiveEnvironmentId(id: string | null): Promise<void> {
  await writeStore(STORAGE_KEYS.activeEnvironmentId, id);
}

/* ------------------------------------------------------------------
 * 变量（全局 / 会话）
 * ---------------------------------------------------------------- */

/** 全局变量（跨环境共享） */
export const getGlobals = () => readStore<Record<string, string>>(STORAGE_KEYS.globals, {});

/** 把 KeyValue[] 数组转成普通对象（跳过未启用项） */
export function keyValuesToRecord(list: KeyValue[] = []): Record<string, string> {
  const record: Record<string, string> = {};
  list.forEach((item) => {
    if (!item?.enabled) return;
    const key = (item.key ?? '').trim();
    if (!key) return;
    record[key] = item.value ?? '';
  });
  return record;
}

/** 把普通对象转成 KeyValue[]（用于回填 UI 表格） */
export function recordToKeyValues(record: Record<string, string> = {}): KeyValue[] {
  return Object.entries(record).map(([key, value]) => ({
    id: `kv_${key}_${Math.random().toString(36).slice(2, 8)}`,
    key,
    value,
    enabled: true,
  }));
}

/**
 * 写入变量。
 * @param scope 'environment' | 'globals' | 'session'
 * @param record 要写入的键值
 */
export async function setVariables(
  scope: 'environment' | 'globals' | 'session',
  record: Record<string, string>,
): Promise<void> {
  if (!record || !Object.keys(record).length) return;
  if (scope === 'globals') {
    const globals = await getGlobals();
    await writeStore(STORAGE_KEYS.globals, { ...globals, ...record });
    return;
  }
  if (scope === 'environment') {
    const envId = await getActiveEnvironmentId();
    if (!envId) return;
    const list = await getEnvironments();
    const env = list.find((item) => item.id === envId);
    if (!env) return;
    const values = keyValuesToRecord(env.values);
    env.values = recordToKeyValues({ ...values, ...record });
    env.updatedAt = Date.now();
    await saveEnvironments(list);
    return;
  }
  // session 作用域存在内存里（Service Worker 生命周期内），见 request-executor
}

/* ------------------------------------------------------------------
 * 设置
 * ---------------------------------------------------------------- */

export async function getSettings(): Promise<Settings> {
  const stored = await readStore<Partial<Settings>>(STORAGE_KEYS.settings, {});
  return { ...DEFAULT_SETTINGS, ...stored };
}

export async function saveSettings(settings: Settings): Promise<void> {
  await writeStore(STORAGE_KEYS.settings, settings);
}

/* ------------------------------------------------------------------
 * 导入 / 导出（整份工作区）
 * ---------------------------------------------------------------- */

/** 工作区快照：用于导入导出与备份 */
export interface WorkspaceSnapshot {
  version: 1;
  exportedAt: number;
  collections: Collection[];
  folders: Folder[];
  requests: HttpRequest[];
  environments: Environment[];
  activeEnvironmentId: string | null;
  globals: Record<string, string>;
}

/** 导出整份工作区 */
export async function exportWorkspace(): Promise<WorkspaceSnapshot> {
  const [collections, folders, requests, environments, activeEnvironmentId, globals] = await Promise.all([
    getCollections(),
    getFolders(),
    getRequests(),
    getEnvironments(),
    getActiveEnvironmentId(),
    getGlobals(),
  ]);
  return { version: 1, exportedAt: Date.now(), collections, folders, requests, environments, activeEnvironmentId, globals };
}

/**
 * 导入工作区。
 * @param mode 'merge' 合并（同名按 id 覆盖）| 'replace' 整体替换
 */
export async function importWorkspace(
  snapshot: Partial<WorkspaceSnapshot>,
  mode: 'merge' | 'replace' = 'merge',
): Promise<void> {
  if (mode === 'replace') {
    await saveCollections(snapshot.collections ?? []);
    await saveFolders(snapshot.folders ?? []);
    await saveRequests(snapshot.requests ?? []);
    await saveEnvironments(snapshot.environments ?? []);
    if (snapshot.activeEnvironmentId !== undefined) {
      await setActiveEnvironmentId(snapshot.activeEnvironmentId ?? null);
    }
    if (snapshot.globals) await writeStore(STORAGE_KEYS.globals, snapshot.globals);
    return;
  }

  const mergeById = <T extends { id: string }>(oldList: T[], newList: T[] = []): T[] => {
    const map = new Map(oldList.map((item) => [item.id, item]));
    newList.forEach((item) => map.set(item.id, item));
    return Array.from(map.values());
  };

  const [collections, folders, requests, environments] = await Promise.all([
    getCollections(),
    getFolders(),
    getRequests(),
    getEnvironments(),
  ]);

  await saveCollections(mergeById(collections, snapshot.collections));
  await saveFolders(mergeById(folders, snapshot.folders));
  await saveRequests(mergeById(requests, snapshot.requests));
  await saveEnvironments(mergeById(environments, snapshot.environments));
  if (snapshot.activeEnvironmentId) await setActiveEnvironmentId(snapshot.activeEnvironmentId);
}
