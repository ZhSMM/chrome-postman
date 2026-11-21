/**
 * 补全候选数据源 Hook。
 *
 * 【在架构中的位置】
 * 把 store 里的状态（环境变量、集合变量、全局变量、历史记录）
 * 整理成补全引擎需要的 CompletionSources 结构。
 *
 * 【为什么要单独抽出来】
 * 补全引擎是纯函数，不知道 store 的存在。
 * 这个 Hook 就是中间的"翻译层"：store 状态 → 候选源。
 */
import { useMemo } from 'react';
import { useAppStore } from './store';
import { BUILTIN_VARIABLES } from '../core/variables';
import { PM_API_CATALOG, COMMON_HEADERS } from '../core/pm-api-catalog';
import type { CompletionSources, CompletionVariable, CompletionHistory } from '../core/completion';

export function useCompletionSources(): CompletionSources {
  const store = useAppStore();

  return useMemo(() => {
    /* ---------- 变量 ---------- */
    const variables: CompletionVariable[] = [];

    const env = store.environments.find((item) => item.id === store.activeEnvId);
    (env?.values ?? []).forEach((item) => {
      if (!item.enabled || !item.key) return;
      variables.push({ name: item.key, scope: 'environment', value: item.value });
    });

    const collection = store.collections.find((item) => item.id === store.currentRequest.collectionId);
    (collection?.variables ?? []).forEach((item) => {
      if (!item.enabled || !item.key) return;
      variables.push({ name: item.key, scope: 'collection', value: item.value });
    });

    Object.entries(store.globals ?? {}).forEach(([name, value]) => {
      variables.push({ name, scope: 'globals', value: String(value ?? '') });
    });

    /* ---------- 内置动态变量 ---------- */
    const builtins = BUILTIN_VARIABLES.map((item) => ({
      name: item.name,
      description: item.description,
      // 示例值现场算一次，让用户看到它大概是长什么样的
      preview: item.preview(),
    }));

    /* ---------- 历史 URL ---------- */
    // 同一个 URL 可能出现多次，这里合并成一条并累计使用次数
    const historyMap = new Map<string, CompletionHistory>();
    store.history.forEach((item) => {
      const url = item.request?.url ?? '';
      if (!url) return;
      const existing = historyMap.get(url);
      if (existing) {
        existing.useCount += 1;
        existing.lastUsed = Math.max(existing.lastUsed, item.timestamp);
      } else {
        historyMap.set(url, {
          url,
          method: item.request?.method ?? 'GET',
          lastUsed: item.timestamp,
          useCount: 1,
        });
      }
    });
    const history = Array.from(historyMap.values()).sort((a, b) => b.lastUsed - a.lastUsed);

    return {
      variables,
      builtins,
      apis: PM_API_CATALOG,
      headers: COMMON_HEADERS,
      history,
    };
  }, [
    store.environments,
    store.activeEnvId,
    store.collections,
    store.currentRequest.collectionId,
    store.globals,
    store.history,
  ]);
}
