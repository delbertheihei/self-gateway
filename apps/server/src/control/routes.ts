/**
 * 控制面路由（`/_sgw/api/*`）。
 *
 * ★ 安全作用域铁律（docs/03 §6.2 / ADR-20）：
 *   `Host` / `Origin` / `X-Gateway-Token` 校验**只作用于 `/_sgw/**`**。
 *   `/v1/**` 代理路径**绝不参与这些校验，也绝不读取该头** —— 向代理请求读取或要求任何头
 *   都是对 H2 的背离。代理路径的访问控制完全依赖"只监听回环"这一层。
 *   回归脚本用例 7 有专门断言锁死这个边界。
 *
 * 命名空间隔离（ADR-9）：所有管理接口在 `/_sgw/` 下，与代理的 `/v1/*` 零冲突。
 */

import fs from 'node:fs';
import path from 'node:path';
import type http from 'node:http';
import { CONTROL_PREFIX, SGW_VERSION, matchPrice } from '@sgw/shared';
import type { HealthReport, GatewayEvent } from '@sgw/shared';
import type { SgwConfig } from '../config/schema.ts';
import type { Logger } from '../config/logger.ts';
import type { Db } from '../db/index.ts';
import { allSettings, dirSizeBytes, setSetting, dbSizeBytes } from '../db/index.ts';
import {
  listUpstreamOverrides, normalizePathMode, normalizeProbeAuth, normalizeProbeModel,
  normalizeSecret, normalizeStripPrefix, persistUpstreamOverride, resolveProbeAuthHeader, validateBaseUrl,
} from '../config/runtime.ts';
import type { Recorder } from '../recorder/index.ts';
import { createAnalytics, resolveRange, type Analytics } from '../analytics/index.ts';
import { createEventBus, type EventBus } from './bus.ts';
import type { Maintenance } from './maintenance.ts';
import type { RuntimeState } from './state.ts';
import { verifyUsageContract } from '../observe/contract-probe.ts';
import type { UpstreamAgents } from '../transport/upstream.ts';
import { probeUpstream } from '../transport/upstream.ts';
import type { TokenGuard } from './token.ts';

export interface ControlContext {
  cfg: SgwConfig;
  log: Logger;
  db: Db;
  recorder: Recorder;
  bus: EventBus;
  state: RuntimeState;
  tokenGuard: TokenGuard;
  uptimeSec: () => number;
  maintenance: () => Maintenance;
  /** 某些设置改了需要重启（例如监听地址） */
  restartedNeeded: () => boolean;
  /**
   * 上游连接池句柄（供"测试连通性"用）。
   * ★ 必填：曾经它是 `agents?: unknown`，index.ts 漏接线也不会报错，
   *   于是"上游与互操作自检"在 `opts.agents.https` 上抛 TypeError —— 请求永久悬挂，
   *   只在日志里留下一行 unhandledRejection。
   */
  agents: UpstreamAgents;
}

export function isControlPath(url: string): boolean {
  return url === CONTROL_PREFIX || url.startsWith(`${CONTROL_PREFIX}/`);
}

/** 反 DNS Rebinding：Host 白名单 */
export function hostAllowed(req: http.IncomingMessage, cfg: SgwConfig): boolean {
  const host = req.headers.host;
  if (typeof host !== 'string' || host === '') return false;
  return cfg.security.allowedHosts.includes(host.toLowerCase());
}

/**
 * Origin 校验（fail-closed）。
 * 变更类请求若带 Origin 且不在白名单 → 拒绝；无 Origin 时只允许 GET/HEAD
 * （浏览器的跨源非 GET 与表单 POST 必带 Origin）。
 */
export function originAllowed(req: http.IncomingMessage, cfg: SgwConfig): boolean {
  const origin = req.headers.origin;
  const method = req.method ?? 'GET';
  if (typeof origin === 'string' && origin !== '') {
    return cfg.security.allowedOrigins.includes(origin.toLowerCase());
  }
  return method === 'GET' || method === 'HEAD';
}

export function sendJson(res: http.ServerResponse, status: number, body: unknown, extraHeaders: Record<string, string> = {}): void {
  const payload = JSON.stringify(body, null, 2);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': String(Buffer.byteLength(payload)),
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    ...extraHeaders,
  });
  res.end(payload);
}

/**
 * 异步分支的统一收尾。
 *
 * ★ 存在的理由（真实故障）：`void (async () => {…})()` 一旦抛出，请求会**永久悬挂** ——
 *   客户端等不到任何响应，服务器只在日志里留一行 unhandledRejection。
 *   所有异步路由都必须经由这里，保证异常变成一条可读的 500。
 */
export function runAsync(res: http.ServerResponse, fn: () => Promise<void>): void {
  void fn().catch((e: unknown) => {
    if (res.headersSent || res.writableEnded) return;
    try { sendJson(res, 500, { error: { code: 'INTERNAL_ERROR', message: errorText(e) } }); }
    catch { /* 连错误响应都发不出去：只能放弃 */ }
  });
}

async function readJsonBody(req: http.IncomingMessage, limit = 1024 * 1024): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > limit) { reject(new Error(`请求体过大（>${limit} 字节）`)); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8').trim();
      if (!text) { resolve({}); return; }
      try { resolve(JSON.parse(text)); } catch (e) { reject(new Error(`JSON 解析失败：${(e as Error).message}`)); }
    });
    req.on('error', (e) => reject(new Error(`读取请求体失败：${(e as Error).message}`)));
  });
}

/** 把任意异常转成可读字符串（`Error` 的 message 可能为空，此时用 name/stack 兜底） */
function errorText(e: unknown): string {
  if (e instanceof Error) {
    return e.message || `${e.name}（message 为空）`;
  }
  try { return JSON.stringify(e) ?? String(e); } catch { return String(e); }
}

