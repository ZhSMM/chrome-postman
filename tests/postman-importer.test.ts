import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  importPostmanCollection,
  importPostmanEnvironment,
  type ImportResult,
} from '../src/core/postman-importer';
import {
  exportPostmanCollection,
  exportPostmanEnvironment,
} from '../src/core/postman-exporter';
import type { HttpRequest } from '../src/shared/types';

/**
 * 读取夹具文件。
 *
 * 【为什么用 fs 而不是 import】
 * 真实场景是"读文件 → JSON.parse → 交给导入器"，
 * 用 fs 读能顺带验证这条链路，而且不依赖打包器对 JSON 模块的处理。
 */
function loadFixture(name: string): any {
  const url = new URL(`./fixtures/postman/${name}`, import.meta.url);
  return JSON.parse(readFileSync(url, 'utf8'));
}

/** 在导入结果里按请求名找请求（夹具里的请求名唯一，好定位） */
function findRequest(result: ImportResult, name: string): HttpRequest {
  const request = result.requests.find((item) => item.name === name);
  if (!request) throw new Error(`夹具里没找到名为「${name}」的请求`);
  return request;
}

/** 找到文件夹 */
function findFolder(result: ImportResult, name: string) {
  const folder = result.folders.find((item) => item.name === name);
  if (!folder) throw new Error(`夹具里没找到名为「${name}」的文件夹`);
  return folder;
}

/**
 * 在导出的 item 树里按名字找请求节点（导出结果是一棵嵌套树，不能靠下标定位）。
 */
function findExportedNode(items: unknown[], name: string): Record<string, unknown> {
  const search = (list: unknown[]): Record<string, unknown> | null => {
    for (const item of list) {
      if (!item || typeof item !== 'object') continue;
      const node = item as Record<string, unknown>;
      if (node.name === name && node.request) return node;
      const children = Array.isArray(node.item) ? node.item : [];
      const found = search(children);
      if (found) return found;
    }
    return null;
  };
  const found = search(items);
  if (!found) throw new Error(`导出结果里没找到名为「${name}」的请求`);
  return found;
}

/**
 * 去掉对象里的 id 字段。
 * 每次导入都会重新生成 id，所以比较"往返前后是否一致"时要把 id 排除掉。
 */
function stripIds<T>(value: T): T {
  return JSON.parse(JSON.stringify(value, (key, val) => (key === 'id' ? undefined : val))) as T;
}

/**
 * 去掉导出结果里会变的 id（每次导入都会重新生成 id），
 * 用来比较"两次导出是否等价"。
 */
function normalizeCollection(node: Record<string, unknown>): Record<string, unknown> {
  const copy = JSON.parse(JSON.stringify(node)) as Record<string, unknown>;
  const info = copy.info as Record<string, unknown> | undefined;
  if (info && '_postman_id' in info) info._postman_id = '<id>';
  return copy;
}

describe('Postman 导入器 · 集合结构', () => {
  const result = importPostmanCollection(loadFixture('basic-collection.json'));

  it('能导入集合名、描述与统计', () => {
    expect(result.collections).toHaveLength(1);
    expect(result.collections[0].name).toBe('示例 REST API');
    expect(result.collections[0].description).toContain('演示集合');
    expect(result.stats).toEqual({
      collections: 1,
      folders: 3,
      requests: 4,
      environments: 1,
      skipped: 1,
    });
  });

  it('所有请求都归属到导入出来的集合', () => {
    const collectionId = result.collections[0].id;
    expect(result.requests.length).toBe(4);
    result.requests.forEach((request) => {
      expect(request.collectionId).toBe(collectionId);
    });
  });

  it('嵌套文件夹用 parentId 还原层级', () => {
    const userFolder = findFolder(result, '用户中心');
    const orderFolder = findFolder(result, '订单模块');
    const subFolder = findFolder(result, '子模块');

    expect(userFolder.parentId).toBeNull();
    expect(orderFolder.parentId).toBeNull();
    expect(subFolder.parentId).toBe(orderFolder.id);
    expect(subFolder.collectionId).toBe(result.collections[0].id);
  });

  it('请求挂在正确的文件夹下，顶级请求 folderId 为 null', () => {
    expect(findRequest(result, '查询用户列表').folderId).toBe(findFolder(result, '用户中心').id);
    expect(findRequest(result, '更新订单备注').folderId).toBe(findFolder(result, '子模块').id);
    expect(findRequest(result, '临时请求').folderId).toBeNull();
  });
});

