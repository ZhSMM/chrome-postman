/**
 * ============================================================
 * Postman Collection v2.1 导出器
 * ============================================================
 *
 * 【在架构中的位置】
 * 与 postman-importer.ts 配对，负责"本项目数据模型 → Postman 集合文件"。
 * 上游是 UI（用户点"导出 Postman 集合"），下游是浏览器下载 .json。
 * 和导入器一样是纯函数：不碰 chrome.*、不碰 DOM、不读写文件，
 * 只负责把数据结构拼成一个"可以直接 JSON.stringify 成文件"的对象。
 *
 * 【初学者先看这里】
 * Postman 的集合文件长这样：
 * {
 *   "info": { "_postman_id": "...", "name": "我的集合", "schema": "https://schema.getpostman.com/..." },
 *   "item": [ { "name": "接口名", "request": { "method": "GET", "url": {...} } } ],
 *   "variable": [ { "key": "baseUrl", "value": "https://x" } ]
 * }
 * 其中 item 是一棵树：请求（带 request 字段）和文件夹（只有 name + item 数组）
 * 混在一起，靠"有没有 request 字段"区分。
 *
 * 【关键实现细节】
 * 1. 顺序：导入时我用"递增时间戳"记录了文件的先后顺序，
 *    导出时按 createdAt 排序即可还原成同一棵树（往返测试依赖这一点）。
 * 2. URL：同时写 raw 和 host/path 数组。
 *    raw 保留用户看到的完整地址（含 {{变量}}）；
 *    host/path 给 Postman 用来做 UI 展示。解析不出来就只写 raw。
 * 3. 鉴权：本项目的 AuthConfig（扁平对象）→ Postman 的数组形式
 *    { type: 'basic', basic: [{ key: 'username', value: 'u' }] }。
 * 4. 脚本：preScript / postScript → event[].script.exec（字符串数组，一行一个元素）。
 *    空脚本不输出 event，免得 Postman 里出现一个空白脚本块。
 * 5. 表格行：enabled:false → disabled:true（Postman 的"禁用"是取反表达）。
 *
 * 【用到的 Chrome API】
 * 无（纯函数层）。
 */

import type {
  AuthConfig,
  BodyConfig,
  Collection,
  Environment,
  Folder,
  HttpRequest,
  KeyValue,
  MultipartPart,
} from '../shared/types';

/** Postman v2.1 的 schema 地址 */
const POSTMAN_V21_SCHEMA = 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json';

/* ------------------------------------------------------------------
 * 内部工具
 * ---------------------------------------------------------------- */

/**
 * 按创建时间排序（相同时按 id 兜底，保证顺序稳定）。
 *
 * 【为什么要排序】
 * 本项目的 Folder / HttpRequest 没有"顺序字段"，
 * 而 Postman 的 item 数组是有顺序的。
 * 导入时我把文件里的先后顺序写进了 createdAt（递增），
 * 这里按 createdAt 排就能还原出同样的树。
 */
function byCreatedAt(a: { createdAt: number; id: string }, b: { createdAt: number; id: string }): number {
  if (a.createdAt !== b.createdAt) return a.createdAt - b.createdAt;
  if (a.id === b.id) return 0;
  return a.id < b.id ? -1 : 1;
}

/**
 * 把 URL 拆成 Postman 的 host / path 数组。
 *
 * 【为什么要同时保留 raw】
 * raw 是"用户看到的样子"，host/path 是"给 Postman 展示用的结构"。
 * 两个都给，Postman 界面才能正确高亮域名和路径。
 * 解析失败（例如用户只填了 "{{baseUrl}}/x" 这种没有协议的地址）就只写 raw。
 */
