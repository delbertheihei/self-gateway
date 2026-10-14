/**
 * Edge —— 面向客户端的代理热路径。
 *
 * ★ 本文件是"不慢"与"不改"两条铁律的最终落地点（H1~H7）。
 *
 * 请求处理顺序（每一步都有理由）：
 *   1. 不给 `req` 挂 data 监听器之前先 pipe —— body 直通上游，字节不变（H1）
 *   2. 上游响应头一到就 `writeHead` + `flushHeaders()`，**不等 body** —— TTFB 只加常数开销
 *   3. `src.pipe(dst)` 负责背压；副本由 tee 旁听 —— 观测绝不影响主链路（H6）
 *   4. `setNoDelay(true)` 两侧 —— 关 Nagle，避免每个 SSE delta 多几十毫秒
 *   5. 客户端断开时**先宽限期排空**再 abort 上游 —— 否则永远拿不到 usage（ADR-15）
 *
 * 模块边界（docs/00 §4）：本文件允许 `import observe/**` 与 `recorder/**` 的类型，
 * 但**不允许**直接写 SQL、也不允许改转发字节。
 */

import http from 'node:http';
import { ERROR_CLASSES, SgwAbortError, specFor, classifyNodeError, ulid } from '@sgw/shared';
import type { ErrorClass, EndpointKind, ObserveShape, RequestEvent, UsageRecord } from '@sgw/shared';
import type { SgwConfig } from '../config/schema.ts';
import type { Logger } from '../config/logger.ts';
import { fingerprint } from '../config/redact.ts';
import {
  forwardUpstream,
  type UpstreamAgents,
  type UpstreamResponse,
} from '../transport/upstream.ts';
import { createPipeline, type Pipeline, type PipelineResult } from '../observe/pipeline.ts';
import { parseContentEncoding, decodeForStorage } from '../observe/decompress.ts';
import { teeForObservation } from '../observe/tee.ts';
import type { Recorder, PendingEvent } from '../recorder/index.ts';
import { makePendingEvent } from '../recorder/index.ts';

export interface EdgeContext {
  cfg: SgwConfig;
  agents: UpstreamAgents;
  log: Logger;
  /** 运行时可变的上游地址（仪表盘可热改） */
  upstreamBaseUrl: () => string;
  /** 记账器；未启用观测时为 null */
  recorder: Recorder | null;
  /** 运行期设置（热改） */
  settings: () => {
    detailEnabled: boolean;
    bodyEnabled: boolean;
    observeMaxBytes: number;
    graceDrainMs: number;
    collectRequestForEstimate: boolean;
  };
  /** 每个交换结束时广播（供 SSE 实时推送） */
  onExchange?: (rec: ExchangeRecord) => void;
  /** 发现上游 usage 结构问题时上报（M0-2b 告警链路） */
  onUsageIncomplete?: (info: { id: string; missing: string[]; model: string | null }) => void;
}

/** 一次交换的元数据（不含正文）。既用于日志，也用于 SSE 推送。 */
export interface ExchangeRecord {
  id: string;
  startedAt: number;
  method: string;
  path: string;
  targetUrl: string;
  endpoint: EndpointKind;
  status: number | null;
  errorClass: ErrorClass | null;
  model: string | null;
  upstreamRequestId: string | null;
  responseId: string | null;
  codexSessionId: string | null;
  codexThreadId: string | null;
  codexOriginator: string | null;
  usage: UsageRecord;
  /** 观测到的响应形态（sse / json / binary / empty / unknown），用于排查"为什么没有 usage" */
  observeShape: string;
  /** 观测侧说明（例如"解压失败，已降级"） */
  observeNote: string | null;
  bytesIn: number;
  bytesOut: number;
  timings: {
    totalMs: number;
    upstreamHeadersMs: number | null;
    upstreamFirstByteMs: number | null;
    firstTokenMs: number | null;
  };
  clientAborted: boolean;
  drainedAfterAbort: boolean;
  observation: { truncated: boolean; copiedBytes: number; copyErrors: number } | null;
}

/** 从 path 归类端点；不做路径改写，只用于统计口径 */
export function classifyEndpoint(path: string): EndpointKind {
  const p = path.split('?')[0] ?? path;
  if (p.endsWith('/responses')) return 'responses';
  if (p.endsWith('/chat/completions')) return 'chat.completions';
  if (p.endsWith('/models')) return 'models';
  return 'other';
}

