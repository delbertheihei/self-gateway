# SGW 技术选型说明书

> 项目：**SGW / Self Gateway**
> 范围：语言/运行时、代理层、存储、后端框架、前端框架、图表、构建与工具链、实时通道、安全
> 版本：v1.0 · 设计冻结
> 前置阅读：[`00-agent-dev-spec.md`](./00-agent-dev-spec.md)（硬约束 H1~H10） · [`02-architecture-design.md`](./02-architecture-design.md)
> 证据基础：`_research/codex-gateway-research.md`（Codex/sub2api 源码级调研）· `research/ai-usage-gateway-tech-research.md`（本机实测数据）

---

## 0. 选型一句话结论

> **用 `node:http` 手写一个 60 行的显式代理（不用 fetch、不用代理中间件），用 Node 内置 `node:sqlite` 存储，用 React 19 + Vite + Tailwind v4 做前端。**
> 整条链路只有 **3 个运行时依赖**：`zod`、`pino`、`eventsource-parser`。

**为什么是这个组合**：本项目的技术难点不在"写个代理"，而在 **"字节级不改"**。所有便利抽象（`fetch`、`http-proxy`、`@fastify/reply-from`）都在这一点上有已知的、会**静默或崩溃式**破坏透传的行为。因此选型的第一原则是**减少中间抽象层**，而不是提高开发效率。

---

## 1. 最终选型总表

| 层 | 选择 | 版本基线 | 一句话理由 |
|---|---|---|---|
| 运行时 | **Node.js 22 LTS**（本项目以 **22.23.3** 为准） | 22.23.3 | 与使用者本机一致；原生 TS 直跑已在 22.23.3 实测通过 |
| 语言 | **TypeScript** 仅作类型门禁 | typescript 5.9.3（`tsc --noEmit`） | 不参与构建；类型错误即失败 |
| 包管理 | **pnpm workspaces**（不引入 Turborepo） | pnpm 9.12.0 | 3 个包不需要任务编排与远程缓存 |
| **Edge（服务端）** | **`node:http` + 自研极简路由** | 内置 | 唯一能拿到 `req.rawHeaders` 且不会被中间件改写头的选择 |
| **Transport（上游）** | **`node:http` / `node:https` 客户端 + `http.Agent({keepAlive})`** | 内置 | 无 300s `bodyTimeout` 陷阱；**不做自动解压**；字节级真透传 |
| **存储** | **`node:sqlite`（`DatabaseSync`）** | 内置 SQLite 3.51.3 | 零原生编译摩擦（Windows 友好）；实测 100 万行插入 ~1s、索引区间查询 ~10ms |
| 任务调度 | **自研定时器 + 批量写队列** | — | 无队列/无外部服务 |
| 配置 | **`sgw.config.ts`（类型化 `defineConfig`）+ SQLite `settings` 表（M2 起）** | — | 需重启的走文件，热改的走 DB；Web 永不回写配置文件 |
| ID 生成 | **自研 ULID（约 70 行）** | — | 字典序 == 时间序 → 明细表可直接用 keyset 分页，无需 `OFFSET` 全扫 |
| **M1 运行时依赖** | **零**（仅 `node:*` 内置模块） | — | 先证明透传正确，再引入依赖 |
| 日志 | **自研最小 logger + 脱敏**（M2 换 pino） | — | 接口形状与 pino 对齐（`logger.info(obj, msg)`），替换零成本 |
| **M2+ 计划依赖** | `zod`（配置校验）· `pino`（结构化日志）· `eventsource-parser`（旁路解析） | — | 详见 §1.1 |
| **前端框架** | **React 19 + Vite + Tailwind CSS v4** | react 19.3 / vite 8.3 / tailwind 4.3 | 图表与组件生态最强；开发速度优先 |
| UI 组件 | **shadcn/ui（copy-in 源码）+ Radix primitives + lucide-react** | radix 1.8.1 / lucide 1.56 | 源码进仓库可改；无组件库锁定 |
| 图表（概览） | **Recharts** | 3.10.1 | SVG 易做 tooltip/legend/a11y，React 19 就绪 |
| 图表（密集时序） | **uPlot** | 1.6.x | ~13KB canvas，5 万点级别不卡 |
| 数据获取 | **TanStack Query** | 5.104.x | 缓存/去重/轮询 + `setQueryData` 合并 SSE 增量 |
| 实时通道 | **SSE**（`/_sgw/api/stream`） | 内置 | 单向够用；同源、受 CORS 约束、浏览器自动重连 |
| 测试 | **自研断言式回归脚本** + Vitest（M2 起） | — | M1 的透传回归不依赖任何测试框架，`node scripts/passthrough-regression.mjs` 即可 |
| 开发运行 | **Node 原生 TS 直跑**（`node src/index.ts`） | — | 无构建步骤、无 bundler、无 sourcemap |
| 构建 | **无**（前端除外：Vite 构建 SPA） | — | 服务端不打包 |

