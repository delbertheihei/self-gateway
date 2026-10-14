# SGW 数据模型与指标体系

> 项目：**SGW / Self Gateway**
> 存储方案：**单文件 SQLite（`node:sqlite` + WAL）+ 可选正文文件落盘**
> 版本：v1.0 · 设计冻结
> 前置阅读：[`02-architecture-design.md`](./02-architecture-design.md) §5（观测器） · [`03-tech-stack-selection.md`](./03-tech-stack-selection.md) §3（存储选型） · [`04-ui-ux-style-guide.md`](./04-ui-ux-style-guide.md) §8

---

## 1. 存储分层策略

```
┌── 热路径（内存，零分配偏向） ─────────────────────────────────┐
│  RingBuffer<RequestEvent> 最近 500 条 → 驱动实时表格与 KPI 增量 │
└──────────────────────────┬───────────────────────────────────┘
                           │ 批量 flush（200ms 或 64 条，先到先发）
┌──────────────────────────▼───────────────────────────────────┐
│  SQLite 主库 data/sgw.db（WAL，synchronous=NORMAL）            │
│   ├─ request_event    逐请求明细（Detail Mode 关闭时不写入）    │
│   ├─ session          Codex 会话维度                           │
│   ├─ rollup_hourly    小时聚合（永远写，与开关无关）            │
│   ├─ rollup_daily     天聚合（永远写）                         │
│   ├─ daily_model      天 × 模型聚合（永远写）                   │
│   ├─ model_price      可编辑价格表                             │
│   ├─ settings         开关与保留策略（KV）                      │
│   └─ meta             版本、迁移、安装 id                      │
└──────────────────────────┬───────────────────────────────────┘
                           │ 仅 Body Mode 开启时
┌──────────────────────────▼───────────────────────────────────┐
│  data/bodies/YYYY-MM-DD/<ulid>.{req,res}.json[.gz]            │
│  （默认 gzip 压缩；request_event.body_ref 存相对路径）          │
└──────────────────────────────────────────────────────────────┘
```

**关键设计决策**

| 决策 | 理由 |
|---|---|
| **聚合表永远写，明细表受开关控制** | 关掉明细后用户**仍然**要看到"今天用了多少"。这是本方案与"整体关日志"方案的本质区别 |
| 聚合与明细**分离表** | 明细一旦被清理，历史 KPI 不塌陷；聚合表很小（1 年 ≈ 8.7k 行/维度） |
| 正文**文件落盘**而非存 TEXT 列 | 避免 DB 膨胀与 VACUUM 抖动；便于按天整目录删除；便于用户手动 grep |
| 批量提交（200ms/64 条） | 单请求一次 fsync 会成为延迟与磁盘寿命杀手 |
| WAL + `synchronous=NORMAL` | 崩溃最多丢最后几百毫秒观测数据，对"记账"完全可接受，换来吞吐 |
| 单一写入者（recorder） | 避免 SQLITE_BUSY；读侧 analytics 用只读连接池 |

---

## 2. 实体关系

```
session 1 ──── * request_event * ──── 1 model_price(by model)
                       │
                       └── body_ref ──→ data/bodies/**（文件）

rollup_hourly / rollup_daily / daily_model  ← 由 request_event 或内存缓冲滚动生成
settings / meta                            ← 独立 KV
```

---

## 3. SQLite Schema（DDL，实现直接采用）

> 目标驱动：**`node:sqlite`**（Node 内置，零原生模块）。DDL 只用标准 SQL，便于将来无痛切到 `better-sqlite3`。