/**
 * 生成网关自身的错误响应。
 *
 * ★ 边界：只有在**没有可透传的上游响应**时才走这里。
 *   上游返回的 4xx/5xx 一律原样透传（见下方 onResponse），绝不包装。
 *
 * `x-sgw-error` 头只出现在这一类响应上，用来让用户在 Codex 报错时
 * 一眼区分"是上游的问题"还是"网关的问题"。
 */
export function sendGatewayError(
  res: http.ServerResponse,
  errorClass: ErrorClass,
  detail: string,
): void {
  if (res.headersSent) { res.destroy(); return; }
  const spec = specFor(errorClass);
  const payload = JSON.stringify({
    error: {
      code: errorClass,
      message: spec.title,
      detail,
      hint: spec.hint,
      source: 'sgw-gateway',
    },
  }, null, 2);

  res.writeHead(spec.status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': String(Buffer.byteLength(payload)),
    'cache-control': 'no-store',
    'x-sgw-error': errorClass,
  });
  res.end(payload);
}

/** 客户端是否已经断开 */
function clientGone(res: http.ServerResponse): boolean {
  return res.writableEnded || res.destroyed || res.socket?.destroyed === true;
}

/** 从原始头里取 Codex 的身份头（原样，仅本地归因用） */
function pickCodexHeaders(rawHeaders: readonly string[]): {
  sessionId: string | null; threadId: string | null; clientRequestId: string | null;
  originator: string | null; subagent: string | null; authorization: string | null;
} {
  const want = {
    'session-id': null as string | null,
    'thread-id': null as string | null,
    'x-client-request-id': null as string | null,
    originator: null as string | null,
    'x-openai-subagent': null as string | null,
    authorization: null as string | null,
  };
  for (let i = 0; i + 1 < rawHeaders.length; i += 2) {
    const k = rawHeaders[i]!.toLowerCase() as keyof typeof want;
    if (k in want && want[k] === null) want[k] = rawHeaders[i + 1]!;
  }
  return {
    sessionId: want['session-id'],
    threadId: want['thread-id'],
    clientRequestId: want['x-client-request-id'],
    originator: want.originator,
    subagent: want['x-openai-subagent'],
    authorization: want.authorization,
  };
}

/**
 * 处理一个 /v1/** 代理请求。
 */