### 1.1 运行时依赖的三阶段收敛

| 阶段 | 依赖 | 说明 |
|---|---|---|
| **M1（已完成）** | **0 个** | 只有 `node:http`/`node:https`/`node:crypto`/`node:fs`/`node:url`/`node:path`。目的是"在引入任何第三方代码前先证明透传正确" |
| M2 计划 | `zod` → 置换手写配置校验；`pino` → 置换自研 logger；`eventsource-parser` → 旁路 SSE 解析 | 三者都是"替换自研实现"，不改变架构 |
| M3 计划 | 前端依赖（独立在 `apps/web`） | 与后端隔离 |

> **不引入** `fastify`、`undici`、`better-sqlite3`、`http-proxy`、`express`、`koa`、`tiktoken`。
> 其中 `tiktoken` 采用**启发式估算代替**（估算器只需 ±5–15% 精度，而引入原生/WASM 依赖与"零原生模块"目标冲突）。

---

## 2. 代理层选型（最关键的一节）

### 2.1 决策依据：三条源码/实测证据

| 证据 | 内容 | 引用 |
|---|---|---|
| **E1** | 原生 `fetch` 对 `connection` / `transfer-encoding` / `content-length` / `keep-alive` / `upgrade` / `expect` **直接抛 `TypeError`（`UND_ERR_INVALID_ARG`）**，而代理**必然**在入站请求里收到这些头 | 本机 raw-socket 实测，Node 22.23.3 |
| **E2** | 原生 `fetch` 会**注入**你没要求的头：`accept: */*`、`accept-language: *`、`sec-fetch-mode: cors`、`user-agent: node`、`accept-encoding: gzip, deflate` —— 直接违反 H2（不得新增任何请求头） | 同上，抓包输出 |
| **E3** | `undici` 的 `Client`/`Agent` 默认 `bodyTimeout = 300_000ms`，会在模型静默超过 5 分钟时**掐断流**并抛 `TypeError: terminated`；`node:http` 客户端默认**无超时**。反向地，`node:http` **服务端** 默认 `requestTimeout = 300_000ms` 也会掐断入站长流 | undici Client 文档 + 本机实测 |

> **E2 是决定性证据**：只要用了 `fetch`，就**永远无法**满足 H2。这不是"配置问题"，而是 API 设计使然。

### 2.2 方案对比

| 方案 | 流式不缓冲 | 头逐字保真 | 超时安全 | 结论 |
|---|---|---|---|---|
| **`node:http` 客户端** | ✅ 实测 5 个 SSE 分片 138/263/408/537/664ms 逐个到达 | ✅ **`rawHeaders` 保留原始大小写与重复头** | ✅ 默认无超时 | **★ 采用** |
| `undici.request()` | ✅ 实测同样逐片到达 | ⚠️ `transfer-encoding`/`content-length`/`keep-alive`/`upgrade` 会抛错，框架头处理 | ❌ 默认 `bodyTimeout=300s`（须显式置 0） | 备选（Promise 人体工学更好，但两个超时都必须置 0） |
| 原生 `fetch` | ✅ | ❌ **抛错 + 注入头** | ❌ `bodyTimeout=300s` | **✗ 否决** |
| Fastify + `@fastify/reply-from` / `@fastify/http-proxy` | ✅ | ✅ 尚可 | 需调 | **✗ 否决**（见 §2.3） |
| `http-proxy`(node-http-proxy) | ✅ | ✅ | 弱 | **✗ 否决**：最后发布 2020-05，6 年无人维护 |
| `fastify-http-proxy`（旧包） | — | — | — | **✗ 否决**：npm 已 deprecated |
| Hono / Elysia | ✅ | WHATWG `Headers` 语义，**丢失原始大小写与重复头** | 需调 | **✗ 否决**：`Headers` 会合并 `set-cookie` 等重复头，破坏 H2/H3 的"逐字"要求 |

### 2.3 为什么不用 Fastify（尽管它本身很好）

**CVE-2026-33805 / GHSA-gwhp-pf74-vj37（CRITICAL，2026-04-16 公布）**：*"Fastify's connection header abuse enables stripping of proxy-added headers"* —— 攻击者提供的 `Connection` 头会导致**代理注入的头被剥离**，即网关注入的上游 `Authorization` 可能被移除或与响应错配。

- 受影响：`@fastify/reply-from ≤ 12.6.1`、`@fastify/http-proxy ≤ 11.4.3`
- 已修复版本：`reply-from ≥ 12.7.1`、`http-proxy ≥ 11.6.4`