export function buildHealthReport(ctx: ControlContext): HealthReport {
  const st = ctx.state;
  const uc = st.usageContract;
  const s = ctx.recorder.settings();
  return {
    ok: true,
    version: SGW_VERSION,
    uptimeSec: Math.round(ctx.uptimeSec()),
    node: process.version,
    listen: `${ctx.cfg.listen.host}:${ctx.cfg.listen.port}`,
    upstream: {
      baseUrl: st.upstreamBaseUrl,
      stripPrefix: ctx.cfg.upstream.stripPrefix,
      pathMode: ctx.cfg.upstream.pathMode,
      reachable: st.upstreamStatus.reachable,
      lastProbeAt: st.upstreamStatus.lastProbeAt,
      lastError: st.upstreamStatus.lastError,
    },
    usageContract: {
      checked: uc.checked,
      complete: uc.complete,
      missingFields: uc.missingFields,
      checkedAt: uc.checkedAt,
    },
    logging: { detailEnabled: s.detailEnabled, bodyEnabled: s.bodyEnabled },
    security: {
      requireToken: ctx.cfg.security.requireToken,
      allowedHosts: ctx.cfg.security.allowedHosts,
    },
    dataDir: ctx.cfg.dataDir,
  };
}

/**
 * 处理控制面请求。返回 true 表示已处理。
 */