describe('Postman 导入器 · URL 与参数', () => {
  const result = importPostmanCollection(loadFixture('edge-cases.json'));

  it('没有 raw 时用 host[] + path[] 拼出 URL', () => {
    expect(findRequest(result, '没有 raw 的 URL').url).toBe('https://api.example.com/v1/health');
  });

  it('host/path 拼接时会带上端口', () => {
    expect(findRequest(result, '带端口的 URL').url).toBe('http://127.0.0.1:8080/ping');
  });

  it('存在 url.raw 时优先用 raw', () => {
    expect(findRequest(result, '行内 query 的 URL').url).toBe(
      'https://api.example.com/v1/search?q={{keyword}}&page=1',
    );
  });

  it('query 里的 {{变量}} 原样保留', () => {
    const basic = importPostmanCollection(loadFixture('basic-collection.json'));
    const params = findRequest(basic, '查询用户列表').params;
    expect(params.map((item) => item.key)).toEqual(['page', 'keyword', 'trace']);
    expect(params.find((item) => item.key === 'keyword')?.value).toBe('{{keyword}}');
  });

  it('query 的 disabled:true 转成 enabled:false', () => {
    const basic = importPostmanCollection(loadFixture('basic-collection.json'));
    const params = findRequest(basic, '查询用户列表').params;
    expect(params.find((item) => item.key === 'page')?.enabled).toBe(true);
    expect(params.find((item) => item.key === 'trace')?.enabled).toBe(false);
  });

  it('header 的 disabled:true 转成 enabled:false', () => {
    const basic = importPostmanCollection(loadFixture('basic-collection.json'));
    const headers = findRequest(basic, '查询用户列表').headers;
    expect(headers.find((item) => item.key === 'Accept')?.enabled).toBe(true);
    expect(headers.find((item) => item.key === 'X-Debug')?.enabled).toBe(false);
    expect(headers.find((item) => item.key === 'X-Request-Id')?.description).toBe('链路追踪 ID');
  });

  it('请求方法会被大写化', () => {
    const basic = importPostmanCollection(loadFixture('basic-collection.json'));
    expect(findRequest(basic, '查询用户列表').method).toBe('GET');
    expect(findRequest(basic, '创建用户').method).toBe('POST');
    expect(findRequest(basic, '更新订单备注').method).toBe('PUT');
  });

  it('不支持的请求方法降级成 GET 并给出警告', () => {
    const request = findRequest(result, '不支持的请求方法');
    expect(request.method).toBe('GET');
    expect(result.warnings.some((item) => item.message.includes('trace'))).toBe(true);
  });
});

describe('Postman 导入器 · 请求体', () => {
  const basic = importPostmanCollection(loadFixture('basic-collection.json'));
  const edge = importPostmanCollection(loadFixture('edge-cases.json'));

  it('raw + language=json → json 模式', () => {
    const body = findRequest(basic, '创建用户').body;
    expect(body.mode).toBe('json');
    expect(body.raw).toContain('zhangsan@example.com');
  });

  it('raw + language=text → text 模式', () => {
    const body = findRequest(edge, '纯文本请求体').body;
    expect(body.mode).toBe('text');
    expect(body.raw).toBe('这是一段纯文本');
  });

  it('urlencoded → form-urlencoded 模式并还原表单', () => {
    const body = findRequest(basic, '更新订单备注').body;
    expect(body.mode).toBe('form-urlencoded');
    expect(body.form.map((item) => item.key)).toEqual(['remark', 'notify']);
    expect(body.form[0].value).toBe('加急');
  });

  it('formdata → form-data 模式并还原分段', () => {
    const body = findRequest(edge, '带文件字段的表单').body;
    expect(body.mode).toBe('form-data');
    expect(body.formData).toHaveLength(2);
    expect(body.formData[0]).toMatchObject({ key: 'title', value: '周报', isFile: false });
    expect(body.formData[1]).toMatchObject({ key: 'attachment', isFile: true, fileName: 'C:\\Users\\demo\\report.pdf' });
  });

  it('file → binary 模式，并提示文件内容没导进来', () => {
    const body = findRequest(edge, '文件请求体').body;
    expect(body.mode).toBe('binary');
    expect(body.binaryFileName).toBe('C:\\Users\\demo\\report.pdf');
    expect(body.binaryMimeType).toBe('application/pdf');
    expect(edge.warnings.some((item) => item.message.includes('文件'))).toBe(true);
  });

  it('graphql → json 模式，并给出降级警告', () => {
    const body = findRequest(edge, 'GraphQL 请求').body;
    expect(body.mode).toBe('json');
    expect(body.raw).toContain('GetUser');
    expect(edge.warnings.some((item) => item.message.includes('GraphQL'))).toBe(true);
  });

  it('没有 body 的请求是 none 模式', () => {
    expect(findRequest(basic, '查询用户列表').body.mode).toBe('none');
  });
});