这个 CVE 的**性质**正是本项目的核心关切（头处理），因此结论不是"升级到安全版本"，而是：**自己写这 60 行头处理，把这条攻击面从供应链里彻底移除**。我们需要的只是一个代理路由 + 约 9 个管理端点，路由器的价值远小于其声明式的头操作带来的不确定性。

> 若团队**强烈偏好** Fastify：必须同时满足 ①`fastify >= 5.12.5` ②`@fastify/reply-from >= 12.7.1` 或 `@fastify/http-proxy >= 11.6.4` ③**在交给插件之前自己剥掉 `Connection` 及其列出的所有头**。且 `_sgw` 控制面与 `/v1` 代理面必须分开注册。

### 2.4 采用方案骨架（约 60 行，作为实现基线）

```ts
import http from 'node:http';

/* ── RFC 9110 §7.6.1：逐跳头 + Connection 中列出的所有头 ── */
const HOP = new Set([
  'connection', 'keep-alive', 'proxy-connection', 'proxy-authenticate',
  'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade',
]);

/** 用 rawHeaders 逐字拷贝，剥掉逐跳头；未知头、原始大小写、重复头全部保留（H2/H3） */
function filterHeaders(rawHeaders: string[]): Record<string, string | string[]> {
  const connTokens = new Set<string>();
  for (let i = 0; i < rawHeaders.length; i += 2)
    if (rawHeaders[i].toLowerCase() === 'connection')
      for (const t of rawHeaders[i + 1].split(',')) {
        const s = t.trim().toLowerCase();
        if (s && s !== 'close' && s !== 'keep-alive') connTokens.add(s);
      }
  const out: Record<string, string | string[]> = {};
  for (let i = 0; i < rawHeaders.length; i += 2) {
    const name = rawHeaders[i], lower = name.toLowerCase();
    if (HOP.has(lower) || connTokens.has(lower)) continue;   // ← 唯一允许的删除
    if (lower === 'host' || lower === 'content-length') continue; // ← 由客户端按目标重算
    out[lower] = lower in out ? ([].concat(out[lower] as never, rawHeaders[i + 1]) as string[]) : rawHeaders[i + 1];
  }
  return out;
}
```
```ts
// 服务端：必须关掉 requestTimeout，否则 300s 后长流被 Node 掐断
server.requestTimeout = 0;
server.headersTimeout = 60_000;
server.keepAliveTimeout = 65_000;
server.on('request', (req, res) => {
  if (isControlPlane(req)) return controlPlane(req, res);
  // 1) 路径原样：仅替换 base 前缀（H4）  2) body 直接 pipe，不解 JSON（H1）
  const up = http.request({
    hostname: upUrl.hostname, port: upUrl.port, protocol: upUrl.protocol,
    path: joinBase(upUrl, req.url), method: req.method,
    headers: filterHeaders(req.rawHeaders), agent: keepAliveAgent,
  }, (upRes) => {
    res.writeHead(upRes.statusCode!, filterHeaders(upRes.rawHeaders));
    res.flushHeaders();                       // 首字节立刻上线，不等 body
    req.socket.setNoDelay(true);              // 关 Nagle，降低事件级延迟
    upRes.pipe(res);                          // backpressure 自动传播
    teeForObservation(upRes, obs);            // ← 旁路观测，只读，绝不回写
  });
  req.pipe(up);                               // 请求体流式转发
  res.on('close', () => { if (!res.writableEnded) graceDrain(up, obs); });
});
```

### 2.5 明确不做的三件事

| ❌ 不做 | 原因 |
|---|---|
| 不用任何响应压缩中间件（`compression` 等） | 会按压缩块缓冲，直接摧毁流式；且改变响应字节（违反 H3） |
| 不在上游请求强制 `Accept-Encoding: identity` —— **默认不强制** | 该头属于"客户端语义"（Codex 声明自己接受什么）。强制改写违反 H2。**兜底**：作为 `settings.edge.forceIdentityEncoding`（默认 `false`）提供，仅当探针发现上游压缩导致观测失败时由用户开启 |
| 不重新分帧 SSE | 不补 `event:`、不补 `[DONE]`、不发心跳注释帧——任何重写都是 H3 的违反 |

> **注**：调研报告建议"强制 `identity`"是为了规避 `fetch` 自动解压的坑。我们已经选了 `node:http`（**不做任何自动解压**），因此这个坑天然不存在，也就**不再需要**改写请求头。这正是选型的第一性收益。

---

## 3. 存储选型

### 3.1 方案对比（数据为本机实测，Node 22.23.3 / SQLite 3.51.3）