```sql
PRAGMA journal_mode = WAL;
PRAGMA synchronous  = NORMAL;
PRAGMA foreign_keys = ON;
PRAGMA busy_timeout = 3000;
PRAGMA temp_store   = MEMORY;
PRAGMA mmap_size    = 134217728;   -- 128MB

-- ── 会话维度 ────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS session (
  id              TEXT PRIMARY KEY,        -- ulid
  external_id     TEXT,                    -- Codex 会话/线程标识（原样）
  project_path    TEXT,                    -- 从会话标识或请求元数据推断，可空
  title           TEXT,                    -- 首条 prompt 摘要（尚未实现，见下方注）
  first_seen_at   INTEGER NOT NULL,
  last_seen_at    INTEGER NOT NULL,
  request_count   INTEGER NOT NULL DEFAULT 0,
  total_tokens    INTEGER NOT NULL DEFAULT 0
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_session_external ON session(external_id) WHERE external_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS ix_session_last_seen ON session(last_seen_at DESC);

-- ── 请求明细（Detail Mode 关闭时不写入） ────────────────────────────────
CREATE TABLE IF NOT EXISTS request_event (
  id                  TEXT PRIMARY KEY,     -- ulid，单调递增便于分页
  started_at          INTEGER NOT NULL,     -- epoch ms
  ended_at            INTEGER NOT NULL,
  method              TEXT NOT NULL,
  path                TEXT NOT NULL,        -- 原样 path
  query               TEXT,
  endpoint            TEXT NOT NULL,        -- responses|chat.completions|models|other
  status              INTEGER,              -- 可空（网络错误时无状态码）
  error_class         TEXT,                 -- 见 00 §7
  streamed            INTEGER NOT NULL DEFAULT 0,
  model               TEXT,
  session_id          TEXT REFERENCES session(id),
  key_fingerprint     TEXT,                 -- sha256(Authorization) 前 8 位
  upstream_request_id TEXT,                 -- 原样取自响应头 x-request-id
  response_id         TEXT,                 -- response.completed.response.id
  -- Codex 身份头（原样取自请求头，仅本地归因用）
  codex_thread_id     TEXT,                 -- thread-id
  codex_client_req_id TEXT,                 -- x-client-request-id
  codex_originator    TEXT,                 -- originator：codex_cli_rs / codex_vscode / …
  codex_subagent      TEXT,                 -- x-openai-subagent：review/compact/…
  -- 计时（ms；除 started_at/ended_at 外均可空）
  t_upstream_connect  INTEGER,
  t_upstream_headers  INTEGER,
  t_first_token       INTEGER,
  t_total             INTEGER NOT NULL,
  -- 用量
  input_tokens        INTEGER NOT NULL DEFAULT 0,
  output_tokens       INTEGER NOT NULL DEFAULT 0,
  total_tokens        INTEGER NOT NULL DEFAULT 0,
  cached_tokens       INTEGER NOT NULL DEFAULT 0,
  cache_write_tokens  INTEGER NOT NULL DEFAULT 0,
  reasoning_tokens    INTEGER NOT NULL DEFAULT 0,
  usage_source        TEXT NOT NULL DEFAULT 'none',   -- upstream|estimated|none
  usage_complete      INTEGER NOT NULL DEFAULT 1,     -- 0 = 上游 usage 缺字段（会致 Codex 失败）
  estimator           TEXT,                            -- tiktoken|heuristic
  -- 体积与截断
  bytes_in            INTEGER NOT NULL DEFAULT 0,
  bytes_out           INTEGER NOT NULL DEFAULT 0,
  truncated_request   INTEGER NOT NULL DEFAULT 0,
  truncated_response  INTEGER NOT NULL DEFAULT 0,
  -- 正文引用
  body_ref            TEXT,                 -- 相对路径，可空
  body_bytes          INTEGER,
  -- 成本（**写入时按当时价格计算的历史留档**；界面展示一律读时重算，见 §7）
  cost_usd            REAL,
  created_day         TEXT NOT NULL         -- 'YYYY-MM-DD' 本地时区，便于按天清理/分区
);
CREATE INDEX IF NOT EXISTS ix_req_started   ON request_event(started_at DESC);
CREATE INDEX IF NOT EXISTS ix_req_day       ON request_event(created_day);
CREATE INDEX IF NOT EXISTS ix_req_model     ON request_event(model, started_at DESC);
CREATE INDEX IF NOT EXISTS ix_req_status    ON request_event(status);
CREATE INDEX IF NOT EXISTS ix_req_session   ON request_event(session_id, started_at DESC);
CREATE INDEX IF NOT EXISTS ix_req_slow      ON request_event(t_total DESC);
CREATE INDEX IF NOT EXISTS ix_req_usage_src ON request_event(usage_source);
CREATE INDEX IF NOT EXISTS ix_req_thread    ON request_event(codex_thread_id, started_at DESC);

-- ── 聚合：小时 ─────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS rollup_hourly (
  bucket_start    INTEGER NOT NULL,         -- epoch ms，整点
  model           TEXT NOT NULL DEFAULT '*',
  endpoint        TEXT NOT NULL DEFAULT '*',
  request_count   INTEGER NOT NULL DEFAULT 0,
  error_count     INTEGER NOT NULL DEFAULT 0,
  input_tokens    INTEGER NOT NULL DEFAULT 0,
  output_tokens   INTEGER NOT NULL DEFAULT 0,
  cached_tokens   INTEGER NOT NULL DEFAULT 0,
  reasoning_tokens INTEGER NOT NULL DEFAULT 0,
  total_tokens    INTEGER NOT NULL DEFAULT 0,
  -- 输入 token 中"缓存信息可信"的部分（上游返回完整 usage）。
  -- 缓存命中率 = cached_tokens / cache_known_input_tokens：本地估算的请求缓存在上游侧
  -- 是**未知**而不是 0，计入分母会把命中率系统性压低（v3 引入，见 §7.3）。
  cache_known_input_tokens INTEGER NOT NULL DEFAULT 0,
  estimated_count INTEGER NOT NULL DEFAULT 0,
  cost_usd        REAL    NOT NULL DEFAULT 0,
  -- 延迟直方图（固定分桶，见 §5.4）
  lat_hist        BLOB,                     -- Uint32Array(24) little-endian
  t_total_sum     INTEGER NOT NULL DEFAULT 0,
  ttfb_sum        INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (bucket_start, model, endpoint)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS ix_rh_bucket ON rollup_hourly(bucket_start DESC);

-- ── 聚合：天 × 模型 ────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS daily_model (
  day             TEXT NOT NULL,            -- 'YYYY-MM-DD' 本地时区
  model           TEXT NOT NULL DEFAULT '*',
  request_count   INTEGER NOT NULL DEFAULT 0,
  error_count     INTEGER NOT NULL DEFAULT 0,
  input_tokens    INTEGER NOT NULL DEFAULT 0,
  output_tokens   INTEGER NOT NULL DEFAULT 0,
  cached_tokens   INTEGER NOT NULL DEFAULT 0,
  reasoning_tokens INTEGER NOT NULL DEFAULT 0,
  total_tokens    INTEGER NOT NULL DEFAULT 0,
  cache_known_input_tokens INTEGER NOT NULL DEFAULT 0,
  estimated_count INTEGER NOT NULL DEFAULT 0,
  cost_usd        REAL    NOT NULL DEFAULT 0,
  lat_hist        BLOB,
  t_total_sum     INTEGER NOT NULL DEFAULT 0,
  ttfb_sum        INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (day, model)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS ix_dm_day ON daily_model(day DESC);

-- ── 会话 × 天 × 模型 聚合（会话排行 + 会话成本用） ───────────────────────
-- ★ 必须带 model 维度：成本读时按"每个模型自己的单价"重算（v3 起）。
CREATE TABLE IF NOT EXISTS daily_session (
  day             TEXT NOT NULL,
  session_id      TEXT NOT NULL,
  model           TEXT NOT NULL DEFAULT '*',
  request_count   INTEGER NOT NULL DEFAULT 0,
  input_tokens    INTEGER NOT NULL DEFAULT 0,
  cached_tokens   INTEGER NOT NULL DEFAULT 0,
  output_tokens   INTEGER NOT NULL DEFAULT 0,
  total_tokens    INTEGER NOT NULL DEFAULT 0,
  cost_usd        REAL    NOT NULL DEFAULT 0,
  PRIMARY KEY (day, session_id, model)
) WITHOUT ROWID;

-- ── 价格表 ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS model_price (
  model              TEXT PRIMARY KEY,      -- 支持通配后缀，如 'gpt-6-*'
  input_per_mtok     REAL NOT NULL,
  output_per_mtok    REAL NOT NULL,
  cached_per_mtok    REAL,
  reasoning_per_mtok REAL,
  currency           TEXT NOT NULL DEFAULT 'USD',
  updated_at         INTEGER NOT NULL
);

-- ── 设置（KV，JSON 值） ─────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS settings (
  key         TEXT PRIMARY KEY,
  value       TEXT NOT NULL,                -- JSON
  updated_at  INTEGER NOT NULL
);

-- ── 元信息 ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
-- 约定键：schema_version / install_id / created_at / last_cleanup_at / prices.seed_version
```

