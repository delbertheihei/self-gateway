/**
 * SQLite 持久层（`node:sqlite`，Node 内置，零原生模块）。
 *
 * 设计来源：[`docs/05-data-model-and-metrics.md`](../../../../docs/05-data-model-and-metrics.md)
 *
 * 三条实现纪律：
 *   1. **全进程单个写实例** —— SQLite 只允许一个写者。读也走同一连接（单用户场景
 *      并发极低，省掉连接池的复杂度与锁争用）。
 *   2. **`timeout: 5000` 必须显式传** —— Node 的 `DatabaseSync` 默认 `timeout: 0`
 *      即"遇到锁立即失败"，与 better-sqlite3 的默认行为不同。这个差异会让
 *      高频写入时随机丢记录，且很难排查。
 *   3. **DDL 只用标准 SQL** —— 便于将来无痛切到 better-sqlite3（若需 SQL 精确分位）。
 *
 * 聚合计策略（本文件最重要的一条）：
 *   **聚合恒写、明细受开关控制**。`detailEnabled=false` 时不写 `request_event`，
 *   但仍写 `rollup_hourly` / `daily_model` / `daily_session`。
 *   这保证"关掉明细后 KPI 仍然可见" —— 否则产品价值直接归零。
 */

import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { Logger } from '../config/logger.ts';

export const SCHEMA_VERSION = 3;

/**
 * 用量污染的判定谓词（SQL 版本）★ 必须与 `edge/proxy.ts` 的写入口径一致：
 * **估算来源 + 请求失败（无上游响应，或 HTTP ≥ 400）** 的 token 一律不计入账本。
 *
 * 为什么需要它（实测到的真实缺陷）：Codex 撞上 404 时会立刻重试，30 次重试每次
 * 都被估算成 33k input token（请求体 41KB），合计 **120 万** 虚假 input；
 * 它们 cached 恒为 0，把"缓存命中率"从 89% 拖到 61%，并让区间 token 虚高 23%。
 */
export const POLLUTED_USAGE_SQL = "usage_source = 'estimated' AND (status IS NULL OR status >= 400)";

/**
 * 增量迁移脚本（key = 目标版本，按序执行）。
 *
 * v1 = 初始 schema（DDL 全部 `IF NOT EXISTS`，因此没有脚本）。
 * v3 = 缓存口径 + 会话按模型聚合 + 剔除历史"失败请求估算用量"污染。
 */
const MIGRATIONS: Array<{ to: number; note: string; run: (db: Db, log: Logger) => void }> = [
  {
    to: 2,
    note: '清掉历史遗留的"模型名标题"，并从 daily_session 回填缺失的 session 行',
    run: (db) => {
      // ① title 在本版本之前**只**由 recorder 写成 `model` / `model · endpoint`，
      //    且没有任何界面可以人工设置它 —— 因此历史非空 title 一律是无意义的占位符。
      //    清空后展示标签会回落到 Codex session-id（唯一、可对着 Codex 日志核对）。
      db.run('UPDATE session SET title = NULL WHERE title IS NOT NULL');

      // ② 回填 session 行：`daily_session` 是**聚合**（关明细也写），而 session 表以前
      //    只在 Detail Mode 下写 —— 于是"关着明细跑过"的会话没有行，标签只能回落成
      //    ID 前缀（两个同毫秒建立的会话前缀相同 → 显示成同一个名字）。
      const missing = db.all<{ sid: string; first_day: string; last_day: string; n: number; tokens: number }>(
        `SELECT ds.session_id AS sid, MIN(ds.day) AS first_day, MAX(ds.day) AS last_day,
                SUM(ds.request_count) AS n, SUM(ds.total_tokens) AS tokens
           FROM daily_session ds
           LEFT JOIN session s ON s.id = ds.session_id
          WHERE s.id IS NULL
          GROUP BY ds.session_id`,
      );
      for (const r of missing) {
        // 有明细就取真实时间；没有（明细已清或当时没开）就用聚合的日界兜底 ——
        // 与 analytics 在缺 session 行时的回落口径保持一致。
        const real = db.get<{ first: number | null; last: number | null }>(
          'SELECT MIN(started_at) AS first, MAX(started_at) AS last FROM request_event WHERE session_id = ?',
          [r.sid],
        );
        const first = Number(real?.first) || new Date(`${r.first_day}T00:00:00`).getTime();
        const last = Number(real?.last) || new Date(`${r.last_day}T23:59:59`).getTime();
        db.run(
          'INSERT OR IGNORE INTO session(id, external_id, project_path, title, first_seen_at, last_seen_at, request_count, total_tokens) '
          + 'VALUES (?, ?, NULL, NULL, ?, ?, ?, ?)',
          [r.sid, r.sid, first, last, Number(r.n), Number(r.tokens)],
        );
      }
    },
  },
  {
    to: 3,
    note: '缓存口径（cache_known_input_tokens）+ 会话按模型聚合 + 剔除历史"失败请求估算用量"污染',
    run: (db, log) => migrateToV3(db, log),
  },
];