| 方案 | Windows 原生编译摩擦 | 同步/异步 | 100 万行插入 | 索引区间查询 | 结论 |
|---|---|---|---|---|---|
| **`node:sqlite`（内置）** | **无**（编进 Node） | 同步 `DatabaseSync` | **~1.04s** | **~10ms** | **★ 采用** |
| `better-sqlite3` 13.0.3 | 低（有 win32-x64/arm64 预编译），但存在偶发 node-gyp 回退 | 同步 | 更快 | 同 | 备选（唯一优势：自带 percentile 扩展） |
| `libsql` / `@libsql/client` | 预编译（仅 win32-x64） | 异步 | — | — | ✗ 否决：为托管服务设计的客户端，本地单写者场景徒增异步复杂度 |
| DuckDB 1.5.6 | 原生 binding **36MB** | 异步 | — | — | ✗ 否决：列存分析引擎，与"每请求插一行"的负载形状不匹配 |
| PGlite | WASM **24MB**，零依赖 | 异步 | — | — | ✗ 否决：为 10ms 的查询背 24MB |
| 纯 JSONL 追加 | 无 | 同步 | 快 | **全表扫描 + JS 聚合**（差） | △ **仅作可选 tier-0 日志**，不作主存储 |

### 3.2 关于百分位（p50/p95/p99）——本选型的关键取舍

**实测（100 万行）**：
- 精确 p50/p95 用 `row_number()` / `count()` 窗口函数：**824ms**（轻量写法 577ms / 80 万行）
- `node:sqlite` **不支持** `percentile()` / `median()` / `percentile_cont`（SQLite percentile 扩展是**编译期**选项，Node 未启用；`nodejs/node#61295` 已于 2026-01-18 合并，但 22/24 都还没有）

**结论**：**不依赖 SQL 分位函数**，改用 [`05-data-model-and-metrics.md`](./05-data-model-and-metrics.md) §5.4 的**固定分桶直方图**（`Uint32Array(24)` → 96 字节 BLOB）。
- 合并任意时间范围 = 把桶相加，O(24)；分位在线性插值得到
- 收益：从 824ms 降到 **0ms**（rollup 表读取），并且分位可以按小时/模型任意切片
- 代价：分位是**近似值**，UI 必须标注（已在 `04` §6 规定）

> **若将来硬性要求 SQL 精确分位**：换 `better-sqlite3`（自带 percentile 扩展，可 `loadExtension`）。这是唯一值得为此付出的迁移成本，因此 `05` 的 schema 与查询层设计为与驱动无关（只用标准 SQL）。

### 3.3 两层表结构（已被实测证明有效）

| 层 | 内容 | 实测收益 |
|---|---|---|
| **Tier 1 `request_event`** | 每请求一行，`started_at` 建索引 | 全表 `GROUP BY` 302ms → **带索引区间查询 10ms** |
| **Tier 2 `rollup_hourly` / `daily_model`** | 预聚合 | 仪表盘总量与 30 天序列 **0ms** |

保留策略（90 天热数据）由实测支撑：100 万行 ≈ 100MB，且有了 rollup 后**没有紧急截断压力**。

### 3.4 `node:sqlite` 使用注意（实现必须遵守）

| 项 | 要求 |
|---|---|
| 稳定性状态 | Node 22 为 1.1 "Active development"（自 22.13.0 起去掉 `--experimental-sqlite` 标志，仍会打印 `ExperimentalWarning`）；Node 25.7.0 起为 1.2 RC |
| **`timeout` 默认值** | **Node 默认 `timeout: 0` = 遇到锁立即失败**（与 better-sqlite3 不同！）→ 必须显式 `new DatabaseSync(path, { timeout: 5000 })` |
| API 命名 | 新版本把 `DatabaseSync` 改名 `Database`（DEP0210）；用适配层隔离，便于跨 Node 版本 |
| 写并发 | SQLite 只允许单写者 → 全进程**单个** `DatabaseSync` 实例 + 串行批量写队列 |
| 窗口函数 | ✅ 支持（已在 §3.2 否决其用于分位，但可用于其他分析） |
| PRAGMA | `journal_mode=WAL`、`synchronous=NORMAL`、`busy_timeout=3000`、`mmap_size=128MB` |

---

## 4. 后端结构选型

### 4.1 不用框架的理由

| 需求 | 数量 | 是否需要框架 |
|---|---|---|
| 代理路由 | 1（`/v1/**` catch-all） | 否 |
| SPA 静态托管 | 1（含 fallback） | 否（手写静态处理器约 30 行） |
| 管理 API | ~9 | 否（方法 + 路径前缀匹配足够） |
| 参数校验 | — | **zod 已覆盖**（不依赖框架的 schema 集成） |
| 日志 | — | pino 独立可用 |

代理路径本身**完全不能用框架语义处理**（`reply.hijack()` / `raw` 访问是必需的逃生舱），所以框架只服务于那 9 个管理端点——投入产出比很低，还要承担 §2.3 的供应链风险。

### 4.2 极简路由（约 40 行）

