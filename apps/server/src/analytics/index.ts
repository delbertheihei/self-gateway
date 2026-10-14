/**
 * Analytics —— **只读**聚合查询层（docs/00 §4：本目录禁止出现 INSERT/UPDATE/DELETE）。
 *
 * 数据来源两层：
 *   - `rollup_hourly` / `daily_model` / `daily_session` —— 预聚合，读起来 0ms
 *   - `request_event` —— 明细，仅用于请求表与详情（keyset 分页）
 *
 * 分位由**直方图合并**得到（`@sgw/shared/histogram`），不是 SQL 分位函数。
 * 这样任意时间范围都只需把 BLOB 累加，复杂度 O(桶数) 而非 O(行数)。
 */

import {
  emptyHist, histFromBlob, histMerge, histPercentiles, histTotal, histToBuckets,
  matchPrice, computeCostUsd,
  type ModelPrice, type RequestEvent,
} from '@sgw/shared';
import type { Db, SqlValue } from '../db/index.ts';

export interface Range {
  from: number;
  to: number;
}

export type RangePreset = '1h' | '24h' | '7d' | '30d' | 'month' | 'custom';

export function resolveRange(preset: string | null, fromRaw?: string, toRaw?: string, now = Date.now()): Range {
  const to = toRaw ? Number(toRaw) : now;
  switch (preset) {
    case '1h': return { from: to - 3_600_000, to };
    case '7d': return { from: to - 7 * 86_400_000, to };
    case '30d': return { from: to - 30 * 86_400_000, to };
    case 'month': {
      const d = new Date(to);
      const start = new Date(d.getFullYear(), d.getMonth(), 1).getTime();
      return { from: start, to };
    }
    case 'custom': {
      const f = fromRaw ? Number(fromRaw) : to - 86_400_000;
      return { from: Math.min(f, to), to };
    }
    case '24h':
    default:
      return { from: to - 86_400_000, to };
  }
}

/** 时间桶聚合视图（小时或天），供趋势图使用 */
export interface TimeseriesPoint {
  bucketStart: number;
  requestCount: number;
  errorCount: number;
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  reasoningTokens: number;
  totalTokens: number;
  estimatedCount: number;
  incompleteCount: number;
  costUsd: number;
}

export interface Summary {
  range: Range;
  requestCount: number;
  errorCount: number;
  estimatedCount: number;
  incompleteCount: number;
  errorRate: number;
  estimatedRatio: number;
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  reasoningTokens: number;
  totalTokens: number;
  uncachedInput: number;
  /**
   * 缓存命中率 = cachedTokens / cacheKnownInput。
   *
   * ★ 分母**不是**全部 input：本地估算的请求在上游侧的缓存情况是**未知**（不是 0），
   *   计入分母会把命中率系统性压低（历史缺陷：实测 89% 被显示成 61%）。
   */
  cacheHitRate: number;
  /** 分母：缓存信息可信的输入 token 数（上游返回了完整 usage 的那部分） */
  cacheKnownInput: number;
  costUsd: number;
  /** 区间内出现的模型是否**全部**有价格。false 时成本是"部分已知" */
  costKnown: boolean;
  /** 缺价格的模型名（界面据此提示"去设置页补价格"） */
  unpricedModels: string[];
  latency: {
    p50: number;
    p95: number;
    p99: number;
    avgMs: number;
    sampleCount: number;
    buckets: Array<{ from: number; to: number; count: number }>;
  };
  ttfbAvgMs: number;
}

export interface ModelBreakdown {
  model: string;
  requestCount: number;
  errorCount: number;
  totalTokens: number;
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  reasoningTokens: number;
  costUsd: number;
  costKnown: boolean;
  share: number;
  p95: number;
}

export interface SessionBreakdown {
  sessionId: string;
  externalId: string | null;
  title: string | null;
  /** 展示用标签：优先 title，否则 externalId，最后才回落到**完整**会话主键（不截断，避免重名） */
  label: string;
  lastSeenAt: number;
  requestCount: number;
  totalTokens: number;
  costUsd: number;
  costKnown: boolean;
}

export interface RequestRow {
  id: string;
  startedAt: number;
  method: string;
  path: string;
  endpoint: string;
  status: number | null;
  errorClass: string | null;
  model: string | null;
  sessionId: string | null;
  threadId: string | null;
  originator: string | null;
  upstreamRequestId: string | null;
  responseId: string | null;
  totalMs: number;
  ttfbMs: number | null;
  firstTokenMs: number | null;
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  reasoningTokens: number;
  totalTokens: number;
  usageSource: string;
  usageComplete: boolean;
  bytesIn: number;
  bytesOut: number;
  costUsd: number | null;
  hasBody: boolean;
  bodyBytes: number | null;
  truncatedResponse: boolean;
}

