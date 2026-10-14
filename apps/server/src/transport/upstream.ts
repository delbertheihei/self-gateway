/**
 * Transport —— 唯一与上游通信的出入口。
 *
 * ★★ 本文件与 shared/headers.ts 共同构成 H1~H5 的实现。★★
 *
 * 为什么用 `node:http` / `node:https` 而不是 fetch 或 undici（三条实测证据，docs/03 §2.1）：
 *   E1  原生 fetch 对 connection / transfer-encoding / content-length / keep-alive / upgrade
 *       **直接抛 TypeError**（而代理必然收到这些头）。
 *   E2  原生 fetch 会**注入** accept / accept-language / sec-fetch-mode / user-agent /
 *       accept-encoding —— 直接违反 H2「不得新增任何请求头」。这是 API 设计使然，无法配置掉。
 *   E3  undici 的 Client/Agent 默认 bodyTimeout = 300_000ms，会在模型静默 >5 分钟时掐断流，
 *       并抛 `TypeError: terminated`。node:http 客户端**默认无超时**。
 *
 * 附带收益：node:http **不做自动解压**。因此上游若返回 gzip，我们转发的是原始压缩字节，
 * 与无网关时完全一致（H3 天然满足），也就不需要像 fetch 方案那样被迫改写
 * `Accept-Encoding: identity`（那会是 H2 违规，见 ADR-16）。
 *
 * 本模块的纪律：
 *   - **绝不** 读/改/删请求体内容（直接 pipe）
 *   - **绝不** 新增请求头（唯一例外：显式开启的 replaceAuth）
 *   - **绝不** 修改上游响应头（只做逐跳头剥离）
 *   - **绝不** 重试
 *   - 响应体**不设超时**（流式长任务是正常场景）
 */

import http from 'node:http';
import https from 'node:https';
import fs from 'node:fs';
import type { Readable } from 'node:stream';
import { filterHopByHop } from '@sgw/shared';
import { classifyNodeError, SgwAbortError } from '@sgw/shared';
import type { UpstreamConfig } from '../config/schema.ts';
import type { Logger } from '../config/logger.ts';

// ─────────────────────────────── 路径拼接 ───────────────────────────────

export interface PathJoinResult {
  /**
   * 最终要写进 HTTP 请求行的 **origin-form** 请求目标（即 `/path?query`），
   * **不是**完整 URL。
   *
   * ⚠️ 血的教训：曾经这里返回完整 URL（`https://host/v1/x`），而 `http.request({ path })`
   * 对以 `http://` 开头的值会原样发出 **absolute-form** 请求行
   * （`POST http://host/v1/x HTTP/1.1`，见 RFC 7230 §5.3.2）。
   * 于是上游看到的 `req.url` 就变成了绝对 URL —— 真实中继/WAF 很可能因此拒绝或误判。
   * 回归脚本里有一条断言专门锁死这个行为：`上游收到的请求行必须是 origin-form`。
   */
  path: string;
  /** 实际剥掉的前缀，便于诊断 */
  stripped: string;
}

/**
 * 计算最终请求上游的 **origin-form 请求目标**（`/path?query`）。
 *
 * Codex 侧的 URL 构造是**纯字符串拼接**（codex-rs/codex-client/src/provider.rs）：
 *   format!("{base 去尾斜杠}/{path 去首斜杠}")
 * 例如 base_url = "http://127.0.0.1:8787/v1"，Codex 请求 `/v1/responses`。
 * 于是入站 path 天然带 `/v1` 前缀，属于**网关自己的路径布局**，必须剥掉后才与
 * 上游 base（通常也带 `/v1`）拼接，否则会得到 `/v1/v1/responses`。
 *
 * 三种 pathMode 的**精确定义**（曾经因为描述含糊而写出过 bug）：
 *   - `absolute`：入站 path **逐字保留**，上游 base 的路径部分被完全忽略。
 *                 入站 `/v1/responses` + base `https://h/v1` → `https://h/v1/responses`
 *                 入站 `/v1/responses` + base `https://h`   → `https://h/v1/responses`
 *   - `append`  ：剥掉 stripPrefix（若匹配）后，追加到上游 base 的路径之后。
 *                 入站 `/v1/responses` + base `https://h/v1` → `https://h/v1/responses`
 *   - `auto`    ：同 `append`，但**只在 stripPrefix 匹配时**才剥；不匹配则等价于把
 *                 入站 path 追加到 base 之后。这是默认值，兼容两种情况。
 *
 * ⚠️ 禁止用 `new URL(path, base)`：new URL('responses', 'https://up/v1')
 *    会得到 'https://up/responses'（吃掉 /v1），而 new URL('/v1/responses', base)
 *    会把 base 的路径整个替换掉。两者都是错的。
 */