export function handleControlRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  ctx: ControlContext,
): boolean {
  const url = req.url ?? '/';
  if (!isControlPath(url)) return false;

  const analytics = createAnalytics(ctx.db);
  const guard = getGuard(ctx);
  const pathOnly = (url.split('?')[0] ?? url);
  const method = req.method ?? 'GET';
  const params = new URL(url, `http://${req.headers.host ?? 'localhost'}`).searchParams;

  // ── 安全前置：Host 白名单（反 DNS Rebinding 核心防线）──
  if (!hostAllowed(req, ctx.cfg)) {
    ctx.log.warn({ host: req.headers.host, url }, '拒绝：Host 不在白名单（疑似 DNS Rebinding）');
    sendJson(res, 403, {
      error: {
        code: 'HOST_NOT_ALLOWED',
        message: 'Host 头不在白名单内',
        hint: `允许的 Host：${ctx.cfg.security.allowedHosts.join(', ')}。`
          + '请用 http://127.0.0.1:端口 访问，而不是其他域名。',
      },
    });
    return true;
  }
  if (!originAllowed(req, ctx.cfg)) {
    ctx.log.warn({ origin: req.headers.origin, method, url }, '拒绝：Origin 不在白名单');
    sendJson(res, 403, {
      error: {
        code: 'ORIGIN_NOT_ALLOWED',
        message: 'Origin 头不在白名单内，或缺少 Origin 的非 GET 请求',
        hint: `允许的 Origin：${ctx.cfg.security.allowedOrigins.join(', ')}`,
      },
    });
    return true;
  }

  const tokenCheck = guard.check(req, pathOnly);
  if (!tokenCheck.ok) {
    sendJson(res, 401, {
      error: {
        code: 'TOKEN_REQUIRED',
        message: tokenCheck.message,
        hint: '请在浏览器中通过设置页给出的引导链接访问一次，或设置 SGW_TOKEN 环境变量。'
          + '若不需要令牌保护，可在 sgw.config.ts 中设置 security.requireToken = false。',
      },
    });
    return true;
  }

  // ══════════════════════════ 健康与版本 ══════════════════════════

  if (method === 'GET' && pathOnly === `${CONTROL_PREFIX}/api/health`) {
    sendJson(res, 200, buildHealthReport(ctx));
    return true;
  }

  if (method === 'GET' && pathOnly === `${CONTROL_PREFIX}/api/version`) {
    sendJson(res, 200, { version: SGW_VERSION, node: process.version, pid: process.pid, schema: 1 });
    return true;
  }

  // ══════════════════════════ 统计 ══════════════════════════

  if (method === 'GET' && pathOnly.startsWith(`${CONTROL_PREFIX}/api/stats/`)) {
    const kind = pathOnly.slice(`${CONTROL_PREFIX}/api/stats/`.length);
    const range = resolveRange(params.get('range'), params.get('from') ?? undefined, params.get('to') ?? undefined);

    switch (kind) {
      case 'summary': {
        sendJson(res, 200, {
          data: analytics.summary(range),
          meta: { rangeMs: [range.from, range.to], detailEnabled: ctx.recorder.settings().detailEnabled },
          warnings: ctx.state.usageContract.complete === false
            ? [`usage_incomplete:${ctx.state.usageContract.missingFields.join('|')}`] : [],
        });
        return true;
      }
      case 'timeseries': {
        const bucket = (params.get('bucket') ?? 'auto') as 'auto' | 'hour' | 'day';
        const breakdown = (params.get('breakdown') ?? 'type') as 'type' | 'model';
        const resolved = bucket === 'auto'
          ? ((range.to - range.from) > 2 * 86_400_000 ? 'day' : 'hour')
          : bucket;
        sendJson(res, 200, { data: analytics.timeseries(range, resolved, breakdown), meta: { bucket: resolved, breakdown } });
        return true;
      }
      case 'by-model': {
        sendJson(res, 200, { data: analytics.byModel(range, Number(params.get('limit') ?? 20)) });
        return true;
      }
      case 'by-session': {
        sendJson(res, 200, { data: analytics.bySession(range, Number(params.get('limit') ?? 20)) });
        return true;
      }
      case 'latency': {
        sendJson(res, 200, { data: analytics.latency(range) });
        return true;
      }
      default:
        sendJson(res, 404, notFound(`stats/${kind}`));
        return true;
    }
  }

  // ══════════════════════════ 请求明细 ══════════════════════════

  if (method === 'GET' && pathOnly === `${CONTROL_PREFIX}/api/requests`) {
    const range = resolveRange(params.get('range'), params.get('from') ?? undefined, params.get('to') ?? undefined);
    const page = analytics.requests({
      range,
      model: params.get('model'),
      status: params.get('status') as '2xx' | '4xx' | '5xx' | 'error' | null,
      endpoint: params.get('endpoint'),
      usageSource: params.get('usageSource') as 'upstream' | 'estimated' | 'none' | null,
      minDurationMs: params.get('minDuration') ? Number(params.get('minDuration')) : null,
      sessionId: params.get('sessionId'),
      q: params.get('q'),
      cursor: params.get('cursor'),
      limit: Number(params.get('limit') ?? 50),
      orderBy: (params.get('orderBy') ?? 'started_at') as 'started_at' | 't_total' | 'total_tokens',
      order: (params.get('order') ?? 'desc') as 'asc' | 'desc',
    });

    // 语义（重要，曾经做错）：
    //   关闭明细只意味着"不再记录**新的**请求"，**不影响已经落库的历史明细**。
    //   因此：历史有数据就照常返回（附一条 warning），历史为空则额外给解释性 notice。
    //   两种情况下都要把"如何重新开启"的指引带给用户 —— 否则用户只看到空表却不知为何。
    if (!ctx.recorder.settings().detailEnabled) {
      const base = {
        ...page,
        warnings: [...(page.warnings ?? []), 'DETAIL_LOGGING_DISABLED'],
        notice: {
          code: 'DETAIL_LOGGING_DISABLED',
          message: page.meta.totalApprox === 0
            ? '请求明细记录已关闭 —— 当前仅保留聚合统计'
            : '请求明细记录已关闭 —— 以下为关闭之前的历史明细',
          hint: '在设置页开启「记录请求明细」后，新请求才会出现在这里。'
            + '概览页的 KPI 与趋势不受影响（聚合统计恒写）。',
        },
      };
      sendJson(res, 200, base);
      return true;
    }

    sendJson(res, 200, page);
    return true;
  }

  if (method === 'GET' && pathOnly.startsWith(`${CONTROL_PREFIX}/api/requests/`)) {
    const rest = pathOnly.slice(`${CONTROL_PREFIX}/api/requests/`.length);
    const [id, sub] = rest.split('/');
    if (!id) { sendJson(res, 404, notFound('requests')); return true; }

    if (sub === 'body') {
      const side = params.get('side') === 'response' ? 'res' : 'req';
      if (!ctx.recorder.settings().bodyEnabled) {
        sendJson(res, 403, {
          error: {
            code: 'BODY_LOGGING_DISABLED',
            message: '正文记录已关闭',
            hint: '在设置中开启「记录请求/响应正文」后，新请求的正文才会被保存。',
          },
        });
        return true;
      }
      const ref = analytics.bodyRef(id);
      if (!ref) {
        sendJson(res, 404, {
          error: { code: 'RECORD_NOT_FOUND', message: '该请求没有保存正文（可能已被清理，或当时未开启）' },
        });
        return true;
      }
      const file = path.join(resolveBodiesDir(ctx.cfg.dataDir), `${ref.ref}.${side}.json`);
      if (!fs.existsSync(file)) {
        sendJson(res, 404, { error: { code: 'RECORD_NOT_FOUND', message: '正文件已不存在（可能已被清理）' } });
        return true;
      }
      const body = fs.readFileSync(file);
      let parsed: unknown = null;
      try { parsed = JSON.parse(body.toString('utf8')); } catch { /* 原样返回文本 */ }
      sendJson(res, 200, {
        data: { id, side, bytes: body.length, truncated: ref.bytes !== null && body.length >= ref.bytes && body.length >= ctx.cfg.edge.observeMaxBytes, raw: parsed ?? body.toString('utf8').slice(0, 200_000) },
        warning: '正文可能包含代码、密钥与个人信息，请勿外传。',
      });
      return true;
    }

    const row = analytics.request(id);
    if (!row) {
      sendJson(res, 404, { error: { code: 'RECORD_NOT_FOUND', message: '记录不存在或已被清理' } });
      return true;
    }
    sendJson(res, 200, { data: row });
    return true;
  }

  if (method === 'GET' && pathOnly === `${CONTROL_PREFIX}/api/sessions`) {
    sendJson(res, 200, { data: analytics.sessions(Number(params.get('limit') ?? 100)) });
    return true;
  }

  if (method === 'GET' && pathOnly === `${CONTROL_PREFIX}/api/meta`) {
    // 本机出现过的模型里，哪些还没有价格？（界面据此提示"去补价格"，避免成本显示成未知）
    const prices = ctx.recorder.listPrices();
    const unpricedModels = analytics.distinctModels().filter((m) => matchPrice(prices, m) === null);
    sendJson(res, 200, {
      data: {
        models: analytics.distinctModels(),
        unpricedModels,
        priceSource: ctx.recorder.priceSource(),
        counts: analytics.counts(),
        settings: ctx.recorder.settings(),
        prices,
        storage: {
          dataDir: ctx.cfg.dataDir,
          dbBytes: dbSizeBytes(ctx.db),
          bodiesBytes: dirSizeBytes(resolveBodiesDir(ctx.cfg.dataDir)),
          totalBytes: dirSizeBytes(ctx.cfg.dataDir),
        },
        lastCleanup: ctx.state.lastCleanup,
        sawWebsocketAttempt: ctx.state.sawWebsocketAttempt,
        upstreamProbeStatus: ctx.state.upstreamProbeStatus,
        restartedNeeded: ctx.restartedNeeded(),
      },
    });
    return true;
  }

  // ══════════════════════════ 实时推送（SSE）══════════════════════════

  if (method === 'GET' && pathOnly === `${CONTROL_PREFIX}/api/stream`) {
    attachStream(req, res, ctx);
    return true;
  }

  // ══════════════════════════ 设置 ══════════════════════════

  if (pathOnly === `${CONTROL_PREFIX}/api/settings`) {
    if (method === 'GET') {
      sendJson(res, 200, {
        data: {
          logging: {
            detailEnabled: ctx.recorder.settings().detailEnabled,
            bodyEnabled: ctx.recorder.settings().bodyEnabled,
            bodyMaxBytes: ctx.recorder.settings().bodyMaxBytes,
            bodyCompress: ctx.recorder.settings().bodyCompress,
          },
          retention: {
            detailDays: ctx.recorder.settings().detailDays,
            bodyDays: ctx.recorder.settings().bodyDays,
            maxDbBytes: ctx.recorder.settings().maxDbBytes,
            maxBodyBytes: ctx.recorder.settings().maxBodyBytes,
            autoVacuum: ctx.recorder.settings().autoVacuum,
          },
          upstream: {
            /** **运行时生效**的上游地址（可能来自设置页热改） */
            baseUrl: ctx.state.upstreamBaseUrl,
            /** 启动时 sgw.config.ts 里写的值（快照，供界面做对照说明） */
            configuredBaseUrl: ctx.state.configUpstream.baseUrl,
            /** 当前被运行期设置覆盖的键（值来自 SQLite，而不是配置文件） */
            overrides: listUpstreamOverrides(ctx.db, ctx.cfg.listen.port),
            stripPrefix: ctx.cfg.upstream.stripPrefix,
            pathMode: ctx.cfg.upstream.pathMode,
            probeModel: ctx.cfg.upstream.probeModel,
            /** 是否已配置"替换鉴权"；★ 密钥本身**永不回传**给前端 */
            replaceAuth: ctx.cfg.upstream.replaceAuth !== false,
            authHeader: ctx.cfg.upstream.authHeader,
            hasProbeAuth: !!resolveProbeAuthHeader(ctx.cfg, ctx.db).value,
            probeAuthSource: resolveProbeAuthHeader(ctx.cfg, ctx.db).source,
            caFile: ctx.cfg.upstream.caFile,
            strictSsl: ctx.cfg.upstream.strictSsl,
            headersTimeoutMs: ctx.cfg.upstream.headersTimeoutMs,
            graceDrainMs: ctx.cfg.edge.graceDrainMs,
          },
          security: {
            requireToken: ctx.cfg.security.requireToken,
            tokenFingerprint: guard.fingerprint(),
            allowedHosts: ctx.cfg.security.allowedHosts,
          },
          edge: {
            observeMaxBytes: ctx.cfg.edge.observeMaxBytes,
            sseKeepAliveMs: ctx.cfg.edge.sseKeepAliveMs,
            requestTimeoutMs: ctx.cfg.edge.requestTimeoutMs,
          },
          // 原始 settings 转储（排查用）。
          // ★ 必须过滤掉含密钥的键：上游鉴权与本地访问令牌都是明文，
          //   这里无脑全量返回会把它们回传给浏览器（即使是 localhost 也不该）。
          raw: redactedRawSettings(ctx.db),
        },
      });
      return true;
    }

    if (method === 'PATCH' || method === 'POST') {
      runAsync(res, async () => {
        try {
          const body = await readJsonBody(req) as Record<string, unknown>;
          const applied = applySettingsPatch(ctx, body);
          ctx.bus.publish({ type: 'settings.changed', data: { settings: ctx.recorder.settings() } });
          sendJson(res, 200, { data: applied, restartedNeeded: ctx.restartedNeeded() });
        } catch (e) {
          sendJson(res, 400, { error: { code: 'INVALID_PATCH', message: errorText(e) } });
        }
      });
      return true;
    }
  }

  // ══════════════════════════ 运维动作 ══════════════════════════

  if (method === 'POST' && pathOnly === `${CONTROL_PREFIX}/api/upstream/test`) {
    runAsync(res, async () => {
      // 未配置上游地址 / 探针模型时**不要**照发一个空模型请求 —— 那只会得到一个
      // 误导性的 400，用户会以为"中继不支持 usage 契约"。直接给出可执行的说明。
      if (!ctx.state.upstreamBaseUrl) {
        sendJson(res, 200, {
          data: {
            checked: false, complete: null, missingFields: [], checkedAt: Date.now(),
            note: '尚未配置上游地址 —— 请在「设置 → 上游」手动填写后再测试。',
            terminalType: null, sawUsage: false,
          },
        });
        return;
      }
      const model = ctx.cfg.upstream.probeModel;
      if (!model) {
        sendJson(res, 200, {
          data: {
            checked: false, complete: null, missingFields: [], checkedAt: Date.now(),
            note: '尚未配置探针模型 —— 请在「设置 → 上游」填写一个上游真实存在的模型名（如你常用的那一个）后再测试。',
            terminalType: null, sawUsage: false,
          },
        });
        return;
      }
      const auth = await resolveAuthForProbe(ctx);
      if (!auth) {
        sendJson(res, 200, {
          data: {
            checked: false, complete: null, missingFields: [], checkedAt: Date.now(),
            note: '没有可用的鉴权：请填写「探针鉴权」，或先让 Codex 正常发一次请求（网关不会保存 Authorization 明文）。',
            terminalType: null, sawUsage: false,
          },
        });
        return;
      }
      const r = await verifyUsageContract({
        baseUrl: ctx.state.upstreamBaseUrl,
        model,
        authorizationHeader: auth,
        agents: ctx.agents,
        log: ctx.log,
        stripPrefix: ctx.cfg.upstream.stripPrefix,
        pathMode: ctx.cfg.upstream.pathMode,
      });
      ctx.state.usageContract = {
        checked: r.checked, complete: r.complete,
        missingFields: r.missingFields, checkedAt: r.checkedAt,
      };
      sendJson(res, 200, { data: r });
    });
    return true;
  }

  if (method === 'POST' && pathOnly === `${CONTROL_PREFIX}/api/selftest`) {
    runAsync(res, async () => {
      const { runSelfTest } = await import('./selftest.ts');
      const report = await runSelfTest(ctx);
      sendJson(res, 200, { data: report });
    });
    return true;
  }

  if (method === 'POST' && pathOnly === `${CONTROL_PREFIX}/api/maintenance`) {
    runAsync(res, async () => {
      const report = ctx.maintenance().runNow('manual');
      ctx.state.lastCleanup = {
        ranAt: report.ranAt, reason: report.reason,
        deletedDetailRows: report.deletedDetailRows, deletedBodyDirs: report.deletedBodyDirs,
      };
      sendJson(res, 200, { data: report });
    });
    return true;
  }

  if (method === 'POST' && pathOnly === `${CONTROL_PREFIX}/api/backup`) {
    const r = ctx.recorder.backup();
    if (r.ok) {
      sendJson(res, 200, { data: { file: r.file, bytes: r.file ? fs.statSync(r.file).size : 0 } });
    } else {
      sendJson(res, 500, { error: { code: 'BACKUP_FAILED', message: r.error ?? '备份失败' } });
    }
    return true;
  }

  if (method === 'DELETE' && pathOnly === `${CONTROL_PREFIX}/api/data`) {
    runAsync(res, async () => {
      try {
        const body = await readJsonBody(req) as { scope?: string; before?: number };
        const scope = body.scope ?? 'detail';
        const result = purgeData(ctx, scope, body.before);
        sendJson(res, 200, { data: result });
      } catch (e) {
        sendJson(res, 400, { error: { code: 'INVALID_REQUEST', message: errorText(e) } });
      }
    });
    return true;
  }

  if (method === 'GET' && pathOnly === `${CONTROL_PREFIX}/api/export/requests.csv`) {
    const range = resolveRange(params.get('range'), params.get('from') ?? undefined, params.get('to') ?? undefined);
    streamRequestsCsv(res, analytics, range);
    return true;
  }

  if (pathOnly === `${CONTROL_PREFIX}/api/prices`) {
    if (method === 'GET') {
      sendJson(res, 200, { data: ctx.recorder.listPrices(), meta: { source: ctx.recorder.priceSource() } });
      return true;
    }
    if (method === 'PUT' || method === 'POST') {
      runAsync(res, async () => {
        try {
          const body = await readJsonBody(req) as { prices?: Array<Record<string, unknown>> } | Array<Record<string, unknown>>;
          const list = Array.isArray(body) ? body : (body.prices ?? []);
          let n = 0;
          for (const p of list) {
            const model = String(p.model ?? '').trim();
            if (!model) continue;
            const num = (v: unknown): number => {
              const x = Number(v);
              return Number.isFinite(x) && x >= 0 ? x : 0;
            };
            ctx.recorder.upsertPrice({
              model,
              inputPerMtok: num(p.inputPerMtok),
              outputPerMtok: num(p.outputPerMtok),
              cachedPerMtok: p.cachedPerMtok === null || p.cachedPerMtok === undefined ? null : num(p.cachedPerMtok),
              reasoningPerMtok: p.reasoningPerMtok === null || p.reasoningPerMtok === undefined ? null : num(p.reasoningPerMtok),
            });
            n++;
          }
          sendJson(res, 200, { data: { updated: n, prices: ctx.recorder.listPrices() } });
        } catch (e) {
          sendJson(res, 400, { error: { code: 'INVALID_REQUEST', message: errorText(e) } });
        }
      });
      return true;
    }
    if (method === 'DELETE') {
      const model = params.get('model');
      if (!model) { sendJson(res, 400, { error: { code: 'INVALID_REQUEST', message: '缺少 model 参数' } }); return true; }
      ctx.recorder.deletePrice(model);
      sendJson(res, 200, { data: { deleted: model, prices: ctx.recorder.listPrices() } });
      return true;
    }
  }

  // 恢复官方默认价格：默认**只补缺失的模型**（不覆盖用户改过的价格）
  if (method === 'POST' && pathOnly === `${CONTROL_PREFIX}/api/prices/defaults`) {
    runAsync(res, async () => {
      try {
        const body = await readJsonBody(req) as { overwrite?: boolean };
        const r = ctx.recorder.seedDefaultPrices({ overwrite: body.overwrite === true });
        ctx.log.info({ ...r, overwrite: body.overwrite === true }, '价格表已按官方默认值补齐');
        sendJson(res, 200, {
          data: { ...r, prices: ctx.recorder.listPrices(), source: ctx.recorder.priceSource() },
        });
      } catch (e) {
        sendJson(res, 400, { error: { code: 'INVALID_REQUEST', message: errorText(e) } });
      }
    });
    return true;
  }

  sendJson(res, 501, {
    error: {
      code: 'NOT_IMPLEMENTED',
      message: `${method} ${pathOnly} 尚未实现`,
      hint: `可用：${CONTROL_PREFIX}/api/health · stats/* · requests · sessions · meta · settings · stream · selftest · upstream/test · maintenance · backup · prices · prices/defaults · export/requests.csv`,
    },
  });
  return true;
}

