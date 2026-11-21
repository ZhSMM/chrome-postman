/**
 * 全局状态仓库（Zustand）。
 *
 * 【为什么用 Zustand 而不是 Redux】
 * Redux 需要写 action / reducer / dispatch 一整套样板代码。
 * Zustand ���用 hooks 风格，几十行就能管理一份全局状态，
 * 适合这种"多个组件共享一份数据"的工具型应用。
 *
 * 【状态分层】
 *   - 持久数据（集合/环境/设置）：存 chrome.storage.local，页面刷新后还在
 *   - 运行数据（当前请求/响应/历史）：内存态，刷新即丢（历史另有 IndexedDB 兜底）
 */
import { create } from 'zustand';
import {
  DEFAULT_SETTINGS,
  emptyAuth,
  emptyBody,
  type Collection,
  type DiagnosticReport,
  type Environment,
  type ExecutionResult,
  type Folder,
  type HistoryItem,
  type HttpRequest,
  type KeyValue,
  type ScriptOutcome,
  type Settings,
} from '../shared/types';
import {
  exportWorkspace,
  getActiveEnvironmentId,
  getCollections,
  getEnvironments,
  getFolders,
  getGlobals,
  getRequests,
  getSettings,
  importWorkspace,
  recordToKeyValues,
  saveCollections,
  saveEnvironments,
  saveFolders,
  saveRequests,
  saveSettings,
  setActiveEnvironmentId,
} from '../core/storage';
import { clearHistory, listHistory } from '../core/db';
import { sendRequestToWorker } from './api';
import { uid } from '../shared/utils';

/** 提示条 */
export interface Toast {
  id: string;
  message: string;
  kind: 'info' | 'error' | 'success';
}

/** 创建一个空白请求草稿 */
export function createEmptyRequest(): HttpRequest {
  const now = Date.now();
  return {
    id: uid('req'),
    name: '新建请求',
    method: 'GET',
    url: '',
    params: [],
    headers: [],
    body: emptyBody(),
    auth: emptyAuth(),
    preScript: '',
    postScript: '',
    createdAt: now,
    updatedAt: now,
  };
}

interface AppState {
  /* ---------- 持久数据 ---------- */
  collections: Collection[];
  folders: Folder[];
  requests: HttpRequest[];
  environments: Environment[];
  activeEnvId: string | null;
  globals: Record<string, string>;
  settings: Settings;

  /* ---------- 运行数据 ---------- */
  currentRequest: HttpRequest;
  /** 当前请求是否已保存到集合里 */
  currentSaved: boolean;
  response: ExecutionResult['response'];
  outcome: ScriptOutcome | null;
  /** 最近一次失败的网络诊断报告 */
  diagnostic: DiagnosticReport | null;
  sending: boolean;
  history: HistoryItem[];
  toasts: Toast[];
  /** 侧边栏当前视图 */
  sidebarView: 'collections' | 'history';

  /* ---------- 动作 ---------- */
  bootstrap: () => Promise<void>;
  setCurrentRequest: (request: HttpRequest, saved?: boolean) => void;
  patchCurrentRequest: (patch: Partial<HttpRequest>) => void;
  createNewRequest: () => void;
  saveCurrentRequest: (collectionId?: string, folderId?: string | null) => Promise<void>;
  deleteRequest: (id: string) => Promise<void>;

  createCollection: (name: string) => Promise<void>;
  renameCollection: (id: string, name: string) => Promise<void>;
  deleteCollection: (id: string) => Promise<void>;
  createFolder: (collectionId: string, name: string) => Promise<void>;
  deleteFolder: (id: string) => Promise<void>;

  createEnvironment: (name: string) => Promise<void>;
  updateEnvironment: (id: string, patch: Partial<Environment>) => Promise<void>;
  deleteEnvironment: (id: string) => Promise<void>;
  setActiveEnvironment: (id: string | null) => Promise<void>;

  send: () => Promise<void>;
  refreshHistory: () => Promise<void>;
  clearHistoryRecords: () => Promise<void>;
  loadHistoryIntoEditor: (item: HistoryItem) => void;

  exportAll: () => Promise<void>;
  importAll: (file: File) => Promise<void>;