export function joinUpstreamPath(
  baseUrl: string,
  incomingUrl: string,
  cfg: Pick<UpstreamConfig, 'pathMode' | 'stripPrefix'>,
): PathJoinResult {
  const basePath = baseUrlPath(baseUrl);

  // 拆分 incoming 的 path 与 query（query 必须原样保留，H4）
  const qIdx = incomingUrl.indexOf('?');
  const incomingPath = qIdx === -1 ? incomingUrl : incomingUrl.slice(0, qIdx);
  const query = qIdx === -1 ? '' : incomingUrl.slice(qIdx);

  // ── absolute：入站 path **原样保留**，完全忽略上游 base 的路径部分 ──
  // 语义：上游 base 只是"连到哪台机器"，路径由客户端说了算。
  // 这对"上游 base 不带路径前缀（https://host 而非 https://host/v1）"的场景有意义，
  // 也可用于排障（完全不做路径转换）。
  if (cfg.pathMode === 'absolute') {
    const p = incomingPath.length === 0 ? '/' : incomingPath;
    return { path: `${p}${query}`, stripped: '' };
  }

  const prefix = cfg.stripPrefix;
  let effectivePath = incomingPath;
  let stripped = '';
  if (prefix.length > 1 && incomingPath.startsWith(prefix)) {
    const rest = incomingPath.slice(prefix.length);
    if (rest.length === 0 || rest.charCodeAt(0) === 47 /* '/' */) {
      effectivePath = rest;
      stripped = prefix;
    }
  }

  // 归一化：拼成 {basePath}/{effectivePath}，并消除重复斜杠
  const tail = effectivePath.replace(/^\/+/, '').replace(/\/+$/, '');
  const joined = tail.length === 0
    ? (basePath.length === 0 ? '/' : basePath)
    : (basePath.length === 0 ? `/${tail}` : `${basePath}/${tail}`);

  return { path: `${joined}${query}`, stripped };
}

/** 取出 baseUrl 的 path 部分，去掉末尾斜杠（`https://h/v1` → `/v1`；`https://h` → ``） */
function baseUrlPath(baseUrl: string): string {
  try {
    const u = new URL(baseUrl);
    return u.pathname.replace(/\/+$/, '');
  } catch {
    // 非法 URL 已在配置校验阶段拦截；这里保守返回空
    const m = /^[a-z]+:\/\/[^/]+(\/.*)?$/i.exec(baseUrl);
    return (m?.[1] ?? '').replace(/\/+$/, '');
  }
}

// ─────────────────────────────── 连接池 ───────────────────────────────

export interface UpstreamAgents {
  http: http.Agent;
  https: https.Agent;
  destroy(): void;
}

export function createAgents(cfg: UpstreamConfig, log: Logger): UpstreamAgents {
  let ca: Buffer | undefined;
  if (cfg.caFile) {
    try {
      ca = fs.readFileSync(cfg.caFile);
      log.info({ caFile: cfg.caFile, bytes: ca.length }, '已加载自定义 CA');
    } catch (e) {
      log.error({ caFile: cfg.caFile, err: (e as Error).message }, '读取 CA 文件失败，将回退到系统 CA');
    }
  }

  const base: http.AgentOptions = {
    keepAlive: cfg.keepAlive,
    keepAliveMsecs: 30_000,
    maxSockets: cfg.maxSockets,
    maxFreeSockets: Math.max(4, Math.floor(cfg.maxSockets / 2)),
    // 关闭 Nagle：SSE 的 delta 都是小包，Nagle + delayed ACK 会累积出几十毫秒延迟
    noDelay: true,
    scheduling: 'lifo',
  };

  const httpAgent = new http.Agent(base);

  const httpsAgent = new https.Agent({
    ...base,
    ...(ca ? { ca } : {}),
    ...(cfg.strictSsl ? {} : { rejectUnauthorized: false }),
    servername: undefined as unknown as string, // 由 Node 按 hostname 自动填充（SNI）
  });

  return {
    http: httpAgent,
    https: httpsAgent,
    destroy() { httpAgent.destroy(); httpsAgent.destroy(); },
  };
}

// ─────────────────────────────── 转发 ───────────────────────────────

export interface UpstreamResponse {
  status: number;
  statusMessage: string;
  httpVersion: string;
  /** 逐字拷贝的上游响应头（保留原始大小写与重复头） */
  rawHeaders: string[];
  /** 已剥离逐跳头的头，可直接 writeHead */
  headers: Record<string, string | string[]>;
  /** 上游原始字节流（**保持压缩态，未做任何解压**） */
  stream: Readable;
  /** 原样取自响应头 —— Codex 的唯一关联 ID，必须保留 */
  requestId: string | null;
}

