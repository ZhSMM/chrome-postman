/**
 * ============================================================
 * 补全引擎（Completion Engine）
 * ============================================================
 *
 * 【在架构中的位置】
 * 位于 UI 输入组件与"知识来源"之间。输入组件把「文本 + 光标位置」
 * 交给 detectContext，得到上下文；再把上下文和候选源交给
 * computeCompletions，得到排序好的候选列表。
 *
 * 【为什么拆成两个纯函数】
 * - detectContext 只关心"光标在什么语境下"，不关心候选从哪来
 * - computeCompletions 只关心"给定的候选哪些匹配、怎么排序"
 * 分开之后两个都能单独测，而且 UI 层只需要拼起来调用。
 *
 * 【为什么是纯函数（不碰 DOM、不碰 chrome.*）】
 * 这样单测能在 Node 里直接跑，UI 换实现也不用动核心逻辑。
 */

/** 候选的种类，决定基础分和展示图标 */
export type CompletionKind = 'variable' | 'builtin' | 'function' | 'header' | 'history' | 'method';

/** 一个候选项 */
export interface CompletionItem {
  /** 实际插入输入框的文本 */
  insertText: string;
  /** 展示文本（可与 insertText 不同） */
  label: string;
  /** 右侧灰色说明 */
  detail?: string;
  kind: CompletionKind;
  /** 排序分，越大越靠前 */
  score: number;
}

/** 补全上下文：由 detectContext 从「文本 + 光标位置」推导 */
export interface CompletionContext {
  /** 触发方式 */
  trigger: 'brace' | 'dot' | 'word';
  /** 用户已输入的查询串 */
  query: string;
  /** 要被替换的文本区间 [start, end) */
  range: { start: number; end: number };
  /**
   * dot 触发时的路径前缀（不含最后一段）。
   * 例如输入 `pm.response.jo` → prefix='pm.response'，query='jo'
   * 这样才能做链式补全（pm. → pm.response. → pm.response.json.）
   */
  prefix?: string;
}

/** 一个可用变量 */
export interface CompletionVariable {
  name: string;
  /** 变量来自哪个作用域 */
  scope: 'environment' | 'collection' | 'globals' | 'session';
  /** 当前值（用于展示） */
  value: string;
}

/** 一个内置动态变量 */
export interface CompletionBuiltin {
  name: string;
  description: string;
  /** 示例值，补全时预览给用户看 */
  preview: string;
}

/** 一条 pm SDK API */
export interface CompletionApi {
  /** 完整路径，如 'pm.response.json' */
  path: string;
  /** 签名提示 */
  signature: string;
  /** 中文说明 */
  description: string;
}

/** 一个常用请求头 */
export interface CompletionHeader {
  name: string;
  description: string;
}

/** 一条历史 URL */
export interface CompletionHistory {
  url: string;
  method: string;
  /** 最近一次使用时间（毫秒时间戳） */
  lastUsed: number;
  /** 累计使用次数 */
  useCount: number;
}

/** 补全的所有数据来源 */
export interface CompletionSources {
  variables: CompletionVariable[];
  builtins: CompletionBuiltin[];
  apis: CompletionApi[];
  headers: CompletionHeader[];
  history: CompletionHistory[];
}

/** 各种类别的基础分 —— 分数高的排前面 */
const KIND_BASE: Record<CompletionKind, number> = {
  function: 70,
  builtin: 60,
  variable: 50,
  method: 40,
  header: 30,
  history: 20,
};

/**
 * 判断 query 的字符是否按顺序出现在 target 里（缩写匹配）。
 *
 * 【为什么需要】
 * 用户想输入 host 时可能只打 "hs"（h...s...t）。
 * 如果只做前缀匹配，"hs" 匹配不到 "host"，候选列表就空了。
 */
export function isSubsequence(query: string, target: string): boolean {
  if (!query) return true;
  const lowerQuery = query.toLowerCase();
  const lowerTarget = target.toLowerCase();
  let i = 0;
  for (const ch of lowerTarget) {
    if (ch === lowerQuery[i]) i += 1;
    if (i === lowerQuery.length) return true;
  }
  return false;
}

/**
 * 计算匹配得分。
 *
 * 【分数的顺序有讲究】
 * 连续包含（比如 query='type' 命中 'content-type'）比缩写匹配
 * （query='ctp' 命中 'content-type'）更精确，所以分更高。
 *
 * 早先的版本把缩写排在包含前面，结果"包含匹配"那一档永远轮不到
 * —— 因为连续子串天然也是子序列。这是个看起来无害、实际让排序失真的 bug。
 *
 * @returns 不匹配时返回 0（调用方据此过滤）
 */