// ─────────────────────────────── 设置补丁 ───────────────────────────────

export function applySettingsPatch(ctx: ControlContext, body: Record<string, unknown>): unknown {
  const logging = body.logging as Record<string, unknown> | undefined;
  const retention = body.retention as Record<string, unknown> | undefined;
  const upstream = body.upstream as Record<string, unknown> | undefined;

  const patch: Record<string, unknown> = {};

  if (logging) {
    if (typeof logging.detailEnabled === 'boolean') patch.detailEnabled = logging.detailEnabled;
    if (typeof logging.bodyEnabled === 'boolean') patch.bodyEnabled = logging.bodyEnabled;
    if (typeof logging.bodyMaxBytes === 'number') patch.bodyMaxBytes = clamp(logging.bodyMaxBytes, 1024, 16 * 1024 * 1024);
    if (typeof logging.bodyCompress === 'boolean') patch.bodyCompress = logging.bodyCompress;

    // 约束：正文记录依赖明细记录（否则正文无处关联）
    const next = { ...ctx.recorder.settings(), ...patch };
    if (next.bodyEnabled && !next.detailEnabled) {
      throw new Error('「记录正文」依赖「记录明细」。请先开启记录明细，或同时开启两者。');
    }
  }

  if (retention) {
    if (typeof retention.detailDays === 'number') patch.detailDays = clamp(retention.detailDays, 0, 3650);
    if (typeof retention.bodyDays === 'number') patch.bodyDays = clamp(retention.bodyDays, 0, 3650);
    if (typeof retention.maxDbBytes === 'number') patch.maxDbBytes = clamp(retention.maxDbBytes, 0, 1024 ** 4);
    if (typeof retention.maxBodyBytes === 'number') patch.maxBodyBytes = clamp(retention.maxBodyBytes, 0, 1024 ** 4);
    if (typeof retention.autoVacuum === 'boolean') patch.autoVacuum = retention.autoVacuum;
  }

  if (upstream) {
    // ══════════════ 上游设置：热改 + 持久化 ══════════════
    // 语义（三态，必须分清，否则用户会"改了却回不去"）：
    //   · 字段缺省（undefined）→ 不动它
    //   · 具体值              → 写入 settings 表，并立即应用到 cfg / state（下一次请求生效）
    //   · null / '' / false   → **删除**该键，回落到 sgw.config.ts 的值
    // 这里绝不回写 sgw.config.ts（docs/03 §4.3：Web 端永不破坏人类可读的配置文件）。
    const applied: string[] = [];
    const cleared: string[] = [];

    const touch = (key: Parameters<typeof persistUpstreamOverride>[1], value: string | null): void => {
      persistUpstreamOverride(ctx.db, key, value);
      // ★ 只有 null 才算"清除"：空字符串对 stripPrefix 是**合法值**（不剥任何前缀）
      if (value === null) cleared.push(key); else applied.push(key);
    };

    // ── 上游地址（最常改的一项）──
    if (upstream.baseUrl !== undefined) {
      if (upstream.baseUrl === null || (typeof upstream.baseUrl === 'string' && upstream.baseUrl.trim() === '')) {
        touch('baseUrl', null);
        ctx.cfg.upstream.baseUrl = ctx.state.configUpstream.baseUrl;
        ctx.state.upstreamBaseUrl = ctx.state.configUpstream.baseUrl;
        ctx.state.upstreamStatus = { reachable: null, lastProbeAt: null, lastError: null };
        ctx.state.upstreamProbeStatus = null;
        reprobeLater(ctx);
      } else if (typeof upstream.baseUrl === 'string') {
        const v = upstream.baseUrl.trim();
        const bad = validateBaseUrl(v, ctx.cfg.listen.port);
        if (bad) throw new Error(`上游地址无效：${bad}`);
        touch('baseUrl', v);
        ctx.cfg.upstream.baseUrl = v;
        ctx.state.upstreamBaseUrl = v;
        // 地址换了 → 旧的连通性结论作废，重新探一次（异步，不阻塞响应）
        ctx.state.upstreamStatus = { reachable: null, lastProbeAt: null, lastError: null };
        ctx.state.upstreamProbeStatus = null;
        reprobeLater(ctx);
      } else {
        throw new Error('upstream.baseUrl 必须是字符串或 null');
      }
    }

    // ── 路径拼接（决定 /v1/v1/responses 这类 404 的根源）──
    // ★ 每一条"清除"分支都回落到 **配置文件快照**，而不是硬编码默认值 ——
    //   否则清除 = 把用户的配置悄悄改成别的值。
    if (upstream.stripPrefix !== undefined) {
      if (upstream.stripPrefix === null) {
        touch('stripPrefix', null);
        ctx.cfg.upstream.stripPrefix = ctx.state.configUpstream.stripPrefix;
      } else {
        const v = normalizeStripPrefix(upstream.stripPrefix);
        touch('stripPrefix', v);
        ctx.cfg.upstream.stripPrefix = v;
      }
    }
    if (upstream.pathMode !== undefined) {
      if (upstream.pathMode === null) {
        touch('pathMode', null);
        ctx.cfg.upstream.pathMode = ctx.state.configUpstream.pathMode;
      } else {
        const v = normalizePathMode(upstream.pathMode);
        touch('pathMode', v);
        ctx.cfg.upstream.pathMode = v;
      }
    }

    // ── 探针模型（决定 usage 契约探针能不能跑）──
    if (upstream.probeModel !== undefined) {
      if (upstream.probeModel === null || (typeof upstream.probeModel === 'string' && upstream.probeModel.trim() === '')) {
        touch('probeModel', null);
        ctx.cfg.upstream.probeModel = ctx.state.configUpstream.probeModel;
      } else {
        const v = normalizeProbeModel(upstream.probeModel);
        touch('probeModel', v);
        ctx.cfg.upstream.probeModel = v;
      }
    }

    // ── 替换鉴权（H5 的显式例外）：明文密钥只落本机 SQLite，永不回传前端 ──
    if (upstream.replaceAuth !== undefined) {
      if (upstream.replaceAuth === false || upstream.replaceAuth === null
        || (typeof upstream.replaceAuth === 'string' && upstream.replaceAuth.trim() === '')) {
        // 配置文件里写死了密钥时无法在运行期关闭 —— 明确告知而不是静默忽略。
        // ★ 判断依据是**启动快照**，不是被热改过的 cfg：否则用户一填密钥就会被误判成
        //   "配置文件写死的" → 再也清不掉（真实踩到的 bug）。
        if (ctx.state.configUpstream.replaceAuthFixed) {
          throw new Error('replaceAuth 已在 sgw.config.ts 中配置为固定密钥，运行期无法关闭。'
            + '请把 sgw.config.ts 里的 upstream.replaceAuth 改为 false 后重启。');
        }
        touch('replaceAuth', null);
        // 回落到"原样透传"（配置文件里没写死密钥，因此就是 false）
        ctx.cfg.upstream.replaceAuth = false;
      } else if (typeof upstream.replaceAuth === 'string') {
        const v = normalizeSecret(upstream.replaceAuth, 'replaceAuth');
        touch('replaceAuth', v);
        ctx.cfg.upstream.replaceAuth = v;
      } else {
        throw new Error('upstream.replaceAuth 必须是密钥字符串、false 或 null');
      }
    }

    // ── 探针鉴权（完整头值，如 "Bearer sk-…"）──
    if (upstream.probeAuth !== undefined) {
      if (upstream.probeAuth === null || (typeof upstream.probeAuth === 'string' && upstream.probeAuth.trim() === '')) {
        touch('probeAuth', null);
        ctx.cfg.upstream.probeAuth = ctx.state.configUpstream.probeAuth;
      } else {
        const v = normalizeProbeAuth(upstream.probeAuth);
        touch('probeAuth', v);
        ctx.cfg.upstream.probeAuth = v;
      }
    }

    ctx.state.upstreamOverrides = listUpstreamOverrides(ctx.db, ctx.cfg.listen.port);
    if (applied.length || cleared.length) {
      // ★ 只记键名，绝不记值（replaceAuth / probeAuth 是明文密钥）
      ctx.log.info({ applied, cleared }, '上游运行期设置已更新（即时生效，无需重启）');
    }
  }

  if (Object.keys(patch).length > 0) ctx.recorder.updateSettings(patch as never);
  return {
    settings: ctx.recorder.settings(),
    upstreamBaseUrl: ctx.state.upstreamBaseUrl,
    upstreamOverrides: ctx.state.upstreamOverrides,
  };
}