  pushToast: (message: string, kind?: Toast['kind']) => void;
  dismissToast: (id: string) => void;
  setSidebarView: (view: 'collections' | 'history') => void;
  updateSettings: (patch: Partial<Settings>) => Promise<void>;
}

export const useAppStore = create<AppState>((set, get) => ({
  collections: [],
  folders: [],
  requests: [],
  environments: [],
  activeEnvId: null,
  globals: {},
  settings: DEFAULT_SETTINGS,

  currentRequest: createEmptyRequest(),
  currentSaved: false,
  response: null,
  outcome: null,
  diagnostic: null,
  sending: false,
  history: [],
  toasts: [],
  sidebarView: 'collections',

  /** 启动时把 chrome.storage 里的数据全部读进来 */
  async bootstrap() {
    const [collections, folders, requests, environments, activeEnvId, globals, settings, history] =
      await Promise.all([
        getCollections(),
        getFolders(),
        getRequests(),
        getEnvironments(),
        getActiveEnvironmentId(),
        getGlobals(),
        getSettings(),
        listHistory(100),
      ]);

    set({ collections, folders, requests, environments, activeEnvId, globals, settings, history });

    // 右键菜单带过来的 URL
    const pending = await chrome.storage.local.get('cp.pendingUrl');
    const pendingUrl = pending?.['cp.pendingUrl'] as string | undefined;
    if (pendingUrl) {
      await chrome.storage.local.remove('cp.pendingUrl');
      get().patchCurrentRequest({ url: pendingUrl, name: pendingUrl });
    }
  },

  setCurrentRequest(request, saved = true) {
    set({ currentRequest: { ...request }, currentSaved: saved });
  },

  patchCurrentRequest(patch) {
    set((state) => ({ currentRequest: { ...state.currentRequest, ...patch } }));
  },

  createNewRequest() {
    set({ currentRequest: createEmptyRequest(), currentSaved: false, response: null, outcome: null });
  },

  /** 保存当前请求到集合 */
  async saveCurrentRequest(collectionId, folderId = null) {
    const { currentRequest, currentSaved, requests } = get();
    const targetCollection = collectionId ?? currentRequest.collectionId ?? get().collections[0]?.id;
    if (!targetCollection) {
      get().pushToast('请先创建一个集合', 'error');
      return;
    }

    const now = Date.now();
    const next: HttpRequest = {
      ...currentRequest,
      collectionId: targetCollection,
      folderId: folderId === undefined ? currentRequest.folderId ?? null : folderId,
      updatedAt: now,
    };

    let list: HttpRequest[];
    if (currentSaved && requests.some((item) => item.id === next.id)) {
      list = requests.map((item) => (item.id === next.id ? next : item));
    } else {
      list = [...requests, next];
    }
    await saveRequests(list);
    set({ requests: list, currentRequest: next, currentSaved: true });
    get().pushToast('请求已保存', 'success');
  },

  async deleteRequest(id) {
    const list = get().requests.filter((item) => item.id !== id);
    await saveRequests(list);
    set({ requests: list });
  },

  async createCollection(name) {
    const now = Date.now();
    const collection: Collection = {
      id: uid('col'),
      name,
      variables: [],
      createdAt: now,
      updatedAt: now,
    };
    const list = [...get().collections, collection];
    await saveCollections(list);
    set({ collections: list });
  },

  async renameCollection(id, name) {
    const list = get().collections.map((item) => (item.id === id ? { ...item, name, updatedAt: Date.now() } : item));
    await saveCollections(list);
    set({ collections: list });
  },

  async deleteCollection(id) {
    const collections = get().collections.filter((item) => item.id !== id);
    const folders = get().folders.filter((item) => item.collectionId !== id);
    const requestIds = new Set(get().requests.filter((r) => r.collectionId === id).map((r) => r.id));
    const requests = get().requests.filter((item) => !requestIds.has(item.id));
    await Promise.all([saveCollections(collections), saveFolders(folders), saveRequests(requests)]);
    set({ collections, folders, requests });
  },

  async createFolder(collectionId, name) {
    const folder: Folder = {
      id: uid('fold'),
      name,
      collectionId,
      parentId: null,
      createdAt: Date.now(),
    };
    const list = [...get().folders, folder];
    await saveFolders(list);
    set({ folders: list });
  },

  async deleteFolder(id) {
    const list = get().folders.filter((item) => item.id !== id);
    const requests = get().requests.map((item) =>
      item.folderId === id ? { ...item, folderId: null } : item,
    );
    await Promise.all([saveFolders(list), saveRequests(requests)]);
    set({ folders: list, requests });
  },

  async createEnvironment(name) {
    const now = Date.now();
    const env: Environment = { id: uid('env'), name, values: [], createdAt: now, updatedAt: now };
    const list = [...get().environments, env];
    await saveEnvironments(list);
    set({ environments: list });
  },

  async updateEnvironment(id, patch) {
    const list = get().environments.map((item) =>
      item.id === id ? { ...item, ...patch, updatedAt: Date.now() } : item,
    );
    await saveEnvironments(list);
    set({ environments: list });
  },

  async deleteEnvironment(id) {
    const list = get().environments.filter((item) => item.id !== id);
    await saveEnvironments(list);
    set({ environments: list });
    if (get().activeEnvId === id) await get().setActiveEnvironment(null);
  },

  async setActiveEnvironment(id) {
    await setActiveEnvironmentId(id);
    set({ activeEnvId: id });
  },

  /** 发送当前请求 */
  async send() {
    const { currentRequest, sending } = get();
    if (sending) return;
    set({ sending: true, response: null, outcome: null, diagnostic: null });

    try {
      const result = await sendRequestToWorker(currentRequest);
      set({ response: result.response, outcome: result.outcome, diagnostic: result.diagnostic ?? null });
      if (result.error) {
        get().pushToast(result.error, 'error');
      } else {
        const passed = result.outcome.tests.filter((t) => t.passed).length;
        const failed = result.outcome.tests.length - passed;
        get().pushToast(
          failed ? `完成，${failed} 条断言失败` : '请求完成',
          failed ? 'error' : 'success',
        );
      }
      await get().refreshHistory();
    } catch (err) {
      get().pushToast((err as Error).message ?? '请求失败', 'error');
    } finally {
      set({ sending: false });
    }
  },

  async refreshHistory() {
    const history = await listHistory(100);
    set({ history });
  },

  async clearHistoryRecords() {
    await clearHistory();
    set({ history: [] });
  },

  /** 把一条历史请求载入编辑器 */
  loadHistoryIntoEditor(item) {
    set({
      currentRequest: { ...item.request },
      currentSaved: false,
      response: item.response,
      outcome: { variables: { environment: {}, globals: {}, session: {} }, tests: item.tests, logs: item.logs },
    });
  },

  /** 导出整份工作区为 JSON 文件 */
  async exportAll() {
    const snapshot = await exportWorkspace();
    const blob = new Blob([JSON.stringify(snapshot, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `chrome-postman-workspace-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(url);
    get().pushToast('已导出工作区', 'success');
  },

  /** 从 JSON 文件导入工作区 */
  async importAll(file) {
    try {
      const text = await file.text();
      const snapshot = JSON.parse(text);
      await importWorkspace(snapshot, 'merge');
      await get().bootstrap();
      get().pushToast('导入成功', 'success');
    } catch (err) {
      get().pushToast(`导入失败：${(err as Error).message}`, 'error');
    }
  },

  pushToast(message, kind = 'info') {
    const toast: Toast = { id: uid('toast'), message, kind };
    set((state) => ({ toasts: [...state.toasts, toast] }));
    setTimeout(() => get().dismissToast(toast.id), kind === 'error' ? 8000 : 3000);
  },

  dismissToast(id) {
    set((state) => ({ toasts: state.toasts.filter((item) => item.id !== id) }));
  },

  setSidebarView(view) {
    set({ sidebarView: view });
  },

  async updateSettings(patch) {
    const settings = { ...get().settings, ...patch };
    await saveSettings(settings);
    set({ settings });
  },
}));

/** 便捷导出：把 KeyValue[] 转成对象（环境管理面板用） */
export { recordToKeyValues };
export type { KeyValue };