/**
 * v3 迁移：三件事，顺序敏感。
 *
 * ── ① 新增"缓存信息已知"的 token 列
 *    缓存命中率的口径必须是 `cached / 有缓存信息的 input`。
 *    过去的分母是**全部** input，而"本地估算"的请求 cached 恒为 0（不是"缓存没命中"，
 *    而是"根本不知道"）。把未知当 0 会把命中率系统性压低。
 *
 * ── ② 剔除历史"失败请求估算用量"污染（`POLLUTED_USAGE_SQL`）
 *    聚合表是**加法**累加的，因此"减去污染行"在数学上是精确的。
 *    聚合表按 (小时|模型|端点)、(天|模型)、(天|会话|模型) 三个维度分别累加，
 *    明细行只累加到唯一一个键上，因此逐键相减不会串账。
 *    同时也把明细行本身归零（`usage_source='none'`）—— 否则"请求列表"与
 *    "概览 KPI"会互相矛盾。行本身保留（失败请求是事实），只清掉 token。
 *
 * ── ③ daily_session 增加 model 维度
 *    成本改为**读时**按当前价格表计算（见 @sgw/shared/pricing 的说明），
 *    而"会话成本"要算得准就必须知道每个会话用了哪些模型、各自多少 token。
 *    旧表只有 total_tokens，无法反推模型 —— 因此重建表，并从明细回填；
 *    对"明细已被清理"的部分保留一行 `model='*'`（token 保留、成本按未知处理，
 *    绝不硬猜价格）。
 */
