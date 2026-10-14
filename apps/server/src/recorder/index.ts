/**
 * Recorder —— 唯一允许写 DB 的地方（docs/00 §4）。
 *
 * 核心设计（docs/05 §1）：
 *   **聚合恒写、明细受开关控制。**
 *   关掉明细后 KPI 仍然可见 —— 这是本方案与"整体关日志"的本质区别。
 *   否则用户一关开关账本就直接归零，产品价值不复存在。
 *
 * 写入路径：
 *   add(event)
 *     ├─ 内存聚合累加（小时 / 天×模型 / 天×会话）—— 永远执行
 *     ├─ 明细入队（detailEnabled 时才入）—— 200ms 或 64 条触发一次事务提交
 *     └─ 正文落盘（bodyEnabled 时才写）—— 独立于事务，失败仅告警
 *
 * 纪律：
 *   - 单写者（全进程一个实例）
 *   - 幂等（`INSERT OR REPLACE`）
 *   - 落库失败最多重试 3 次，之后丢弃并计数（账本允许尽力而为，主链路绝不受影响）
 */

import fs from 'node:fs';
import path from 'node:path';
import {
  emptyHist, histAdd, histFromBlob, histMerge, histToBlob,
  DEFAULT_MODEL_PRICES, PRICE_TABLE_VERSION, PRICE_TABLE_SOURCE, matchPrice, computeCostUsd,
  type ModelPrice, type RequestEvent, type UsageRecord,
} from '@sgw/shared';
import { dirSizeBytes, type Db, type SqlValue } from '../db/index.ts';
import type { Logger } from '../config/logger.ts';

export interface RecorderSettings {
  detailEnabled: boolean;
  bodyEnabled: boolean;
  bodyMaxBytes: number;
  bodyCompress: boolean;
  detailDays: number;
  bodyDays: number;
  maxDbBytes: number;
  maxBodyBytes: number;
  autoVacuum: boolean;
}

export const DEFAULT_RECORDER_SETTINGS: RecorderSettings = {
  detailEnabled: false,
  bodyEnabled: false,
  bodyMaxBytes: 512 * 1024,
  bodyCompress: false,
  detailDays: 30,
  bodyDays: 7,
  maxDbBytes: 2 * 1024 * 1024 * 1024,
  maxBodyBytes: 2 * 1024 * 1024 * 1024,
  autoVacuum: true,
};

/** 待落库的明细行 */
export interface PendingEvent extends RequestEvent {
  /** 成本（写入时按当时价格固化；改价格不影响历史） */
  costUsd: number | null;
  /** 当日（本地时区），用于按天清理/分区。字段名与 DB 列一致。 */
  created_day: string;
}

/** 价格（每 1M token，USD）。实现见 `@sgw/shared/pricing`（server 与 web 共用同一份契约）。 */
export type { ModelPrice };

export interface RecorderStats {
  queued: number;
  writtenEvents: number;
  droppedEvents: number;
  writeErrors: number;
  lastWriteMs: number;
  lastFlushAt: number | null;
  bodiesWritten: number;
  bodyBytes: number;
}

export interface Recorder {
  add(event: PendingEvent, bodies?: { request?: Buffer; response?: Buffer }): void;
  /** 立即把队列写盘（优雅关闭时调用） */
  flush(): void;
  settings(): RecorderSettings;
  updateSettings(patch: Partial<RecorderSettings>): RecorderSettings;
  stats(): RecorderStats;
  /** 价格表操作 */
  listPrices(): ModelPrice[];
  upsertPrice(p: ModelPrice): void;
  deletePrice(model: string): void;
  /**
   * 把内置的官方默认价格补齐到价格表（**只插不覆盖**）。
   *
   * `overwrite=true` 时连已存在的行也重置为官方价（设置页的"恢复默认"按钮）。
   * 返回真正写入的行数 —— 界面据此区分"已是最新"与"补了 N 条"。
   */
  seedDefaultPrices(opts?: { overwrite?: boolean }): { inserted: number; overwritten: number };
  /** 价格表来源与版本（界面展示"这些默认值从哪来、何时核对的"） */
  priceSource(): typeof PRICE_TABLE_SOURCE & { version: number };
  computeCost(model: string | null, usage: UsageRecord): number | null;
  /** 保留策略与清理 */
  cleanup(now?: number): CleanupReport;
  /** 备份（VACUUM INTO） */
  backup(): { ok: boolean; file?: string; error?: string };
  close(): void;
}

export interface CleanupReport {
  ranAt: number;
  deletedDetailRows: number;
  deletedBodyDirs: string[];
  deletedSessions: number;
  reason: string;
  dbBytes: number;
  bodyBytes: number;
}

const FLUSH_INTERVAL_MS = 200;
const FLUSH_BATCH = 64;
const MAX_QUEUE = 5_000;         // 队列硬上限：溢出即丢弃最旧（保护内存）

