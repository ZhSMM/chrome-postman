/**
 * ============================================================
 * Postman Collection v2.1 导入器
 * ============================================================
 *
 * 【在架构中的位置】
 * 位于"外部文件 → 本项目数据模型"这条流水线的入口。
 * 上游是 UI（用户拖进来一个 .json 文件），下游是 storage 层
 * （把 collections / folders / requests / environments 存进 chrome.storage）。
 * 本文件只负责"把 Postman 的 JSON 翻译成本项目的类型"，
 * 不碰 chrome.*、不碰 DOM、不读写文件 —— 这样单元测试能在 Node 里直接跑。
 *
 * 【初学者先看这里】
 * Postman 的 Collection v2.1 格式有几个"反直觉"的地方，初学者最容易踩：
 *   1. URL 是**分段存**的：{ protocol, host: ["api","example","com"], path: ["v1","users"] }，
 *      也有一个"已经拼好的" raw 字段。我们优先用 raw，没有 raw 才自己拼。
 *   2. 鉴权是一个对象里套数组：{ type: 'basic', basic: [{key:'username', value:'u'}] }，
 *      数组里每一项是 {key, value} 这样的键值对。
 *   3. 脚本在 item[].event[].script.exec 里，而且 exec 是**字符串数组**（一行一个元素）。
 *   4. 嵌套 item[]（没有 request 字段的那种）代表"文件夹"。
 *   5. 顶层的 variable[] 和 item 里的 variable[] 含义不一样（见下方映射表）。
 *
 * 【关键实现细节】
 * 字段映射（Postman → 本项目）：
 *   info.name                     → Collection.name
 *   info.description              → Collection.description
 *   item[].name                   → HttpRequest.name
 *   item[].request.method         → HttpRequest.method（大写化）
 *   item[].request.url            → HttpRequest.url
 *   item[].request.url.query[]    → HttpRequest.params
 *   item[].request.header[]       → HttpRequest.headers
 *   item[].request.body           → HttpRequest.body
 *   item[].request.auth           → HttpRequest.auth
 *   item[].event[].script.exec    → HttpRequest.preScript / postScript
 *   item[].variable[]             → Collection.variables（提升到集合级）
 *   顶层 variable[]               → 新建一个 Environment
 *   嵌套 item[]（无 request）      → Folder（用 parentId 还原层级）
 *   item[].response[]             → 丢弃（计入 stats.skipped + warning）
 *
 * 关于 stats.skipped 的口径："因不支持而被跳过的部分数量"。
 * 下面这些都会计入：被丢弃的示例响应、降级掉的鉴权类型、读不到内容的文件引用、
 * 不支持的 body 模式、集合级脚本/集合级鉴权、非法条目。
 *
 * ⚠️ 已知不对称（规格决定，不是 bug）：
 *   导入时"顶层 variable[]"会变成一个 Environment，而导出时 Collection.variables
 *   又写回"顶层 variable[]"。所以"含集合变量的集合"做 Postman 往返时，
 *   集合变量会变成环境变量。需要保留集合变量的场景请单独导出环境文件。
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
  HttpMethod,
  HttpRequest,
  KeyValue,
  MultipartPart,
} from '../shared/types';
import { uid } from '../shared/utils';

/** 导入过程中给用户看的提示（info = 只是说明，warning = 需要用户留意） */
export interface ImportWarning {
  level: 'info' | 'warning';
  /** 出问题的请求名（集合级问题可以不带） */
  requestName?: string;
  /** 中文说明 */
  message: string;
}

/** 一次导入的结果 */
export interface ImportResult {
  collections: Collection[];
  folders: Folder[];
  requests: HttpRequest[];
  environments: Environment[];
  warnings: ImportWarning[];
  stats: {
    collections: number;
    folders: number;
    requests: number;
    environments: number;
    /** 因不支持而被跳过的部分数量 */
    skipped: number;
  };
}

/** 支持的 HTTP 方法白名单 */
const SUPPORTED_METHODS: HttpMethod[] = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'];

/** Postman v2.1 的 schema 地址（导出时会原样写上，方便 Postman 识别） */
export const POSTMAN_V21_SCHEMA = 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json';

/* ------------------------------------------------------------------
 * 内部工具
 * ---------------------------------------------------------------- */

/** 是否是"普通对象"（排除 null 和数组） */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** 安全地把任意值转成数组 */
function toArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

/** 安全地把任意值转成字符串（undefined/null → ''） */
function toText(value: unknown): string {
  if (value === undefined || value === null) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return '';
}