export function handleProxyRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  ctx: EdgeContext,
): void {
  const startedAt = Date.now();
  const startedHr = process.hrtime.bigint();
  const url = req.url ?? '/';
  const id = ulid(startedAt);
  const endpoint = classifyEndpoint(url);
  const qIdx = url.indexOf('?');
  const pathOnly = qIdx === -1 ? url : url.slice(0, qIdx);
  const query = qIdx === -1 ? null : url.slice(qIdx);
  const rt = ctx.settings();

  // ── ★ 前置闸门：上游地址未配置 / 非法时**必须**在这里挡住 ──
  //   为什么（真实风险）：`forwardUpstream` 内部是 `new URL(baseUrl)`。空串或坏串会**同步抛出**，
  //   而异常从 http 请求回调里冒出去 → 客户端**永久挂起**（只在日志里留一行 uncaughtException）。
  //   上游地址现在可以在设置页手动填写，因此"没填"是一个**正常状态**，必须给可读的响应。
  const upstreamBaseUrl = ctx.upstreamBaseUrl();
  if (!upstreamBaseUrl) {
    ctx.log.warn({ path: pathOnly }, '拒绝转发：上游地址未配置');
    req.resume();   // 排空请求体，避免 keep-alive 连接上的下一个请求被残包污染
    sendGatewayError(res, 'upstream_not_configured',
      '网关尚未配置上游地址。请打开仪表盘「设置 → 上游」手动填写（改完即时生效，无需重启），'
      + '或把地址写在 sgw.config.ts 的 upstream.baseUrl 里。');
    return;
  }

  const codex = pickCodexHeaders(req.rawHeaders);

  let settled = false;
  let clientAborted = false;
  let upstreamResponseSeen = false;
  let pipeline: Pipeline | null = null;
  let graceTimer: NodeJS.Timeout | null = null;
  /** 已收到上游响应头后记录在此，供"客户端中途断开"时切换为只读排空 */
  let activeUpstream: UpstreamResponse | null = null;
  /** 是否已切换为只读排空（避免重复挂监听） */
  let draining = false;

  const timings = {
    totalMs: 0,
    upstreamHeadersMs: null as number | null,
    upstreamFirstByteMs: null as number | null,
    firstTokenMs: null as number | null,
  };
  let status: number | null = null;
  let errorClass: ErrorClass | null = null;
  let upstreamRequestId: string | null = null;
  let responseId: string | null = null;
  let model: string | null = null;
  let usage: UsageRecord | null = null;
  let observeShape = 'unknown';
  let observeNote: string | null = null;
  let bytesOut = 0;
  const bytesIn = req.headers['content-length'] ? Number(req.headers['content-length']) : 0;

  /**
   * 请求体的实体编码。★ 必须在**转发前**就读出来。
   *
   * 为什么：Codex 会用 `Content-Encoding: zstd` 压缩 `/responses` 的请求体。
   * 不按它解码的话，① 落盘的"请求正文"是压缩字节（界面显示乱码）；
   * ② 本地估算会把二进制噪声当文本计数。
   * 响应侧相反（`content-encoding` 只有等上游响应头到达才知道），所以那边传的是惰性读取器。
   */
  const requestEncoding = parseContentEncoding(req.headers['content-encoding']);

  // 正文捕获（仅 Body Mode）：响应侧在这里缓冲；请求侧由 pipeline 解码后提供明文
  const captured: { response: Buffer[] } = { response: [] };
  const wantBodies = rt.bodyEnabled && ctx.recorder !== null;
  const bodyCap = ctx.cfg.edge.observeMaxBytes;

  // ── 请求体旁听：只为记账。上游侧由 forwardUpstream 内部 pipe 保证字节不变 ──
  req.on('data', (chunk: Buffer) => {
    pipeline?.onRequestChunk(chunk);
  });

  const finish = (): void => {
    if (settled) return;
    settled = true;
    if (graceTimer) { clearTimeout(graceTimer); graceTimer = null; }
    timings.totalMs = Number(process.hrtime.bigint() - startedHr) / 1e6;

    const result = pipeline?.finish() ?? null;
    if (result) {
      usage = result.usage;
      observeShape = result.raw.shape;
      observeNote = result.note ?? (result.usageMissingFields.length > 0
        ? `上游 usage 缺字段：${result.usageMissingFields.join(', ')}` : null);
      // 模型名：优先响应里报的，其次请求体里声明的，最后才标 unknown
      model = model ?? result.model ?? 'unknown';
      responseId = responseId ?? result.responseId;
      if (result.firstTokenAt !== null && timings.upstreamHeadersMs !== null) {
        timings.firstTokenMs = result.firstTokenAt - startedAt;
      }
      if (result.usageMissingFields.length > 0) {
        ctx.onUsageIncomplete?.({ id, missing: result.usageMissingFields, model });
      }
    }

    const finalUsage: UsageRecord = usage ?? {
      inputTokens: 0, outputTokens: 0, totalTokens: 0,
      cachedInputTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0,
      source: 'none', complete: true,
    };

    // ── 落账 ──
    if (ctx.recorder) {
      try {
        const event: RequestEvent = {
          id,
          startedAt,
          method: req.method ?? 'GET',
          path: pathOnly,
          query,
          endpoint,
          status,
          errorClass,
          streamed: result?.raw.shape === 'sse',
          upstreamRequestId,
          responseId,
          model,
          codexSessionId: codex.sessionId,
          codexThreadId: codex.threadId,
          codexClientRequestId: codex.clientRequestId,
          codexOriginator: codex.originator,
          codexSubagent: codex.subagent,
          timing: {
            enqueuedAt: startedAt,
            ...(timings.upstreamHeadersMs !== null ? { upstreamHeadersMs: timings.upstreamHeadersMs } : {}),
            ...(timings.firstTokenMs !== null ? { firstTokenMs: timings.firstTokenMs } : {}),
            completedAt: Date.now(),
            totalMs: Math.round(timings.totalMs),
          },
          usage: finalUsage,
          observeShape: (result?.raw.shape ?? 'unknown') as ObserveShape,
          observeNote,
          bytesIn,
          bytesOut,
          truncated: {
            // 请求侧：pipeline 知道副本是否被上限截断、是否解码失败
            request: result?.requestTruncated ?? false,
            response: result?.truncated ?? false,
          },
          bodyRef: null,
          keyFingerprint: codex.authorization ? fingerprint(codex.authorization) : null,
        };
        const cost = ctx.recorder.computeCost(model, finalUsage);
        const pending: PendingEvent = makePendingEvent({ event, costUsd: cost, now: startedAt });
        const bodies = wantBodies
          ? buildBodyCopies(result, captured.response, upContentEncoding)
          : undefined;
        ctx.recorder.add(pending, bodies);
      } catch (e) {
        ctx.log.error({ err: (e as Error).message }, '组装记账事件失败（已忽略）');
      }
    }

    const rec: ExchangeRecord = {
      id, startedAt, method: req.method ?? 'GET', path: pathOnly,
      targetUrl: handle?.targetUrl ?? '', endpoint, status, errorClass, model,
      upstreamRequestId, responseId,
      codexSessionId: codex.sessionId, codexThreadId: codex.threadId, codexOriginator: codex.originator,
      usage: finalUsage, bytesIn, bytesOut, timings,
      observeShape, observeNote,
      clientAborted,
      drainedAfterAbort: result?.clientAborted === true && !clientAborted,
      observation: result ? {
        truncated: result.truncated,
        copiedBytes: result.stats.copiedBytes,
        copyErrors: result.stats.copyErrors,
      } : null,
    };

    try { ctx.onExchange?.(rec); } catch { /* 推送失败不影响主链路 */ }
    logExchange(ctx.log, rec);
  };

  // ── 观测：在**转发之前**建立 ──
  // ★ 为什么必须在转发前建立（实测踩到）：若等到收到上游响应头才建观测，
  //   那么"只返回错误、没有响应体"的请求（429/500/连接失败）就完全没被观测，
  //   结果是模型名落成 `unknown`、请求体信息全丢。
  //   响应头是惰性读取的（传函数），因此提前建立不会导致读不到 content-type。
  let upContentType: string | null = null;
  let upContentEncoding: string | null = null;
  /**
   * 只有 LLM 端点才值得做本地 token 估算。
   *
   * ★ 实测：中继上的 `/v1/alpha/search`（归类为 `other`）返回的 JSON 里根本没有 usage，
   *   估算器于是把请求体数成 170~248 个"input token" —— 这些 token 不存在，
   *   却混进了 Token 统计与成本。非 LLM 端点一律记 `none`。
   */
  const llmEndpoint = endpoint === 'responses' || endpoint === 'chat.completions';
  pipeline = createPipeline({
    contentType: () => upContentType,
    contentEncoding: () => upContentEncoding,
    requestEncoding,
    maxBytes: rt.observeMaxBytes,
    collectRequest: rt.collectRequestForEstimate && llmEndpoint,
    ...(llmEndpoint ? {} : {
      estimateSkipNote: '非 LLM 端点（仅 /responses 与 /chat/completions 做本地 token 估算），未记录 token',
    }),
    captureRequest: wantBodies,
    maxRequestBytes: bodyCap,
    graceDrainMs: rt.graceDrainMs,
    // ★ 失败请求不得把"请求体估算值"当成用量记进账本（见 PipelineOptions.isFailedResponse）。
    //   status 在本闭包里是**当前最新值**，而 finish() 一定在状态码尘埃落定之后才被调用。
    isFailedResponse: () => status === null || status >= 400,
  });

  // 兜底：即便地址看起来非空，仍可能在 new URL() 上炸掉（例如手改坏了的 DB 值）。
  // 同步异常的后果同上（客户端挂起），因此这里显式收口。
  let handle: ReturnType<typeof forwardUpstream>;
  try {
    handle = forwardUpstream({
      clientReq: req,
      cfg: ctx.cfg.upstream,
      agents: ctx.agents,
      log: ctx.log,
      baseUrl: upstreamBaseUrl,
    });
  } catch (e) {
    const detail = `上游地址无法解析：${upstreamBaseUrl} —— ${(e as Error).message}`;
    ctx.log.error({ id, err: (e as Error).message }, '拒绝转发：上游地址非法');
    req.resume();
    sendGatewayError(res, 'config_invalid', detail);
    return;
  }

  // ── 客户端断开 ──
  res.on('close', () => {
    if (settled) return;
    if (res.writableEnded) { finish(); return; }
    clientAborted = true;
    pipeline?.markClientAborted();

    // ★★ 宽限期排空（ADR-15）★★
    // usage **只存在于终止事件**（response.completed）。用户按 Esc 时若立刻 abort 上游，
    // 这一轮就永远记不到账 —— 而这恰是最需要记账的场景。
    // 所以：先继续读上游一段短窗口（默认 8s），拿到 usage 再 abort。
    const graceMs = ctx.settings().graceDrainMs;
    if (graceMs > 0) {
      ctx.log.debug({ id, graceMs }, '客户端断开：进入宽限期排空以捕获 usage');
      // ★ 关键：立刻把已建立的 pipe 摘掉并改为"只读"。
      //   否则 `up.stream.pipe(res)` 会因 res 被销毁而 **pause 源流**，
      //   宽限期内一个字节都读不到（实测踩到，见 drainUpstream 注释）。
      if (activeUpstream) startDrain(activeUpstream);
      graceTimer = setTimeout(() => {
        graceTimer = null;
        if (!settled) {
          ctx.log.debug({ id }, '宽限期到期，abort 上游');
          handle.abort(new SgwAbortError('client_aborted', '客户端断开且宽限期到期'));
        }
      }, graceMs);
      graceTimer.unref?.();
      return;
    }
    handle.abort(new SgwAbortError('client_aborted', '客户端提前断开'));
  });

  handle.onResponse((up: UpstreamResponse) => {
    upstreamResponseSeen = true;
    activeUpstream = up;
    status = up.status;
    upstreamRequestId = up.requestId;
    timings.upstreamHeadersMs = Date.now() - startedAt;

    // ── 记录响应头供观测器惰性读取（观测器已在转发前建立）──
    upContentType = rawHeader(up.rawHeaders, 'content-type');
    upContentEncoding = rawHeader(up.rawHeaders, 'content-encoding');

    if (clientGone(res)) {
      // 客户端已经走了：宽限期排空期间仍然继续读（不写客户端），以捕获 usage。
      startDrain(up);
      return;
    }

    // ── 立刻回写状态行与响应头，不等首个 body 分片 ──
    try {
      res.writeHead(up.status, up.statusMessage || undefined, up.headers);
      res.flushHeaders();
      req.socket.setNoDelay(true);
      res.socket?.setNoDelay(true);
    } catch (e) {
      ctx.log.error({ id, err: (e as Error).message }, 'writeHead 失败');
      errorClass = 'internal_error';
      res.destroy();
      finish();
      return;
    }

    up.stream.once('data', () => {
      timings.upstreamFirstByteMs = Date.now() - startedAt;
    });

    // ── 主链路 pipe + 旁路旁听（H6）──
    // 返回的 handle 我们不需要单独持有：生命周期由 onEnd/onError 与 res 事件驱动。
    teeForObservation({
      src: up.stream,
      dst: res,
      maxBytes: rt.observeMaxBytes,
      onCopy: (chunk) => {
        pipeline?.onResponseChunk(chunk);
        bytesOut += chunk.length;
        if (wantBodies) {
          const have = captured.response.reduce((n, b) => n + b.length, 0);
          if (have < bodyCap) captured.response.push(chunk);
        }
      },
      onEnd: () => {
        if (up.status >= 400 && errorClass === null) {
          errorClass = up.status >= 500 ? 'upstream_5xx' : 'upstream_4xx';
        }
        finish();
      },
      onError: (err) => {
        errorClass = up.status >= 400 ? null : classifyNodeError(err);
        ctx.log.warn({ id, err: err.message, errorClass }, '上游流中断');
        if (!res.writableEnded) res.destroy();
        finish();
      },
    });
  });

  /**
   * 切换为「只读排空」：客户端已走，但我们要继续读上游以捕获 usage。
   *
   * ★ 必须显式处理一个实测踩到的坑：
   *   `up.stream.pipe(res)` 之后若 `res` 被销毁，**pipe 会把源流 pause 掉**。
   *   此时 `up.stream.resume()` 无效（流已被 pipe 接管且处于 paused），
   *   于是宽限期内一个字节都读不到 → usage 永远拿不到 → 退化成估算
   *   （表现为 t_total ≈ graceDrainMs 且 usage_source=estimated）。
   *
   *   正确序列：① `unpipe()` 解绑 ② `resume()` 驱动 ③ `read()` 抽干内部缓冲。
   *
   * 幂等：重复调用直接返回。
   */
  function startDrain(up: UpstreamResponse): void {
    if (draining || settled) return;
    draining = true;

    const consume = (chunk: Buffer): void => {
      // ★ 客户端没收到这些字节，因此**不计入 bytesOut**（如实反映"用户实际拿到多少"）
      pipeline?.onResponseChunk(chunk);
      if (wantBodies) {
        const have = captured.response.reduce((n, b) => n + b.length, 0);
        if (have < bodyCap) captured.response.push(chunk);
      }
    };

    try { up.stream.unpipe(res); } catch { /* 忽略 */ }
    up.stream.on('data', consume);
    up.stream.resume();
    for (;;) {
      const chunk = up.stream.read() as Buffer | null;
      if (chunk === null) break;
      consume(chunk);
    }

    up.stream.on('end', () => { finish(); });
    up.stream.on('error', () => { finish(); });
  }

  handle.onEnd(() => { finish(); });

  handle.onError((err) => {
    if (settled) return;
    if (err instanceof SgwAbortError) {
      if (err.errorClass === 'client_aborted') {
        clientAborted = true;
        if (!upstreamResponseSeen) errorClass = 'client_aborted';
        finish();
        return;
      }
      errorClass = err.errorClass;
      if (!upstreamResponseSeen) sendGatewayError(res, err.errorClass, err.message);
      else if (!res.writableEnded) res.destroy();
      finish();
      return;
    }

    const cls = classifyNodeError(err);
    errorClass = cls;
    const detail = (err as Error)?.message ?? String(err);
    ctx.log.error({ id, path: pathOnly, errorClass: cls, detail }, '转发上游失败');
    if (!upstreamResponseSeen && !clientGone(res)) {
      sendGatewayError(res, cls, detail);
    } else if (!res.writableEnded) {
      res.destroy();
    }
    finish();
  });
}