function migrateToV3(db: Db, log: Logger): void {
  // ═══ ① 新增列 ═══
  if (!hasColumn(db, 'rollup_hourly', 'cache_known_input_tokens')) {
    db.exec('ALTER TABLE rollup_hourly ADD COLUMN cache_known_input_tokens INTEGER NOT NULL DEFAULT 0');
  }
  if (!hasColumn(db, 'daily_model', 'cache_known_input_tokens')) {
    db.exec('ALTER TABLE daily_model ADD COLUMN cache_known_input_tokens INTEGER NOT NULL DEFAULT 0');
  }

  // ═══ ② 剔除污染 ═══
  const bad = db.get<{ n: number; inp: number; tot: number }>(
    `SELECT COUNT(*) AS n, COALESCE(SUM(input_tokens), 0) AS inp, COALESCE(SUM(total_tokens), 0) AS tot
       FROM request_event WHERE ${POLLUTED_USAGE_SQL}`,
  );
  const badRows = Number(bad?.n ?? 0);
  if (badRows > 0) {
    db.exec(`CREATE TEMP TABLE _sgw_bad_hour AS
      SELECT (started_at / 3600000) * 3600000 AS bucket_start, COALESCE(model, '*') AS model, endpoint,
             SUM(input_tokens) AS inp, SUM(output_tokens) AS out, SUM(total_tokens) AS tot,
             SUM(cost_usd) AS cost, COUNT(*) AS n
        FROM request_event WHERE ${POLLUTED_USAGE_SQL}
       GROUP BY bucket_start, model, endpoint`);
    db.exec(`CREATE TEMP TABLE _sgw_bad_day AS
      SELECT created_day AS day, COALESCE(model, '*') AS model,
             SUM(input_tokens) AS inp, SUM(output_tokens) AS out, SUM(total_tokens) AS tot,
             SUM(cost_usd) AS cost, COUNT(*) AS n
        FROM request_event WHERE ${POLLUTED_USAGE_SQL}
       GROUP BY created_day, model`);
    db.exec(`CREATE TEMP TABLE _sgw_bad_session AS
      SELECT created_day AS day, session_id,
             SUM(input_tokens) AS inp, SUM(output_tokens) AS out, SUM(total_tokens) AS tot,
             SUM(cost_usd) AS cost, COUNT(*) AS n
        FROM request_event WHERE ${POLLUTED_USAGE_SQL} AND session_id IS NOT NULL
       GROUP BY created_day, session_id`);

    db.exec(`UPDATE rollup_hourly SET
        input_tokens     = MAX(0, input_tokens     - COALESCE((SELECT b.inp  FROM _sgw_bad_hour b
          WHERE b.bucket_start = rollup_hourly.bucket_start AND b.model = rollup_hourly.model AND b.endpoint = rollup_hourly.endpoint), 0)),
        output_tokens    = MAX(0, output_tokens    - COALESCE((SELECT b.out  FROM _sgw_bad_hour b
          WHERE b.bucket_start = rollup_hourly.bucket_start AND b.model = rollup_hourly.model AND b.endpoint = rollup_hourly.endpoint), 0)),
        total_tokens     = MAX(0, total_tokens     - COALESCE((SELECT b.tot  FROM _sgw_bad_hour b
          WHERE b.bucket_start = rollup_hourly.bucket_start AND b.model = rollup_hourly.model AND b.endpoint = rollup_hourly.endpoint), 0)),
        cost_usd         = MAX(0, cost_usd         - COALESCE((SELECT b.cost FROM _sgw_bad_hour b
          WHERE b.bucket_start = rollup_hourly.bucket_start AND b.model = rollup_hourly.model AND b.endpoint = rollup_hourly.endpoint), 0)),
        estimated_count  = MAX(0, estimated_count  - COALESCE((SELECT b.n    FROM _sgw_bad_hour b
          WHERE b.bucket_start = rollup_hourly.bucket_start AND b.model = rollup_hourly.model AND b.endpoint = rollup_hourly.endpoint), 0))`);

    db.exec(`UPDATE daily_model SET
        input_tokens     = MAX(0, input_tokens    - COALESCE((SELECT b.inp  FROM _sgw_bad_day b WHERE b.day = daily_model.day AND b.model = daily_model.model), 0)),
        output_tokens    = MAX(0, output_tokens   - COALESCE((SELECT b.out  FROM _sgw_bad_day b WHERE b.day = daily_model.day AND b.model = daily_model.model), 0)),
        total_tokens     = MAX(0, total_tokens    - COALESCE((SELECT b.tot  FROM _sgw_bad_day b WHERE b.day = daily_model.day AND b.model = daily_model.model), 0)),
        cost_usd         = MAX(0, cost_usd        - COALESCE((SELECT b.cost FROM _sgw_bad_day b WHERE b.day = daily_model.day AND b.model = daily_model.model), 0)),
        estimated_count  = MAX(0, estimated_count - COALESCE((SELECT b.n    FROM _sgw_bad_day b WHERE b.day = daily_model.day AND b.model = daily_model.model), 0))`);

    db.exec(`UPDATE daily_session SET
        total_tokens = MAX(0, total_tokens - COALESCE((SELECT b.tot  FROM _sgw_bad_session b WHERE b.day = daily_session.day AND b.session_id = daily_session.session_id), 0)),
        cost_usd     = MAX(0, cost_usd     - COALESCE((SELECT b.cost FROM _sgw_bad_session b WHERE b.day = daily_session.day AND b.session_id = daily_session.session_id), 0))`);

    db.exec(`UPDATE session SET
        total_tokens = MAX(0, total_tokens - COALESCE((SELECT SUM(b.tot) FROM _sgw_bad_session b WHERE b.session_id = session.id), 0))`);

    // 明细行归零：失败请求没有"可计量用量"，但请求本身是事实，因此保留行。
    db.exec(`UPDATE request_event SET
        input_tokens = 0, output_tokens = 0, total_tokens = 0, cached_tokens = 0,
        cache_write_tokens = 0, reasoning_tokens = 0, cost_usd = 0,
        usage_source = 'none', usage_complete = 1, estimator = NULL,
        observe_note = COALESCE(observe_note || ' ', '') || '请求失败（HTTP ' || COALESCE(CAST(status AS TEXT), '无响应')
          || '）—— 未产生可计量用量，本地估算已丢弃（v3 迁移）'
      WHERE ${POLLUTED_USAGE_SQL}`);

    log.warn({
      rows: badRows,
      inputTokens: Number(bad?.inp ?? 0),
      totalTokens: Number(bad?.tot ?? 0),
    }, 'v3 迁移：已从聚合与明细中剔除失败请求的估算用量污染');
  }

  // ═══ ③ daily_session 重建（增加 model 维度）═══
  if (!hasColumn(db, 'daily_session', 'model')) {
    db.exec(`CREATE TABLE daily_session_v3 (
       day           TEXT NOT NULL,
       session_id    TEXT NOT NULL,
       model         TEXT NOT NULL DEFAULT '*',
       request_count INTEGER NOT NULL DEFAULT 0,
       input_tokens  INTEGER NOT NULL DEFAULT 0,
       cached_tokens INTEGER NOT NULL DEFAULT 0,
       output_tokens INTEGER NOT NULL DEFAULT 0,
       total_tokens  INTEGER NOT NULL DEFAULT 0,
       cost_usd      REAL    NOT NULL DEFAULT 0,
       PRIMARY KEY (day, session_id, model)
     ) WITHOUT ROWID`);

    // 有明细的部分：按 (天, 会话, 模型) 精确回填
    db.exec(`INSERT INTO daily_session_v3(day, session_id, model, request_count,
                input_tokens, cached_tokens, output_tokens, total_tokens, cost_usd)
             SELECT created_day, session_id, COALESCE(model, '*'), COUNT(*),
                    SUM(input_tokens), SUM(cached_tokens), SUM(output_tokens), SUM(total_tokens), 0
               FROM request_event WHERE session_id IS NOT NULL
              GROUP BY created_day, session_id, COALESCE(model, '*')`);

    // 没有明细的余量：保留 token、模型标 '*'
    // （成本按**未知**处理 —— 宁可显示"—"，也不拿别的模型的价格硬算）
    db.exec(`INSERT INTO daily_session_v3(day, session_id, model, request_count,
                input_tokens, cached_tokens, output_tokens, total_tokens, cost_usd)
             SELECT o.day, o.session_id, '*',
                    o.request_count - COALESCE(d.n, 0),
                    0, 0, 0,
                    o.total_tokens - COALESCE(d.tok, 0),
                    0
               FROM daily_session o
               LEFT JOIN (SELECT created_day AS day, session_id, COUNT(*) AS n, SUM(total_tokens) AS tok
                            FROM request_event WHERE session_id IS NOT NULL
                           GROUP BY created_day, session_id) d
                 ON d.day = o.day AND d.session_id = o.session_id
              WHERE o.request_count - COALESCE(d.n, 0) > 0`);

    db.exec('DROP TABLE daily_session');
    db.exec('ALTER TABLE daily_session_v3 RENAME TO daily_session');
    log.info('v3 迁移：daily_session 已重建（增加 model 维度，成本可读时重算）');
  }

  // ═══ ④ 回填"缓存信息已知"的 token ═══
  //   已知 = usage_source='upstream' 且 usage_complete=1（缓存分项可信）
  //   未知 = 其余（本地估算 / usage 字段不全）
  //   没有明细可核对的余量（明细已过期清理）按**已知**归入 —— 存储时能取到 cached 的
  //   只可能是上游 usage，这是最保守的归因（宁可多算进分母，也不虚高命中率）。
  db.exec(`CREATE TEMP TABLE _sgw_unknown_hour AS
    SELECT (started_at / 3600000) * 3600000 AS bucket_start, COALESCE(model, '*') AS model, endpoint,
           SUM(input_tokens) AS inp
      FROM request_event WHERE NOT (usage_source = 'upstream' AND usage_complete = 1)
     GROUP BY bucket_start, model, endpoint`);
  db.exec(`CREATE TEMP TABLE _sgw_unknown_day AS
    SELECT created_day AS day, COALESCE(model, '*') AS model, SUM(input_tokens) AS inp
      FROM request_event WHERE NOT (usage_source = 'upstream' AND usage_complete = 1)
     GROUP BY created_day, model`);

  db.exec(`UPDATE rollup_hourly SET cache_known_input_tokens = MAX(0, input_tokens - COALESCE((
      SELECT u.inp FROM _sgw_unknown_hour u
       WHERE u.bucket_start = rollup_hourly.bucket_start AND u.model = rollup_hourly.model
         AND u.endpoint = rollup_hourly.endpoint), 0))`);
  db.exec(`UPDATE daily_model SET cache_known_input_tokens = MAX(0, input_tokens - COALESCE((
      SELECT u.inp FROM _sgw_unknown_day u
       WHERE u.day = daily_model.day AND u.model = daily_model.model), 0))`);

  db.exec('DROP TABLE IF EXISTS _sgw_bad_hour');
  db.exec('DROP TABLE IF EXISTS _sgw_bad_day');
  db.exec('DROP TABLE IF EXISTS _sgw_bad_session');
  db.exec('DROP TABLE IF EXISTS _sgw_unknown_hour');
  db.exec('DROP TABLE IF EXISTS _sgw_unknown_day');
}