/** 导入过程中的共享上下文（把 warnings / skipped 计数集中管理） */
interface ImportContext {
  warnings: ImportWarning[];
  skipped: number;
  collectionId: string;
  /** 生成递增的时间戳：保证导出时的排序 === 文件里的先后顺序 */
  nextStamp: () => number;
}

/**
 * Postman 的 {key, value} 数组 → 本项目的 KeyValue[]。
 *
 * 【为什么需要这个】
 * Postman 里"表格行"统一是 {key, value, disabled}，
 * disabled:true 表示这一行被临时禁用（界面上的 eye 图标）。
 * 本项目用 enabled 表达同一件事，所以要取反。
 */
function toKeyValues(list: unknown): KeyValue[] {
  const result: KeyValue[] = [];
  toArray(list).forEach((entry) => {
    if (!isRecord(entry)) return;
    const item: KeyValue = {
      id: uid('kv'),
      key: toText(entry.key),
      value: toText(entry.value),
      enabled: entry.disabled !== true,
    };
    const description = toText(entry.description);
    if (description) item.description = description;
    result.push(item);
  });
  return result;
}

/**
 * 从 Postman 的鉴权数组里取一个值。
 *
 * 【为什么要兼容两种形状】
 * 官方导出的形状是：[{ key: 'username', value: 'u' }]（key/value 分离）；
 * 而一些老工具 / 手工 JSON 写的是：[{ username: 'u' }]（属性直接摊平）。
 * 两种都要能读，否则用户会看到"导进来鉴权全是空的"。
 */
function pickAuthValue(list: unknown[], name: string): string {
  for (const entry of list) {
    if (!isRecord(entry)) continue;
    const entryKey = entry.key;
    if (typeof entryKey === 'string' && 'value' in entry) {
      // 标准形状：{ key: 'username', value: 'u' }
      if (entryKey.toLowerCase() === name.toLowerCase()) return toText(entry.value);
      continue;
    }
    // 摊平形状：{ username: 'u' }
    if (name in entry) return toText(entry[name]);
  }
  return '';
}

/**
 * 把 Postman 的 url 字段还原成一个 URL 字符串。
 *
 * 【为什么优先用 raw】
 * raw 是 Postman 自己拼好的完整地址，它还可能带着 {{变量}} 占位符
 * 和行内 query 串（?a=1）。如果只用 host/path 数组重新拼，
 * 这些信息会丢（比如 host 数组里的 "{{baseUrl}}" 拼接方式和原串可能不同）。
 * 只有在没有 raw 时（比如用户手写 JSON）才用分段拼。
 */
function buildUrlString(url: unknown): string {
  if (typeof url === 'string') return url;
  if (!isRecord(url)) return '';

  const raw = url.raw;
  if (typeof raw === 'string') return raw;

  const protocol = toText(url.protocol);
  const hostParts = toArray(url.host)
    .map((part) => toText(part))
    .filter((part) => part.length > 0);
  const pathParts = toArray(url.path)
    .map((part) => toText(part))
    .filter((part) => part.length > 0);

  let result = '';
  if (protocol) result += `${protocol}://`;
  const hostJoined = hostParts.join('.');
  result += hostJoined;

  // 端口：Postman 单独存 port 字段，拼接公式里没有它，但丢掉端口 URL 就错了。
  // 端口要插在 host 后面、path 前面（host 里已经带了端口就不要再加一次）。
  const port = toText(url.port);
  if (port && !hostJoined.includes(':')) result += `:${port}`;

  if (pathParts.length) result += `/${pathParts.join('/')}`;
  return result;
}

/**
 * 把 Postman 的 body 转成本项目的 BodyConfig。
 *
 * 【为什么逐个模式处理】
 * Postman 的 body 有 raw / urlencoded / formdata / file / graphql 五种，
 * 它们的数据形状完全不同（graphql 还是嵌套对象），没法用一套通用逻辑处理。
 * 遇到本项目不支持的模式时宁可降级 + 报警，也不要静默丢数据。
 */