```ts
type Handler = (req: http.IncomingMessage, res: http.ServerResponse, params: Record<string,string>) => void | Promise<void>;
const routes: Array<[method: string, pattern: RegExp, handler: Handler]> = [
  ['GET',    /^\/_sgw\/api\/health$/,              health],
  ['GET',    /^\/_sgw\/api\/stats\/(summary|timeseries|by-model|by-session|latency)$/, stats],
  ['GET',    /^\/_sgw\/api\/requests$/,            listRequests],
  ['GET',    /^\/_sgw\/api\/requests\/([0-9A-HJKMNP-TV-Z]{26})$/, getRequest],
  ['GET',    /^\/_sgw\/api\/requests\/([0-9A-HJKMNP-TV-Z]{26})\/body$/, getBody],
  ['GET',    /^\/_sgw\/api\/stream$/,              stream],
  ['GET',    /^\/_sgw\/api\/settings$/,            getSettings],
  ['PATCH',  /^\/_sgw\/api\/settings$/,            patchSettings],
  ['POST',   /^\/_sgw\/api\/(selftest|upstream\/test)$/, actions],
  ['DELETE', /^\/_sgw\/api\/data$/,                purge],
];
```

### 4.3 配置策略（混合式，来自实测建议）

| 配置类型 | 位置 | 修改方式 | 例子 |
|---|---|---|---|
| **启动期配置**（改了要重启） | `sgw.config.ts`（类型化，`defineConfig`，**可选**） | 编辑文件 + 重启 | `listen.port`、`dataDir`、`logging.level`、`edge.*`、`upstream.caFile/strictSsl` |
| **运行期设置**（热改 + 持久化） | SQLite `settings` 表（JSON） | 仪表盘设置页 | Detail/Body 开关、保留策略、价格表、**上游地址 / 路径拼接 / 探针模型 / 上游鉴权** |

**优先级：`settings` 表 > `sgw.config.ts` > 内置默认值。**

**两类"固定信息"必须被手动输入，不得写死在仓库里**：

1. **上游地址 `baseUrl`** —— 它因部署环境而异（公司中继、自建 one-api、本机 echo 服务器），
   而且随时会变。写进 `sgw.config.ts` 意味着"改一个地址要停机重启"，也意味着**每个 clone
   的人都继承了别人的内网域名**。因此仓库里的默认值是**空字符串**，由使用者在设置页填写
   （写进 `settings` 表 → 重启后仍在）。
2. **上游鉴权 `replaceAuth` / `probeAuth`** —— 明文密钥绝不进版本库；只落本机 `data/sgw.db`，
   且**永不回传给前端**（设置页只显示"是否已设置"）。

**实现纪律**（否则"热改"会变成"看起来热改"）：

- 代理热路径**逐请求**读取这些值（`forwardUpstream` 从 `cfg.upstream` 读 `pathMode` /
  `stripPrefix` / `replaceAuth`，地址由 `state.upstreamBaseUrl` 提供），绝不在启动时缓存成常量。
- **未配置上游地址是合法状态**：网关照常启动，`/v1/**` 返回一条可读的 502（而不是崩掉或挂起）；
  探针自动跳过并说明原因。
- **自环检测必须在热改路径上也跑一遍**（`validateBaseUrl` → `selfLoopMessage`），
  否则把地址改成 `http://127.0.0.1:<自己的端口>/v1` 会把网关打成无限自转发。

**铁律**：**Web 端永不回写 `sgw.config.ts`**。这样配置文件可以被 git 管理、被人类阅读、被任意工具解析，而运行时状态不会被 UI 意外破坏。

---

## 5. 前端选型

### 5.1 框架对比

| 方案 | 版本 | 应用 JS 体积（gz 估算） | 图表生态 | 结论 |
|---|---|---|---|---|
| **React 19 + Vite + Tailwind v4** | 19.3.0 / 8.3.4 / 4.3.3 | ~50KB React 基线 + ~40KB Tailwind 产物 | **最强**（Recharts/visx/ECharts wrapper 齐备） | **★ 采用** |
| Svelte 5 (runes) + SvelteKit 3 | 5.57.2 / 3.0.1 | **~32.5KB**（同类应用） | 较弱，React 专用 wrapper 与 shadcn 式组件集不存在 | 备选（体积优 33%，但要手写更多 UI） |
| Vue 3.5 + Vite | 3.5.44 | 介于两者之间 | 良好 | ✗ 否决：对本项目无相对优势 |

**决策理由**：本项目要交付 **7 个页面 + 表格 + 抽屉 + 图表 + 双主题**。开发速度与图表生态的价值远大于 18KB 的体积差——毕竟这是**本机 localhost 应用，体积不进入关键路径**。

> ⚠️ React 19 移除了函数组件的 `defaultProps`。选用组件库前需确认无此依赖（**Recharts 3.x 与 Radix 已确认干净**）。

### 5.2 图表选型（双库并用）