/** 列是否存在（用于"老库缺新列"的迁移判定；表名来自本文件常量，不接受外部输入） */
function hasColumn(db: Db, table: string, column: string): boolean {
  return db.all<{ name: string }>(`SELECT name FROM pragma_table_info('${table}')`)
    .some((r) => r.name === column);
}

/** 全部 DDL。用 `IF NOT EXISTS` 保证幂等；迁移由 `migrate()` 负责。 */
const DDL = [
  `CREATE TABLE IF NOT EXISTS meta (
     key   TEXT PRIMARY KEY,
     value TEXT NOT NULL
   ) WITHOUT ROWID`,

  `CREATE TABLE IF NOT EXISTS session (
     id            TEXT PRIMARY KEY,
     external_id   TEXT,
     project_path  TEXT,
     title         TEXT,
     first_seen_at INTEGER NOT NULL,
     last_seen_at  INTEGER NOT NULL,
     request_count INTEGER NOT NULL DEFAULT 0,
     total_tokens  INTEGER NOT NULL DEFAULT 0
   )`,

  `CREATE TABLE IF NOT EXISTS request_event (
     id                  TEXT PRIMARY KEY,
     started_at          INTEGER NOT NULL,
     ended_at            INTEGER NOT NULL,
     method              TEXT NOT NULL,
     path                TEXT NOT NULL,
     query               TEXT,
     endpoint            TEXT NOT NULL,
     status              INTEGER,
     error_class         TEXT,
     streamed            INTEGER NOT NULL DEFAULT 0,
     model               TEXT,
     session_id          TEXT,
     key_fingerprint     TEXT,
     upstream_request_id TEXT,
     response_id         TEXT,
     codex_thread_id     TEXT,
     codex_client_req_id TEXT,
     codex_originator    TEXT,
     codex_subagent      TEXT,
     t_upstream_connect  INTEGER,
     t_upstream_headers  INTEGER,
     t_first_token       INTEGER,
     t_total             INTEGER NOT NULL,
     input_tokens        INTEGER NOT NULL DEFAULT 0,
     output_tokens       INTEGER NOT NULL DEFAULT 0,
     total_tokens        INTEGER NOT NULL DEFAULT 0,
     cached_tokens       INTEGER NOT NULL DEFAULT 0,
     cache_write_tokens  INTEGER NOT NULL DEFAULT 0,
     reasoning_tokens    INTEGER NOT NULL DEFAULT 0,
     usage_source        TEXT NOT NULL DEFAULT 'none',
     usage_complete      INTEGER NOT NULL DEFAULT 1,
     estimator           TEXT,
     -- 观测到的响应形态：sse / json / binary / empty / unknown。
     -- 单独存一列，便于排查"为什么这条没有 usage"（binary/empty 本来就不可能有）。
     observe_shape       TEXT NOT NULL DEFAULT 'unknown',
     observe_note        TEXT,
     bytes_in            INTEGER NOT NULL DEFAULT 0,
     bytes_out           INTEGER NOT NULL DEFAULT 0,
     truncated_request   INTEGER NOT NULL DEFAULT 0,
     truncated_response  INTEGER NOT NULL DEFAULT 0,
     body_ref            TEXT,
     body_bytes          INTEGER,
     cost_usd            REAL,
     created_day         TEXT NOT NULL
   )`,

  `CREATE TABLE IF NOT EXISTS rollup_hourly (
     bucket_start     INTEGER NOT NULL,
     model            TEXT NOT NULL DEFAULT '*',
     endpoint         TEXT NOT NULL DEFAULT '*',
     request_count    INTEGER NOT NULL DEFAULT 0,
     error_count      INTEGER NOT NULL DEFAULT 0,
     input_tokens     INTEGER NOT NULL DEFAULT 0,
     output_tokens    INTEGER NOT NULL DEFAULT 0,
     cached_tokens    INTEGER NOT NULL DEFAULT 0,
     reasoning_tokens INTEGER NOT NULL DEFAULT 0,
     total_tokens     INTEGER NOT NULL DEFAULT 0,
     -- 输入 token 中"缓存信息可信"的那部分（上游返回了完整 usage）。
     -- 缓存命中率 = cached_tokens / cache_known_input_tokens；
     -- 本地估算的请求缓存在上游侧是**未知**，不是 0，因此不进分母。
     cache_known_input_tokens INTEGER NOT NULL DEFAULT 0,
     estimated_count  INTEGER NOT NULL DEFAULT 0,
     incomplete_count INTEGER NOT NULL DEFAULT 0,
     cost_usd         REAL    NOT NULL DEFAULT 0,
     lat_hist         BLOB,
     t_total_sum      INTEGER NOT NULL DEFAULT 0,
     ttfb_sum         INTEGER NOT NULL DEFAULT 0,
     PRIMARY KEY (bucket_start, model, endpoint)
   ) WITHOUT ROWID`,

  `CREATE TABLE IF NOT EXISTS daily_model (
     day              TEXT NOT NULL,
     model            TEXT NOT NULL DEFAULT '*',
     request_count    INTEGER NOT NULL DEFAULT 0,
     error_count      INTEGER NOT NULL DEFAULT 0,
     input_tokens     INTEGER NOT NULL DEFAULT 0,
     output_tokens    INTEGER NOT NULL DEFAULT 0,
     cached_tokens    INTEGER NOT NULL DEFAULT 0,
     reasoning_tokens INTEGER NOT NULL DEFAULT 0,
     total_tokens     INTEGER NOT NULL DEFAULT 0,
     cache_known_input_tokens INTEGER NOT NULL DEFAULT 0,
     estimated_count  INTEGER NOT NULL DEFAULT 0,
     incomplete_count INTEGER NOT NULL DEFAULT 0,
     cost_usd         REAL    NOT NULL DEFAULT 0,
     lat_hist         BLOB,
     t_total_sum      INTEGER NOT NULL DEFAULT 0,
     ttfb_sum         INTEGER NOT NULL DEFAULT 0,
     PRIMARY KEY (day, model)
   ) WITHOUT ROWID`,

  // 会话聚合：**按模型细分**。成本改为读时按当前价格表计算，
  // 而会话里可能混用多个模型，只有知道每个模型各自的 token 才能算准。
  `CREATE TABLE IF NOT EXISTS daily_session (
     day           TEXT NOT NULL,
     session_id    TEXT NOT NULL,
     model         TEXT NOT NULL DEFAULT '*',
     request_count INTEGER NOT NULL DEFAULT 0,
     input_tokens  INTEGER NOT NULL DEFAULT 0,
     cached_tokens INTEGER NOT NULL DEFAULT 0,
     output_tokens INTEGER NOT NULL DEFAULT 0,
     total_tokens  INTEGER NOT NULL DEFAULT 0,
     cost_usd      REAL    NOT NULL DEFAULT 0,
     PRIMARY KEY (day, session_id, model)
   ) WITHOUT ROWID`,

  `CREATE TABLE IF NOT EXISTS model_price (
     model              TEXT PRIMARY KEY,
     input_per_mtok     REAL NOT NULL,
     output_per_mtok    REAL NOT NULL,
     cached_per_mtok    REAL,
     reasoning_per_mtok REAL,
     currency           TEXT NOT NULL DEFAULT 'USD',
     updated_at         INTEGER NOT NULL
   ) WITHOUT ROWID`,

  `CREATE TABLE IF NOT EXISTS settings (
     key        TEXT PRIMARY KEY,
     value      TEXT NOT NULL,
     updated_at INTEGER NOT NULL
   ) WITHOUT ROWID`,

  // ── 索引（对应 docs/05 §3）──
  `CREATE INDEX IF NOT EXISTS ix_req_started   ON request_event(started_at DESC)`,
  `CREATE INDEX IF NOT EXISTS ix_req_day       ON request_event(created_day)`,
  `CREATE INDEX IF NOT EXISTS ix_req_model     ON request_event(model, started_at DESC)`,
  `CREATE INDEX IF NOT EXISTS ix_req_status    ON request_event(status)`,
  `CREATE INDEX IF NOT EXISTS ix_req_session   ON request_event(session_id, started_at DESC)`,
  `CREATE INDEX IF NOT EXISTS ix_req_slow      ON request_event(t_total DESC)`,
  `CREATE INDEX IF NOT EXISTS ix_req_usage_src ON request_event(usage_source)`,
  `CREATE INDEX IF NOT EXISTS ix_req_thread    ON request_event(codex_thread_id, started_at DESC)`,
  `CREATE INDEX IF NOT EXISTS ix_session_last  ON session(last_seen_at DESC)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS ux_session_external ON session(external_id) WHERE external_id IS NOT NULL`,
  `CREATE INDEX IF NOT EXISTS ix_rh_bucket     ON rollup_hourly(bucket_start DESC)`,
  `CREATE INDEX IF NOT EXISTS ix_dm_day        ON daily_model(day DESC)`,
];