function parseUrl(url: string): { protocol: string; host: string[]; path: string[]; port?: string } | null {
  const matched = /^([a-zA-Z][a-zA-Z0-9+.-]*):\/\/([^/?#]*)([^?#]*)/.exec(url.trim());
  if (!matched) return null;

  const protocol = matched[1];
  const hostPart = matched[2];
  const pathPart = matched[3];

  const host = hostPart.split('.').filter((part) => part.length > 0);
  let port: string | undefined;

  // 端口：Postman 单独存 port，host 数组里不带
  if (host.length) {
    const last = host[host.length - 1];
    const colon = last.indexOf(':');
    if (colon > 0) {
      port = last.slice(colon + 1);
      host[host.length - 1] = last.slice(0, colon);
    }
  }

  const path = pathPart.split('/').filter((part) => part.length > 0);
  const result: { protocol: string; host: string[]; path: string[]; port?: string } = { protocol, host, path };
  if (port) result.port = port;
  return result;
}

/** 表格行 → Postman 的 {key, value, disabled} */
function toPostmanRows(rows: KeyValue[]): Record<string, unknown>[] {
  return rows.map((row) => {
    const item: Record<string, unknown> = {
      key: row.key,
      value: row.value,
      type: 'string',
    };
    if (!row.enabled) item.disabled = true;
    if (row.description) item.description = row.description;
    return item;
  });
}

/**
 * 本项目的 body → Postman 的 body。
 *
 * 【为什么要分情况】
 * Postman 的 body 有 4 种不同的数据结构（raw / urlencoded / formdata / file），
 * 形状互不兼容，必须按模式分别输出。
 * 没有 body（mode = none）时直接不输出 body 字段，Postman 里有 body 也没关系。
 */
function buildBody(body: BodyConfig): Record<string, unknown> | undefined {
  switch (body.mode) {
    case 'none':
      return undefined;

    // raw 系列：json / text / xml / html 在 Postman 里都是 mode: 'raw'，
    // 靠 options.raw.language 区分
    case 'json':
    case 'text':
    case 'xml':
    case 'html': {
      return {
        mode: 'raw',
        raw: body.raw,
        options: { raw: { language: body.mode } },
      };
    }

    case 'form-urlencoded':
      return {
        mode: 'urlencoded',
        urlencoded: body.form.map((row) => {
          const item: Record<string, unknown> = { key: row.key, value: row.value, type: 'string' };
          if (!row.enabled) item.disabled = true;
          return item;
        }),
      };

    case 'form-data':
      return {
        mode: 'formdata',
        formdata: body.formData.map((part) => buildFormDataPart(part)),
      };

    case 'binary': {
      const file: Record<string, unknown> = { src: body.binaryFileName ?? '' };
      if (body.binaryMimeType) file.contentType = body.binaryMimeType;
      return { mode: 'file', file };
    }

    default:
      return undefined;
  }
}

/**
 * multipart 的一个分段 → Postman 的 formdata 元素。
 *
 * 【已知限制】
 * Postman 的文件分段存的是**本机路径**（src），没有"内嵌文件内容"的字段，
 * 所以本项目里的 Base64 文件内容导不出去，只能带出文件名。
 */
function buildFormDataPart(part: MultipartPart): Record<string, unknown> {
  if (!part.isFile) {
    const item: Record<string, unknown> = { key: part.key, value: part.value, type: 'text' };
    return item;
  }
  const item: Record<string, unknown> = { key: part.key, type: 'file', src: part.fileName ?? '' };
  if (part.mimeType) item.contentType = part.mimeType;
  return item;
}

/**
 * 本项目的鉴权 → Postman 的鉴权（数组形式）。
 *
 * 【为什么要写成数组】
 * Postman 的鉴权对象是 { type: 'basic', basic: [{key,value},...] }：
 * type 决定用哪个数组，数组里每一项是"参数名 → 参数值"。
 * 本项目的 AuthConfig 是扁平对象，所以这里要把它"摊平"成数组。
 */
function buildAuth(auth: AuthConfig): Record<string, unknown> | undefined {
  switch (auth.type) {
    case 'none':
      // 不输出 auth：Postman 里"没有 auth"就是继承集合鉴权 / 不带认证
      return undefined;

    case 'basic':
      return {
        type: 'basic',
        basic: [
          { key: 'username', value: auth.username ?? '', type: 'string' },
          { key: 'password', value: auth.password ?? '', type: 'string' },
        ],
      };

    case 'bearer':
      return {
        type: 'bearer',
        bearer: [{ key: 'token', value: auth.token ?? '', type: 'string' }],
      };

    case 'apikey':
      return {
        type: 'apikey',
        apikey: [
          { key: 'key', value: auth.apiKey ?? '', type: 'string' },
          { key: 'value', value: auth.apiValue ?? '', type: 'string' },
          { key: 'in', value: auth.apiKeyIn ?? 'header', type: 'string' },
        ],
      };

    case 'digest':
      return {
        type: 'digest',
        digest: [
          { key: 'username', value: auth.digestUsername ?? '', type: 'string' },
          { key: 'password', value: auth.digestPassword ?? '', type: 'string' },
        ],
      };

    case 'oauth2':
      return {
        type: 'oauth2',
        oauth2: [{ key: 'accessToken', value: auth.oauthToken ?? '', type: 'string' }],
      };

    default:
      return undefined;
  }
}

/**
 * 请求 → Postman 的 request 对象。
 *
 * 【为什么 url 要同时写 raw 和 host/path】
 * 见 parseUrl 的注释：raw 保证用户看到的地址不变，host/path 保证 Postman 界面正常。
 */
function buildRequestNode(request: HttpRequest): Record<string, unknown> {
  const url: Record<string, unknown> = { raw: request.url };
  const parsed = parseUrl(request.url);
  if (parsed) {
    url.protocol = parsed.protocol;
    url.host = parsed.host;
    url.path = parsed.path;
    if (parsed.port) url.port = parsed.port;
  }

  const node: Record<string, unknown> = {
    name: request.name,
    request: {
      method: request.method,
      url,
    },
  };

  const requestNode = node.request as Record<string, unknown>;

  if (request.headers.length) requestNode.header = toPostmanRows(request.headers);
  if (request.params.length) {
    url.query = request.params.map((row) => {
      const item: Record<string, unknown> = { key: row.key, value: row.value, type: 'string' };
      if (!row.enabled) item.disabled = true;
      return item;
    });
  }

  const body = buildBody(request.body);
  if (body) requestNode.body = body;

  const auth = buildAuth(request.auth);
  if (auth) requestNode.auth = auth;

  // 脚本：空脚本不输出，免得 Postman 里出现空白脚本块
  const events: Record<string, unknown>[] = [];
  if (request.preScript.trim()) {
    events.push({
      listen: 'prerequest',
      script: { type: 'text/javascript', exec: request.preScript.split('\n') },
    });
  }
  if (request.postScript.trim()) {
    events.push({
      listen: 'test',
      script: { type: 'text/javascript', exec: request.postScript.split('\n') },
    });
  }
  if (events.length) node.event = events;

  return node;
}

/* ------------------------------------------------------------------
 * 对外接口
 * ---------------------------------------------------------------- */

/**
 * 导出一个 Postman Collection v2.1 集合。
 *
 * 【做什么】
 * 把集合 + 文件夹 + 请求组装成 Postman 的 item 树，
 * 文件夹按 parentId 还原成嵌套结构。
 *
 * 【为什么参数是三个而不是一个对象】
 * 本项目里集合、文件夹、请求是三张独立的表（存储层就是分开存的），
 * 这里显式传三个数组，调用方自己决定导哪一部分。
 *
 * @param collection 要导出的集合
 * @param folders 该集合下的文件夹（可以包含子文件夹）
 * @param requests 该集合下的请求
 */
export function exportPostmanCollection(
  collection: Collection,
  folders: Folder[],
  requests: HttpRequest[],
): Record<string, unknown> {
  const ownedFolders = folders.filter((folder) => folder.collectionId === collection.id);
  const ownedRequests = requests.filter(
    (request) => !request.collectionId || request.collectionId === collection.id,
  );

  /**
   * 组装某一层的 item：把"这一层的文件夹"和"这一层的请求"按创建时间合并，
   * 这样请求和文件夹的相对先后顺序和原始文件一致。
   */
  const buildLevel = (parentFolderId: string | null): Record<string, unknown>[] => {
    const levelFolders = ownedFolders
      .filter((folder) => (folder.parentId ?? null) === parentFolderId)
      .sort(byCreatedAt);
    const levelRequests = ownedRequests
      .filter((request) => (request.folderId ?? null) === parentFolderId)
      .sort(byCreatedAt);

    const items: Record<string, unknown>[] = [];
    let folderIndex = 0;
    let requestIndex = 0;
    while (folderIndex < levelFolders.length || requestIndex < levelRequests.length) {
      const takeFolder =
        requestIndex >= levelRequests.length ||
        (folderIndex < levelFolders.length && levelFolders[folderIndex].createdAt <= levelRequests[requestIndex].createdAt);
      if (takeFolder) {
        const folder = levelFolders[folderIndex++];
        items.push(buildFolderNode(folder));
      } else {
        items.push(buildRequestNode(levelRequests[requestIndex++]));
      }
    }
    return items;
  };

  /** 文件夹节点：name + 自己的子项 */
  const buildFolderNode = (folder: Folder): Record<string, unknown> => ({
    name: folder.name,
    item: buildLevel(folder.id),
  });

  const info: Record<string, unknown> = {
    _postman_id: collection.id,
    name: collection.name,
    schema: POSTMAN_V21_SCHEMA,
  };
  if (collection.description !== undefined) info.description = collection.description;

  const result: Record<string, unknown> = {
    info,
    item: buildLevel(null),
  };

  if (collection.variables.length) {
    result.variable = collection.variables.map((variable) => {
      const item: Record<string, unknown> = { key: variable.key, value: variable.value, type: 'string' };
      if (!variable.enabled) item.disabled = true;
      if (variable.description) item.description = variable.description;
      return item;
    });
  }

  return result;
}

/**
 * 导出一个 Postman 环境文件。
 *
 * 【做什么】
 * 生成 Postman 的环境 JSON：{ id, name, values, _postman_variable_scope }。
 *
 * 【为什么 secret 环境要逐个变量标 type: 'secret'】
 * Postman 的"敏感变量"是**按变量**标记的（values[].type = 'secret'），
 * 而本项目的 Environment.secret 是**按环境**标记的。
 * 所以导出时整个环境里的变量都会标成 secret，导入时再还原成环境级标记。
 *
 * @param env 要导出的环境
 */
export function exportPostmanEnvironment(env: Environment): Record<string, unknown> {
  return {
    id: env.id,
    name: env.name,
    values: env.values.map((value) => {
      const item: Record<string, unknown> = {
        key: value.key,
        value: value.value,
        type: env.secret ? 'secret' : 'default',
        enabled: value.enabled,
      };
      if (value.description) item.description = value.description;
      return item;
    }),
    _postman_variable_scope: 'environment',
  };
}
