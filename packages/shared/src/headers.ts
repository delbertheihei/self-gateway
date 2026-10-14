/**
 * 逐跳头（hop-by-hop）处理 —— RFC 9110 §7.6.1。
 *
 * ★ 本文件是 H2 / H3 的核心实现，是"说不改就真的不改"的承重墙。
 *
 * 关键点（每一条都有踩坑史）：
 *   1. 必须从 **rawHeaders**（扁平数组）而非 WHATWG Headers / req.headers 重建，
 *      否则会丢掉 **原始大小写** 与 **重复头**（如多个 set-cookie 被逗号合并 → 不可解析）。
 *   2. RFC 9110 §7.6.1 是 MUST：先解析 `Connection`，**删除其中列出的每一个头**，
 *      再删除 `Connection` 自己。这不是"删几个固定头"那么简单。
 *   3. RFC 9110 §7.6.1 是 SHOULD：`Keep-Alive`/`Proxy-Connection`/`TE`/`Transfer-Encoding`/`Upgrade`。
 *   4. `Host` 与 `Content-Length` 必须删——它们是**框架头**，由发起方按目标重算。
 *      body 字节本身一个都不改，但"分几块发"由 HTTP 客户端决定。
 *   5. **绝不新增任何头**（H2）。包括 `Accept-Encoding: identity`（ADR-16）与
 *      `X-Accel-Buffering`。唯一例外是网关**自身产生**的错误响应，那时代码在 errors.ts
 *      里显式加 `x-sgw-error`，因为此时没有可透传的上游响应。
 *   6. **绝不读取** `Connection` 之外的任何头来"做判断"（例如不按 Origin 拦 /v1 请求）——
 *      读取本身无害，但一旦据此拦请求，就会为将来"顺手改个头"埋下伏笔。
 */

/** 无论 Connection 怎么写，都必须剥离的头（RFC 9110 §7.6.1） */
export const ALWAYS_HOP_BY_HOP: ReadonlySet<string> = new Set([
  'connection',
  'keep-alive',
  'proxy-connection',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
  // 框架头：由发起方按目标重算，不属于"业务头"
  'host',
  'content-length',
]);

/** 客户端自动附加、不应参与"是否新增头"比对的头（回归测试用） */
export const AUTO_ADDED_BY_CLIENT: ReadonlySet<string> = new Set([
  'host',
  'connection',
  'content-length',
  'transfer-encoding',
]);

/**
 * 复制头，剥掉逐跳头。
 *
 * - `rawHeaders` 是 `[name, value, name, value, ...]` 扁平数组
 * - **保留原始大小写**（H3 的字面要求；同时避免 Node 把大小写暴露给上游）
 * - **保留重复头**（用 `string[]`）
 *
 * @param rawHeaders `req.rawHeaders` 或 `res.rawHeaders`
 */
export function filterHopByHop(rawHeaders: readonly string[]): Record<string, string | string[]> {
  // ── 第一步：解析 Connection，收集其中列出的所有头名（MUST）──
  const connectionTokens = new Set<string>();
  for (let i = 0; i + 1 < rawHeaders.length; i += 2) {
    if (rawHeaders[i]!.toLowerCase() !== 'connection') continue;
    for (const token of rawHeaders[i + 1]!.split(',')) {
      const name = token.trim().toLowerCase();
      // "close" / "keep-alive" 是连接选项而非头名，不要当成头删
      if (name && name !== 'close' && name !== 'keep-alive') connectionTokens.add(name);
    }
  }

  // ── 第二步：逐字重建，跳过逐跳头 ──
  const out: Record<string, string | string[]> = {};
  for (let i = 0; i + 1 < rawHeaders.length; i += 2) {
    const name = rawHeaders[i]!;
    const lower = name.toLowerCase();
    if (ALWAYS_HOP_BY_HOP.has(lower) || connectionTokens.has(lower)) continue;

    const existing = out[name];            // 大小写敏感的键（保真）
    if (existing === undefined) {
      out[name] = rawHeaders[i + 1]!;
    } else if (Array.isArray(existing)) {
      existing.push(rawHeaders[i + 1]!);
    } else {
      out[name] = [existing, rawHeaders[i + 1]!];
    }
  }
  return out;
}

/** 判断某个头是否被本实现视为逐跳头（回归测试与诊断用） */
export function isHopByHop(name: string): boolean {
  return ALWAYS_HOP_BY_HOP.has(name.toLowerCase());
}

/**
 * 提取头集合用于回归比对：小写化 + 去重，忽略逐跳头与客户端自动头。
 * H2 的判定即：`proxiedHeaders ⊇ directHeaders`，且 `proxiedHeaders - directHeaders ⊆ ∅`。
 */
export function headerNameSet(rawHeaders: readonly string[]): Set<string> {
  const set = new Set<string>();
  for (let i = 0; i + 1 < rawHeaders.length; i += 2) {
    const lower = rawHeaders[i]!.toLowerCase();
    if (isHopByHop(lower) || AUTO_ADDED_BY_CLIENT.has(lower)) continue;
    set.add(lower);
  }
  return set;
}