export function matchScore(query: string, target: string): number {
  if (!query) return 50; // 没输入内容时，所有候选都算"基础匹配"
  const lowerQuery = query.toLowerCase();
  const lowerTarget = target.toLowerCase();

  if (lowerTarget === lowerQuery) return 100;
  if (lowerTarget.startsWith(lowerQuery)) return 100;
  if (lowerTarget.includes(lowerQuery)) return 70; // 连续包含
  if (isSubsequence(query, target) && query.length >= 2) return 50; // 缩写
  return 0;
}

/**
 * 从「文本 + 光标位置」推导补全上下文。
 *
 * 【为什么必须从光标往左扫描，而不是用 lastIndexOf】
 * 因为要判断占位符**有没有闭合**。
 * `{{host}}` 已经闭合了，光标在后面，此时不该再弹出变量补全。
 * 只看 "{{" 的位置判断不出来，必须检查中间有没有 "}"。
 *
 * @param text 完整文本
 * @param cursor 光标位置（字符下标）
 * @returns 上下文；当前语境不适合补全时返回 null
 */
export function detectContext(text: string, cursor: number): CompletionContext | null {
  if (!text || cursor < 0 || cursor > text.length) return null;
  const before = text.slice(0, cursor);

  /* ---------- ① {{ 触发：变量 / 内置变量 ---------- */
  const open = before.lastIndexOf('{{');
  if (open !== -1) {
    const between = before.slice(open + 2);
    // 已经闭合（含 }）或者跨行了 → 占位符已经写完，不该触发
    if (!between.includes('}') && !between.includes('\n') && !between.includes('{')) {
      return {
        trigger: 'brace',
        query: between.trim(),
        range: { start: open, end: cursor },
      };
    }
  }

  /* ---------- ② 点号触发：pm SDK API ---------- */
  /*
   * 【替换区间为什么覆盖"整段路径"而不是只覆盖 query】
   * 用户输入 "pm.res"，如果只替换 "res"，插入完整路径 "pm.response"
   * 就会变成 "pm.pm.response"。所以区间必须从路径起点开始，
   * 插入文本用完整路径。
   */
  // 情况 A：末尾就是一个点（刚打完 "pm."）
  const trailingDot = before.match(/([A-Za-z_$][\w$]*(?:\.[\w$]+)*)\.$/);
  if (trailingDot) {
    return {
      trigger: 'dot',
      query: '',
      prefix: trailingDot[1],
      range: { start: cursor - trailingDot[0].length, end: cursor },
    };
  }

  // 情况 B：路径形式（"pm.res"、"pm.response.jo"）
  // 此时最后一段是"用户正在输入的片段"，其余部分是路径前缀。
  const pathMatch = before.match(/([A-Za-z_$][\w$]*(?:\.[\w$]+)*)$/);
  if (pathMatch && pathMatch[1].includes('.')) {
    const whole = pathMatch[1];
    const parts = whole.split('.');
    const lastSegment = parts[parts.length - 1];
    const prefix = parts.slice(0, -1).join('.');
    return {
      trigger: 'dot',
      query: lastSegment,
      prefix,
      range: { start: cursor - whole.length, end: cursor },
    };
  }

  /* ---------- ③ 普通词：请求头 / 历史 URL / 变量名 ---------- */
  const wordMatch = before.match(/[A-Za-z0-9_$-]*$/);
  const word = wordMatch ? wordMatch[0] : '';
  if (word) {
    return {
      trigger: 'word',
      query: word,
      range: { start: cursor - word.length, end: cursor },
    };
  }

  /*
   * 词是空的，但光标前面是 '/' 或 ':' —— 这明显是"正要打路径/域名"。
   * 比如刚敲完 "https://"，这时应该能列出历史 URL 供选择。
   * 不做这个特判的话，用户打完协议就得自己继续打字才能看到候选。
   */
  if (cursor > 0 && (before[cursor - 1] === '/' || before[cursor - 1] === ':')) {
    return {
      trigger: 'word',
      query: '',
      range: { start: cursor, end: cursor },
    };
  }

  return null;
}

/**
 * 根据上下文和候选源，算出排序好的候选列表。
 *
 * 【排序规则】
 *   总分 = 类别基础分 + 匹配分 + 使用频率分
 * 这样"用得多的请求头"会排在"没用过的请求头"前面，
 * 同时函数类候选天然比历史 URL 靠前。
 */
export function computeCompletions(ctx: CompletionContext, sources: CompletionSources): CompletionItem[] {
  const items = computeForTrigger(ctx, sources);

  /*
   * 点号语境下如果一个候选都没有，退回普通词语境再试一次。
   *
   * 【为什么需要】
   * "api.example.com/users" 这样的 URL 片段在语法上和 "pm.response.json"
   * 长得一样（都是点号分隔的路径），会被判成点号语境。
   * 如果不回退，用户在 URL 里就再也看不到历史 URL 的补全了。
   */
  if (!items.length && ctx.trigger === 'dot') {
    return computeForTrigger({ ...ctx, trigger: 'word' }, sources);
  }

  return items;
}