function rawHeader(rawHeaders: readonly string[], name: string): string | null {
  const lower = name.toLowerCase();
  for (let i = 0; i + 1 < rawHeaders.length; i += 2) {
    if (rawHeaders[i]!.toLowerCase() === lower) return rawHeaders[i + 1]!;
  }
  return null;
}

/**
 * 组装要落盘的正文副本（**明文**）。
 *
 * 请求侧：pipeline 已经按请求头的 `Content-Encoding` 解码（zstd 常见）。
 * 响应侧：这里按响应头的 `Content-Encoding` 解码；观测已截断时不尝试解码
 * （半截压缩流必然失败），直接原样保存 —— 落盘失败一律降级为原始字节，绝不丢数据。
 */
function buildBodyCopies(
  result: PipelineResult | null,
  responseChunks: Buffer[],
  responseEncodingRaw: string | null,
): { request?: Buffer; response?: Buffer } | undefined {
  const out: { request?: Buffer; response?: Buffer } = {};
  const req = result?.requestBody ?? null;
  if (req && req.length > 0) out.request = req;
  if (responseChunks.length > 0) {
    const raw = Buffer.concat(responseChunks);
    out.response = result?.truncated
      ? raw
      : decodeForStorage(raw, parseContentEncoding(responseEncodingRaw)).data;
  }
  return out.request || out.response ? out : undefined;
}