**`session` 表的写入时机与标签口径（曾两次出错，务必遵守）**

- **写入时机**：`session` 与 `daily_session` **同源**，都在聚合路径上写（`recorder.flushAggregates()`），
  **不依赖 Detail Mode**。曾经它只在 `writeDetailBatch()` 里 upsert，于是"关着明细跑过"的会话
  没有行，`/stats/by-session` 查不到 `external_id`，标签只能回落到 ID 前缀。
- **`title` 当前恒为 NULL**：它曾经被写成模型名（`model` / `model · endpoint`），于是
  "最活跃会话"里出现一个叫 `gpt-6-sol` 的条目。真正的标题（首条 prompt 摘要）尚未实现；
  实现之前**不要**用任何"看起来像名字"的字段（模型名、端点名）去填它。
- **展示标签的唯一口径**（后端给出，前端不拼）：`title → external_id（Codex session-id）→ 完整主键`。
  ★ 回落**禁止截断主键**：ULID 前 10 字符只覆盖 48 位毫秒时间戳 + 2 位随机，
  同一毫秒建立的两个会话前缀相同 —— 这正是"两个不同会话显示成同一个「未命名会话 · 01a13882-3」"的根因。

**迁移历史**

| 版本 | 内容 |
|---|---|
| v2 | 清掉历史模型名标题，并按 `daily_session` 回填缺失的会话行（时间戳优先取 `request_event`，无明细时用聚合日界兜底） |
| v3 | ① 新增 `cache_known_input_tokens`（缓存口径）；② **剔除历史"失败请求估算用量"污染**（见 §7.4）；③ `daily_session` 重建为 `(day, session_id, model)`，明细能核对的部分精确回填，核对不上的余量保留一行 `model='*'`（token 保留、成本按未知处理，绝不硬猜价格）；④ 回填 `cache_known_input_tokens` |