function buildBody(body: unknown, ctx: ImportContext, requestName: string): BodyConfig {
  const result: BodyConfig = { mode: 'none', raw: '', form: [], formData: [] };
  if (!isRecord(body)) return result;

  const mode = toText(body.mode).toLowerCase();

  if (mode === 'raw') {
    result.raw = toText(body.raw);
    const options = isRecord(body.options) ? body.options : undefined;
    const rawOptions = options && isRecord(options.raw) ? options.raw : undefined;
    const language = toText(rawOptions?.language).toLowerCase();

    // language 决定本项目的 body 模式。
    // json / xml / html 有对应的模式，保留可以让「导出→导入→再导出」保持等价；
    // 其它（text / javascript / 未知）统一按纯文本处理。
    if (language === 'json') result.mode = 'json';
    else if (language === 'xml') result.mode = 'xml';
    else if (language === 'html') result.mode = 'html';
    else {
      result.mode = 'text';
      if (language && language !== 'text' && language !== 'javascript') {
        ctx.warnings.push({
          level: 'info',
          requestName,
          message: `raw 报文语言「${language}」本项目没有对应模式，已按纯文本（text）处理`,
        });
      }
    }
    return result;
  }

  if (mode === 'urlencoded') {
    result.mode = 'form-urlencoded';
    result.form = toKeyValues(body.urlencoded);
    return result;
  }

  if (mode === 'formdata') {
    result.mode = 'form-data';
    result.formData = buildMultipartParts(body.formdata, ctx, requestName);
    return result;
  }

  if (mode === 'file') {
    result.mode = 'binary';
    const file = isRecord(body.file) ? body.file : undefined;
    result.binaryFileName = toText(file?.src);
    const contentType = toText(file?.contentType);
    if (contentType) result.binaryMimeType = contentType;
    ctx.warnings.push({
      level: 'warning',
      requestName,
      message: `binary 请求体引用的文件「${result.binaryFileName || '未知'}」是本机路径，扩展读不到内容，请重新选择文件`,
    });
    ctx.skipped += 1;
    return result;
  }

  if (mode === 'graphql') {
    const graphql = isRecord(body.graphql) ? body.graphql : undefined;
    const query = toText(graphql?.query);
    const variables = isRecord(graphql?.variables) ? graphql.variables : {};
    result.mode = 'json';
    result.raw = JSON.stringify({ query, variables }, null, 2);
    ctx.warnings.push({
      level: 'warning',
      requestName,
      message: 'GraphQL 请求体本项目暂不支持，已降级成 JSON（query + variables）',
    });
    ctx.skipped += 1;
    return result;
  }

  if (mode) {
    ctx.warnings.push({
      level: 'warning',
      requestName,
      message: `请求体模式「${mode}」本项目不支持，已按"无请求体"处理`,
    });
    ctx.skipped += 1;
  }
  return result;
}

/**
 * 把 Postman 的 formdata 数组转成本项目的 MultipartPart[]。
 *
 * 【为什么文件字段只能保留文件名】
 * Postman 的文件字段存的是**本机文件路径**（src），不是文件内容。
 * 核心层不做 IO（也不该读用户磁盘），所以这里只保留路径与 MIME 类型，
 * 并且明确提示用户内容没导进来。
 */
function buildMultipartParts(list: unknown, ctx: ImportContext, requestName: string): MultipartPart[] {
  const result: MultipartPart[] = [];
  toArray(list).forEach((entry) => {
    if (!isRecord(entry)) return;
    const key = toText(entry.key);
    const type = toText(entry.type).toLowerCase();
    const src = toText(entry.src);
    const isFile = type === 'file' || (!!src && type !== 'text');

    if (isFile) {
      const part: MultipartPart = {
        id: uid('mp'),
        key,
        value: '',
        isFile: true,
        fileName: src,
        enabled: true,
      };
      const contentType = toText(entry.contentType);
      if (contentType) part.mimeType = contentType;
      result.push(part);
      ctx.warnings.push({
        level: 'warning',
        requestName,
        message: `form-data 文件字段「${key || '未命名'}」只导入了文件名「${src || '未知'}」，文件内容需要重新选择`,
      });
      ctx.skipped += 1;
      return;
    }

    result.push({
      id: uid('mp'),
      key,
      value: toText(entry.value),
      isFile: false,
      enabled: true,
    });
  });
  return result;
}

/**
 * 把 Postman 的 auth 转成本项目的 AuthConfig。
 *
 * 【为什么要对不支持的类型降级 + 报警】
 * hawk / awsv4 / edgegrid / ntlm 这些鉴权本项目没实现。
 * 如果静默降级成"无鉴权"，用户会以为鉴权配好了，请求一发出就 401，
 * 还查不出原因。所以这里必须明确告诉用户"这一项没导进来"。
 */