describe('Postman 导入器 · 鉴权', () => {
  const result = importPostmanCollection(loadFixture('auth-variants.json'));

  it('noauth → none', () => {
    expect(findRequest(result, '无鉴权').auth.type).toBe('none');
  });

  it('basic → username / password', () => {
    const auth = findRequest(result, 'Basic 鉴权').auth;
    expect(auth.type).toBe('basic');
    expect(auth.username).toBe('demo');
    expect(auth.password).toBe('s3cret');
  });

  it('bearer → token', () => {
    const auth = findRequest(result, 'Bearer 鉴权').auth;
    expect(auth.type).toBe('bearer');
    expect(auth.token).toBe('{{authToken}}');
  });

  it('apikey（header）→ apiKey / apiValue / apiKeyIn', () => {
    const auth = findRequest(result, 'ApiKey 鉴权（Header）').auth;
    expect(auth.type).toBe('apikey');
    expect(auth.apiKey).toBe('X-Api-Key');
    expect(auth.apiValue).toBe('{{apiKey}}');
    expect(auth.apiKeyIn).toBe('header');
  });

  it('apikey（query）→ apiKeyIn 为 query', () => {
    const auth = findRequest(result, 'ApiKey 鉴权（Query）').auth;
    expect(auth.type).toBe('apikey');
    expect(auth.apiKey).toBe('api_key');
    expect(auth.apiKeyIn).toBe('query');
  });

  it('oauth2 → oauthToken', () => {
    const auth = findRequest(result, 'OAuth2 鉴权').auth;
    expect(auth.type).toBe('oauth2');
    expect(auth.oauthToken).toBe('{{accessToken}}');
  });

  it('digest 保留配置但给出"暂未实现"的警告', () => {
    const auth = findRequest(result, 'Digest 鉴权').auth;
    expect(auth.type).toBe('digest');
    expect(auth.digestUsername).toBe('demo');
    expect(result.warnings.some((item) => item.message.includes('Digest'))).toBe(true);
  });

  it('hawk 降级为 none，并且必须产生警告（防止静默降级）', () => {
    const auth = findRequest(result, 'Hawk 鉴权').auth;
    expect(auth.type).toBe('none');
    const warning = result.warnings.find((item) => item.message.includes('hawk'));
    expect(warning).toBeDefined();
    expect(warning?.level).toBe('warning');
    expect(warning?.requestName).toBe('Hawk 鉴权');
  });

  it('awsv4 降级为 none，并且必须产生警告', () => {
    expect(findRequest(result, 'AWS SigV4 鉴权').auth.type).toBe('none');
    const warning = result.warnings.find((item) => item.message.includes('awsv4'));
    expect(warning).toBeDefined();
    expect(warning?.level).toBe('warning');
  });

  it('edgegrid / ntlm 也都降级并产生警告', () => {
    expect(findRequest(result, 'EdgeGrid 鉴权').auth.type).toBe('none');
    expect(findRequest(result, 'NTLM 鉴权').auth.type).toBe('none');
    expect(result.warnings.some((item) => item.message.includes('edgegrid'))).toBe(true);
    expect(result.warnings.some((item) => item.message.includes('ntlm'))).toBe(true);
  });

  it('降级的鉴权会计入 skipped', () => {
    // hawk + awsv4 + edgegrid + ntlm = 4 个降级，加上 digest（本项目未实现）= 5
    expect(result.stats.skipped).toBe(5);
  });
});