> v3 的迁移是**一次性、精确的减法**：聚合表是加法累加的，且每条明细只累加到唯一一个
> (小时\|模型\|端点) / (天\|模型) / (天\|会话) 键上，因此"逐键相减"不会串账。
> 它只覆盖**仍在 `request_event` 里**的污染行；明细已被保留策略清理的部分无法回溯，这也是
> 修好写入口径比事后修数更重要的原因。

---

## 4. 设置项（`settings` 表内 JSON）

```jsonc
{
  "logging": {
    "detailEnabled": false,        // 请求明细总开关
    "bodyEnabled": false,          // 正文落盘（依赖 detailEnabled=true）
    "bodyMaxBytes": 524288,        // 单条上限 512KB
    "bodyCompress": true           // gzip 落盘
  },
  "retention": {
    "detailDays": 30,
    "bodyDays": 7,
    "maxDbBytes": 2147483648,      // 2GB，超限先删最老明细
    "maxBodyBytes": 2147483648,
    "autoVacuum": true
  },
  "upstream": {
    "baseUrl": "https://relay.example.com/v1",   // ★ 运行期手动填写（设置页），不是写死的常量
    "stripPrefix": "/v1",          // 拼上游前从入站 path 剥掉的前缀
    "replaceAuth": false,          // ★ 默认 false = 原样透传 Authorization
    "authHeader": "Authorization",
    "caFile": null,
    "strictSsl": true,
    "headersTimeoutMs": 10000,     // 等上游响应头；超时 → 504
    "silentWarnMs": 120000,        // 流中途静默到此值写 warn 日志（不掐断）
    "keepAlive": true
    // 注意：**没有** bodyTimeout —— 流式长任务不设上限（见 02 §6.3）
  },
  "edge": {
    "host": "127.0.0.1",           // ★ 硬编码回环，UI 只读
    "port": 8787,
    "stripHopByHop": true,         // 必须 true
    "observeMaxBytes": 524288,
    "observeTimeoutMs": 3000,
    "graceDrainMs": 8000,          // ★ 客户端中断后的宽限期排空（为拿到 usage）
    "sseKeepAliveMs": 0,           // 0 = 关闭。>0 会向代理的 SSE 注入注释帧，属改动字节流
    "requestTimeoutMs": 0          // 0 = 不限制（必须为 0，Node 默认 300s 会掐断长流）
  },
  "security": {
    "requireToken": true,          // 每次安装随机 token，SPA 自动携带
    "allowedHosts": ["127.0.0.1:8787", "localhost:8787", "[::1]:8787"],
    "allowedOrigins": ["http://127.0.0.1:8787", "http://localhost:8787"]
  },
  "estimator": {
    "prefer": "tiktoken",          // tiktoken | heuristic
    "charsPerToken": 3.6           // 启发式回退系数
  },
  "ui": {
    "theme": "system",             // system | dark | light
    "defaultRange": "24h",
    "liveEnabled": true
  }
}
```

> **开关语义澄清（FR-C1）**：`detailEnabled=false` 时**不写** `request_event`，但**继续写** `rollup_*`。UI 上概览/趋势/模型分布照常工作，仅"请求明细/会话详情"页显示提示："明细记录已关闭 —— 当前仅保留聚合统计 [去开启]"。

---

## 5. 指标定义（Metrics Dictionary）

### 5.1 计数指标

| 指标 | 定义 | 备注 |
|---|---|---|
| `request_count` | 完成的 HTTP 交换数 | 含失败；不含被 Edge 拒绝（非 `/v1/*`）的请求 |
| `error_count` | `status >= 400` 或 `error_class IS NOT NULL` | 客户端中断（`client_aborted`）单独计，默认不计入失败率 |
| `error_rate` | `error_count / request_count` | UI 显示为百分比，1 位小数 |
| `input_tokens` | 上游 `usage.input_tokens` | 含缓存命中与写入部分 |
| `output_tokens` | `usage.output_tokens` | 含 reasoning |
| `cached_tokens` | `usage.input_tokens_details.cached_tokens` | 命中缓存读取的部分，通常有折扣 |
| `cache_write_tokens` | `usage.input_tokens_details.cache_write_tokens` | 写入缓存的部分，部分供应商计价不同 |
| `reasoning_tokens` | `usage.output_tokens_details.reasoning_tokens` | 是 output 的子集，**不重复计入 total** |
| `total_tokens` | `usage.total_tokens`，缺失时 `input + output` | 优先信任上游。⚠️ 上游**缺此字段**时，Codex 会整轮失败，见 §5.6 |
| `uncached_input` | `input_tokens - cached_tokens` | 成本计算用 |
| `cache_hit_rate` | `cached_tokens / input_tokens` | input 为 0 时显示 `—` |
| `estimated_ratio` | `estimated_count / request_count` | 用于提示数据可信度 |