function buildAuth(auth: unknown, ctx: ImportContext, requestName: string): AuthConfig {
  if (!isRecord(auth)) return { type: 'none' };
  const type = toText(auth.type).toLowerCase();

  switch (type) {
    case 'noauth':
      return { type: 'none' };
    case 'basic': {
      const list = toArray(auth.basic);
      return {
        type: 'basic',
        username: pickAuthValue(list, 'username'),
        password: pickAuthValue(list, 'password'),
      };
    }
    case 'bearer':
      return { type: 'bearer', token: pickAuthValue(toArray(auth.bearer), 'token') };
    case 'apikey': {
      const list = toArray(auth.apikey);
      const location = pickAuthValue(list, 'in').toLowerCase();
      return {
        type: 'apikey',
        apiKey: pickAuthValue(list, 'key'),
        apiValue: pickAuthValue(list, 'value'),
        apiKeyIn: location === 'query' ? 'query' : 'header',
      };
    }
    case 'oauth2':
      return { type: 'oauth2', oauthToken: pickAuthValue(toArray(auth.oauth2), 'accessToken') };
    case 'digest': {
      const list = toArray(auth.digest);
      ctx.warnings.push({
        level: 'warning',
        requestName,
        message: 'Digest 鉴权本项目暂未实现，已保留配置但发送时不会生效，请手动改用其它鉴权方式',
      });
      ctx.skipped += 1;
      return {
        type: 'digest',
        digestUsername: pickAuthValue(list, 'username'),
        digestPassword: pickAuthValue(list, 'password'),
      };
    }
    default: {
      ctx.warnings.push({
        level: 'warning',
        requestName,
        message: `鉴权类型「${type}」本项目不支持，已降级为「无鉴权」，该请求发送时不会带上认证信息`,
      });
      ctx.skipped += 1;
      return { type: 'none' };
    }
  }
}

/**
 * 把 item[].event[] 转成 preScript / postScript。
 *
 * 【为什么要 join('\n')】
 * Postman 的 script.exec 是**字符串数组**（一行一个元素），
 * 本项目用一整个字符串存脚本，所以用换行拼回去。
 * 同类型的多个 event 也要合并（Postman 允许一个请求挂多个 test 事件）。
 */
function buildScripts(item: Record<string, unknown>): { preScript: string; postScript: string } {
  const preParts: string[] = [];
  const postParts: string[] = [];

  toArray(item.event).forEach((event) => {
    if (!isRecord(event)) return;
    const listen = toText(event.listen).toLowerCase();
    const script = isRecord(event.script) ? event.script : undefined;
    const exec = script?.exec;

    let code = '';
    if (typeof exec === 'string') code = exec;
    else if (Array.isArray(exec)) code = exec.map((line) => toText(line)).join('\n');
    if (!code) return;

    if (listen === 'prerequest') preParts.push(code);
    else if (listen === 'test') postParts.push(code);
  });

  return { preScript: preParts.join('\n'), postScript: postParts.join('\n') };
}

/**
 * 把一个 Postman 的 request item 转成本项目的 HttpRequest。
 *
 * 【为什么 item.request 还要兼容字符串】
 * Postman 允许 `"request": "https://example.com"` 这种极简写法，
 * 遇到时按 GET + 纯 URL 处理。
 */
function buildRequest(
  item: Record<string, unknown>,
  name: string,
  ctx: ImportContext,
  parentFolderId: string | null,
): HttpRequest {
  const raw = item.request;
  let methodText = 'GET';
  let url = '';
  let headerList: unknown[] = [];
  let bodyRaw: unknown;
  let authRaw: unknown;

  if (typeof raw === 'string') {
    url = raw;
  } else if (isRecord(raw)) {
    methodText = toText(raw.method) || 'GET';
    url = buildUrlString(raw.url);
    headerList = toArray(raw.header);
    bodyRaw = raw.body;
    authRaw = raw.auth;
  }

  const upperMethod = methodText.toUpperCase();
  let method: HttpMethod = 'GET';
  if (SUPPORTED_METHODS.includes(upperMethod as HttpMethod)) {
    method = upperMethod as HttpMethod;
  } else {
    ctx.warnings.push({
      level: 'warning',
      requestName: name,
      message: `请求方法「${methodText}」本项目不支持，已按 GET 处理`,
    });
    ctx.skipped += 1;
  }

  const { preScript, postScript } = buildScripts(item);
  const stamp = ctx.nextStamp();

  return {
    id: uid('req'),
    name,
    method,
    url,
    params: [],
    headers: toKeyValues(headerList),
    body: buildBody(bodyRaw, ctx, name),
    auth: buildAuth(authRaw, ctx, name),
    preScript,
    postScript,
    collectionId: ctx.collectionId,
    folderId: parentFolderId,
    environmentId: null,
    createdAt: stamp,
    updatedAt: stamp,
  };
}

