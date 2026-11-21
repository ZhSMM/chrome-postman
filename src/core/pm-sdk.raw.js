/**
 * ============================================================
 * pm SDK —— 运行在 QuickJS 沙箱里的「Postman 兼容 API」
 * ============================================================
 *
 * 【在架构中的位置】
 * 这份代码 **不会** 被打进 UI bundle，而是以「纯源码字符串」的形式
 * 注入到 QuickJS 沙箱里，在用户脚本之前执行。
 *
 *   宿主 (Service Worker)
 *     └─ newContext()
 *          ├─ evalCode(pm-sdk 源码)   ← 装好 pm / console / expect
 *          └─ evalCode(用户脚本)        ← 用户写的是 pm.environment.set(...)
 *
 * 【为什么用 QuickJS 而不是 eval】
 * Chrome 扩展页面的 CSP 是 `script-src 'self'`，**禁止 eval / new Function**。
 * 所以常见的「new Function('pm', code)」方案在 MV3 里是行不通的。
 * QuickJS 把真正的 JS 引擎编译成 WebAssembly 跑在沙箱里，
 * 既能执行任意用户 JS，又不受扩展 CSP 限制，还自带内存/超时隔离。
 *
 * 【宿主与沙箱之间怎么通信】
 * - 宿主 → 沙箱：把 request / response / 变量包塞进 globalThis.__state
 * - 沙箱 → 宿主：只有一个原生函数 __hostLog(level, message)；
 *   其余数据（脚本改了哪些 header、断言结果、变量）都写回 __state，
 *   宿主执行完一次性 dump 出来。
 *
 * 【给初学者的提示】
 * 这个文件是"普通 JS"，不是 TypeScript，所以：
 *   - 没有类型注解
 *   - 用 var/let/const 都可以
 *   - 不能 import 任何外部模块
 */