export interface ForwardOptions {
  /** 客户端原始请求（直接 pipe，不读 body） */
  clientReq: http.IncomingMessage;
  cfg: UpstreamConfig;
  agents: UpstreamAgents;
  log: Logger;
  /** 目标上游 baseUrl（可被运行时覆盖） */
  baseUrl: string;
}

export interface ForwardHandle {
  /** 上游响应头到达时触发；此时客户端尚未收到任何字节 */
  onResponse: (cb: (res: UpstreamResponse) => void) => void;
  /** 上游响应流自然结束 */
  onEnd: (cb: () => void) => void;
  /** 失败（含超时、TLS、DNS、被中止） */
  onError: (cb: (err: unknown) => void) => void;
  /** 主动中止（客户端断开、网关关闭） */
  abort: (reason: SgwAbortError) => void;
  /** 供诊断：最终请求到的完整 URL */
  readonly targetUrl: string;
  readonly strippedPrefix: string;
  readonly isUpstreamStreaming: boolean;
  /** 诊断用：上游请求连接是否已被销毁（宽限期排空是否还能读到数据的关键判据） */
  isUpstreamRequestDestroyed(): boolean;
}

/**
 * 把客户端请求转发到上游。**同步返回 handle**，因为 onResponse 可能在任何 await 之后触发。
 *
 * 关键实现点：
 *   - 请求头：`filterHopByHop(req.rawHeaders)` —— 逐字拷贝，只删逐跳头（H2）
 *   - 请求体：`clientReq.pipe(upReq)` —— 字节直通，**不解 JSON**（H1）
 *   - 响应头：头到达时立即回调 → 调用方 `writeHead` + `flushHeaders()`，不等 body
 *   - 响应体：调用方自行 `pipe`，backpressure 由 pipe 自动传播（H6）
 */
export function forwardUpstream(opts: ForwardOptions): ForwardHandle {
  const { clientReq, cfg, agents, log, baseUrl } = opts;

  const target = new URL(baseUrl);
  const { path: upstreamPath, stripped } = joinUpstreamPath(baseUrl, clientReq.url ?? '/', cfg);
  const targetUrl = `${target.origin}${upstreamPath}`;

  // ── 头：逐字拷贝 - 逐跳头（H2）──
  const headers = filterHopByHop(clientReq.rawHeaders);

  // ── H5：默认原样透传 Authorization；仅当显式配置了 replaceAuth 才替换 ──
  if (cfg.replaceAuth !== false) {
    // 注意：这里会覆盖客户端发来的同名头。这是**显式开关**行为，默认关闭。
    headers[cfg.authHeader] = `Bearer ${cfg.replaceAuth}`;
    log.debug({ target: target.host, authHeader: cfg.authHeader }, '已按配置替换鉴权头（replaceAuth 开启）');
  }

  const transport = target.protocol === 'https:' ? https : http;
  const agent = target.protocol === 'https:' ? agents.https : agents.http;

  let settled = false;
  let aborted = false;
  let responseSeen = false;

  const upReq = transport.request({
    protocol: target.protocol,
    hostname: target.hostname,
    port: target.port || (target.protocol === 'https:' ? 443 : 80),
    path: upstreamPath,
    method: clientReq.method,
    headers,
    agent,
    // ★ 刻意不设置 timeout：node:http 客户端默认无超时，流式长任务必须如此（ADR-14）
  });

  const responseCbs: Array<(res: UpstreamResponse) => void> = [];
  const endCbs: Array<() => void> = [];
  const errorCbs: Array<(err: unknown) => void> = [];

  const fireError = (err: unknown): void => {
    if (settled) return;
    settled = true;
    clearTimeout(headersTimer);
    for (const cb of errorCbs) cb(err);
  };
  const fireEnd = (): void => {
    if (settled) return;
    settled = true;
    clearTimeout(headersTimer);
    for (const cb of endCbs) cb();
  };

  // ── 等响应头的超时（只作用于"首字节之前"）──
  // 注意：Node 的 setTimeout 返回 Timeout 对象；这里用 undefined 而非 null 作为"无定时器"，
  // 以便直接传给 clearTimeout（其签名不接受 null，严格模式下会报错）。
  const headersTimer: NodeJS.Timeout | undefined = cfg.headersTimeoutMs > 0
    ? setTimeout(() => {
        if (responseSeen || settled) return;
        const err = new SgwAbortError('upstream_headers_timeout',
          `上游 ${cfg.headersTimeoutMs}ms 内未返回响应头`);
        upReq.destroy(err as unknown as Error);
        fireError(err);
      }, cfg.headersTimeoutMs)
    : undefined;

  upReq.on('socket', (socket) => {
    if (socket.connecting) socket.once('connect', () => { /* 建连已完成，计时由 Edge 侧打点 */ });
  });

  upReq.on('response', (upRes) => {
    responseSeen = true;
    if (headersTimer) clearTimeout(headersTimer);

    // 上游响应头：同样只剥逐跳头，其余逐字保留（H3）
    const filtered = filterHopByHop(upRes.rawHeaders);

    let requestId: string | null = null;
    for (let i = 0; i + 1 < upRes.rawHeaders.length; i += 2) {
      if (upRes.rawHeaders[i]!.toLowerCase() === 'x-request-id') { requestId = upRes.rawHeaders[i + 1]!; break; }
    }

    // 把上游流的生命周期接到 handle 上，Edge 侧无需直接碰 upRes
    upRes.on('end', () => { fireEnd(); });
    upRes.on('error', (err) => { fireError(err); });
    upRes.on('aborted', () => {
      fireError(new SgwAbortError('upstream_stream_truncated', '上游提前中断了响应流'));
    });

    const wrapped: UpstreamResponse = {
      status: upRes.statusCode ?? 502,
      statusMessage: upRes.statusMessage ?? '',
      httpVersion: upRes.httpVersion,
      rawHeaders: upRes.rawHeaders,
      headers: filtered,
      stream: upRes,
      requestId,
    };
    for (const cb of responseCbs) cb(wrapped);
  });

  upReq.on('error', (err) => {
    if (aborted && err instanceof Error && /aborted|destroyed/i.test(err.message)) {
      // 我们自己中止的，不重复上报
      fireError(new SgwAbortError('client_aborted', '请求已被中止'));
      return;
    }
    fireError(err);
  });

  // 请求体直通。不解析、不缓冲、不改字节（H1）
  clientReq.pipe(upReq);
  clientReq.on('error', (err) => {
    // 客户端在发完 body 之前就断了
    upReq.destroy();
    fireError(err);
  });

  return {
    targetUrl,
    strippedPrefix: stripped,
    get isUpstreamStreaming(): boolean { return responseSeen; },
    isUpstreamRequestDestroyed(): boolean { return upReq.destroyed; },

    onResponse(cb) { responseCbs.push(cb); },
    onEnd(cb) { endCbs.push(cb); },
    onError(cb) { errorCbs.push(cb); },

    abort(reason) {
      if (settled || aborted) return;
      aborted = true;
      clearTimeout(headersTimer);
      upReq.destroy();
      fireError(reason);
    },
  };
}