/**
 * 递归遍历 item 树，把请求和文件夹分别收集出来。
 *
 * 【为什么用递归而不是一层层循环】
 * Postman 的文件夹可以无限嵌套，用 parentId 还原层级是唯一正解：
 * 每建一个文件夹就记下它的 parentId，请求的 folderId 指向所属文件夹。
 */
function walkItems(items: unknown, ctx: ImportContext, parentFolderId: string | null, output: {
  folders: Folder[];
  requests: HttpRequest[];
  collectionVariables: KeyValue[];
}): void {
  toArray(items).forEach((raw) => {
    if (!isRecord(raw)) {
      ctx.warnings.push({ level: 'warning', message: '集合里有一条不是对象的条目，已跳过' });
      ctx.skipped += 1;
      return;
    }

    const name = toText(raw.name).trim() || '未命名';

    // item 里的 variable[] 一律提升成集合级变量
    if (Array.isArray(raw.variable)) {
      output.collectionVariables.push(...toKeyValues(raw.variable));
    }

    // 示例响应（Postman 用来存"保存下来的响应样例"）本项目没有对应概念
    const responses = toArray(raw.response);
    if (responses.length) {
      ctx.warnings.push({
        level: 'info',
        requestName: name,
        message: `「${name}」里的 ${responses.length} 条示例响应（response）本项目暂不支持，已丢弃`,
      });
      ctx.skipped += responses.length;
    }

    const hasRequest = 'request' in raw && raw.request !== undefined && raw.request !== null;
    if (hasRequest) {
      const request = buildRequest(raw, name, ctx, parentFolderId);
      // query 参数挂在 url.query 上，不在 request.query 上
      const rawRequest = isRecord(raw.request) ? raw.request : undefined;
      const urlNode = rawRequest && isRecord(rawRequest.url) ? rawRequest.url : undefined;
      request.params = toKeyValues(urlNode?.query);
      output.requests.push(request);
      return;
    }

    // 没有 request 字段 → 这是个文件夹
    const folder: Folder = {
      id: uid('fld'),
      name,
      collectionId: ctx.collectionId,
      parentId: parentFolderId,
      createdAt: ctx.nextStamp(),
    };
    output.folders.push(folder);
    walkItems(raw.item, ctx, folder.id, output);
  });
}

/* ------------------------------------------------------------------
 * 对外接口
 * ---------------------------------------------------------------- */

/**
 * 导入一个 Postman Collection v2.1 文件。
 *
 * 【做什么】
 * 把已 JSON.parse 的对象翻译成 Collection / Folder / HttpRequest / Environment，
 * 并附带"哪些内容没能导进来"的提示（warnings）与统计（stats）。
 *
 * 【为什么这样设计】
 * - 只接受已解析的对象（不是文件路径），因为核心层不做 IO；
 *   文件读盘、弹窗这些是 UI 的事。
 * - 遇到不支持的内容不抛错，而是降级 + warning + skipped 计数。
 *   一次导入里有几个不认识的东西，不该让用户整个文件都导不进来。
 * - 只有"根本不是对象"这种硬错误才抛异常（带中文说明）。
 *
 * @param json 已 JSON.parse 的集合文件内容
 */