/**
 * 上游地址刚被热改：异步探一次连通性，把新地址的结论刷进 state。
 *
 * 刻意**不 await**：用户点"应用"要的是立刻反馈，而不是等一次网络探测。
 * 失败也不抛出（探测函数自己会返回 reachable=false）。
 */
function reprobeLater(ctx: ControlContext): void {
  const target = ctx.state.upstreamBaseUrl;
  if (!target) return;
  void probeUpstream(target, ctx.agents, 5_000).then((r) => {
    // 期间可能又被改过一次：只接受"探测目标仍是当前生效地址"的结果
    if (ctx.state.upstreamBaseUrl !== target) return;
    ctx.state.upstreamStatus = { reachable: r.reachable, lastProbeAt: Date.now(), lastError: r.error };
    ctx.state.upstreamProbeStatus = r.status;
    if (r.reachable) ctx.log.info({ status: r.status, target }, '上游地址已热改，连通性 OK');
    else ctx.log.warn({ error: r.error, target }, '上游地址已热改，但连通性探测失败');
  }).catch((e: unknown) => {
    ctx.log.warn({ err: errorText(e) }, '上游热改后的连通性探测异常（已忽略）');
  });
}

function clamp(v: number, min: number, max: number): number {
  if (!Number.isFinite(v)) return min;
  return Math.min(max, Math.max(min, Math.round(v)));
}