### 5.2 时间指标

| 指标 | 定义 | 计算点 |
|---|---|---|
| `t_upstream_connect` | 收到请求头 → 上游 TCP/TLS 建连完成 | transport |
| `t_upstream_headers` | 建连完成 → 收到上游响应头（含等待排队） | transport |
| `ttfb` | 收到请求头 → 上游首字节 | `t_upstream_headers` 近似 |
| `ttft`（首 token） | 收到请求头 → 首个 `response.output_text.delta` 或首个数据 chunk | observe |
| `generation` | 首个 token → 最后字节 | 派生 |
| `t_total` | 收到请求头 → 响应完成（或中断） | edge |
| `tokens_per_sec` | `output_tokens / (generation / 1000)` | 派生，UI 仅在 > 0.5s 生成时长时显示 |
| `gateway_overhead` | `t_total − 上游侧耗时`（若上游给 `x-upstream-time` 之类则用，否则用 p95 对比基线） | 自检项 |

### 5.4 延迟分位与直方图

**不使用 SQL 分位函数**（实测 100 万行下 `row_number()` 窗口精确分位需 **824ms**，且在时间桶上无法复用；`node:sqlite` 也不提供 `percentile()`/`median()`——那是 SQLite 的编译期扩展），改用**固定分桶直方图**：

```ts
// 分桶边界（ms），24 桶 —— 覆盖 1ms ~ 130s，尾部超限并入最后一桶
export const LAT_BUCKETS_MS = [
  1, 2, 5, 10, 20, 50, 100, 150, 200, 300, 400, 500,
  750, 1000, 1500, 2000, 3000, 5000, 8000, 12000, 20000, 40000, 80000, 130000,
];
// 存储：Uint32Array(24) → BLOB(96 bytes)
// 分位：在合并后的直方图上做线性插值
export function percentile(hist: Uint32Array, p: number): number;
```

**优势**：单行 96 字节，任意时间范围只需把桶相加即可得到 p50/p95/p99；查询复杂度 O(桶数) 而非 O(行数)。

**精度声明**：直方图分位在 UI 上标注为「近似」（tooltip：分位基于固定分桶直方图，精度受桶宽限制）。

> **为什么这个取舍是对的**：仪表盘的用途是"发现异常"，而不是"出具权威 SLA 报告"。用 96 字节/行换来 **0ms** 的任意时间范围分位查询（对比精确分位 824ms），是完全划算的。若未来确实需要精确分位，只需换 `better-sqlite3` 驱动（自带 percentile 扩展）并保留同一套 schema 与查询层——见 [`03`](./03-tech-stack-selection.md) §3.2。

### 5.5 `node:sqlite` 驱动层实现注意

| 项 | 要求 | 原因 |
|---|---|---|
| 打开方式 | `new DatabaseSync(path, { timeout: 5000 })` | **Node 的 `timeout` 默认是 `0` = 遇到锁立即失败**（与 `better-sqlite3` 的默认行为不同！） |
| 实例数 | 全进程**单个**写实例 + 串行批量队列 | SQLite 只允许一个写者 |
| API 名称 | 用薄适配层隔离 `DatabaseSync`（新版本已改名 `Database`，DEP0210） | 便于跨 Node 主版本升级 |
| 稳定性 | Node 22 为 1.1（会打印 `ExperimentalWarning`，纯提示）；Node 25.7+ 为 1.2 RC | 建议跑 Node 24 LTS |
| PRAGMA | 见 §3 顶部 | WAL + `synchronous=NORMAL` 是性能与安全性的平衡点 |
| 窗口函数 | ✅ 可用（但**不用于分位**，见 §5.4） | — |

### 5.6 上游 usage 完整性（互操作红线）

### 5.6 上游 usage 完整性（互操作红线）

Codex 的 `ResponseCompleted` 把 `response.id`、`usage.input_tokens`、`usage.output_tokens`、`usage.total_tokens` 声明为**非 `Option`**。因此：

| 上游形态 | Codex | 记账 |
|---|---|---|
| 无 `usage` 字段 / `usage: null` | ✅ 正常 | 估算，`usage_source='estimated'` |
| `usage` 完整 | ✅ 正常 | 精确，`usage_source='upstream'`，`usage_complete=1` |
| ⚠️ `usage` 缺 `total_tokens` 等 | ❌ **整轮硬失败** | 原样透传，`usage_complete=0`，UI 红色告警 |

**指标**：`usage_complete_rate = 1 - count(usage_complete=0)/count(*)`。该值 < 100% 时，概览页必须常驻告警横幅（对应 FR-A13）。

