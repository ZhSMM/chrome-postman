/**
 * ============================================================
 * 历史记录库（History Store）—— 基于 IndexedDB
 * ============================================================
 *
 * 【在架构中的位置】
 * 每发一次请求就落一条历史。历史里存着完整的请求快照 + 响应体。
 *
 * 【为什么不用 chrome.storage 存历史】
 *   - chrome.storage.local 默认配额 10MB（unlimitedStorage 可解除，但仍然不适合海量响应体）
 *   - IndexedDB 是浏览器原生数据库，能存二进制、大对象，还有索引
 *   - 历史天然是「只追加 + 按时间查」，正是 IndexedDB 的强项
 *
 * 【本模块的封装风格】
 * IndexedDB 原生 API 是回调式的，这里统一包成 Promise，
 * 调用方就能用 await，写起来跟普通 async 函数一样。
 */

import type { HistoryItem } from '../shared/types';

const DB_NAME = 'cp-history';
const DB_VERSION = 1;
const STORE_NAME = 'history';

/** 打开数据库连接（首次调用会创建库与对象仓库） */
function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        const store = db.createObjectStore(STORE_NAME, { keyPath: 'id' });
        // 按时间倒序查询用
        store.createIndex('timestamp', 'timestamp');
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

/** 在一个事务里执行操作 */
async function withStore<T>(
  mode: IDBTransactionMode,
  action: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  const db = await openDb();
  try {
    return await new Promise<T>((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, mode);
      const store = tx.objectStore(STORE_NAME);
      const request = action(store);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  } finally {
    db.close();
  }
}

/** 判断当前环境是否支持 IndexedDB（单元测试 / 隐私模式下可能没有） */
function hasIndexedDb(): boolean {
  return typeof indexedDB !== 'undefined';
}

/** 写入一条历史 */
export async function addHistory(item: HistoryItem): Promise<void> {
  if (!hasIndexedDb()) return;
  await withStore('readwrite', (store) => store.put(item));
}

/** 按时间倒序取历史 */
export async function listHistory(limit = 100): Promise<HistoryItem[]> {
  if (!hasIndexedDb()) return [];
  const items = await withStore<HistoryItem[]>('readonly', (store) => store.getAll());
  return items.sort((a, b) => b.timestamp - a.timestamp).slice(0, limit);
}

/** 取单条历史 */
export async function getHistory(id: string): Promise<HistoryItem | undefined> {
  if (!hasIndexedDb()) return undefined;
  return withStore<HistoryItem | undefined>('readonly', (store) => store.get(id));
}

/** 删除单条历史 */
export async function deleteHistory(id: string): Promise<void> {
  if (!hasIndexedDb()) return;
  await withStore('readwrite', (store) => store.delete(id));
}

/** 清空历史 */
export async function clearHistory(): Promise<void> {
  if (!hasIndexedDb()) return;
  await withStore('readwrite', (store) => store.clear());
}

/**
 * 裁剪历史，只保留最近 limit 条。
 * 在每次写入后调用，避免历史无限增长。
 */
export async function pruneHistory(limit = 200): Promise<void> {
  if (!hasIndexedDb()) return;
  const items = await withStore<HistoryItem[]>('readonly', (store) => store.getAll());
  if (items.length <= limit) return;

  const sorted = items.sort((a, b) => b.timestamp - a.timestamp);
  const toDelete = sorted.slice(limit);

  const db = await openDb();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      const store = tx.objectStore(STORE_NAME);
      toDelete.forEach((item) => store.delete(item.id));
      // 注意：多个 delete 属于同一个事务，事务完成才算全部删成功
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  } finally {
    db.close();
  }
}