export type SqlValue = string | number | bigint | null | Uint8Array;
export type Row = Record<string, SqlValue>;

export interface Db {
  /** 底层句柄（analytics / recorder 需要 prepare 时使用） */
  readonly handle: DatabaseSync;
  /** 文件绝对路径（健康检查展示用） */
  readonly file: string;
  exec(sql: string): void;
  run(sql: string, params?: SqlValue[]): { changes: number | bigint; lastInsertRowid: number | bigint };
  get<T = Row>(sql: string, params?: SqlValue[]): T | undefined;
  all<T = Row>(sql: string, params?: SqlValue[]): T[];
  /** 单事务批量执行（recorder 的核心：一次 fsync 落多条） */
  transaction<T>(fn: () => T): T;
  close(): void;
}

export interface OpenDbOptions {
  dataDir: string;
  log: Logger;
  /** 测试用内存库 */
  inMemory?: boolean;
}

export function openDb(opts: OpenDbOptions): Db {
  const file = opts.inMemory ? ':memory:' : path.join(opts.dataDir, 'sgw.db');
  if (!opts.inMemory) fs.mkdirSync(opts.dataDir, { recursive: true });

  // ★ timeout 必须显式给：Node 默认 0 = 遇锁立即失败
  const handle = new DatabaseSync(file, { timeout: 5_000 });

  // PRAGMA：WAL + NORMAL 是"性能 / 崩溃安全"的平衡点。
  // 崩溃最多丢最后几百毫秒的**观测**数据，对记账完全可接受。
  handle.exec('PRAGMA journal_mode = WAL');
  handle.exec('PRAGMA synchronous = NORMAL');
  handle.exec('PRAGMA foreign_keys = ON');
  handle.exec('PRAGMA busy_timeout = 3000');
  handle.exec('PRAGMA temp_store = MEMORY');
  if (!opts.inMemory) handle.exec('PRAGMA mmap_size = 134217728');

  const db: Db = {
    handle,
    file,

    exec(sql) { handle.exec(sql); },

    run(sql, params = []) {
      const stmt = handle.prepare(sql);
      const r = stmt.run(...params);
      return { changes: r.changes, lastInsertRowid: r.lastInsertRowid };
    },

    get<T = Row>(sql: string, params: SqlValue[] = []) {
      const stmt = handle.prepare(sql);
      return stmt.get(...params) as T | undefined;
    },

    all<T = Row>(sql: string, params: SqlValue[] = []) {
      const stmt = handle.prepare(sql);
      return stmt.all(...params) as T[];
    },

    transaction<T>(fn: () => T): T {
      handle.exec('BEGIN');
      try {
        const out = fn();
        handle.exec('COMMIT');
        return out;
      } catch (e) {
        try { handle.exec('ROLLBACK'); } catch { /* 忽略回滚失败 */ }
        throw e;
      }
    },

    close() {
      try { handle.exec('PRAGMA wal_checkpoint(TRUNCATE)'); } catch { /* 忽略 */ }
      handle.close();
    },
  };

  migrate(db, opts.log);
  return db;
}