| 图 | 库 | 理由 |
|---|---|---|
| 概览趋势面积图、模型占比、Token 构成、迷你直方图 | **Recharts 3.10.1** | SVG → tooltip/legend/键盘可达性开箱即用；点数在 1k 量级 |
| 请求明细页的按分钟原始序列、延迟热力图（>5 万点） | **uPlot 1.6.x** | ~13KB canvas，为密集时序而生；SVG 在 >1 万点会崩 |
| ECharts 6.1 | ✗ 否决 | 更强，但 tree-shaking 需要严格只用 `echarts/core`，且 React wrapper 已 9 个月未更新 |
| visx | ✗ 否决 | 需自建坐标轴/tooltip/legend，对"token 仪表盘"而言代码量过大 |
| Chart.js | ✗ 否决 | 无优势，wrapper 已 1 年未更新 |
| Observable Plot | ✗ 否决 | 200KB+ d3 栈，命令式 API 与 React 相性差 |

> **uPlot 的风险已登记**：实质单人维护、最后发布约 19 个月前。缓解：它只用于**一个**页面，且封装在 `<DenseChart>` 组件后；若失效可退回 Recharts（接受性能降级）或换 ECharts core。

### 5.3 数据获取与状态

- **TanStack Query 5.104.x**：缓存、去重、`refetchInterval`、devtools，以及关键能力 `queryClient.setQueryData()` 把 SSE 推送**合并进缓存**（而不是让两种数据源打架）
- **SSE 是推送通道**（不是 WebSocket）：见 §6
- 设置页表单：`react-hook-form` + zod resolver（可选，若不想引则用受控组件 + zod 手校验）

### 5.4 主题实现

Tailwind v4 是 **Vite 插件 + CSS-first 配置**（`@import "tailwindcss"` + `@theme`，**不需要** `tailwind.config.js` 与 PostCSS 链）。因此 [`04-ui-ux-style-guide.md`](./04-ui-ux-style-guide.md) §4 的令牌直接写进 `tokens.css`，用 `@theme` 把 `--sgw-*` 映射为 Tailwind 语义色，组件内 `bg-surface` / `text-secondary` 即可，**不出现硬编码颜色**。

---

## 6. 实时通道与本地安全

### 6.1 SSE，不用 WebSocket（决定性理由）

| 维度 | SSE | WebSocket |
|---|---|---|
| 浏览器跨源保护 | **受 CORS 约束**，恶意页面**读不到**事件流 | **不受 CORS 约束**，只要能握手就能读 |
| 认证/校验复用 | 普通同源 `GET`，复用 Host/Origin/Token 校验 | 需在 `upgrade` 事件里**手写** Origin 校验 |
| 断线重连 | `EventSource` 自动重连 + `Last-Event-ID` 补发 | 需自己实现 |
| 双向需求 | 无（本项目只需服务端→前端推送） | 有才值得 |
| `http://127.0.0.1` 是否可用 | ✅ 回环属 secure context，`EventSource`/`crypto.subtle` 均可用，**无需 TLS** | ✅ |

**结论**：单向计数推送场景下，WebSocket 是**纯负担**。同时，代理侧也**不**实现 Codex 的 `ws://…/v1/responses`（`supports_websockets` 默认 `false`，见 §7）。

### 6.2 本地驻留服务的安全加固（"localhost 不是安全边界"）

浏览器会从**任意网页**向 `127.0.0.1:8787` 发请求。攻击者页面读不到响应（CORS），但能**发起**请求；而 **DNS Rebinding** 连"读"的限制都能绕过（攻击者域名先解析到自己的 IP 加载恶意 JS，再改解析到 `127.0.0.1`，于是浏览器与服务端都看到 `Host: evil.com`）。

| 措施 | 具体做法 | 防的是什么 |
|---|---|---|
| **1. 严格回环监听** | `listen(port, '127.0.0.1')`；**禁止** `0.0.0.0` / 双栈 `::`。如确需 IPv6，另起 `[::1]` 并同样加白名单 | 局域网/其他主机访问 |
| **2. `Host` 白名单** | 每个请求（含 SSE）校验 `Host` ∈ {`127.0.0.1:8787`, `localhost:8787`, `[::1]:8787`}，否则 403 | **DNS Rebinding（核心防线）** |
| **3. `Origin` 校验** | 变更类请求若带 `Origin` 且不在白名单 → 403；**无 `Origin` 时只允许 `GET`/`HEAD`**（浏览器跨源非 GET 与表单 POST 必带 `Origin`）→ **fail closed** | 盲 CSRF（含无需 JS 的 `<form>` POST） |
| **4. 每次安装随机 Token** | 首次启动 `crypto.randomBytes(32).toString('base64url')` → 存 `data/.token`（受限 ACL）。首访 `http://127.0.0.1:8787/?token=…` 引导，SPA 存入 `localStorage` 后**立即 `history.replaceState` 从 URL 抹掉**。此后一律走 **`X-Gateway-Token` 请求头** | 其他本地进程 + 强制预检，堵死盲 CSRF |
| **5. 永不发 CORS 头** | 不设 `Access-Control-Allow-Origin`（`*` 与反射 `Origin` 都禁止）。本项目**没有任何合法的跨源消费方** | 恶意页面读取响应 |
| **6. 附加头** | `Content-Security-Policy: default-src 'self'; connect-src 'self'`、`X-Content-Type-Options: nosniff`、API 响应 `Cache-Control: no-store` | XSS / 缓存泄漏 |
| **7. `Sec-Fetch-Site`** | 对管理 API 拒绝 `cross-site`（缺失值视为未知，不硬失败） | 纵深防御 |
| **8. 密钥不出服务端** | 上游 Key 永不进入 SPA；UI 只显示掩码 + `hasCustomKey` 布尔 | DNS Rebinding 的**首要窃取目标** |