/** 供 Edge 在拿到上游响应后注册"流结束/流错误"回调 */
export function attachStreamLifecycle(
  res: UpstreamResponse,
  handlers: { onEnd: () => void; onError: (err: unknown) => void },
): void {
  res.stream.on('end', handlers.onEnd);
  res.stream.on('close', () => { /* 可能先于 end 触发；由 onEnd 兜底 */ });
  res.stream.on('error', handlers.onError);
}

export { classifyNodeError };

/**
 * 探测上游是否可达（健康检查 / 设置页"测试连通性"用）。
 * 只发一个 HEAD/GET，不消耗模型额度。
 */
export async function probeUpstream(
  baseUrl: string,
  agents: UpstreamAgents,
  timeoutMs = 5_000,
): Promise<{ reachable: boolean; status: number | null; error: string | null }> {
  return new Promise((resolve) => {
    let done = false;
    const finish = (r: { reachable: boolean; status: number | null; error: string | null }): void => {
      if (done) return;
      done = true;
      resolve(r);
    };
    try {
      const target = new URL(baseUrl);
      const transport = target.protocol === 'https:' ? https : http;
      const agent = target.protocol === 'https:' ? agents.https : agents.http;
      const req = transport.request({
        protocol: target.protocol,
        hostname: target.hostname,
        port: target.port || (target.protocol === 'https:' ? 443 : 80),
        path: `${target.pathname.replace(/\/+$/, '')}/models?client_version=sgw-probe`,
        method: 'GET',
        headers: { accept: 'application/json' },   // 这是网关**自己**发的探测请求，不受 H2 约束
        agent,
      });
      const timer = setTimeout(() => { req.destroy(); finish({ reachable: false, status: null, error: 'timeout' }); }, timeoutMs);
      req.on('response', (res) => {
        clearTimeout(timer);
        res.resume();   // 丢弃 body
        // 200/401/403 都说明"端点存在"，只是鉴权不同
        finish({ reachable: true, status: res.statusCode ?? null, error: null });
      });
      req.on('error', (e) => {
        clearTimeout(timer);
        finish({ reachable: false, status: null, error: `${classifyNodeError(e)}: ${e.message}` });
      });
      req.end();
    } catch (e) {
      finish({ reachable: false, status: null, error: (e as Error).message });
    }
  });
}