/** 建表 + 记录 schema 版本。`CREATE ... IF NOT EXISTS` 保证可重复执行。 */
export function migrate(db: Db, log: Logger): void {
  const t0 = Date.now();
  db.transaction(() => {
    for (const sql of DDL) db.exec(sql);
  });

  const cur = db.get<{ value: string }>('SELECT value FROM meta WHERE key = ?', ['schema_version']);
  if (!cur) {
    db.run('INSERT OR REPLACE INTO meta(key, value) VALUES (?, ?)', ['schema_version', String(SCHEMA_VERSION)]);
    db.run('INSERT OR REPLACE INTO meta(key, value) VALUES (?, ?)', ['install_id', randomId()]);
    db.run('INSERT OR REPLACE INTO meta(key, value) VALUES (?, ?)', ['created_at', String(Date.now())]);
    log.info({ schemaVersion: SCHEMA_VERSION, ms: Date.now() - t0 }, '数据库已初始化');
    return;
  }

  const have = Number(cur.value);
  if (have < SCHEMA_VERSION) {
    for (const m of MIGRATIONS) {
      if (have >= m.to) continue;
      log.warn({ from: have, to: m.to, note: m.note }, '执行 schema 迁移');
      try {
        db.transaction(() => { m.run(db, log); });
      } catch (e) {
        // 迁移失败必须显式暴露：继续往下走会带着错误的 schema 版本号运行
        log.error({ to: m.to, err: (e as Error).message }, 'schema 迁移失败 —— 请备份 data/ 后再启动');
        throw e;
      }
    }
    db.run('INSERT OR REPLACE INTO meta(key, value) VALUES (?, ?)', ['schema_version', String(SCHEMA_VERSION)]);
    log.info({ from: have, to: SCHEMA_VERSION }, 'schema 迁移完成');
  } else if (have > SCHEMA_VERSION) {
    log.error({ have, want: SCHEMA_VERSION }, '数据库 schema 版本高于本程序 —— 请升级 SGW');
  }
}