describe('Postman 导入器 · 脚本与事件', () => {
  const basic = importPostmanCollection(loadFixture('basic-collection.json'));
  const edge = importPostmanCollection(loadFixture('edge-cases.json'));

  it('prerequest → preScript，test → postScript', () => {
    const request = findRequest(basic, '查询用户列表');
    expect(request.preScript).toContain('准备请求用户列表');
    expect(request.postScript).toContain('状态码为 200');
  });

  it('script.exec 是数组时按换行 join', () => {
    const request = findRequest(basic, '查询用户列表');
    expect(request.postScript.split('\n')).toEqual([
      "pm.test('状态码为 200', function () {",
      '    pm.response.to.have.status(200);',
      '});',
    ]);
  });

  it('多个同类 event 会合并', () => {
    const request = findRequest(edge, '多个脚本事件');
    expect(request.preScript).toBe("console.log('第一段前置脚本');\nconsole.log('第二段前置脚本');");
    expect(request.postScript).toBe("console.log('第一段测试脚本');\nconsole.log('第二段测试脚本');");
  });

  it('没有 event 的请求脚本为空字符串', () => {
    expect(findRequest(basic, '临时请求').preScript).toBe('');
    expect(findRequest(basic, '临时请求').postScript).toBe('');
  });
});

describe('Postman 导入器 · 变量与示例响应', () => {
  it('item[].variable[] 提升为集合变量', () => {
    const edge = importPostmanCollection(loadFixture('edge-cases.json'));
    expect(edge.collections[0].variables).toHaveLength(1);
    expect(edge.collections[0].variables[0]).toMatchObject({
      key: 'collectionLevelKey',
      value: 'collectionLevelValue',
      enabled: true,
    });
  });

  it('顶层 variable[] 会变成一个独立环境', () => {
    const basic = importPostmanCollection(loadFixture('basic-collection.json'));
    expect(basic.environments).toHaveLength(1);
    expect(basic.environments[0].name).toBe('示例 REST API 变量');
    expect(basic.environments[0].values.map((item) => item.key)).toEqual(['baseUrl', 'authToken']);
    // 顶层变量里 type=secret 的那个会让整个环境被标记为敏感
    expect(basic.environments[0].secret).toBe(true);
  });

  it('示例响应 response[] 被丢弃，并且计入 skipped', () => {
    const basic = importPostmanCollection(loadFixture('basic-collection.json'));
    expect(basic.stats.skipped).toBe(1);
    expect(basic.warnings.some((item) => item.message.includes('示例响应'))).toBe(true);
  });

  it('丢弃的响应不会变成请求', () => {
    const basic = importPostmanCollection(loadFixture('basic-collection.json'));
    expect(basic.requests.map((item) => item.name)).not.toContain('成功');
  });
});

describe('Postman 导入器 · 环境文件', () => {
  const result = importPostmanEnvironment(loadFixture('environment.json'));

  it('能导入环境名与变量表', () => {
    expect(result.environments).toHaveLength(1);
    expect(result.environments[0].name).toBe('开发环境');
    expect(result.environments[0].values.map((item) => item.key)).toEqual([
      'baseUrl',
      'authToken',
      'keyword',
      'oldApiKey',
    ]);
    expect(result.environments[0].values[0].value).toBe('https://api.dev.example.com');
  });

  it('enabled:false 的变量导入成未启用', () => {
    const old = result.environments[0].values.find((item) => item.key === 'oldApiKey');
    expect(old?.enabled).toBe(false);
  });

  it('存在 type=secret 的变量时环境被标记为敏感', () => {
    expect(result.environments[0].secret).toBe(true);
  });

  it('环境导入不会带出集合/文件夹/请求', () => {
    expect(result.collections).toHaveLength(0);
    expect(result.folders).toHaveLength(0);
    expect(result.requests).toHaveLength(0);
    expect(result.stats.environments).toBe(1);
  });
});