(function bootstrapPmSdk() {
  'use strict';

  // 宿主注入的状态对象
  var state = globalThis.__state;
  if (!state) {
    throw new Error('pm SDK 未初始化：缺少 __state');
  }

  /* ---------------------------------------------------------------
   * 1. 日志：把 console.log 转发给宿主
   * ------------------------------------------------------------- */

  function formatArg(arg) {
    if (typeof arg === 'string') return arg;
    if (arg === undefined) return 'undefined';
    if (arg === null) return 'null';
    if (typeof arg === 'object') {
      try {
        return JSON.stringify(arg);
      } catch (e) {
        return String(arg);
      }
    }
    return String(arg);
  }

  function log(level, args) {
    var message = Array.prototype.map.call(args, formatArg).join(' ');
    if (typeof globalThis.__hostLog === 'function') {
      globalThis.__hostLog(level, message);
    }
    state.logs.push({ level: level, message: message, timestamp: Date.now() });
  }

  var sandboxConsole = {
    log: function () { log('log', arguments); },
    info: function () { log('log', arguments); },
    debug: function () { log('log', arguments); },
    warn: function () { log('warn', arguments); },
    error: function () { log('error', arguments); },
  };
  globalThis.console = sandboxConsole;

  /* ---------------------------------------------------------------
   * 2. HeaderList：请求头 / 响应头的增删改查
   * ------------------------------------------------------------- */

  function HeaderList(list) {
    this.list = list || [];
  }

  HeaderList.prototype._findIndex = function (name) {
    var lower = String(name).toLowerCase();
    for (var i = 0; i < this.list.length; i += 1) {
      if (String(this.list[i].key).toLowerCase() === lower) return i;
    }
    return -1;
  };

  HeaderList.prototype.add = function (a, b) {
    var name = typeof a === 'object' && a !== null ? a.name : a;
    var value = typeof a === 'object' && a !== null ? a.value : b;
    if (!name) return;
    this.list.push({ key: String(name), value: value === undefined ? '' : String(value), enabled: true });
  };

  HeaderList.prototype.upsert = function (a, b) {
    var name = typeof a === 'object' && a !== null ? a.name : a;
    var value = typeof a === 'object' && a !== null ? a.value : b;
    if (!name) return;
    var index = this._findIndex(name);
    if (index === -1) {
      this.add(name, value);
    } else {
      this.list[index].value = value === undefined ? '' : String(value);
      this.list[index].enabled = true;
    }
  };

  HeaderList.prototype.remove = function (name) {
    var lower = String(name).toLowerCase();
    this.list = this.list.filter(function (item) {
      return String(item.key).toLowerCase() !== lower;
    });
    // HeaderList 的 list 可能是 state 里的数组，filter 返回新数组后需要同步回去
    if (state.request && state.request.headers === this.list) {
      state.request.headers = this.list;
    }
  };

  HeaderList.prototype.get = function (name) {
    var index = this._findIndex(name);
    return index === -1 ? undefined : this.list[index].value;
  };

  HeaderList.prototype.has = function (name) {
    return this._findIndex(name) !== -1;
  };

  HeaderList.prototype.all = function () {
    return this.list.map(function (item) {
      return { key: item.key, value: item.value };
    });
  };

  HeaderList.prototype.toObject = function () {
    var obj = {};
    this.list.forEach(function (item) {
      obj[item.key] = item.value;
    });
    return obj;
  };

  HeaderList.prototype.count = function () {
    return this.list.length;
  };

  /* ---------------------------------------------------------------
   * 3. 变量仓库：pm.environment / pm.globals / pm.variables
   * ------------------------------------------------------------- */

  function VarStore(bag, fallback) {
    this.bag = bag || {};
    this.fallback = fallback || null; // 读取时的兜底作用域（pm.variables 用）
  }

  VarStore.prototype.get = function (key) {
    if (Object.prototype.hasOwnProperty.call(this.bag, key)) return this.bag[key];
    if (this.fallback && Object.prototype.hasOwnProperty.call(this.fallback, key)) {
      return this.fallback[key];
    }
    return undefined;
  };

  VarStore.prototype.set = function (key, value) {
    this.bag[key] = value === undefined || value === null ? '' : String(value);
  };

  VarStore.prototype.unset = function (key) {
    delete this.bag[key];
  };

  VarStore.prototype.delete = function (key) {
    this.unset(key);
  };

  VarStore.prototype.has = function (key) {
    return Object.prototype.hasOwnProperty.call(this.bag, key) ||
      (this.fallback ? Object.prototype.hasOwnProperty.call(this.fallback, key) : false);
  };

  VarStore.prototype.clear = function () {
    var self = this;
    Object.keys(this.bag).forEach(function (key) {
      delete self.bag[key];
    });
  };

  VarStore.prototype.toObject = function () {
    var obj = {};
    var self = this;
    Object.keys(this.bag).forEach(function (key) {
      obj[key] = self.bag[key];
    });
    return obj;
  };

  /* ---------------------------------------------------------------
   * 4. 断言：pm.expect(value) —— 迷你版 chai
   * ------------------------------------------------------------- */

  function deepEqual(a, b) {
    if (a === b) return true;
    if (typeof a !== typeof b) return false;
    if (a === null || b === null) return false;
    if (typeof a !== 'object') return Number.isNaN(a) && Number.isNaN(b);
    if (Array.isArray(a) !== Array.isArray(b)) return false;
    var aKeys = Object.keys(a);
    var bKeys = Object.keys(b);
    if (aKeys.length !== bKeys.length) return false;
    for (var i = 0; i < aKeys.length; i += 1) {
      if (!Object.prototype.hasOwnProperty.call(b, aKeys[i])) return false;
      if (!deepEqual(a[aKeys[i]], b[aKeys[i]])) return false;
    }
    return true;
  }

  function typeOf(value) {
    if (value === null) return 'null';
    if (Array.isArray(value)) return 'array';
    return typeof value;
  }

  function Assertion(value, negate, deep) {
    this._value = value;
    this._negate = !!negate;
    this._deep = !!deep;
  }

  // 链式属性，全部返回自身
  // 注意：这里只能放"纯链式词"。像 an / a 这种要带参数调用的，
  // 必须是普通方法（不能是 getter），否则后面赋值会报 "no setter for property"。
  ['to', 'be', 'been', 'is', 'that', 'which', 'and', 'has', 'have', 'with', 'the'].forEach(function (word) {
    Object.defineProperty(Assertion.prototype, word, {
      get: function () { return this; },
      configurable: true,
    });
  });

  Object.defineProperty(Assertion.prototype, 'not', {
    get: function () { return new Assertion(this._value, !this._negate, this._deep); },
    configurable: true,
  });

  Object.defineProperty(Assertion.prototype, 'deep', {
    get: function () { return new Assertion(this._value, this._negate, true); },
    configurable: true,
  });

  Assertion.prototype._assert = function (condition, message, negatedMessage) {
    var ok = this._negate ? !condition : condition;
    if (!ok) throw new Error(this._negate ? negatedMessage : message);
    return this;
  };

  Assertion.prototype.a = function (type) {
    return this._assert(typeOf(this._value) === type, 'expected ' + JSON.stringify(this._value) + ' to be a ' + type, 'expected ' + JSON.stringify(this._value) + ' not to be a ' + type);
  };

  Assertion.prototype.an = Assertion.prototype.a;

  Assertion.prototype.equal = function (expected) {
    var same = this._deep ? deepEqual(this._value, expected) : this._value === expected;
    return this._assert(same, 'expected ' + JSON.stringify(this._value) + ' to equal ' + JSON.stringify(expected), 'expected ' + JSON.stringify(this._value) + ' not to equal ' + JSON.stringify(expected));
  };

  Assertion.prototype.equals = Assertion.prototype.equal;
  Assertion.prototype.eq = Assertion.prototype.equal;

  Assertion.prototype.eql = function (expected) {
    return this._assert(deepEqual(this._value, expected), 'expected ' + JSON.stringify(this._value) + ' to deeply equal ' + JSON.stringify(expected), 'expected ' + JSON.stringify(this._value) + ' not to deeply equal ' + JSON.stringify(expected));
  };

  Assertion.prototype.include = function (item) {
    var contains = false;
    if (typeof this._value === 'string') {
      contains = this._value.indexOf(String(item)) !== -1;
    } else if (Array.isArray(this._value)) {
      contains = this._value.some(function (v) { return deepEqual(v, item); });
    } else if (this._value && typeof this._value === 'object') {
      contains = Object.prototype.hasOwnProperty.call(this._value, item);
    }
    return this._assert(contains, 'expected ' + JSON.stringify(this._value) + ' to include ' + JSON.stringify(item), 'expected ' + JSON.stringify(this._value) + ' not to include ' + JSON.stringify(item));
  };

  Assertion.prototype.contain = Assertion.prototype.include;
  Assertion.prototype.includes = Assertion.prototype.include;

  Assertion.prototype.property = function (name, value) {
    var has = this._value !== null && typeof this._value === 'object' &&
      Object.prototype.hasOwnProperty.call(this._value, name);
    if (arguments.length > 1 && has) {
      has = deepEqual(this._value[name], value);
    }
    return this._assert(has, 'expected object to have property ' + JSON.stringify(name) + (arguments.length > 1 ? ' with value ' + JSON.stringify(value) : ''), 'expected object not to have property ' + JSON.stringify(name));
  };

  Assertion.prototype.status = function (code) {
    var actual = this._value && typeof this._value === 'object' && this._value.code !== undefined ? this._value.code : this._value;
    return this._assert(actual === code, 'expected status ' + actual + ' to equal ' + code, 'expected status not to equal ' + code);
  };

  Assertion.prototype.ok = function () {
    return this._assert(!!this._value, 'expected ' + JSON.stringify(this._value) + ' to be truthy', 'expected ' + JSON.stringify(this._value) + ' to be falsy');
  };

  Assertion.prototype.true = function () {
    return this._assert(this._value === true, 'expected ' + JSON.stringify(this._value) + ' to be true', 'expected ' + JSON.stringify(this._value) + ' not to be true');
  };

  Assertion.prototype.false = function () {
    return this._assert(this._value === false, 'expected ' + JSON.stringify(this._value) + ' to be false', 'expected ' + JSON.stringify(this._value) + ' not to be false');
  };

  Assertion.prototype.above = function (n) {
    return this._assert(this._value > n, 'expected ' + this._value + ' to be above ' + n, 'expected ' + this._value + ' not to be above ' + n);
  };
  Assertion.prototype.gt = Assertion.prototype.above;

  Assertion.prototype.below = function (n) {
    return this._assert(this._value < n, 'expected ' + this._value + ' to be below ' + n, 'expected ' + this._value + ' not to be below ' + n);
  };
  Assertion.prototype.lt = Assertion.prototype.below;

  Assertion.prototype.least = function (n) {
    return this._assert(this._value >= n, 'expected ' + this._value + ' to be at least ' + n, 'expected ' + this._value + ' not to be at least ' + n);
  };
  Assertion.prototype.gte = Assertion.prototype.least;

  Assertion.prototype.most = function (n) {
    return this._assert(this._value <= n, 'expected ' + this._value + ' to be at most ' + n, 'expected ' + this._value + ' not to be at most ' + n);
  };
  Assertion.prototype.lte = Assertion.prototype.most;

  Assertion.prototype.length = function (n) {
    var len = this._value && this._value.length !== undefined ? this._value.length : undefined;
    return this._assert(len === n, 'expected length ' + len + ' to equal ' + n, 'expected length not to equal ' + n);
  };

  Assertion.prototype.match = function (pattern) {
    var re = pattern instanceof RegExp ? pattern : new RegExp(pattern);
    return this._assert(re.test(String(this._value)), 'expected ' + JSON.stringify(this._value) + ' to match ' + re, 'expected ' + JSON.stringify(this._value) + ' not to match ' + re);
  };

  Assertion.prototype.oneOf = function (list) {
    var contains = Array.isArray(list) && list.some(function (v) { return deepEqual(v, this._value); }, this);
    return this._assert(contains, 'expected ' + JSON.stringify(this._value) + ' to be one of ' + JSON.stringify(list), 'expected ' + JSON.stringify(this._value) + ' not to be one of ' + JSON.stringify(list));
  };

  Assertion.prototype.empty = function () {
    var isEmpty = this._value === null || this._value === undefined ||
      (typeof this._value === 'string' && this._value === '') ||
      (Array.isArray(this._value) && this._value.length === 0) ||
      (typeof this._value === 'object' && Object.keys(this._value).length === 0);
    return this._assert(isEmpty, 'expected value to be empty', 'expected value not to be empty');
  };

  /* ---------------------------------------------------------------
   * 4b. 响应相关断言
   *
   * 【为什么单独开一块】
   * 上面这些断言是对"任意值"用的（equal、include…），
   * 而 header / jsonBody / body / json 这几个是专门针对**响应**的。
   * 它们在 Postman 里非常常用，从 Postman 迁过来的用户会直接写，
   * 所以这里补上，避免用户写了却报错。
   * ------------------------------------------------------------- */

  /**
   * 断言响应头存在（或值相等）。
   * 用法：pm.response.to.have.header('Content-Type');
   *      pm.response.to.have.header('Content-Type', 'application/json');
   */
  Assertion.prototype.header = function (name, value) {
    var headers = this._value && this._value.headers ? this._value.headers : null;
    var actual = undefined;
    if (headers) {
      if (typeof headers.get === 'function') {
        actual = headers.get(name);
      } else if (typeof headers === 'object') {
        // 兜底：headers 是普通对象时，按 key 大小写不敏感地找
        var lower = String(name).toLowerCase();
        var keys = Object.keys(headers);
        for (var i = 0; i < keys.length; i += 1) {
          if (keys[i].toLowerCase() === lower) {
            actual = headers[keys[i]];
            break;
          }
        }
      }
    }
    var has = actual !== undefined && actual !== null;
    if (arguments.length > 1 && has) {
      has = String(actual) === String(value);
    }
    var expected = arguments.length > 1
      ? 'expected header "' + name + '" to equal "' + value + '"'
      : 'expected header "' + name + '" to exist';
    var negated = arguments.length > 1
      ? 'expected header "' + name + '" not to equal "' + value + '"'
      : 'expected header "' + name + '" not to exist';
    return this._assert(has, expected, negated);
  };

  /**
   * 断言响应体是合法 JSON，且某个路径的值符合预期。
   * 用法：pm.response.to.have.jsonBody('data.id', 42);
   *      pm.response.to.have.jsonBody('ok');          // 只检查字段存在
   */
  Assertion.prototype.jsonBody = function (path, value) {
    var parsed = null;
    var raw = this._value && this._value.body !== undefined ? String(this._value.body) : '';
    try {
      parsed = JSON.parse(raw);
    } catch (e) {
      return this._assert(
        false,
        'expected response body to be valid JSON',
        'expected response body not to be valid JSON',
      );
    }
    // 支持 'a.b.c' 这样的路径写法
    var parts = String(path).split('.');
    var actual = parsed;
    for (var i = 0; i < parts.length; i += 1) {
      if (actual === null || actual === undefined) break;
      actual = actual[parts[i]];
    }
    var has = actual !== undefined;
    if (arguments.length > 1 && has) {
      has = deepEqual(actual, value);
    }
    var expected = arguments.length > 1
      ? 'expected json body at "' + path + '" to equal ' + JSON.stringify(value)
      : 'expected json body to have "' + path + '"';
    var negated = arguments.length > 1
      ? 'expected json body at "' + path + '" not to equal ' + JSON.stringify(value)
      : 'expected json body not to have "' + path + '"';
    return this._assert(has, expected, negated);
  };

  /**
   * 断言响应体包含某段文本。
   * 用法：pm.response.to.have.body('"ok":true');
   */
  Assertion.prototype.body = function (text) {
    var raw = this._value && this._value.body !== undefined ? String(this._value.body) : '';
    var has = raw.indexOf(String(text)) !== -1;
    return this._assert(
      has,
      'expected response body to contain "' + text + '"',
      'expected response body not to contain "' + text + '"',
    );
  };

  /**
   * 断言响应体是合法 JSON。
   * 用法：pm.response.to.be.json();
   */
  Assertion.prototype.json = function () {
    var raw = this._value && this._value.body !== undefined ? String(this._value.body) : '';
    var ok = true;
    try {
      JSON.parse(raw);
    } catch (e) {
      ok = false;
    }
    return this._assert(
      ok,
      'expected response body to be valid JSON',
      'expected response body not to be valid JSON',
    );
  };

  function expect(value) {
    return new Assertion(value, false, false);
  }
  globalThis.expect = expect;

  /* ---------------------------------------------------------------
   * 5. pm 对象
   * ------------------------------------------------------------- */

  function buildRequestApi() {
    var request = state.request;
    var body = {
      mode: request.body && request.body.mode ? request.body.mode : 'none',
      get raw() {
        return request.body && request.body.raw !== undefined ? request.body.raw : '';
      },
      set raw(value) {
        if (!request.body) request.body = { mode: 'none', raw: '', form: [], formData: [] };
        request.body.raw = value === undefined || value === null ? '' : String(value);
      },
      toString: function () {
        return this.raw;
      },
      json: function () {
        try {
          return JSON.parse(this.raw);
        } catch (e) {
          throw new Error('响应体不是合法 JSON：' + e.message);
        }
      },
    };

    return {
      get method() { return request.method; },
      set method(value) { request.method = String(value).toUpperCase(); },
      url: {
        toString: function () { return request.url; },
        get raw() { return request.url; },
        set raw(value) { request.url = String(value); },
      },
      headers: new HeaderList(request.headers),
      body: body,
      auth: request.auth || { type: 'none' },
    };
  }

  function buildResponseApi() {
    var response = state.response;
    if (!response) {
      var emptyApi = {
        code: 0, status: '', responseTime: 0, size: 0,
        headers: new HeaderList([]),
        json: function () { throw new Error('没有响应体'); },
        text: function () { return ''; },
      };
      // 空响应也要提供 .to 入口，否则 pm.response.to.have.status(...) 会报 TypeError
      Object.defineProperty(emptyApi, 'to', {
        get: function () { return new Assertion(emptyApi, false, false); },
        configurable: true,
      });
      return emptyApi;
    }
    var api = {
      get code() { return response.code; },
      set code(value) { response.code = Number(value); },
      get status() { return response.status; },
      set status(value) { response.status = String(value); },
      get responseTime() { return response.responseTime; },
      set responseTime(value) { response.responseTime = Number(value); },
      get size() { return response.size; },
      headers: new HeaderList(response.headers),
      json: function () {
        try {
          return JSON.parse(response.body);
        } catch (e) {
          throw new Error('响应体不是合法 JSON：' + e.message);
        }
      },
      text: function () { return response.body; },
      toString: function () { return response.body; },
    };
    // chai 风格的断言入口：pm.response.to.have.status(200)
    Object.defineProperty(api, 'to', {
      get: function () { return new Assertion(api, false, false); },
      configurable: true,
    });
    return api;
  }

  var pm = {
    environment: new VarStore(state.env),
    globals: new VarStore(state.globals),
    // pm.variables 读取时会向外层作用域兜底（会话 > 环境 > 集合 > 全局）
    variables: new VarStore(state.session, null),

    get request() { return buildRequestApi(); },
    get response() { return buildResponseApi(); },

    /**
     * 注册一条断言。
     * pm.test('状态码是 200', function () { pm.response.to.have.status(200); });
     */
    test: function (name, fn) {
      var started = Date.now();
      var label = typeof name === 'string' ? name : '未命名断言';
      try {
        if (typeof fn === 'function') fn();
        state.tests.push({ name: label, passed: true, duration: Date.now() - started });
      } catch (e) {
        state.tests.push({
          name: label,
          passed: false,
          error: e && e.message ? e.message : String(e),
          duration: Date.now() - started,
        });
      }
    },

    expect: expect,
  };

  globalThis.pm = pm;

  /* ---------------------------------------------------------------
   * 6. 变量兜底作用域（供 pm.variables.get 用）
   * ------------------------------------------------------------- */
  var outer = {};
  if (state.env) Object.keys(state.env).forEach(function (k) { outer[k] = state.env[k]; });
  if (state.collection) Object.keys(state.collection).forEach(function (k) { outer[k] = state.collection[k]; });
  if (state.globals) Object.keys(state.globals).forEach(function (k) { outer[k] = state.globals[k]; });
  pm.variables.fallback = outer;
})();