function randomId(): string {
  return Array.from({ length: 16 }, () => Math.floor(Math.random() * 16).toString(16)).join('');
}

// ─────────────────────────────── settings KV ───────────────────────────────

export function getSetting<T>(db: Db, key: string, fallback: T): T {
  const row = db.get<{ value: string }>('SELECT value FROM settings WHERE key = ?', [key]);
  if (!row) return fallback;
  try { return JSON.parse(row.value) as T; } catch { return fallback; }
}

export function setSetting(db: Db, key: string, value: unknown): void {
  db.run(
    'INSERT INTO settings(key, value, updated_at) VALUES (?, ?, ?) '
    + 'ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at',
    [key, JSON.stringify(value), Date.now()],
  );
}

/**
 * 删除一个设置项 = 让该项**回落到配置文件 / 内置默认值**。
 *
 * 语义上这不是"设成空"，而是"取消覆盖"。上游地址这类可热改项必须有这条出路，
 * 否则用户一旦在界面上填过值，就再也回不到"跟随 sgw.config.ts"的状态。
 */
export function deleteSetting(db: Db, key: string): void {
  db.run('DELETE FROM settings WHERE key = ?', [key]);
}

export function allSettings(db: Db): Record<string, unknown> {
  const rows = db.all<{ key: string; value: string }>('SELECT key, value FROM settings');
  const out: Record<string, unknown> = {};
  for (const r of rows) {
    try { out[r.key] = JSON.parse(r.value); } catch { out[r.key] = r.value; }
  }
  return out;
}

// ─────────────────────────────── 数据库文件信息 ───────────────────────────────

export function dbSizeBytes(db: Db): number {
  if (db.file === ':memory:') {
    const p = db.get<{ p: number }>('SELECT page_count * page_size AS p FROM pragma_page_count(), pragma_page_size()');
    return Number(p?.p ?? 0);
  }
  try {
    let total = 0;
    for (const suffix of ['', '-wal', '-shm']) {
      const f = `${db.file}${suffix}`;
      if (fs.existsSync(f)) total += fs.statSync(f).size;
    }
    return total;
  } catch {
    return 0;
  }
}

export function dirSizeBytes(dir: string): number {
  let total = 0;
  try {
    if (!fs.existsSync(dir)) return 0;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) total += dirSizeBytes(full);
      else total += fs.statSync(full).size;
    }
  } catch { /* 忽略 */ }
  return total;
}