/**
 * settings 表的"脱敏转储"。
 *
 * 存在的理由（实测踩到）：`raw: allSettings(db)` 会把 `upstream.replaceAuth`（明文密钥）
 * 与 `security.token`（本地访问令牌）原样回传给浏览器。即使是回环访问也不该发生 ——
 * 一个 XSS 或一次误截图就泄漏了。含密钥的键一律**只报键名**。
 */
function redactedRawSettings(db: Db): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(allSettings(db))) {
    if (k === 'security.token' || k.startsWith('upstream.') || /secret|token|password|key/i.test(k)) {
      out[k] = '«已隐藏»';
    } else {
      out[k] = v;
    }
  }
  return out;
}

// ─────────────────────────────── SSE 推送 ───────────────────────────────

function attachStream(req: http.IncomingMessage, res: http.ServerResponse, ctx: ControlContext): void {
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache, no-store',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
  });
  res.flushHeaders();
  res.socket?.setNoDelay(true);

  let eventId = 0;
  const send = (event: GatewayEvent): void => {
    if (res.writableEnded || res.destroyed) return;
    const payload = JSON.stringify(event.data);
    // 控制面流的心跳与 id 是我们自己的协议，不受 H3 约束（H3 只约束 /v1 代理流）
    res.write(`id: ${++eventId}\nevent: ${event.type}\ndata: ${payload}\n\n`);
  };

  const unsubscribe = ctx.bus.subscribe({
    label: `sse-${eventId}-${Date.now()}`,
    send,
    close: () => { try { res.end(); } catch { /* 忽略 */ } },
  });

  // 心跳：15s 一次注释帧，防中间设备掐空闲连接
  const heartbeat = setInterval(() => {
    if (res.writableEnded || res.destroyed) return;
    res.write(': heartbeat\n\n');
  }, 15_000);
  heartbeat.unref?.();

  // 首帧：立刻给一个快照，避免前端"空白等待"
  send({ type: 'stats.tick', data: { at: Date.now(), requestDelta: 0, tokenDelta: 0, errorDelta: 0 } });

  const cleanup = (): void => {
    clearInterval(heartbeat);
    unsubscribe();
  };
  res.on('close', cleanup);
  req.on('error', cleanup);
}