export interface CreateRecorderOptions {
  db: Db;
  log: Logger;
  dataDir: string;
  sync?: boolean;                 // 测试用：同步写入，不靠定时器
}

export function createRecorder(opts: CreateRecorderOptions): Recorder {
  const { db, log } = opts;
  const bodiesDir = path.join(opts.dataDir, 'bodies');
  const sync = opts.sync === true;

  let settings: RecorderSettings = { ...DEFAULT_RECORDER_SETTINGS };
  loadSettings();

  const queue: Array<{ event: PendingEvent; bodies?: { request?: Buffer; response?: Buffer } }> = [];
  const stats: RecorderStats = {
    queued: 0, writtenEvents: 0, droppedEvents: 0, writeErrors: 0,
    lastWriteMs: 0, lastFlushAt: null, bodiesWritten: 0, bodyBytes: 0,
  };

  let timer: NodeJS.Timeout | null = null;
  let closed = false;

  // ── 内存聚合累加器（小时 / 天×模型 / 天×会话×模型）──
  interface HourAgg {
    bucketStart: number; model: string; endpoint: string;
    requestCount: number; errorCount: number;
    input: number; output: number; cached: number; reasoning: number; total: number;
    /** 输入 token 中缓存信息可信的部分（见 DB 列注释） */
    cacheKnownInput: number;
    estimated: number; incomplete: number; cost: number;
    hist: Uint32Array; tTotalSum: number; ttfbSum: number;
  }
  interface DayModelAgg extends Omit<HourAgg, 'bucketStart' | 'model' | 'endpoint'> {
    day: string; model: string;
  }
  interface DaySessionAgg {
    day: string; sessionId: string; model: string;
    requestCount: number; input: number; cached: number; output: number; total: number; cost: number;
  }

  const hourAgg = new Map<string, HourAgg>();
  const dayModelAgg = new Map<string, DayModelAgg>();
  const daySessionAgg = new Map<string, DaySessionAgg>();
  /**
   * 本批次触碰到的会话（flush 时落 `session` 表）。
   *
   * ★ 为什么必须在这里（聚合路径）而不是明细路径：
   *   `daily_session` 是**聚合**，永远写；而 `session` 表原来只在 `writeDetailBatch` 里
   *   upsert —— 也就是只在 Detail Mode 打开时才有行。结果是"关着明细跑出来的会话"
   *   在 /stats/by-session 里查不到 `external_id`，标签只能回落到 ID 前缀
   *   （曾表现为两个不同会话显示成同一个「未命名会话 · 01a13882-3」）。
   */
  const sessionTouched = new Map<string, {
    externalId: string | null; firstAt: number; lastAt: number; requests: number; tokens: number;
  }>();

  function loadSettings(): void {
    const row = db.get<{ value: string }>('SELECT value FROM settings WHERE key = ?', ['recorder']);
    if (!row) return;
    try {
      const parsed = JSON.parse(row.value) as Partial<RecorderSettings>;
      settings = { ...DEFAULT_RECORDER_SETTINGS, ...parsed };
    } catch { /* 保持默认 */ }
  }

  function persistSettings(): void {
    db.run(
      'INSERT INTO settings(key, value, updated_at) VALUES (?, ?, ?) '
      + 'ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at',
      ['recorder', JSON.stringify(settings), Date.now()],
    );
  }

  // ─────────────────────────── 价格表 ───────────────────────────

  function listPrices(): ModelPrice[] {
    const rows = db.all<{
      model: string; input_per_mtok: number; output_per_mtok: number;
      cached_per_mtok: number | null; reasoning_per_mtok: number | null;
    }>('SELECT model, input_per_mtok, output_per_mtok, cached_per_mtok, reasoning_per_mtok FROM model_price ORDER BY model');
    return rows.map((r) => ({
      model: r.model,
      inputPerMtok: Number(r.input_per_mtok),
      outputPerMtok: Number(r.output_per_mtok),
      cachedPerMtok: r.cached_per_mtok === null ? null : Number(r.cached_per_mtok),
      reasoningPerMtok: r.reasoning_per_mtok === null ? null : Number(r.reasoning_per_mtok),
    }));
  }

  function upsertPrice(p: ModelPrice): void {
    db.run(
      'INSERT INTO model_price(model, input_per_mtok, output_per_mtok, cached_per_mtok, reasoning_per_mtok, currency, updated_at) '
      + 'VALUES (?, ?, ?, ?, ?, ?, ?) '
      + 'ON CONFLICT(model) DO UPDATE SET input_per_mtok = excluded.input_per_mtok, '
      + 'output_per_mtok = excluded.output_per_mtok, cached_per_mtok = excluded.cached_per_mtok, '
      + 'reasoning_per_mtok = excluded.reasoning_per_mtok, updated_at = excluded.updated_at',
      [p.model, p.inputPerMtok, p.outputPerMtok, p.cachedPerMtok, p.reasoningPerMtok, 'USD', Date.now()],
    );
  }

  function deletePrice(model: string): void {
    db.run('DELETE FROM model_price WHERE model = ?', [model]);
  }

  /**
   * 播种官方默认价格。
   *
   * 三条纪律：
   *   1. **只插不覆盖**（除非显式 overwrite）—— 用户按中继账单改过的价格绝不能被启动流程抹掉。
   *   2. 用 `meta['prices.seed_version']` 记住播种到哪一版 —— 因此用户**删掉**的行
   *      不会在下次重启时"复活"（这是"没有价格的模型"这一意图的唯一表达方式）。
   *   3. 播种发生在 recorder 构造期，即任何请求落账之前 —— 保证第一笔账就有价可依。
   */
  function seedDefaultPrices(opts: { overwrite?: boolean } = {}): { inserted: number; overwritten: number } {
    const overwrite = opts.overwrite === true;
    let inserted = 0;
    let overwritten = 0;
    db.transaction(() => {
      const have = new Set(db.all<{ model: string }>('SELECT model FROM model_price').map((r) => r.model));
      for (const p of DEFAULT_MODEL_PRICES) {
        if (have.has(p.model)) {
          if (!overwrite) continue;
          upsertPrice(p);
          overwritten++;
          continue;
        }
        upsertPrice(p);
        inserted++;
      }
      db.run(
        'INSERT INTO meta(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
        ['prices.seed_version', String(PRICE_TABLE_VERSION)],
      );
    });
    if (inserted > 0 || overwritten > 0) {
      log.info({ inserted, overwritten, version: PRICE_TABLE_VERSION, source: PRICE_TABLE_SOURCE.label },
        '价格表已补齐官方默认值（可在设置页按中继账单修改）');
    }
    return { inserted, overwritten };
  }

  /** 启动期调用：只在"尚未播种到当前版本"时补齐 */
  function seedIfNeeded(): void {
    const row = db.get<{ value: string }>('SELECT value FROM meta WHERE key = ?', ['prices.seed_version']);
    const seeded = Number(row?.value ?? 0);
    if (Number.isFinite(seeded) && seeded >= PRICE_TABLE_VERSION) return;
    seedDefaultPrices();
  }

  function priceSource(): typeof PRICE_TABLE_SOURCE & { version: number } {
    return { ...PRICE_TABLE_SOURCE, version: PRICE_TABLE_VERSION };
  }

  /**
   * 写时成本（**历史留档**，不是界面展示口径）。
   *
   * 界面上的成本一律由 `analytics` 按**当前价格表**读时重算（见 shared/pricing 顶部说明），
   * 因此这里算出来的值只写进 `cost_usd` 列做留档，改价格不会让它变化 —— 这正是留档的意义。
   */
  function computeCost(model: string | null, usage: UsageRecord): number | null {
    if (usage.source === 'none') return null;
    return computeCostUsd(matchPrice(listPrices(), model), usage);
  }

  // ─────────────────────────── 聚合累加 ───────────────────────────

  function hourBucket(ts: number): number {
    return Math.floor(ts / 3_600_000) * 3_600_000;
  }
  function dayKey(ts: number): string {
    const d = new Date(ts);
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const dd = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${dd}`;
  }

  function accumulate(e: PendingEvent): void {
    const isError = (e.status !== null && e.status >= 400) || (e.errorClass !== null && e.errorClass !== 'client_aborted');
    const estimated = e.usage.source === 'estimated' ? 1 : 0;
    const incomplete = e.usage.complete ? 0 : 1;
    const cost = e.costUsd ?? 0;
    // ★ 缓存口径纪律：只有**上游返回了完整 usage** 的请求，其 cached 分项才可信。
    //   本地估算的请求 cached 恒为 0，但那是"未知"而不是"没命中" —— 计入分母会把
    //   缓存命中率系统性压低（实测被拖低 28 个百分点）。因此单独累计可信部分。
    const cacheKnownInput = (e.usage.source === 'upstream' && e.usage.complete) ? e.usage.inputTokens : 0;
    // ★ 口径纪律（曾经写错，导致列表里 TTFB 显示成 29865785.8min）：
    //   `timing.upstreamHeadersMs` / `firstTokenMs` 已经是**相对 enqueuedAt 的毫秒数**，
    //   可直接入库，**不要再减一次**（早期版本误当绝对时间戳处理）。
    const ttfb = Math.max(0, e.timing.upstreamHeadersMs ?? 0);

    // 小时聚合（model × endpoint 两个维度都记，便于按任一维度查）
    const dims: Array<{ model: string; endpoint: string }> = [
      { model: e.model ?? '*', endpoint: e.endpoint },
    ];
    for (const d of dims) {
      const key = `${hourBucket(e.startedAt)}|${d.model}|${d.endpoint}`;
      let agg = hourAgg.get(key);
      if (!agg) {
        agg = {
          bucketStart: hourBucket(e.startedAt), model: d.model, endpoint: d.endpoint,
          requestCount: 0, errorCount: 0, input: 0, output: 0, cached: 0,
          reasoning: 0, total: 0, cacheKnownInput: 0, estimated: 0, incomplete: 0, cost: 0,
          hist: emptyHist(), tTotalSum: 0, ttfbSum: 0,
        };
        hourAgg.set(key, agg);
      }
      agg.requestCount++;
      if (isError) agg.errorCount++;
      agg.input += e.usage.inputTokens;
      agg.output += e.usage.outputTokens;
      agg.cached += e.usage.cachedInputTokens;
      agg.reasoning += e.usage.reasoningTokens;
      agg.total += e.usage.totalTokens;
      agg.cacheKnownInput += cacheKnownInput;
      agg.estimated += estimated;
      agg.incomplete += incomplete;
      agg.cost += cost;
      agg.tTotalSum += e.timing.completedAt - e.timing.enqueuedAt;
      agg.ttfbSum += ttfb;
      histAdd(agg.hist, e.timing.completedAt - e.timing.enqueuedAt);
    }

    // 天 × 模型
    const day = e.created_day;
    const dmKey = `${day}|${e.model ?? '*'}`;
    let dm = dayModelAgg.get(dmKey);
    if (!dm) {
      dm = {
        day, model: e.model ?? '*',
        requestCount: 0, errorCount: 0, input: 0, output: 0, cached: 0,
        reasoning: 0, total: 0, cacheKnownInput: 0, estimated: 0, incomplete: 0, cost: 0,
        hist: emptyHist(), tTotalSum: 0, ttfbSum: 0,
      };
      dayModelAgg.set(dmKey, dm);
    }
    dm.requestCount++;
    if (isError) dm.errorCount++;
    dm.input += e.usage.inputTokens;
    dm.output += e.usage.outputTokens;
    dm.cached += e.usage.cachedInputTokens;
    dm.reasoning += e.usage.reasoningTokens;
    dm.total += e.usage.totalTokens;
    dm.cacheKnownInput += cacheKnownInput;
    dm.estimated += estimated;
    dm.incomplete += incomplete;
    dm.cost += cost;
    dm.tTotalSum += e.timing.completedAt - e.timing.enqueuedAt;
    dm.ttfbSum += ttfb;
    histAdd(dm.hist, e.timing.completedAt - e.timing.enqueuedAt);

    // 天 × 会话 × 模型（成本读时重算需要模型维度）
    if (e.codexSessionId) {
      const model = e.model ?? '*';
      const dsKey = `${day}|${e.codexSessionId}|${model}`;
      let ds = daySessionAgg.get(dsKey);
      if (!ds) {
        ds = {
          day, sessionId: e.codexSessionId, model,
          requestCount: 0, input: 0, cached: 0, output: 0, total: 0, cost: 0,
        };
        daySessionAgg.set(dsKey, ds);
      }
      ds.requestCount++;
      ds.input += e.usage.inputTokens;
      ds.cached += e.usage.cachedInputTokens;
      ds.output += e.usage.outputTokens;
      ds.total += e.usage.totalTokens;
      ds.cost += cost;

      // 会话维度（flush 时落 session 表）
      // ★ title 一律留 NULL：模型名不是会话标题。
      //   曾经把 `model · endpoint` 写进 title，于是"最活跃会话"里出现一个叫
      //   `gpt-6-sol` 的条目 —— 既不是会话也不是用户能认出的东西。
      //   真正的标题（首条 prompt 摘要，见 docs/05 §3）尚未实现；在那之前，
      //   展示标签统一回落到 Codex 的 session-id（唯一、可对着 Codex 日志核对）。
      const prev = sessionTouched.get(e.codexSessionId);
      sessionTouched.set(e.codexSessionId, {
        externalId: e.codexSessionId,
        firstAt: prev ? Math.min(prev.firstAt, e.startedAt) : e.startedAt,
        lastAt: prev ? Math.max(prev.lastAt, e.startedAt) : e.startedAt,
        requests: (prev?.requests ?? 0) + 1,
        tokens: (prev?.tokens ?? 0) + e.usage.totalTokens,
      });
    }
  }

  // ─────────────────────────── 正文落盘 ───────────────────────────

  function writeBodies(id: string, day: string, bodies: { request?: Buffer; response?: Buffer }): {
    ref: string | null; bytes: number;
  } {
    if (!settings.bodyEnabled) return { ref: null, bytes: 0 };
    const maxPerBody = settings.bodyMaxBytes;
    let totalBytes = 0;
    const dir = path.join(bodiesDir, day);
    try {
      fs.mkdirSync(dir, { recursive: true });
      const parts: string[] = [];
      for (const [side, buf] of [['req', bodies.request], ['res', bodies.response]] as const) {
        if (!buf || buf.length === 0) continue;
        const slice = buf.length > maxPerBody ? buf.subarray(0, maxPerBody) : buf;
        const file = `${id}.${side}.json`;
        fs.writeFileSync(path.join(dir, file), slice);
        totalBytes += slice.length;
        parts.push(`${side}:${file}`);
      }
      if (parts.length === 0) return { ref: null, bytes: 0 };
      stats.bodiesWritten += parts.length;
      stats.bodyBytes += totalBytes;
      return { ref: `${day}/${id}`, bytes: totalBytes };
    } catch (e) {
      log.warn({ id, err: (e as Error).message }, '正文落盘失败（已忽略）');
      return { ref: null, bytes: 0 };
    }
  }

  // ─────────────────────────── 提交 ───────────────────────────

  // ★ 占位符数量必须与列清单**严格一致**。这里用数组长度推导，
  //   避免"手改列清单忘了改参数个数"这类静默失败（曾经写成 41 个 ? 而列只有 40 个，
  //   导致每条 INSERT 都抛错并被吞掉 —— 表现为"记账全是 0"却毫无报错）。
  const INSERT_COLUMNS = [
    'id', 'started_at', 'ended_at', 'method', 'path', 'query', 'endpoint', 'status', 'error_class', 'streamed',
    'model', 'session_id', 'key_fingerprint', 'upstream_request_id', 'response_id',
    'codex_thread_id', 'codex_client_req_id', 'codex_originator', 'codex_subagent',
    't_upstream_connect', 't_upstream_headers', 't_first_token', 't_total',
    'input_tokens', 'output_tokens', 'total_tokens', 'cached_tokens', 'cache_write_tokens', 'reasoning_tokens',
    'usage_source', 'usage_complete', 'estimator', 'observe_shape', 'observe_note', 'bytes_in', 'bytes_out',
    'truncated_request', 'truncated_response', 'body_ref', 'body_bytes', 'cost_usd', 'created_day',
  ] as const;

  /** 启动期自检：列清单必须与建表语句一致，否则立刻报错而不是静默丢数据 */
  function assertSchemaMatches(): void {
    const actual = db.all<{ name: string }>("SELECT name FROM pragma_table_info('request_event')")
      .map((r) => r.name);
    const missing = INSERT_COLUMNS.filter((c) => !actual.includes(c));
    const extra = actual.filter((c) => !(INSERT_COLUMNS as readonly string[]).includes(c));
    if (missing.length || extra.length) {
      log.error({ missing, extra }, '⚠️ request_event 列清单与建表语句不一致，将导致明细写入失败');
    }
  }

  function writeDetailBatch(batch: Array<{ event: PendingEvent; bodies?: { request?: Buffer; response?: Buffer } }>): void {
    const sql = `INSERT OR REPLACE INTO request_event (${INSERT_COLUMNS.join(', ')})
                 VALUES (${INSERT_COLUMNS.map(() => '?').join(', ')})`;

    db.transaction(() => {
      for (const { event: e, bodies } of batch) {
        const body = writeBodies(e.id, e.created_day, bodies ?? {});

        // ★ 这三列与 timing 的 *Ms 字段一一对应（都是相对毫秒），直接入库。
        db.run(sql, [
          e.id, e.startedAt, e.timing.completedAt, e.method, e.path, e.query, e.endpoint,
          e.status, e.errorClass, e.streamed ? 1 : 0,
          e.model, e.codexSessionId, e.keyFingerprint, e.upstreamRequestId, e.responseId,
          e.codexThreadId, e.codexClientRequestId, e.codexOriginator, e.codexSubagent,
          e.timing.upstreamConnectMs ?? null,
          e.timing.upstreamHeadersMs ?? null,
          e.timing.firstTokenMs ?? null,
          Math.max(0, e.timing.completedAt - e.timing.enqueuedAt),
          e.usage.inputTokens, e.usage.outputTokens, e.usage.totalTokens,
          e.usage.cachedInputTokens, e.usage.cacheWriteTokens, e.usage.reasoningTokens,
          e.usage.source, e.usage.complete ? 1 : 0, e.usage.estimator ?? null,
          e.observeShape, e.observeNote,
          e.bytesIn, e.bytesOut,
          e.truncated.request ? 1 : 0, e.truncated.response ? 1 : 0,
          body.ref, body.bytes, e.costUsd, e.created_day,
        ]);
      }
    });
  }

  function flushAggregates(): void {
    if (hourAgg.size === 0 && dayModelAgg.size === 0 && daySessionAgg.size === 0 && sessionTouched.size === 0) return;

    db.transaction(() => {
      for (const agg of hourAgg.values()) {
        const existing = db.get<{ lat_hist: unknown }>(
          'SELECT lat_hist FROM rollup_hourly WHERE bucket_start = ? AND model = ? AND endpoint = ?',
          [agg.bucketStart, agg.model, agg.endpoint],
        );
        const hist = existing ? histFromBlob(existing.lat_hist) : emptyHist();
        histMerge(hist, agg.hist);
        db.run(
          'INSERT INTO rollup_hourly (bucket_start, model, endpoint, request_count, error_count, '
          + 'input_tokens, output_tokens, cached_tokens, reasoning_tokens, total_tokens, '
          + 'cache_known_input_tokens, estimated_count, incomplete_count, cost_usd, lat_hist, t_total_sum, ttfb_sum) '
          + 'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) '
          + 'ON CONFLICT(bucket_start, model, endpoint) DO UPDATE SET '
          + 'request_count = rollup_hourly.request_count + excluded.request_count, '
          + 'error_count = rollup_hourly.error_count + excluded.error_count, '
          + 'input_tokens = rollup_hourly.input_tokens + excluded.input_tokens, '
          + 'output_tokens = rollup_hourly.output_tokens + excluded.output_tokens, '
          + 'cached_tokens = rollup_hourly.cached_tokens + excluded.cached_tokens, '
          + 'reasoning_tokens = rollup_hourly.reasoning_tokens + excluded.reasoning_tokens, '
          + 'total_tokens = rollup_hourly.total_tokens + excluded.total_tokens, '
          + 'cache_known_input_tokens = rollup_hourly.cache_known_input_tokens + excluded.cache_known_input_tokens, '
          + 'estimated_count = rollup_hourly.estimated_count + excluded.estimated_count, '
          + 'incomplete_count = rollup_hourly.incomplete_count + excluded.incomplete_count, '
          + 'cost_usd = rollup_hourly.cost_usd + excluded.cost_usd, '
          + 'lat_hist = excluded.lat_hist, t_total_sum = rollup_hourly.t_total_sum + excluded.t_total_sum, '
          + 'ttfb_sum = rollup_hourly.ttfb_sum + excluded.ttfb_sum',
          [
            agg.bucketStart, agg.model, agg.endpoint, agg.requestCount, agg.errorCount,
            agg.input, agg.output, agg.cached, agg.reasoning, agg.total,
            agg.cacheKnownInput, agg.estimated, agg.incomplete, agg.cost, histToBlob(hist),
            agg.tTotalSum, agg.ttfbSum,
          ],
        );
      }

      for (const dm of dayModelAgg.values()) {
        const existing = db.get<{ lat_hist: unknown }>(
          'SELECT lat_hist FROM daily_model WHERE day = ? AND model = ?', [dm.day, dm.model],
        );
        const hist = existing ? histFromBlob(existing.lat_hist) : emptyHist();
        histMerge(hist, dm.hist);
        db.run(
          'INSERT INTO daily_model (day, model, request_count, error_count, input_tokens, output_tokens, '
          + 'cached_tokens, reasoning_tokens, total_tokens, cache_known_input_tokens, estimated_count, '
          + 'incomplete_count, cost_usd, lat_hist, t_total_sum, ttfb_sum) '
          + 'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) '
          + 'ON CONFLICT(day, model) DO UPDATE SET '
          + 'request_count = daily_model.request_count + excluded.request_count, '
          + 'error_count = daily_model.error_count + excluded.error_count, '
          + 'input_tokens = daily_model.input_tokens + excluded.input_tokens, '
          + 'output_tokens = daily_model.output_tokens + excluded.output_tokens, '
          + 'cached_tokens = daily_model.cached_tokens + excluded.cached_tokens, '
          + 'reasoning_tokens = daily_model.reasoning_tokens + excluded.reasoning_tokens, '
          + 'total_tokens = daily_model.total_tokens + excluded.total_tokens, '
          + 'cache_known_input_tokens = daily_model.cache_known_input_tokens + excluded.cache_known_input_tokens, '
          + 'estimated_count = daily_model.estimated_count + excluded.estimated_count, '
          + 'incomplete_count = daily_model.incomplete_count + excluded.incomplete_count, '
          + 'cost_usd = daily_model.cost_usd + excluded.cost_usd, '
          + 'lat_hist = excluded.lat_hist, t_total_sum = daily_model.t_total_sum + excluded.t_total_sum, '
          + 'ttfb_sum = daily_model.ttfb_sum + excluded.ttfb_sum',
          [
            dm.day, dm.model, dm.requestCount, dm.errorCount, dm.input, dm.output,
            dm.cached, dm.reasoning, dm.total, dm.cacheKnownInput, dm.estimated, dm.incomplete, dm.cost,
            histToBlob(hist), dm.tTotalSum, dm.ttfbSum,
          ],
        );
      }

      for (const ds of daySessionAgg.values()) {
        db.run(
          'INSERT INTO daily_session(day, session_id, model, request_count, input_tokens, '
          + 'cached_tokens, output_tokens, total_tokens, cost_usd) '
          + 'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) '
          + 'ON CONFLICT(day, session_id, model) DO UPDATE SET '
          + 'request_count = daily_session.request_count + excluded.request_count, '
          + 'input_tokens = daily_session.input_tokens + excluded.input_tokens, '
          + 'cached_tokens = daily_session.cached_tokens + excluded.cached_tokens, '
          + 'output_tokens = daily_session.output_tokens + excluded.output_tokens, '
          + 'total_tokens = daily_session.total_tokens + excluded.total_tokens, '
          + 'cost_usd = daily_session.cost_usd + excluded.cost_usd',
          [ds.day, ds.sessionId, ds.model, ds.requestCount, ds.input, ds.cached, ds.output, ds.total, ds.cost],
        );
      }

      // ── session 表（与 daily_session 同步，**不依赖 Detail Mode**）──
      //   title 只插不更新：已有的标题（未来从首条 prompt 生成）不会被覆盖；
      //   现在插入时恒为 NULL，展示标签由 analytics 层统一回落到 external_id。
      for (const [id, s] of sessionTouched) {
        db.run(
          'INSERT INTO session(id, external_id, project_path, title, first_seen_at, last_seen_at, request_count, total_tokens) '
          + 'VALUES (?, ?, NULL, NULL, ?, ?, ?, ?) '
          + 'ON CONFLICT(id) DO UPDATE SET '
          + 'external_id = COALESCE(session.external_id, excluded.external_id), '
          + 'last_seen_at = MAX(session.last_seen_at, excluded.last_seen_at), '
          + 'request_count = session.request_count + excluded.request_count, '
          + 'total_tokens = session.total_tokens + excluded.total_tokens',
          [id, s.externalId, s.firstAt, s.lastAt, s.requests, s.tokens],
        );
      }
    });

    hourAgg.clear();
    dayModelAgg.clear();
    daySessionAgg.clear();
    sessionTouched.clear();
  }

  function flush(): void {
    if (timer) { clearTimeout(timer); timer = null; }
    const t0 = Date.now();
    try {
      if (queue.length > 0) {
        const batch = queue.splice(0, queue.length);
        let attempt = 0;
        for (;;) {
          try { writeDetailBatch(batch); break; } catch (e) {
            attempt++;
            if (attempt >= 3) {
              stats.writeErrors++;
              stats.droppedEvents += batch.length;
              log.error({ err: (e as Error).message, dropped: batch.length }, '明细落库失败（已重试 3 次，丢弃）');
              break;
            }
          }
        }
        stats.writtenEvents += batch.length;
      }
      if (sync === false || true) flushAggregates();
      stats.lastWriteMs = Date.now() - t0;
      stats.lastFlushAt = Date.now();
      stats.queued = queue.length;
    } catch (e) {
      stats.writeErrors++;
      log.error({ err: (e as Error).message }, 'flush 失败');
    }
  }

  function schedule(): void {
    if (timer || closed) return;
    timer = setTimeout(() => { timer = null; flush(); }, FLUSH_INTERVAL_MS);
    timer.unref?.();
  }

  // ─────────────────────────── 保留策略 ───────────────────────────

  function cleanup(now: number = Date.now()): CleanupReport {
    const report: CleanupReport = {
      ranAt: now,
      deletedDetailRows: 0,
      deletedBodyDirs: [],
      deletedSessions: 0,
      reason: '',
      dbBytes: 0,
      bodyBytes: 0,
    };
    // 先把内存里的东西落盘，否则清理看不到它们
    flush();

    const reasons: string[] = [];

    // 1) 明细按天清理
    if (settings.detailDays > 0) {
      const cutoffDay = dayKey(now - settings.detailDays * 86_400_000);
      const r = db.run('DELETE FROM request_event WHERE created_day < ?', [cutoffDay]);
      const n = Number(r.changes);
      if (n > 0) { report.deletedDetailRows += n; reasons.push(`明细早于 ${cutoffDay}（${n} 行）`); }
    }

    // 2) 容量上限：DB 超限时从最老明细开始删
    const dbBytes = dirSizeBytes(opts.dataDir);
    report.dbBytes = dbBytes;
    if (settings.maxDbBytes > 0 && dbBytes > settings.maxDbBytes) {
      const target = Math.floor(settings.maxDbBytes * 0.9);
      let guard = 0;
      while (dirSizeBytes(opts.dataDir) > target && guard < 200) {
        const oldest = db.get<{ day: string }>('SELECT MIN(created_day) AS day FROM request_event');
        if (!oldest?.day) break;
        const r = db.run('DELETE FROM request_event WHERE created_day = ?', [oldest.day]);
        const n = Number(r.changes);
        report.deletedDetailRows += n;
        reasons.push(`容量超限，删除 ${oldest.day}（${n} 行）`);
        if (n === 0) break;
        guard++;
      }
      try { db.exec('PRAGMA incremental_vacuum'); } catch { /* 忽略 */ }
    }

    // 3) 正文目录按天整删（O(1)）
    if (fs.existsSync(bodiesDir)) {
      const cutoffBody = settings.bodyDays > 0 ? dayKey(now - settings.bodyDays * 86_400_000) : null;
      for (const entry of fs.readdirSync(bodiesDir, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const isOld = cutoffBody !== null && entry.name < cutoffBody;
        const tooBig = settings.maxBodyBytes > 0 && dirSizeBytes(bodiesDir) > settings.maxBodyBytes;
        if (isOld || tooBig) {
          try {
            fs.rmSync(path.join(bodiesDir, entry.name), { recursive: true, force: true });
            report.deletedBodyDirs.push(entry.name);
            reasons.push(`正文目录 ${entry.name}（${isOld ? '超期' : '超容量'}）`);
          } catch (e) {
            log.warn({ dir: entry.name, err: (e as Error).message }, '删除正文目录失败');
          }
        }
      }
    }

    // 4) 孤儿引用
    const withRef = db.all<{ id: string; body_ref: string }>(
      'SELECT id, body_ref FROM request_event WHERE body_ref IS NOT NULL',
    );
    for (const row of withRef) {
      if (!fs.existsSync(path.join(bodiesDir, row.body_ref))) {
        db.run('UPDATE request_event SET body_ref = NULL, body_bytes = NULL WHERE id = ?', [row.id]);
      }
    }

    // 5) 陈旧会话
    const sessionCutoff = now - Math.max(settings.detailDays, 7) * 2 * 86_400_000;
    const sr = db.run('DELETE FROM session WHERE last_seen_at < ? AND request_count > 0', [sessionCutoff]);
    report.deletedSessions = Number(sr.changes);

    // 6) 每周一次 checkpoint
    try { db.exec('PRAGMA wal_checkpoint(TRUNCATE)'); } catch { /* 忽略 */ }

    report.reason = reasons.length ? reasons.join('；') : '无需要清理的数据';
    report.dbBytes = dirSizeBytes(opts.dataDir);
    report.bodyBytes = dirSizeBytes(bodiesDir);
    db.run(
      'INSERT INTO meta(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
      ['last_cleanup_at', String(now)],
    );
    return report;
  }

  function backup(): { ok: boolean; file?: string; error?: string } {
    try {
      flush();
      const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, '');
      const file = path.join(opts.dataDir, `backup-${stamp}-${Date.now()}.db`);
      db.run(`VACUUM INTO ?`, [file]);
      return { ok: true, file };
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
  }

  // ─────────────────────────── 对外接口 ───────────────────────────

  function add(event: PendingEvent, bodies?: { request?: Buffer; response?: Buffer }): void {
    try {
      // 聚合永远累加（关明细也要有 KPI）
      accumulate(event);

      if (settings.detailEnabled) {
        if (queue.length >= MAX_QUEUE) {
          queue.shift();
          stats.droppedEvents++;
        }
        queue.push(bodies ? { event, bodies } : { event });
        stats.queued = queue.length;
      } else if (bodies && settings.bodyEnabled) {
        // 关明细但开正文：这是配置矛盾，明确告警而不是静默丢弃
        log.warn('bodyEnabled=true 但 detailEnabled=false —— 正文无处关联，已忽略');
      }

      if (sync) { flush(); return; }
      if (queue.length >= FLUSH_BATCH) flush();
      else schedule();
    } catch (e) {
      stats.writeErrors++;
      log.error({ err: (e as Error).message }, 'recorder.add 失败（已忽略，不影响主链路）');
    }
  }

  function updateSettings(patch: Partial<RecorderSettings>): RecorderSettings {
    settings = { ...settings, ...patch };
    persistSettings();
    if (!settings.detailEnabled && !settings.bodyEnabled) {
      // 不影响已入队的数据；只是不再新增
    }
    return settings;
  }

  function close(): void {
    closed = true;
    if (timer) { clearTimeout(timer); timer = null; }
    flush();
  }

  // 启动期自检：列清单必须与建表语句一致（放在 INSERT_COLUMNS 初始化之后，避免 TDZ）
  assertSchemaMatches();
  // 启动期播种官方默认价格（只插不覆盖）——必须早于第一笔账
  seedIfNeeded();

  return {
    add,
    flush,
    settings: () => ({ ...settings }),
    updateSettings,
    stats: () => ({ ...stats, queued: queue.length }),
    listPrices,
    upsertPrice,
    deletePrice,
    seedDefaultPrices,
    priceSource,
    computeCost,
    cleanup,
    backup,
    close,
  };
}

/** 便捷构造：为一次交换组装 PendingEvent（成本与"当日"在这里固化） */
export function makePendingEvent(args: {
  event: RequestEvent;
  costUsd: number | null;
  now?: number;
}): PendingEvent {
  const now = args.now ?? Date.now();
  const d = new Date(now);
  const day = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  return { ...args.event, costUsd: args.costUsd, created_day: day };
}

export type { SqlValue };