describe('Postman 导入器 · 健壮性与错误处理', () => {
  it('根节点不是对象时抛出中文错误', () => {
    expect(() => importPostmanCollection(null)).toThrow(/导入失败/);
    expect(() => importPostmanCollection('not a collection')).toThrow(/导入失败/);
    expect(() => importPostmanCollection([1, 2, 3])).toThrow(/导入失败/);
  });

  it('环境文件缺少 values 时抛出中文错误', () => {
    expect(() => importPostmanEnvironment({ name: '没有 values' })).toThrow(/导入失败/);
    expect(() => importPostmanEnvironment(null)).toThrow(/导入失败/);
  });

  it('空集合不会崩', () => {
    const result = importPostmanCollection({ info: { name: '空集合' } });
    expect(result.collections[0].name).toBe('空集合');
    expect(result.requests).toHaveLength(0);
    expect(result.folders).toHaveLength(0);
    expect(result.stats.skipped).toBe(0);
  });

  it('缺少 info 字段时使用默认名称并给出提示', () => {
    const result = importPostmanCollection({ item: [] });
    expect(result.collections[0].name).toBe('未命名集合');
    expect(result.warnings.some((item) => item.message.includes('info'))).toBe(true);
  });

  it('item 不是对象时跳过并计数', () => {
    const result = importPostmanCollection({
      info: { name: '脏数据' },
      item: ['坏条目', { name: '好条目', request: { method: 'GET', url: { raw: 'https://api.example.com/ok' } } }],
    });
    expect(result.requests).toHaveLength(1);
    expect(result.stats.skipped).toBe(1);
  });
});

describe('Postman 导出器', () => {
  const imported = importPostmanCollection(loadFixture('basic-collection.json'));
  const exported = exportPostmanCollection(imported.collections[0], imported.folders, imported.requests);

  it('info 里带 _postman_id / name / schema', () => {
    const info = exported.info as Record<string, unknown>;
    expect(info._postman_id).toBe(imported.collections[0].id);
    expect(info.name).toBe('示例 REST API');
    expect(String(info.schema)).toContain('v2.1.0');
  });

  it('URL 同时写 raw 与 host/path 数组', () => {
    const node = findExportedNode(exported.item as unknown[], '查询用户列表');
    const request = node.request as Record<string, unknown>;
    const url = request.url as Record<string, unknown>;
    expect(url.raw).toBe('https://api.example.com/v1/users');
    expect(url.protocol).toBe('https');
    expect(url.host).toEqual(['api', 'example', 'com']);
    expect(url.path).toEqual(['v1', 'users']);
  });

  it('header / query 会带上 disabled 标记', () => {
    const node = findExportedNode(exported.item as unknown[], '查询用户列表');
    const request = node.request as Record<string, unknown>;
    const header = request.header as Record<string, unknown>[];
    const url = request.url as Record<string, unknown>;
    const query = url.query as Record<string, unknown>[];
    expect(header.find((item2) => item2.key === 'X-Debug')?.disabled).toBe(true);
    expect(header.find((item2) => item2.key === 'Accept')?.disabled).toBeUndefined();
    expect(query.find((item2) => item2.key === 'trace')?.disabled).toBe(true);
  });

  it('鉴权导出成 Postman 的数组形式', () => {
    const node = findExportedNode(exported.item as unknown[], '创建用户');
    const request = node.request as Record<string, unknown>;
    const auth = request.auth as Record<string, unknown>;
    expect(auth.type).toBe('bearer');
    expect(Array.isArray(auth.bearer)).toBe(true);
    expect((auth.bearer as Record<string, unknown>[])[0]).toMatchObject({ key: 'token', value: '{{authToken}}' });
  });

  it('空脚本不会输出 event', () => {
    const node = findExportedNode(exported.item as unknown[], '临时请求');
    expect(node.event).toBeUndefined();
  });

  it('有脚本的请求会输出 event（exec 是字符串数组）', () => {
    const node = findExportedNode(exported.item as unknown[], '查询用户列表');
    const events = node.event as Record<string, unknown>[];
    expect(events.map((event) => event.listen)).toEqual(['prerequest', 'test']);
    const script = events[0].script as Record<string, unknown>;
    expect(Array.isArray(script.exec)).toBe(true);
  });

  it('集合变量输出到 variable[]', () => {
    const collection = { ...imported.collections[0], variables: [{ id: 'kv_1', key: 'baseUrl', value: 'https://x', enabled: true }] };
    const output = exportPostmanCollection(collection, [], []);
    expect(output.variable).toEqual([{ key: 'baseUrl', value: 'https://x', type: 'string' }]);
  });

  it('导出的环境是 Postman 的环境结构', () => {
    const env = importPostmanEnvironment(loadFixture('environment.json')).environments[0];
    const output = exportPostmanEnvironment(env);
    expect(output.name).toBe('开发环境');
    expect(output.id).toBe(env.id);
    expect(output._postman_variable_scope).toBe('environment');
    const values = output.values as Record<string, unknown>[];
    expect(values.find((item) => item.key === 'authToken')?.type).toBe('secret');
    expect(values.find((item) => item.key === 'oldApiKey')?.enabled).toBe(false);
  });
});