### 5.6b 为什么"成功的请求"也可能是估算（v3 修复）

`usage` **只存在于流末尾的终止事件**（`response.completed` / `response.incomplete`），
其它事件（`response.created`、各种 `*.delta`）的 `usage` 恒为 `null`。因此"拿不到 usage"的真正原因往往是
**观测没看到流的末尾**。观测缓冲的硬上限是 `edge.observeMaxBytes`（默认 512KB），
它按 **1:4:12** 的比例切成「头部 128KB + 尾部 384KB」：

| 现象 | 根因 | 处理 |
|---|---|---|
| >512KB 的 SSE 响应拿到精确 usage | 尾部缓冲捞到了终止事件 | ✅ v3 起正常 |
| `truncated_response=1` + 来源=估算 | 中间段被丢弃**且**尾部也没捞到（例如压缩流无法分段解压） | 说明写进 `observe_note`，明细里可见 |
| 来源=估算 + `clientAborted` | 客户端按 Esc，宽限期（默认 8s）内没等到终止事件 | **保留估算**（token 确实消耗了），`observe_note` 写明原因 |
| 来源=none（非 LLM 端点） | `/v1/alpha/search` 这类端点不是 LLM 调用，响应里永远没有 usage | 不估算（否则会凭空产生 token） |

### 5.7 成本估算

```
cost =
    (input - cached) / 1e6 * price.input        # 未缓存输入
  + cached            / 1e6 * (price.cached ?? price.input)   # 缓存命中（有折扣）
  + output            / 1e6 * price.output
```

**口径（v3 起，两条都是硬约束）**

1. **成本一律"读时"按当前价格表计算**，界面不展示 `cost_usd` 列。
   价格表有官方默认值、也是用户可编辑的；把金额固化进历史行会导致"改了价格但数字不变"，
   也会让默认价格补不上历史。聚合表保留了完整 token 分项，因此重算是精确的、无需数据迁移。
   `request_event.cost_usd` / `rollup_hourly.cost_usd` 等列仍按写入时价格写入，作为**历史留档**。
2. **"没有价格" ≠ "0 元"**。缺价格的模型返回 `null`，`summary.costKnown=false` 且
   `summary.unpricedModels` 列出缺价模型；前端显示 `—`（部分缺价时加 `≈` 前缀），
   绝不显示 `$0.0000?`（这是修复前的历史缺陷）。

- 价格来自 `model_price`，模型匹配顺序：**精确匹配 → 最长前缀通配（`gpt-6-*`）→ 默认行（`*`）→ 未知则 `NULL`**。
  匹配实现只有一份：`@sgw/shared/pricing` 的 `matchPrice()`（recorder 与 analytics 共用，避免口径分叉）。
- 默认价格来自官方定价页（`PRICE_TABLE_SOURCE`，USD / 1M tokens），启动时**只插不覆盖**地播种；
  用 `meta['prices.seed_version']` 记住播种版本，因此用户删掉的行不会在重启后复活。
  设置页提供「补齐官方默认价格」与「重建为官方默认值（覆盖）」两个动作。
- UI 一律带 `ⓘ`：**"成本为本地估算，仅供参考；实际计费以公司账单为准"**。

### 5.8 缓存命中率（v3 修正后的口径）

```
cacheHitRate = cached_tokens / cache_known_input_tokens      # 分母只含"缓存信息可信"的输入
cache_known_input_tokens = Σ input_tokens where usage_source='upstream' AND usage_complete=1
```

**为什么不能拿全部 `input_tokens` 当分母**（修复前的缺陷）：
本地估算的请求（上游没给 usage）其 `cached` 字段**恒为 0** —— 但那是"未知"，不是"没命中"。
把未知当 0 计入分母，命中率会被系统性压低。实测：区间内 89.0% 被显示成 61.1%。

`rollup_hourly` / `daily_model` 因此各多一列 `cache_known_input_tokens`（v3 迁移回填，
明细可核对的部分精确回填；明细已被清理的余量按"已知"归入 —— 存储时能取到 cached 的只可能是
上游 usage，这是最保守的归因）。

### 5.9 失败请求不产生用量（v3 新增的写入口径）

**判定**：本次交换"失败" = **没有上游响应**（status 为 null，含连接失败 / 504 超时 / 未收到响应头即中断）
**或** 上游 HTTP ≥ 400。此时：

- **丢弃本地估算**：请求体估算值代表"如果跑了会用多少"，不是"实际用了多少"。
  模型从未被调用 → `usage_source='none'`、token 全 0、成本 `null`，并在 `observe_note` 写明原因；
- **上游给了 usage 就仍按上游记**（例如 200 但流中途断掉，status 仍是 200 → 照常估算兜底）。