function logExchange(log: Logger, rec: ExchangeRecord): void {
  const bad = rec.errorClass !== null
    && rec.errorClass !== 'upstream_4xx'
    && rec.errorClass !== 'client_aborted';
  const fields = {
    method: rec.method,
    path: rec.path,
    status: rec.status,
    ms: Math.round(rec.timings.totalMs),
    ttfb: rec.timings.upstreamHeadersMs,
    bytesOut: rec.bytesOut,
    tokens: rec.usage.totalTokens || undefined,
    usageSource: rec.usage.source,
    model: rec.model ?? undefined,
    reqId: rec.upstreamRequestId ?? undefined,
    ...(rec.errorClass ? { errorClass: rec.errorClass } : {}),
    ...(rec.clientAborted ? { clientAborted: true } : {}),
    ...(rec.observation?.truncated ? { observeTruncated: true } : {}),
  };
  if (bad) log.warn(fields, '交换完成（有异常）');
  else log.info(fields, '交换完成');
}

/** 断言所有错误分类都有对应的响应规格（开发期自检，避免漏写 specFor 分支） */
export function assertErrorSpecsComplete(): string[] {
  const missing: string[] = [];
  for (const cls of ERROR_CLASSES) {
    const spec = specFor(cls);
    if (!spec || typeof spec.status !== 'number' || !spec.title) missing.push(cls);
  }
  return missing;
}