describe('Postman 导出/导入 · 往返一致性', () => {
  it('导出 → 导入 → 再导出，三次结果等价（id 除外）', () => {
    const first = importPostmanCollection(loadFixture('basic-collection.json'));
    const exportedOnce = exportPostmanCollection(first.collections[0], first.folders, first.requests);

    const second = importPostmanCollection(exportedOnce);
    const exportedTwice = exportPostmanCollection(second.collections[0], second.folders, second.requests);

    const third = importPostmanCollection(exportedTwice);
    const exportedThrice = exportPostmanCollection(third.collections[0], third.folders, third.requests);

    expect(normalizeCollection(exportedTwice)).toEqual(normalizeCollection(exportedOnce));
    expect(normalizeCollection(exportedThrice)).toEqual(normalizeCollection(exportedTwice));

    // 往返之后集合结构本身也要一致（请求数、文件夹数、层级）
    expect(second.stats.requests).toBe(first.stats.requests);
    expect(second.stats.folders).toBe(first.stats.folders);
    expect(second.requests.map((item) => item.name)).toEqual(first.requests.map((item) => item.name));
    expect(second.folders.map((item) => item.name)).toEqual(first.folders.map((item) => item.name));
  });

  it('往返之后请求的各个字段都保持一致', () => {
    const first = importPostmanCollection(loadFixture('basic-collection.json'));
    const exportedOnce = exportPostmanCollection(first.collections[0], first.folders, first.requests);
    const second = importPostmanCollection(exportedOnce);

    const before = findRequest(first, '查询用户列表');
    const after = findRequest(second, '查询用户列表');

    expect(after.method).toBe(before.method);
    expect(after.url).toBe(before.url);
    expect(stripIds(after.params)).toEqual(stripIds(before.params));
    expect(stripIds(after.headers)).toEqual(stripIds(before.headers));
    expect(stripIds(after.body)).toEqual(stripIds(before.body));
    expect(stripIds(after.auth)).toEqual(stripIds(before.auth));
    expect(after.preScript).toBe(before.preScript);
    expect(after.postScript).toBe(before.postScript);
  });

  it('已知不对称：集合变量导出到根 variable[]，再导入会变成环境变量', () => {
    // 这条测试是为了把"规格决定的已知不对称"钉死，避免以后被当成 bug 误改。
    // 背景：导入侧按规格把「顶层 variable[]」变成 Environment，
    // 而导出侧按规格把 Collection.variables 写回「顶层 variable[]」。
    const first = importPostmanCollection(loadFixture('basic-collection.json'));
    const collection = {
      ...first.collections[0],
      variables: [{ id: 'kv_1', key: 'baseUrl', value: 'https://x', enabled: true }],
    };
    const exported = exportPostmanCollection(collection, [], []);
    expect(exported.variable).toEqual([{ key: 'baseUrl', value: 'https://x', type: 'string' }]);

    const second = importPostmanCollection(exported);
    expect(second.environments).toHaveLength(1);
    expect(second.environments[0].values[0].key).toBe('baseUrl');
    expect(second.collections[0].variables).toHaveLength(0);
  });

  it('环境导出 → 导入 → 再导出也是等价的', () => {
    const env = importPostmanEnvironment(loadFixture('environment.json')).environments[0];
    const exported = exportPostmanEnvironment(env);
    const reimported = importPostmanEnvironment(exported).environments[0];
    const exportedAgain = exportPostmanEnvironment(reimported);

    expect(exportedAgain.name).toBe(exported.name);
    expect(exportedAgain.values).toEqual(exported.values);
    expect(reimported.secret).toBe(true);
  });
});