/** 按触发方式计算候选（computeCompletions 的内部实现） */
function computeForTrigger(ctx: CompletionContext, sources: CompletionSources): CompletionItem[] {
  const items: CompletionItem[] = [];

  const push = (
    item: Omit<CompletionItem, 'score'> & { score?: number },
    baseScore: number,
    matched: number,
    usage = 0,
  ) => {
    if (matched <= 0) return;
    items.push({ ...item, score: baseScore + matched + usage });
  };

  if (ctx.trigger === 'brace') {
    /* ---------- {{ 变量补全 ---------- */
    const query = ctx.query;

    // 同名变量只保留优先级最高的（环境 > 集合 > 全局 > 会话）
    const seen = new Set<string>();
    const scopePriority = ['environment', 'collection', 'globals', 'session'] as const;
    for (const scope of scopePriority) {
      for (const item of sources.variables.filter((v) => v.scope === scope)) {
        if (seen.has(item.name)) continue;
        seen.add(item.name);
        const matched = matchScore(query, item.name);
        push(
          {
            insertText: `{{${item.name}}}`,
            label: item.name,
            detail: `${SCOPE_LABEL[item.scope]} · ${item.value || '(空)'}`,
            kind: 'variable',
          },
          KIND_BASE.variable,
          matched,
        );
      }
    }

    // 内置动态变量
    for (const item of sources.builtins) {
      const matched = matchScore(query, item.name);
      push(
        {
          insertText: `{{${item.name}}}`,
          label: item.name,
          detail: `${item.description} · 例：${item.preview}`,
          kind: 'builtin',
        },
        KIND_BASE.builtin,
        matched,
      );
    }
  }

  if (ctx.trigger === 'dot') {
    /* ---------- pm SDK API 补全 ---------- */
    const prefix = ctx.prefix ?? '';
    for (const item of sources.apis) {
      // 路径必须与前缀对齐：pm. 只会给出 pm.* 的候选
      if (prefix && !item.path.startsWith(`${prefix}.`)) continue;

      /*
       * 【拿哪一段去匹配 query —— 这是个容易搞错的地方】
       * 用户输入 "pm.res" 时，想补的是 "response"（pm 的下一段），
       * 而不是 "json"（整条路径的最后一段）。
       * 所以要取"相对于前缀的下一段"来比对。
       */
      const rest = prefix ? item.path.slice(prefix.length + 1) : item.path;
      const nextSegment = rest.split('.')[0];

      const matched = matchScore(ctx.query, nextSegment);
      push(
        {
          // 插入完整路径（替换区间覆盖整段路径）
          insertText: item.path,
          // 展示时只显示下一段，因为前缀用户已经打出来了
          label: nextSegment,
          detail: `${item.path}${item.signature} — ${item.description}`,
          kind: 'function',
        },
        KIND_BASE.function,
        matched,
      );
    }
  }

  if (ctx.trigger === 'word') {
    /* ---------- 普通词补全 ---------- */
    const query = ctx.query;

    for (const item of sources.headers) {
      const matched = matchScore(query, item.name);
      push(
        { insertText: item.name, label: item.name, detail: item.description, kind: 'header' },
        KIND_BASE.header,
        matched,
      );
    }

    // 变量名也参与普通词补全（用户在 Header 名里写 host 时会用到）
    const seen = new Set<string>();
    for (const item of sources.variables) {
      if (seen.has(item.name)) continue;
      seen.add(item.name);
      const matched = matchScore(query, item.name);
      push(
        {
          insertText: item.name,
          label: item.name,
          detail: `${SCOPE_LABEL[item.scope]} · ${item.value || '(空)'}`,
          kind: 'variable',
        },
        KIND_BASE.variable,
        matched,
      );
    }

    // 历史 URL：按最近使用时间给分
    const now = Date.now();
    const maxAge = Math.max(
      1,
      ...sources.history.map((h) => now - h.lastUsed),
    );
    for (const item of sources.history) {
      const matched = matchScore(query, item.url);
      if (matched <= 0) continue;
      // 越新用得越多，加分越高（最高 30 分）
      const recency = Math.round(30 * (1 - (now - item.lastUsed) / maxAge));
      const frequency = Math.min(20, item.useCount);
      push(
        {
          insertText: item.url,
          label: item.url,
          detail: `${item.method} · 用过 ${item.useCount} 次`,
          kind: 'history',
        },
        KIND_BASE.history,
        matched,
        recency + frequency,
      );
    }
  }

  // 分数相同时按标签排序，保证结果稳定（不会因为输入顺序变化而跳动）
  items.sort((a, b) => b.score - a.score || a.label.localeCompare(b.label));
  return items;
}

/** 作用域中文名 */
export const SCOPE_LABEL: Record<string, string> = {
  environment: '环境变量',
  collection: '集合变量',
  globals: '全局变量',
  session: '会话变量',
};