// ─────────────────────────────── CSV 导出 ───────────────────────────────

function streamRequestsCsv(
  res: http.ServerResponse,
  analytics: Analytics,
  range: { from: number; to: number },
): void {
  res.writeHead(200, {
    'content-type': 'text/csv; charset=utf-8',
    'content-disposition': `attachment; filename="sgw-requests-${new Date().toISOString().slice(0, 10)}.csv"`,
    'cache-control': 'no-store',
  });
  // BOM：让 Excel 正确识别 UTF-8
  res.write('\ufeff');
  res.write([
    'id', 'started_at', 'started_iso', 'method', 'path', 'endpoint', 'status', 'error_class',
    'model', 'session_id', 'originator', 'upstream_request_id', 'response_id',
    'total_ms', 'ttfb_ms', 'first_token_ms',
    'input_tokens', 'output_tokens', 'cached_tokens', 'reasoning_tokens', 'total_tokens',
    'usage_source', 'usage_complete', 'cost_usd', 'bytes_in', 'bytes_out',
  ].join(',') + '\n');

  let cursor: string | null = null;
  let guard = 0;
  for (;;) {
    const page = analytics.requests({ range, limit: 500, cursor });
    for (const r of page.data) {
      res.write([
        r.id, r.startedAt, new Date(r.startedAt).toISOString(), r.method, csv(r.path), r.endpoint,
        r.status ?? '', r.errorClass ?? '', csv(r.model ?? ''), csv(r.sessionId ?? ''), csv(r.originator ?? ''),
        csv(r.upstreamRequestId ?? ''), csv(r.responseId ?? ''),
        Math.round(r.totalMs), r.ttfbMs?.toFixed(1) ?? '', r.firstTokenMs?.toFixed(1) ?? '',
        r.inputTokens, r.outputTokens, r.cachedTokens, r.reasoningTokens, r.totalTokens,
        r.usageSource, r.usageComplete ? 1 : 0, r.costUsd ?? '', r.bytesIn, r.bytesOut,
      ].join(',') + '\n');
    }
    if (!page.meta.hasMore || !page.meta.nextCursor) break;
    cursor = page.meta.nextCursor;
    if (++guard > 200) break;   // 防呆：最多 10 万行
  }
  res.end();
}