export function importPostmanCollection(json: unknown): ImportResult {
  if (!isRecord(json)) {
    throw new Error('导入失败：集合文件的根节点必须是一个 JSON 对象（{ ... }），请确认选的是 Postman v2.1 集合文件');
  }

  const warnings: ImportWarning[] = [];
  const collectionId = uid('col');
  const now = Date.now();
  let order = 0;
  const ctx: ImportContext = {
    warnings,
    skipped: 0,
    collectionId,
    // 递增时间戳：让导出时的排序 === 文件里的先后顺序（往返测试靠这个）
    nextStamp: () => now + order++,
  };

  const info = isRecord(json.info) ? json.info : undefined;
  let name = toText(info?.name).trim();
  if (!name) {
    name = '未命名集合';
    warnings.push({
      level: 'info',
      message: info
        ? '集合缺少 info.name，已使用默认名称「未命名集合」'
        : '集合文件缺少 info 字段，已使用默认名称「未命名集合」',
    });
  }

  const schema = toText(info?.schema);
  if (schema && !schema.includes('v2.1')) {
    warnings.push({
      level: 'info',
      message: `集合的 schema 不是 v2.1（${schema}），已按 v2.1 规则尽力解析`,
    });
  }

  let description: string | undefined;
  const rawDescription = info?.description;
  if (typeof rawDescription === 'string') description = rawDescription;
  else if (isRecord(rawDescription)) description = toText(rawDescription.content);
  if (description === undefined) description = undefined;

  const collection: Collection = {
    id: collectionId,
    name,
    description,
    variables: [],
    createdAt: now,
    updatedAt: now,
  };

  const output = { folders: [] as Folder[], requests: [] as HttpRequest[], collectionVariables: [] as KeyValue[] };
  walkItems(json.item, ctx, null, output);
  collection.variables = output.collectionVariables;

  // 集合级鉴权：Postman 允许请求继承集合鉴权，本项目没有"继承"概念，
  // 所以这里只提示用户，不做静默继承。
  if (isRecord(json.auth)) {
    warnings.push({
      level: 'warning',
      message: '集合级鉴权（根 auth）本项目不支持继承，已忽略，请在各个请求上单独配置',
    });
    ctx.skipped += 1;
  }

  // 集合级脚本：同样没有对应的存放位置
  if (Array.isArray(json.event) && json.event.length) {
    warnings.push({
      level: 'warning',
      message: '集合级脚本（根 event）本项目暂不支持，已忽略，本项目仅支持请求级脚本',
    });
    ctx.skipped += 1;
  }

  // 顶层 variable[]：按规格单独做成一个 Environment
  const environments: Environment[] = [];
  const rootVariables = Array.isArray(json.variable) ? json.variable : [];
  if (rootVariables.length) {
    const values = toKeyValues(rootVariables);
    const env: Environment = {
      id: uid('env'),
      name: `${name} 变量`,
      values,
      createdAt: now,
      updatedAt: now,
    };
    const hasSecret = rootVariables.some((item) => isRecord(item) && toText(item.type).toLowerCase() === 'secret');
    if (hasSecret) env.secret = true;
    environments.push(env);
    warnings.push({
      level: 'info',
      message: `集合顶层的 ${rootVariables.length} 个变量已导入为独立环境「${env.name}」`,
    });
  }

  return {
    collections: [collection],
    folders: output.folders,
    requests: output.requests,
    environments,
    warnings,
    stats: {
      collections: 1,
      folders: output.folders.length,
      requests: output.requests.length,
      environments: environments.length,
      skipped: ctx.skipped,
    },
  };
}

/**
 * 导入一个 Postman 环境文件。
 *
 * 【做什么】
 * Postman 环境文件的形状是 { id, name, values: [{key, value, type, enabled}] }，
 * 这里把它转成一个 Environment。
 *
 * 【为什么环境要单独一个函数】
 * 环境文件和集合文件是两种独立的东西（用户通常分开导出/导入），
 * 混在一个函数里会让"顶层 variable[] → Environment"这种特殊规则变得含糊。
 *
 * @param json 已 JSON.parse 的环境文件内容
 */
export function importPostmanEnvironment(json: unknown): ImportResult {
  if (!isRecord(json)) {
    throw new Error('导入失败：环境文件的根节点必须是一个 JSON 对象（{ ... }），请确认选的是 Postman 环境文件');
  }
  if (!Array.isArray(json.values)) {
    throw new Error('导入失败：不是合法的 Postman 环境文件（缺少 values 数组）');
  }

  const warnings: ImportWarning[] = [];
  const now = Date.now();
  const name = toText(json.name).trim() || '未命名环境';

  const values: KeyValue[] = [];
  json.values.forEach((entry) => {
    if (!isRecord(entry)) return;
    const item: KeyValue = {
      id: uid('kv'),
      key: toText(entry.key),
      value: toText(entry.value),
      enabled: entry.enabled !== false,
    };
    const description = toText(entry.description);
    if (description) item.description = description;
    values.push(item);
  });

  const env: Environment = {
    id: uid('env'),
    name,
    values,
    createdAt: now,
    updatedAt: now,
  };
  if (json.values.some((entry) => isRecord(entry) && toText(entry.type).toLowerCase() === 'secret')) {
    env.secret = true;
  }

  return {
    collections: [],
    folders: [],
    requests: [],
    environments: [env],
    warnings,
    stats: {
      collections: 0,
      folders: 0,
      requests: 0,
      environments: 1,
      skipped: 0,
    },
  };
}
