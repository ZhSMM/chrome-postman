/**
 * 侧边栏：集合树 + 历史记录。
 *
 * 【数据结构】
 * Collection（集合）→ Folder（文件夹，可嵌套）→ HttpRequest（请求）
 * 三者在 storage 里是三张平表，靠 id 关联。这样增删改单条记录时
 * 只需要重写一张表，不用整棵树一起保存。
 */
import { useState } from 'react';
import { useAppStore } from '../store';
import type { Collection, HttpRequest } from '../../shared/types';
import { formatMs } from '../../shared/utils';

export default function Sidebar() {
  const store = useAppStore();
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [filter, setFilter] = useState('');

  const toggle = (id: string) => setExpanded((prev) => ({ ...prev, [id]: !prev[id] }));

  const match = (text: string) => !filter || text.toLowerCase().includes(filter.toLowerCase());

  const renderRequest = (request: HttpRequest) => {
    if (!match(request.name) && !match(request.url)) return null;
    const active = store.currentRequest.id === request.id;
    return (
      <div
        key={request.id}
        className={`tree-item ${active ? 'selected' : ''}`}
        style={{ paddingLeft: 26 }}
        onClick={() => store.setCurrentRequest(request)}
        title={request.url}
      >
        <span className={`method-tag ${request.method}`}>{request.method}</span>
        <span className="name">{request.name}</span>
        <span className="actions">
          <button
            className="btn ghost sm danger"
            title="删除请求"
            onClick={(e) => {
              e.stopPropagation();
              store.deleteRequest(request.id);
            }}
          >
            ✕
          </button>
        </span>
      </div>
    );
  };

  const renderCollection = (collection: Collection) => {
    const folders = store.folders.filter((f) => f.collectionId === collection.id);
    const requests = store.requests.filter((r) => r.collectionId === collection.id && !r.folderId);
    const open = expanded[collection.id];

    const visibleRequests = requests.map(renderRequest).filter(Boolean);
    const visibleFolders = folders.filter((f) => match(f.name));
    if (!match(collection.name) && !visibleRequests.length && !visibleFolders.length) return null;

    return (
      <div key={collection.id}>
        <div className="tree-item" onClick={() => toggle(collection.id)}>
          <span className="chevron">{open ? '▼' : '▶'}</span>
          <span className="name">{collection.name}</span>
          <span className="actions">
            <button
              className="btn ghost sm"
              title="新建文件夹"
              onClick={(e) => {
                e.stopPropagation();
                const name = prompt('文件夹名称');
                if (name) store.createFolder(collection.id, name);
              }}
            >
              📁
            </button>
            <button
              className="btn ghost sm"
              title="重命名"
              onClick={(e) => {
                e.stopPropagation();
                const name = prompt('集合名称', collection.name);
                if (name) store.renameCollection(collection.id, name);
              }}
            >
              ✎
            </button>
            <button
              className="btn ghost sm danger"
              title="删除集合"
              onClick={(e) => {
                e.stopPropagation();
                if (confirm(`删除集合「${collection.name}」及其下所有请求？`)) {
                  store.deleteCollection(collection.id);
                }
              }}
            >
              ✕
            </button>
          </span>
        </div>

        {open && (
          <>
            {visibleFolders.map((folder) => {
              const folderRequests = store.requests.filter(
                (r) => r.folderId === folder.id,
              );
              const folderOpen = expanded[folder.id];
              return (
                <div key={folder.id}>
                  <div className="tree-item" style={{ paddingLeft: 14 }} onClick={() => toggle(folder.id)}>
                    <span className="chevron">{folderOpen ? '▼' : '▶'}</span>
                    <span className="name">{folder.name}</span>
                    <span className="actions">
                      <button
                        className="btn ghost sm danger"
                        title="删除文件夹"
                        onClick={(e) => {
                          e.stopPropagation();
                          store.deleteFolder(folder.id);
                        }}
                      >
                        ✕
                      </button>
                    </span>
                  </div>
                  {folderOpen && folderRequests.map(renderRequest)}
                </div>
              );
            })}
            {visibleRequests}
            {!visibleRequests.length && !visibleFolders.length && (
              <div className="faint" style={{ padding: '2px 0 2px 26px' }}>
                暂无请求
              </div>
            )}
          </>
        )}
      </div>
    );
  };

  return (
    <>
      <div className="sidebar-tabs">
        <button
          className={`btn sm ${store.sidebarView === 'collections' ? 'primary' : 'ghost'}`}
          onClick={() => store.setSidebarView('collections')}
        >
          集合
        </button>
        <button
          className={`btn sm ${store.sidebarView === 'history' ? 'primary' : 'ghost'}`}
          onClick={() => store.setSidebarView('history')}
        >
          历史 ({store.history.length})
        </button>
      </div>

      <div style={{ padding: '6px 8px 0' }}>
        <input
          style={{ width: '100%' }}
          placeholder="搜索请求…"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        />
      </div>

      <div className="sidebar-content">
        {store.sidebarView === 'collections' ? (
          <>
            {store.collections.map(renderCollection)}
            {!store.collections.length && (
              <div className="empty-state" style={{ padding: '24px 8px' }}>
                还没有集合
                <div style={{ marginTop: 8 }}>
                  <button
                    className="btn sm"
                    onClick={() => {
                      const name = prompt('集合名称', '新建集合');
                      if (name) store.createCollection(name);
                    }}
                  >
                    + 新建集合
                  </button>
                </div>
              </div>
            )}
          </>
        ) : (
          <>
            {store.history.map((item) => (
              <div
                key={item.id}
                className="tree-item"
                onClick={() => store.loadHistoryIntoEditor(item)}
                title={item.request.url}
              >
                <span className={`method-tag ${item.request.method}`}>{item.request.method}</span>
                <span className="name">
                  {item.request.name || item.request.url}
                  <div className="faint" style={{ fontSize: 11 }}>
                    {new Date(item.timestamp).toLocaleString()} · {formatMs(item.duration)}
                    {item.error ? ' · 失败' : ''}
                  </div>
                </span>
              </div>
            ))}
            {!store.history.length && <div className="empty-state">还没有历史记录</div>}
            {!!store.history.length && (
              <button
                className="btn sm danger"
                style={{ margin: 8 }}
                onClick={() => {
                  if (confirm('清空全部历史记录？')) store.clearHistoryRecords();
                }}
              >
                清空历史
              </button>
            )}
          </>
        )}
      </div>

      <div
        style={{
          display: 'flex',
          gap: 6,
          padding: 8,
          borderTop: '1px solid var(--border)',
          flexWrap: 'wrap',
        }}
      >
        <button className="btn sm" onClick={store.createNewRequest}>
          + 新请求
        </button>
        <button
          className="btn sm"
          onClick={() => {
            const name = prompt('集合名称', '新建集合');
            if (name) store.createCollection(name);
          }}
        >
          + 集合
        </button>
        <button className="btn sm ghost" onClick={store.exportAll} title="导出工作区 JSON">
          导出
        </button>
        <label className="btn sm ghost" style={{ cursor: 'pointer' }}>
          导入
          <input
            type="file"
            accept="application/json"
            style={{ display: 'none' }}
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) store.importAll(file);
              e.target.value = '';
            }}
          />
        </label>
      </div>
    </>
  );
}