function csv(v: string): string {
  if (!v) return '';
  return /[",\n\r]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
}

// ─────────────────────────────── 数据清理 ───────────────────────────────

function purgeData(ctx: ControlContext, scope: string, before?: number): Record<string, unknown> {
  const bodiesDir = resolveBodiesDir(ctx.cfg.dataDir);
  const out: Record<string, unknown> = { scope, deletedDetailRows: 0, deletedBodyDirs: [], keptAggregates: true };

  if (scope === 'detail' || scope === 'all') {
    const params: Parameters<typeof ctx.db.run>[1] = [];
    let sql = 'DELETE FROM request_event';
    if (typeof before === 'number') { sql += ' WHERE started_at < ?'; params.push(before); }
    const r = ctx.db.run(sql, params);
    out.deletedDetailRows = Number(r.changes);
  }

  if (scope === 'bodies' || scope === 'all') {
    if (fs.existsSync(bodiesDir)) {
      const dirs = fs.readdirSync(bodiesDir, { withFileTypes: true })
        .filter((e) => e.isDirectory()).map((e) => e.name);
      for (const d of dirs) {
        fs.rmSync(path.join(bodiesDir, d), { recursive: true, force: true });
        (out.deletedBodyDirs as string[]).push(d);
      }
    }
    if (scope === 'bodies') {
      // 正文清空后清掉引用，避免孤儿
      ctx.db.run('UPDATE request_event SET body_ref = NULL, body_bytes = NULL WHERE body_ref IS NOT NULL');
    }
  }

  if (scope === 'all') {
    ctx.db.run('DELETE FROM request_event');
    ctx.db.run('DELETE FROM session');
    ctx.db.run('DELETE FROM daily_session');
    out.deletedDetailRows = Number(out.deletedDetailRows);
    out.keptAggregates = true;
    out.note = '聚合表（rollup_hourly / daily_model）已保留，KPI 不会归零。如需彻底清空请删除 data/ 目录。';
  }

  try { ctx.db.exec('PRAGMA wal_checkpoint(TRUNCATE)'); } catch { /* 忽略 */ }
  out.sizes = {
    dbBytes: dbSizeBytes(ctx.db),
    bodiesBytes: dirSizeBytes(bodiesDir),
    totalBytes: dirSizeBytes(ctx.cfg.dataDir),
  };
  ctx.log.info(out, '执行数据清理');
  return out;
}

function resolveBodiesDir(dataDir: string): string {
  return path.join(dataDir, 'bodies');
}

function notFound(what: string): { error: { code: string; message: string } } {
  return { error: { code: 'NOT_FOUND', message: `未知接口：${what}` } };
}

async function resolveAuthForProbe(ctx: ControlContext): Promise<string | null> {
  return resolveProbeAuthHeader(ctx.cfg, ctx.db).value;
}

// ─────────────────────────────── Token 守卫 ───────────────────────────────

function getGuard(ctx: ControlContext): TokenGuard {
  return ctx.tokenGuard;
}

export { createEventBus, createAnalytics, dirSizeBytes, setSetting };