export interface RequestQuery {
  range: Range;
  model?: string | null;
  status?: '2xx' | '4xx' | '5xx' | 'error' | null;
  endpoint?: string | null;
  usageSource?: 'upstream' | 'estimated' | 'none' | null;
  minDurationMs?: number | null;
  sessionId?: string | null;
  q?: string | null;
  cursor?: string | null;
  limit?: number;
  orderBy?: 'started_at' | 't_total' | 'total_tokens';
  order?: 'asc' | 'desc';
}

export interface Page<T> {
  data: T[];
  meta: {
    nextCursor: string | null;
    hasMore: boolean;
    totalApprox: number;
    rangeMs: [number, number];
  };
  warnings: string[];
}

export interface Analytics {
  summary(range: Range): Summary;
  timeseries(range: Range, bucket: 'hour' | 'day', breakdown?: 'type' | 'model'): TimeseriesPoint[] | TimeseriesByModel;
  byModel(range: Range, limit?: number): ModelBreakdown[];
  bySession(range: Range, limit?: number): SessionBreakdown[];
  latency(range: Range): Summary['latency'];
  requests(query: RequestQuery): Page<RequestRow>;
  request(id: string): (RequestRow & Record<string, unknown>) | null;
  bodyRef(id: string): { ref: string; bytes: number | null } | null;
  sessions(limit?: number): SessionBreakdown[];
  counts(): { events: number; sessions: number; hasDetail: boolean };
  distinctModels(): string[];
}

export interface TimeseriesByModel {
  models: string[];
  points: Array<{ bucketStart: number; byModel: Record<string, TimeseriesPoint> }>;
}