**关于 Token 的可用性取舍**：Token 对用户**零摩擦**——SPA 自动携带，用户从不输入。但它能挡住"其他本地进程直接调 API"和"跨站盲请求"两类风险。v1 **默认开启**，并提供 `security.requireToken=false` 关闭（关闭时 UI 常驻提示"未启用本地令牌"）。

> ⚠️ **作用域铁律**：`X-Gateway-Token` 与 `Host`/`Origin` 校验**只作用于 `/_sgw/**` 控制面与静态资源**。
> **`/v1/**` 代理路径绝不参与这些校验、绝不读取或要求该头** —— 因为向代理请求添加任何头都直接违反 H2。代理路径的访问控制完全依赖"只监听回环"这一层。这是 §6.2 七条措施与 H1~H10 的边界，实现时最容易写错，必须写测试用例锁定。

> **不引入** `Access-Control-Allow-Origin`、不做登录页、不做多用户。

### 6.3 认证头的两种模式

```ts
function authHeader(inbound?: string): Record<string, string> {
  if (cfg.upstreamApiKey) return { authorization: `Bearer ${cfg.upstreamApiKey}` }; // 显式开关，默认关
  return inbound ? { authorization: inbound } : {};                                  // 原样透传（H5，默认）
}
// 兼容 Azure 风格中继：若入站是 "Bearer xxx" 且上游需要 x-api-key，由配置决定是否同时映射
```

---

## 7. 与 Codex 客户端相关的选型约束（来自源码调研）

这些不是"选型"而是**必须遵守的对接事实**，直接影响实现，列在此处便于集中查阅。

| 事实 | 对实现的要求 |
|---|---|
| Codex 只会请求 **`POST /v1/responses`** 与 **`GET /v1/models?client_version=<ver>`**；**不存在** `GET /v1/responses/{id}` | 代理必须是 catch-all 转发（不枚举路径），且 `/v1/models` 的 query 必须原样保留 |
| `base_url` 是**纯字符串拼接**：`{base 去尾斜杠}/{path 去首斜杠}` | 用 `joinBase()` 实现，**不要**用 `new URL(path, base).href`（会吃掉 base 的 `/v1`） |
| 纯 `http://` **被接受**（无 scheme 白名单） | 假设 A1 成立，M0-7 仍需实测确认 |
| ⚠️ **必须用 `127.0.0.1`，不要用 `localhost`** | Codex 存在 localhost 解析优先 IPv6 的已知缺陷（#21773 / #19525）。`scripts/point-codex.ts` 必须硬写 `127.0.0.1` |
| `wire_api = "chat"` 在 Codex ≥ `v0.95.0` 已**移除（硬报错）** | Codex **永不**调用 `/v1/chat/completions`。该路径仅在"其他客户端"场景下作为附带的原样转发（P2），**不投入观测适配** |
| WebSocket 传输由 `supports_websockets` 控制，**默认 `false`** | v1 只做 HTTP。切换脚本**不要**打开该开关。若用户开着它，Codex 会走 `ws://…/v1/responses` → 需在 README 明确说明"本网关不支持 WS，请保持默认" |
| usage **只在** `response.completed` / `response.incomplete` 里 | 观测器不必累积 delta；扫到终止事件取值即可 |
| ⚠️ `usage` 若存在但**缺 `total_tokens`/`input_tokens`/`output_tokens`**，Codex **整轮硬失败** | 启动/首轮自检必须断言这些字段存在 → 见 `02` §5.6；**这是本网关最有价值的附加功能**（提前发现中继配置问题） |
| 响应头 `x-codex-turn-state` 会被 Codex **回放**，用于粘性路由 | 必须**双向**原样保留（H2/H3 已覆盖，但要写进测试用例） |
| Codex 读 `x-request-id` 作为唯一关联 ID；**不读** `openai-processing-ms` | 观测表同时存 `upstream_request_id`（来自响应头）与本地 `id` |
| `body: store=false`；续写用 **body 内 `previous_response_id`**（仅 WS 路径） | 网关**不得**改动 body（H1）；也不会被要求处理 `/responses/{id}` |
| Codex 侧 `stream_idle_timeout_ms` 默认 **300 000ms**，`stream_max_retries` 默认 5 | 网关若"静默挂住"，Codex 会进入重连循环而不是干净报错 → 网关必须先于 300s 给出明确错误（见 `02` §6.3） |