**为什么必须这么做**（实测缺陷）：Codex 撞上 404 会立刻重试，每次重试的请求体都有 40KB，
估算器把它算成 33k input token 写进账本 —— 30 次重试累计 **120 万**虚假 input，
它们 cached 恒为 0，于是**真实的 89.0% 命中率被显示成 61.1%**，区间 token 也虚高 23%。
写入口径修好之后，v3 迁移把**仍在明细里**的历史污染逐键减掉。

---

## 6. 控制面 API 契约（`/_sgw/api/*`）

> **命名空间隔离**：所有管理接口挂 `/_sgw/`，与代理的 `/v1/*` 完全隔离，避免任何路径冲突。
> 默认仅回环可访问 + 校验 `Host`/`Origin`（见 `02` §8）。

### 6.1 查询接口

| 方法 | 路径 | 说明 |
|---|---|---|
| `GET` | `/_sgw/api/health` | 版本、uptime、DB 大小、开关状态、上游连通性、**usage 完整性状态** |
| `GET` | `/_sgw/api/stats/summary` | KPI 汇总。参数 `range=1h\|24h\|7d\|30d\|month\|custom&from&to` |
| `GET` | `/_sgw/api/stats/timeseries` | 时间序列。参数 `bucket=auto\|hour\|day&breakdown=type\|model&tz` |
| `GET` | `/_sgw/api/stats/by-model` | 模型维度聚合（含占比、成本、延迟近似分位） |
| `GET` | `/_sgw/api/stats/by-session` | 会话排行。参数 `limit&orderBy=tokens\|cost\|count` |
| `GET` | `/_sgw/api/stats/latency` | 分位 + 直方图数据（UI 画迷你柱状） |
| `GET` | `/_sgw/api/requests` | 明细分页。参数 `range&model&status&endpoint&minDuration&usageSource&q&sessionId&cursor&limit&orderBy&order` |
| `GET` | `/_sgw/api/requests/:id` | 单条完整详情 |
| `GET` | `/_sgw/api/requests/:id/body` | 正文（`?side=request\|response`）。**Body Mode 关闭时返回 403 + 说明** |
| `GET` | `/_sgw/api/sessions` | 会话列表 |

**分页约定**：使用 **cursor（keyset）分页**而非 offset，游标 = `base64(ulid)`；响应含 `nextCursor`。返回体统一：

```jsonc
{
  "data": [ /* ... */ ],
  "meta": { "nextCursor": "…", "hasMore": true, "totalApprox": 386, "rangeMs": [1710000000000, 1710086400000] },
  "warnings": ["usage_estimated: 12 条记录为估算值"]
}
```

### 6.2 配置与运维接口

| 方法 | 路径 | 说明 |
|---|---|---|
| `GET` | `/_sgw/api/settings` | 全量设置（**脱敏**：不返回密钥，仅 `hasCustomKey: boolean`） |
| `PATCH` | `/_sgw/api/settings` | 局部更新（zod 校验），立即生效并广播 |
| `GET` | `/_sgw/api/stream` | **SSE**：`request.start` / `request.end` / `stats.tick` / `settings.changed` |
| `POST` | `/_sgw/api/selftest` | 触发 H1~H5 透传自检，返回逐项结果 |
| `POST` | `/_sgw/api/upstream/test` | 上游连通性 + TLS + **路径前缀语义探测**（`/models` vs `/models`，定 `stripPrefix`）+ **usage 完整性探针** |
| `DELETE` | `/_sgw/api/data` | 清理。`{ scope: 'detail'\|'bodies'\|'all', before?: epochMs }` |
| `GET` | `/_sgw/api/export/requests.csv` | 导出明细（流式响应，不占内存） |
| `GET` | `/_sgw/api/prices` | 价格表读取（附默认值来源 `meta.source`） |
| `PUT`/`POST` | `/_sgw/api/prices` | 批量 upsert（`{ prices: [...] }`） |
| `DELETE` | `/_sgw/api/prices?model=…` | 删除一条（**删掉默认值是"这个模型没有价格"的唯一表达**，重启不会复活） |
| `POST` | `/_sgw/api/prices/defaults` | 补齐官方默认价格。`{ overwrite?: boolean }`：默认只插不覆盖；`true` 时连已改过的行一起重置 |
| `POST` | `/_sgw/api/shutdown` | 优雅关闭（UI 上的"停止网关"） |

### 6.3 错误码约定

```jsonc
{ "error": { "code": "BODY_LOGGING_DISABLED",
             "message": "正文记录已关闭",
             "hint": "在设置中开启「记录请求/响应正文」后可查看" } }
```