export function createAnalytics(db: Db): Analytics {
  // ── 内部：价格表与成本 ──
  //
  // ★ 成本**读时**计算（按当前价格表），不读 `cost_usd` 列。
  //   理由见 `@sgw/shared/pricing` 顶部：价格表有官方默认值、且用户会按中继账单修正；
  //   把金额固化进历史行会导致"改了价格但数字不变"，也会让默认价格永远补不上历史。
  //   聚合表保留了完整 token 分项，因此重算是精确的，不需要任何数据迁移。
  function loadPrices(): ModelPrice[] {
    return db.all<{
      model: string; input_per_mtok: number; output_per_mtok: number;
      cached_per_mtok: number | null; reasoning_per_mtok: number | null;
    }>('SELECT model, input_per_mtok, output_per_mtok, cached_per_mtok, reasoning_per_mtok FROM model_price')
      .map((r) => ({
        model: r.model,
        inputPerMtok: Number(r.input_per_mtok),
        outputPerMtok: Number(r.output_per_mtok),
        cachedPerMtok: r.cached_per_mtok === null ? null : Number(r.cached_per_mtok),
        reasoningPerMtok: r.reasoning_per_mtok === null ? null : Number(r.reasoning_per_mtok),
      }));
  }

  /** 一批「模型 × token 分项」的成本。返回 null 表示**该模型没有价格**（不是 0 元）。 */
  function costOf(prices: readonly ModelPrice[], model: string, t: { inp: number; cached: number; out: number }): number | null {
    const price = matchPrice(prices, model === '*' ? null : model);
    if (!price) return null;
    return computeCostUsd(price, {
      inputTokens: t.inp, cachedInputTokens: t.cached, outputTokens: t.out,
    });
  }

  // ── 内部：从两类聚合表按"小时或天"取数 ──
  function hourlyRows(range: Range): Array<Record<string, SqlValue>> {
    return db.all(
      `SELECT bucket_start, model, request_count, error_count, input_tokens, output_tokens,
              cached_tokens, reasoning_tokens, total_tokens, cache_known_input_tokens,
              estimated_count, incomplete_count, cost_usd, lat_hist, t_total_sum, ttfb_sum
         FROM rollup_hourly
        WHERE bucket_start >= ? AND bucket_start <= ?
        ORDER BY bucket_start ASC`,
      [Math.floor(range.from / 3_600_000) * 3_600_000, range.to],
    );
  }

  function dailyRows(range: Range, model: string | null = null): Array<Record<string, SqlValue>> {
    const days = dayKeys(range);
    if (days.length === 0) return [];
    const placeholders = days.map(() => '?').join(', ');
    const params: SqlValue[] = [...days];
    let sql = `SELECT day, model, request_count, error_count, input_tokens, output_tokens,
                      cached_tokens, reasoning_tokens, total_tokens, cache_known_input_tokens,
                      estimated_count, incomplete_count, cost_usd, lat_hist, t_total_sum, ttfb_sum
                 FROM daily_model WHERE day IN (${placeholders})`;
    if (model) { sql += ' AND model = ?'; params.push(model); }
    sql += ' ORDER BY day ASC';
    return db.all(sql, params);
  }

  function dayKeys(range: Range): string[] {
    const out: string[] = [];
    const d = new Date(range.from);
    d.setHours(0, 0, 0, 0);
    while (d.getTime() <= range.to) {
      out.push(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`);
      d.setDate(d.getDate() + 1);
      if (out.length > 400) break;
    }
    return out;
  }

  function zeroPoint(bucketStart: number): TimeseriesPoint {
    return {
      bucketStart, requestCount: 0, errorCount: 0, inputTokens: 0, outputTokens: 0,
      cachedTokens: 0, reasoningTokens: 0, totalTokens: 0, estimatedCount: 0,
      incompleteCount: 0, costUsd: 0,
    };
  }

  return {
    summary(range: Range): Summary {
      // 若范围内有"今天"，小时表更精确 —— 两者相加会重复，因此选择：
      //   小时表是唯一**持续实时更新**的表，因此以它为主力口径。
      const hourRows = hourlyRows(range);
      const prices = loadPrices();

      const s: Summary = {
        range,
        requestCount: 0, errorCount: 0, estimatedCount: 0, incompleteCount: 0,
        errorRate: 0, estimatedRatio: 0,
        inputTokens: 0, outputTokens: 0, cachedTokens: 0, reasoningTokens: 0, totalTokens: 0,
        uncachedInput: 0, cacheHitRate: 0, cacheKnownInput: 0,
        costUsd: 0, costKnown: true, unpricedModels: [],
        latency: { p50: 0, p95: 0, p99: 0, avgMs: 0, sampleCount: 0, buckets: [] },
        ttfbAvgMs: 0,
      };

      const hist = emptyHist();
      let tTotalSum = 0;
      let ttfbSum = 0;
      /** 按模型累计 token 分项 —— 成本是"每个模型各自的单价"，必须分模型算 */
      const perModel = new Map<string, { inp: number; cached: number; out: number }>();

      for (const r of hourRows) {
        s.requestCount += num(r.request_count);
        s.errorCount += num(r.error_count);
        s.inputTokens += num(r.input_tokens);
        s.outputTokens += num(r.output_tokens);
        s.cachedTokens += num(r.cached_tokens);
        s.reasoningTokens += num(r.reasoning_tokens);
        s.totalTokens += num(r.total_tokens);
        s.cacheKnownInput += num(r.cache_known_input_tokens);
        s.estimatedCount += num(r.estimated_count);
        s.incompleteCount += num(r.incomplete_count);
        tTotalSum += num(r.t_total_sum);
        ttfbSum += num(r.ttfb_sum);
        histMerge(hist, histFromBlob(r.lat_hist));

        const model = String(r.model ?? '*');
        const acc = perModel.get(model) ?? { inp: 0, cached: 0, out: 0 };
        acc.inp += num(r.input_tokens);
        acc.cached += num(r.cached_tokens);
        acc.out += num(r.output_tokens);
        perModel.set(model, acc);
      }

      // ── 成本（读时）：逐模型用**该模型自己的**单价累加 ──
      let cost = 0;
      const unpriced: string[] = [];
      for (const [model, t] of perModel) {
        if (model === '*') continue;                 // 模型名未知 → 无从定价，不计入 unpriced 提示
        if (t.inp === 0 && t.out === 0) continue;    // 只有失败/空请求 → 不因它报"缺价格"
        const c = costOf(prices, model, t);
        if (c === null) { unpriced.push(model); continue; }
        cost += c;
      }
      s.costUsd = round6(cost);
      s.unpricedModels = unpriced.sort();
      s.costKnown = unpriced.length === 0;

      const sampleCount = histTotal(hist);
      const pcts = histPercentiles(hist, [0.5, 0.95, 0.99]);
      const p50 = pcts[0] ?? 0;
      const p95 = pcts[1] ?? 0;
      const p99 = pcts[2] ?? 0;
      s.latency = {
        p50: fix(p50), p95: fix(p95), p99: fix(p99),
        avgMs: s.requestCount > 0 ? fix(tTotalSum / s.requestCount) : 0,
        sampleCount,
        buckets: sampleCount > 0 ? histToBuckets(hist) : [],
      };
      s.ttfbAvgMs = s.requestCount > 0 ? fix(ttfbSum / s.requestCount) : 0;

      s.errorRate = s.requestCount > 0 ? s.errorCount / s.requestCount : 0;
      s.estimatedRatio = s.requestCount > 0 ? s.estimatedCount / s.requestCount : 0;
      s.uncachedInput = Math.max(0, s.inputTokens - s.cachedTokens);
      // ★ 分母是"缓存信息已知"的 input，而不是全部 input（见 Summary.cacheHitRate 注释）
      s.cacheHitRate = s.cacheKnownInput > 0 ? s.cachedTokens / s.cacheKnownInput : 0;
      return s;
    },

    timeseries(range: Range, bucket: 'hour' | 'day', breakdown: 'type' | 'model' = 'type'): TimeseriesPoint[] | TimeseriesByModel {
      const prices = loadPrices();
      if (breakdown === 'model') {
        const rows = db.all(
          `SELECT bucket_start, model, request_count, error_count, input_tokens, output_tokens,
                  cached_tokens, reasoning_tokens, total_tokens, estimated_count, incomplete_count
             FROM rollup_hourly
            WHERE bucket_start >= ? AND bucket_start <= ?
            ORDER BY bucket_start ASC`,
          [Math.floor(range.from / 3_600_000) * 3_600_000, range.to],
        );
        const models = [...new Set(rows.map((r) => String(r.model)))];
        const byBucket = new Map<number, Record<string, TimeseriesPoint>>();
        for (const r of rows) {
          const at = num(r.bucket_start);
          let entry = byBucket.get(at);
          if (!entry) { entry = {}; byBucket.set(at, entry); }
          const model = String(r.model);
          const p = entry[model] ?? zeroPoint(at);
          p.requestCount += num(r.request_count);
          p.errorCount += num(r.error_count);
          p.inputTokens += num(r.input_tokens);
          p.outputTokens += num(r.outputTokens);
          p.cachedTokens += num(r.cached_tokens);
          p.reasoningTokens += num(r.reasoning_tokens);
          p.totalTokens += num(r.total_tokens);
          p.estimatedCount += num(r.estimated_count);
          p.incompleteCount += num(r.incomplete_count);
          // 成本读时计算：这条本来就是"按模型"的，直接套该模型的单价
          p.costUsd += costOf(prices, model, {
            inp: num(r.input_tokens), cached: num(r.cached_tokens), out: num(r.output_tokens),
          }) ?? 0;
          entry[model] = p;
        }
        const points = [...byBucket.entries()]
          .sort((a, b) => a[0] - b[0])
          .map(([bucketStart, byModel]) => ({ bucketStart, byModel }));
        return { models, points };
      }

      const useDaily = bucket === 'day' || (range.to - range.from) > 2 * 86_400_000;
      const map = new Map<number, TimeseriesPoint>();
      /** 成本必须**按 (桶, 模型)** 分别算（同一桶里不同模型单价不同），最后再加到桶上 */
      const costAcc = new Map<string, { inp: number; cached: number; out: number }>();

      const addModelTokens = (at: number, model: string, r: Record<string, SqlValue>): void => {
        const key = `${at}|${model}`;
        const acc = costAcc.get(key) ?? { inp: 0, cached: 0, out: 0 };
        acc.inp += num(r.input_tokens);
        acc.cached += num(r.cached_tokens);
        acc.out += num(r.output_tokens);
        costAcc.set(key, acc);
      };

      if (useDaily) {
        for (const r of dailyRows(range)) {
          const at = new Date(`${String(r.day)}T00:00:00`).getTime();
          const p = map.get(at) ?? zeroPoint(at);
          p.requestCount += num(r.request_count);
          p.errorCount += num(r.error_count);
          p.inputTokens += num(r.input_tokens);
          p.outputTokens += num(r.output_tokens);
          p.cachedTokens += num(r.cached_tokens);
          p.reasoningTokens += num(r.reasoning_tokens);
          p.totalTokens += num(r.total_tokens);
          p.estimatedCount += num(r.estimated_count);
          p.incompleteCount += num(r.incomplete_count);
          addModelTokens(at, String(r.model ?? '*'), r);
          map.set(at, p);
        }
      } else {
        for (const r of hourlyRows(range)) {
          const at = num(r.bucket_start);
          const p = map.get(at) ?? zeroPoint(at);
          p.requestCount += num(r.request_count);
          p.errorCount += num(r.error_count);
          p.inputTokens += num(r.input_tokens);
          p.outputTokens += num(r.output_tokens);
          p.cachedTokens += num(r.cached_tokens);
          p.reasoningTokens += num(r.reasoning_tokens);
          p.totalTokens += num(r.total_tokens);
          p.estimatedCount += num(r.estimated_count);
          p.incompleteCount += num(r.incomplete_count);
          addModelTokens(at, String(r.model ?? '*'), r);
          map.set(at, p);
        }
      }

      // 把逐模型成本累加到对应桶（读时按当前价格表）
      for (const [key, t] of costAcc) {
        const sep = key.indexOf('|');
        const at = Number(key.slice(0, sep));
        const model = key.slice(sep + 1);
        if (model === '*') continue;
        const p = map.get(at);
        if (!p) continue;
        p.costUsd += costOf(prices, model, t) ?? 0;
      }

      // 补齐空桶，让图表连续（前端不必自己补）
      const step = useDaily ? 86_400_000 : 3_600_000;
      const aligned = useDaily
        ? (() => { const d = new Date(range.from); d.setHours(0, 0, 0, 0); return d.getTime(); })()
        : Math.floor(range.from / step) * step;
      const out: TimeseriesPoint[] = [];
      for (let t = aligned; t <= range.to; t += step) {
        out.push(map.get(t) ?? zeroPoint(t));
      }
      return out;
    },

    byModel(range: Range, limit = 20): ModelBreakdown[] {
      const prices = loadPrices();
      const acc = new Map<string, { m: ModelBreakdown; hist: Uint32Array }>();
      const totalAll = { tokens: 0 };

      // 小时表按 model 分组（成本读时计算，因此不读 cost_usd）
      const byModelHour = db.all(
        `SELECT model, request_count, error_count, input_tokens, output_tokens, cached_tokens,
                reasoning_tokens, total_tokens, lat_hist
           FROM rollup_hourly
          WHERE bucket_start >= ? AND bucket_start <= ?`,
        [Math.floor(range.from / 3_600_000) * 3_600_000, range.to],
      );

      for (const r of byModelHour) {
        const model = String(r.model);
        let entry = acc.get(model);
        if (!entry) {
          entry = {
            m: {
              model, requestCount: 0, errorCount: 0, totalTokens: 0, inputTokens: 0,
              outputTokens: 0, cachedTokens: 0, reasoningTokens: 0, costUsd: 0,
              costKnown: true, share: 0, p95: 0,
            },
            hist: emptyHist(),
          };
          acc.set(model, entry);
        }
        entry.m.requestCount += num(r.request_count);
        entry.m.errorCount += num(r.error_count);
        entry.m.inputTokens += num(r.input_tokens);
        entry.m.outputTokens += num(r.output_tokens);
        entry.m.cachedTokens += num(r.cached_tokens);
        entry.m.reasoningTokens += num(r.reasoning_tokens);
        entry.m.totalTokens += num(r.total_tokens);
        histMerge(entry.hist, histFromBlob(r.lat_hist));
        totalAll.tokens += num(r.total_tokens);
      }

      const list = [...acc.values()].map(({ m, hist }) => {
        m.p95 = fix(histPercentiles(hist, [0.95])[0] ?? 0);
        m.share = totalAll.tokens > 0 ? m.totalTokens / totalAll.tokens : 0;
        const c = m.model === '*'
          ? null
          : costOf(prices, m.model, { inp: m.inputTokens, cached: m.cachedTokens, out: m.outputTokens });
        m.costUsd = round6(c ?? 0);
        m.costKnown = c !== null;
        return m;
      });
      list.sort((a, b) => b.totalTokens - a.totalTokens);
      return list.slice(0, limit);
    },

    bySession(range: Range, limit = 20): SessionBreakdown[] {
      const days = dayKeys(range);
      if (days.length === 0) return [];
      const prices = loadPrices();
      const placeholders = days.map(() => '?').join(', ');
      // ★ 按 (会话, 模型) 取数：成本读时计算，会话里可能混用多个模型，
      //   必须逐个模型套它自己的单价。
      const rows = db.all(
        `SELECT ds.session_id, ds.model,
                SUM(ds.request_count) AS request_count, SUM(ds.input_tokens) AS input_tokens,
                SUM(ds.cached_tokens) AS cached_tokens, SUM(ds.output_tokens) AS output_tokens,
                SUM(ds.total_tokens) AS total_tokens, MAX(ds.day) AS last_day
           FROM daily_session ds
          WHERE ds.day IN (${placeholders})
          GROUP BY ds.session_id, ds.model`,
        [...days] as SqlValue[],
      );
      const bySession = new Map<string, {
        requestCount: number; totalTokens: number; cost: number; costKnown: boolean; lastDay: string;
      }>();
      for (const r of rows) {
        const sid = String(r.session_id);
        const model = String(r.model ?? '*');
        const acc = bySession.get(sid) ?? { requestCount: 0, totalTokens: 0, cost: 0, costKnown: true, lastDay: String(r.last_day) };
        acc.requestCount += num(r.request_count);
        acc.totalTokens += num(r.total_tokens);
        if (String(r.last_day) > acc.lastDay) acc.lastDay = String(r.last_day);
        const c = model === '*' ? null : costOf(prices, model, {
          inp: num(r.input_tokens), cached: num(r.cached_tokens), out: num(r.output_tokens),
        });
        if (c === null) acc.costKnown = false;
        else acc.cost += c;
        bySession.set(sid, acc);
      }

      const ranked = [...bySession.entries()]
        .sort((a, b) => b[1].totalTokens - a[1].totalTokens)
        .slice(0, limit);

      const out: SessionBreakdown[] = [];
      for (const [sid, acc] of ranked) {
        const info = db.get<{ external_id: string | null; title: string | null; last_seen_at: number }>(
          'SELECT external_id, title, last_seen_at FROM session WHERE id = ?', [sid],
        );
        const externalId = info?.external_id ?? null;
        const title = info?.title ?? null;
        out.push({
          sessionId: sid,
          externalId,
          title,
          // ★ 展示标签必须在后端确定（前端不该猜）。
          //   优先级：title（首条 prompt 摘要，尚未生成）→ externalId（Codex session-id）
          //   → 完整主键。★ 回落时**绝不能截断主键**：ULID 前 10 字符只覆盖
          //   48 位毫秒时间戳 + 2 位随机，同一毫秒内建立的两个会话会前缀相同，
          //   于是"两个不同会话显示成同一个名字"。宁可长，也不要重名。
          label: title ?? externalId ?? `未命名会话 · ${sid}`,
          lastSeenAt: num(info?.last_seen_at) || new Date(`${acc.lastDay}T23:59:59`).getTime(),
          requestCount: acc.requestCount,
          totalTokens: acc.totalTokens,
          costUsd: round6(acc.cost),
          costKnown: acc.costKnown,
        });
      }
      return out;
    },

    latency(range: Range): Summary['latency'] {
      const hist = emptyHist();
      let count = 0;
      let sum = 0;
      for (const r of hourlyRows(range)) {
        histMerge(hist, histFromBlob(r.lat_hist));
        count += num(r.request_count);
        sum += num(r.t_total_sum);
      }
      const sampleCount = histTotal(hist);
      const pcts = histPercentiles(hist, [0.5, 0.95, 0.99]);
      const p50 = pcts[0] ?? 0;
      const p95 = pcts[1] ?? 0;
      const p99 = pcts[2] ?? 0;
      return {
        p50: fix(p50), p95: fix(p95), p99: fix(p99),
        avgMs: count > 0 ? fix(sum / count) : 0,
        sampleCount,
        buckets: sampleCount > 0 ? histToBuckets(hist) : [],
      };
    },

    requests(query: RequestQuery): Page<RequestRow> {
      const limit = Math.min(Math.max(query.limit ?? 50, 1), 500);
      const where: string[] = ['started_at >= ?', 'started_at <= ?'];
      const params: SqlValue[] = [query.range.from, query.range.to];
      const warnings: string[] = [];

      if (query.model) { where.push('model = ?'); params.push(query.model); }
      if (query.endpoint) { where.push('endpoint = ?'); params.push(query.endpoint); }
      if (query.sessionId) { where.push('session_id = ?'); params.push(query.sessionId); }
      if (query.usageSource) { where.push('usage_source = ?'); params.push(query.usageSource); }
      if (query.minDurationMs && query.minDurationMs > 0) {
        where.push('t_total >= ?'); params.push(query.minDurationMs);
      }
      if (query.status === '2xx') where.push('status >= 200 AND status < 300');
      else if (query.status === '4xx') where.push('status >= 400 AND status < 500');
      else if (query.status === '5xx') where.push('status >= 500');
      else if (query.status === 'error') where.push('(status >= 400 OR error_class IS NOT NULL)');
      if (query.q) {
        where.push('(path LIKE ? OR model LIKE ? OR upstream_request_id LIKE ? OR response_id LIKE ?)');
        const like = `%${query.q}%`;
        params.push(like, like, like, like);
      }

      // keyset 分页：ULID 字典序 == 时间序，因此游标比较即可，避免 OFFSET 全扫
      const orderBy = query.orderBy ?? 'started_at';
      const order = (query.order ?? 'desc').toUpperCase() === 'ASC' ? 'ASC' : 'DESC';
      const cmp = order === 'DESC' ? '<' : '>';
      if (query.cursor) where.push(`id ${cmp} ?`);
      if (query.cursor) params.push(query.cursor);

      const totalApprox = num(db.get<{ n: number }>(
        'SELECT COUNT(*) AS n FROM request_event WHERE started_at >= ? AND started_at <= ?',
        [query.range.from, query.range.to],
      )?.n);

      const hasDetail = totalApprox > 0;
      if (!hasDetail) {
        return {
          data: [], meta: { nextCursor: null, hasMore: false, totalApprox: 0, rangeMs: [query.range.from, query.range.to] },
          warnings: ['DETAIL_LOGGING_DISABLED'],
        };
      }

      const sql = `SELECT * FROM request_event
                    WHERE ${where.join(' AND ')}
                    ORDER BY ${orderBy} ${order}
                    LIMIT ?`;
      const rows = db.all(sql, [...params, limit + 1] as SqlValue[]);
      const hasMore = rows.length > limit;
      const page = hasMore ? rows.slice(0, limit) : rows;
      const prices = loadPrices();
      const data = page.map((r) => mapRequestRow(r, prices));

      const estCount = data.filter((d) => d.usageSource === 'estimated').length;
      if (estCount > 0) warnings.push(`usage_estimated:${estCount}`);

      return {
        data,
        meta: {
          nextCursor: hasMore && data.length ? data[data.length - 1]!.id : null,
          hasMore,
          totalApprox,
          rangeMs: [query.range.from, query.range.to],
        },
        warnings,
      };
    },

    request(id: string): (RequestRow & Record<string, unknown>) | null {
      const row = db.get<Record<string, SqlValue>>('SELECT * FROM request_event WHERE id = ?', [id]);
      if (!row) return null;
      const base = mapRequestRow(row, loadPrices());
      return {
        ...base,
        query: row.query ?? null,
        codexClientReqId: row.codex_client_req_id ?? null,
        codexSubagent: row.codex_subagent ?? null,
        keyFingerprint: row.key_fingerprint ?? null,
        tUpstreamConnect: row.t_upstream_connect ?? null,
        tUpstreamHeaders: row.t_upstream_headers ?? null,
        tFirstToken: row.t_first_token ?? null,
        observeShape: String(row.observe_shape ?? 'unknown'),
        observeNote: row.observe_note ?? null,
        cacheWriteTokens: num(row.cache_write_tokens),
        usageComplete: num(row.usage_complete) === 1,
        estimator: row.estimator ?? null,
        createdDay: String(row.created_day),
        truncatedRequest: num(row.truncated_request) === 1,
      };
    },

    bodyRef(id: string): { ref: string; bytes: number | null } | null {
      const row = db.get<{ body_ref: string | null; body_bytes: number | null }>(
        'SELECT body_ref, body_bytes FROM request_event WHERE id = ?', [id],
      );
      if (!row || !row.body_ref) return null;
      return { ref: row.body_ref, bytes: row.body_bytes === null ? null : num(row.body_bytes) };
    },

    sessions(limit = 100): SessionBreakdown[] {
      const rows = db.all(
        `SELECT id, external_id, title, last_seen_at, request_count, total_tokens
           FROM session ORDER BY last_seen_at DESC LIMIT ?`, [limit],
      );
      return rows.map((r) => {
        const sid = String(r.id);
        const externalId = r.external_id === null ? null : String(r.external_id);
        const title = r.title === null ? null : String(r.title);
        return {
          sessionId: sid,
          externalId,
          title,
          label: title ?? externalId ?? `未命名会话 · ${sid}`,
          lastSeenAt: num(r.last_seen_at),
          requestCount: num(r.request_count),
          totalTokens: num(r.total_tokens),
          // 这条投影只有会话级 token 总数（无模型维度），**无法**按模型定价。
          // 会话成本请看 by-session（它按模型细分后读时重算）。
          costUsd: 0,
          costKnown: false,
        };
      });
    },

    counts(): { events: number; sessions: number; hasDetail: boolean } {
      const events = num(db.get<{ n: number }>('SELECT COUNT(*) AS n FROM request_event')?.n);
      const sessions = num(db.get<{ n: number }>('SELECT COUNT(*) AS n FROM session')?.n);
      return { events, sessions, hasDetail: events > 0 };
    },

    distinctModels(): string[] {
      // 三个来源取并集：明细（有详情时最全）、小时聚合（永远在写）、天聚合（历史）
      const rows = db.all<{ model: string }>(
        `SELECT DISTINCT model FROM request_event WHERE model IS NOT NULL
         UNION SELECT DISTINCT model FROM rollup_hourly WHERE model IS NOT NULL
         UNION SELECT DISTINCT model FROM daily_model WHERE model IS NOT NULL
         UNION SELECT DISTINCT model FROM daily_session WHERE model IS NOT NULL`,
      );
      return rows.map((r) => r.model).filter((m) => m && m !== '*').sort();
    },
  };
}

// ─────────────────────────────── 小工具 ───────────────────────────────

function num(v: unknown): number {
  if (typeof v === 'number') return Number.isFinite(v) ? v : 0;
  if (typeof v === 'bigint') return Number(v);
  if (typeof v === 'string') { const n = Number(v); return Number.isFinite(n) ? n : 0; }
  return 0;
}
function fix(v: number): number {
  return Number.isFinite(v) ? Math.round(v * 10) / 10 : 0;
}
function round6(v: number): number {
  return Number.isFinite(v) ? Math.round(v * 1e6) / 1e6 : 0;
}

function mapRequestRow(r: Record<string, SqlValue>, prices: readonly ModelPrice[]): RequestRow {
  const inputTokens = num(r.input_tokens);
  const cachedTokens = num(r.cached_tokens);
  const outputTokens = num(r.output_tokens);
  const model = r.model === null ? null : String(r.model);
  // ★ 成本**读时**按当前价格表算（不读 cost_usd 列）：
  //   这样"设置页补了价格"立刻反映到全部历史视图，也让明细与概览用同一份口径。
  //   usage_source='none' 的请求（失败且无法估算）没有用量，直接判为"未知"。
  const cost = r.usage_source === 'none'
    ? null
    : computeCostUsd(matchPrice(prices, model), { inputTokens, cachedInputTokens: cachedTokens, outputTokens });
  return {
    id: String(r.id),
    startedAt: num(r.started_at),
    method: String(r.method),
    path: String(r.path),
    endpoint: String(r.endpoint),
    status: r.status === null ? null : num(r.status),
    errorClass: r.error_class === null ? null : String(r.error_class),
    model,
    sessionId: r.session_id === null ? null : String(r.session_id),
    threadId: r.codex_thread_id === null ? null : String(r.codex_thread_id),
    originator: r.codex_originator === null ? null : String(r.codex_originator),
    upstreamRequestId: r.upstream_request_id === null ? null : String(r.upstream_request_id),
    responseId: r.response_id === null ? null : String(r.response_id),
    totalMs: num(r.t_total),
    ttfbMs: r.t_upstream_headers === null ? null : num(r.t_upstream_headers),
    firstTokenMs: r.t_first_token === null ? null : num(r.t_first_token),
    inputTokens,
    outputTokens,
    cachedTokens,
    reasoningTokens: num(r.reasoning_tokens),
    totalTokens: num(r.total_tokens),
    usageSource: String(r.usage_source),
    usageComplete: num(r.usage_complete) === 1,
    bytesIn: num(r.bytes_in),
    bytesOut: num(r.bytes_out),
    costUsd: cost,
    hasBody: r.body_ref !== null && r.body_ref !== undefined,
    bodyBytes: r.body_bytes === null || r.body_bytes === undefined ? null : num(r.body_bytes),
    truncatedResponse: num(r.truncated_response) === 1,
  };
}

export type { RequestEvent };