---

## 8. 明确否决清单（一句话汇总）

| 技术 | 否决理由 |
|---|---|
| 原生 `fetch` 做代理 | 对逐跳头**抛错**且**注入** `accept*`/`user-agent` → 直接违反 H2/H3 |
| `undici` + 默认超时 | `bodyTimeout=300s` 会掐断长流；须显式置 0（可接受，但不如 `node:http` 默认安全） |
| Fastify 代理插件 | CRITICAL CVE-2026-33805（`Connection` 头滥用剥离代理注入头） |
| `http-proxy` / `fastify-http-proxy` | 6 年未维护 / npm 已 deprecated |
| Hono / Elysia | WHATWG `Headers` 丢失原始大小写与重复头 |
| Turborepo | 3 个包无缓存问题可解 |
| 服务端打包（tsup/tsdown） | 无收益；原生模块需 `external`；未打包的堆栈更可读 |
| `better-sqlite3`（默认） | 引入 Windows 原生编译风险；唯一优势（percentile 扩展）已被直方图方案化解 |
| DuckDB / PGlite | 36MB / 24MB 换 10ms 的查询 → 不成比例 |
| ECharts / visx / Chart.js / Observable Plot | 见 §5.2 |
| Svelte（v1 默认） | 体积优但图表/组件生态弱，开发成本高于收益 |
| WebSocket（前端推送） | 绕过 CORS，需手写 Origin 校验，单向场景无收益 |
| 任何响应压缩中间件 | 缓冲破坏流式 + 改变响应字节 |
| `tiktoken` 作为必装依赖 | 估算器可降级；设为 `optionalDependencies`，加载失败即用启发式 |
| Babel / webpack / PostCSS 链 | Vite 8 + Tailwind v4 插件已覆盖 |

---

## 9. 版本与依赖治理

### 9.1 版本基线建议

| 项 | 决策 | 备注 |
|---|---|---|
| Node | **建议升级到 24 LTS**（24.21.0）；22.23.3 亦可运行 | 22 已进入维护期（EOL 2027-04-30）；24 EOL 2028-04-30；`node:sqlite` 在 24 更成熟 |
| `@types/node` | 与 Node **主版本对齐**（Node 24 → `@types/node@24.x`） | 26.x 面向 Node 26 API，勿混用 |
| TypeScript | 7.0.2（原生 Go 编译器，含 `@typescript/typescript-win32-x64`，无需工具链） | 仅用作 `tsc --noEmit` 类型门禁 |
| 前端不打包服务端 | 服务端**不打包**，`tsx`/Node 原生 TS 直跑 | 启动毫秒级，堆栈可读 |
| 原生模块 | **零个**（`node:sqlite` 是内建） | 这是选型的核心收益：`pnpm i` 永不触发 node-gyp |

### 9.2 `sgw.config.ts` 基线

```ts
import { defineConfig } from './apps/server/src/config/schema.ts';

export default defineConfig({
  listen:   { host: '127.0.0.1', port: 8787 },        // host 只读，UI 不可改
  // ★ 上游地址留空即可：由使用者在仪表盘「设置 → 上游」手动填写
  //   （热改、即时生效、存 SQLite settings 表；优先级高于本文件）。
  upstream: { baseUrl: '', pathMode: 'auto' },
  dataDir:  './data',
  logLevel: 'info',
  security: { requireToken: true, tokenFile: './data/.token' },
  estimator:{ prefer: 'tiktoken', charsPerToken: 3.6 },
});
// 以下走 SQLite settings 表（仪表盘可热改）：
//   logging.detailEnabled / logging.bodyEnabled / retention.* / model_price / upstream.baseUrl 覆盖值
```

### 9.3 依赖升级纪律（Agent 必须遵守）

1. 新增**运行时**依赖需在本文件登记条目 + 否决理由；否则不予合入
2. 前端依赖不得出现在 `apps/server`；服务端依赖不得出现在 `apps/web`
3. 任何 `fastify*`、`http-proxy`、`undici` 的引入都属于**架构级变更**，需重新评估 §2 的三条证据
4. 锁定 `pnpm-lock.yaml`；升级 Node 主版本时重跑透传回归（H1~H5）