| 码 | HTTP | 场景 |
|---|---|---|
| `BODY_LOGGING_DISABLED` | 403 | 读正文但开关关 |
| `DETAIL_LOGGING_DISABLED` | 409 | 明细被关，该请求无记录 |
| `RECORD_NOT_FOUND` | 404 | 记录已被清理 |
| `INVALID_RANGE` | 400 | 时间范围非法 |
| `UPSTREAM_UNREACHABLE` | 502 | 上游探测失败 |
| `UPSTREAM_USAGE_INCOMPLETE` | 200（仅告警） | 上游 usage 缺字段，会导致 Codex 整轮失败；随 health/settings 返回 |
| `WEBSOCKET_NOT_SUPPORTED` | 501 | 收到 `Upgrade: websocket` 的 `/v1/responses`（见 `02` ADR-17） |
| `DB_BUSY` | 503 | 写锁超时（UI 显示重试） |

---

## 7. 数据保留与清理策略

### 7.1 清理任务（每小时一次，低优先级）
```
1. 明细：DELETE FROM request_event WHERE created_day < today - retention.detailDays
2. 正文：删除 data/bodies/<day>/ 中超出 bodyDays 的目录（整目录删，O(1)）
3. 容量：若 db 文件 > maxDbBytes → 从最老明细开始按天删除，直到低于 90% 阈值
4. 孤儿：request_event 中 body_ref 指向不存在的文件 → 置 NULL
5. 每周一次 PRAGMA incremental_vacuum / wal_checkpoint(TRUNCATE)
6. 会话表：last_seen_at 超过 detailDays*2 且 request_count=0 的会话删除
```

### 7.2 清理的可见性（必须）
- 设置页显示：当前 DB 大小、正文目录大小、最近一次清理时间、下次预计清理量
- 任何清理动作写入 `meta`（`last_cleanup_at`）+ 结构化日志，并在 UI 显示"上次清理删除了 X 条记录 / Y MB"
- 手动清理必须二次确认，且**保留聚合**（KPI 不会因此归零）——UI 文案要明确说明这一点

---

## 8. 数据一致性规则

| 规则 | 说明 |
|---|---|
| **usage 来源优先** | 上游 `usage` 存在 → `upstream`；否则估算 → `estimated`；无法估算 → `none` 且计 0 |
| **非 LLM 端点** | 仅 `/responses` 与 `/chat/completions` 做本地估算；其它端点记 `none`（响应里没有 usage 的可能） |
| **幂等** | `request_event.id` 为本地 ulid，重复 flush 用 `INSERT OR REPLACE` 保证幂等 |
| **聚合与明细一致性** | 聚合在**内存**累加（与明细同一事件源），flush 时同一事务提交，避免"明细有聚合无" |
| **模型名归一** | 取请求体 `model`；若缺失则取响应体 `model`；仍缺失记 `unknown`。不做大小写或别名合并（保留原始事实） |
| **会话归组优先级** | ①`session-id`（Codex 的会话标识）→ ②`thread-id` → ③`x-client-request-id` → ④响应 `response.id` 兜底。**不硬猜**：都缺失时归入 `session_id = NULL`，UI 显示为"未归组" |
| **时区** | 存储全部 epoch ms（UTC 语义）；`created_day` 用**本地时区**生成，与用户直觉一致；UI 显示本地时间 |
| **reasoning 不重复计** | `total_tokens` 优先用上游值；若自算，只用 `input + output`，不额外加 reasoning |
| **失败请求** | 若上游已返回部分 token 后中断，按已解析到的 usage 计入（或估算），并标 `error_class` |

---

## 9. 边界与容量估算

| 场景 | 假设 | 估算 |
|---|---|---|
| 日均请求 | 400 次 | — |
| 单行大小 | ≈ 380 字节（含索引约 600） | — |
| 明细 30 天 | 12,000 行 | ≈ 7 MB（含索引） |
| 正文 7 天 | 平均 60KB × 2 份 | ≈ 336 MB |
| 聚合表 1 年 | 24×365 小时 × 1 模型 | ≈ 8,800 行 ≈ 1.5 MB |
| 结论 | 一年内 DB 主要增长来自正文 | 默认策略下 DB 常年 < 50MB |

> **体量判定**：本设计在 `maxDbBytes=2GB` 的配置下可支撑约 **日均 5,000 次请求 / 一年**，远超单开发者实际用量。若未来要支撑团队级用量，需要换 ClickHouse/DuckDB——v1 不做。

---

## 10. 备份、导出与迁移

| 能力 | 方案 |
|---|---|
| 备份 | 停止写入后 `VACUUM INTO 'backup-YYYYMMDD.db'`（SQLite 原生，安全且紧凑）；设置页提供按钮 |
| 导出明细 | `GET /_sgw/api/export/requests.csv`，流式逐行写，支持时间范围 |
| 导出聚合 | JSON（`daily_model` + `rollup_hourly` 范围查询） |
| 迁移 | `meta.schema_version` + 顺序迁移脚本；迁移前自动 `VACUUM INTO` 备份 |
| 重置 | 删除 `data/` 目录即可（UI 提供"清空全部数据"等价操作） |
