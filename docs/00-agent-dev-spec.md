# SGW Agent 开发定义文档（Agent Development Spec）

> **文档定位**：本文件是「交给 AI 编码 Agent（或人类开发者）执行实现」时的**唯一契约文档**。它不重复需求背景与设计理由，只规定：做什么、边界在哪、怎么算做完了、不允许做什么。
>
> **使用方式**：把本文件 + `01~06` 文档一起投喂给编码 Agent；实现过程中任何与本文冲突的设计，以本文为准。
>
> - 项目代号：**SGW**（Self Gateway）
> - 文档版本：v1.1（**M1 已实现并通过回归**，含实现期修正）
> - 目标运行时：**Windows 11 + Node.js 22 LTS（以 22.23.3 为准）** + pnpm 9
> - **运行时依赖：M1 = 0 个；M2+ 计划 3 个**（`zod` / `pino` / `eventsource-parser`）
> - **无构建步骤**：Node 22 原生执行 `.ts`（`node apps/server/src/index.ts`）；`tsc --noEmit` 仅作类型门禁

> ⚠️ **Node 22 原生 TS 的语言限制（写错会直接崩在启动期）**：只支持**可擦除语法**。
> **禁止 `enum` / `namespace` / 构造函数参数属性 / 装饰器元数据**。
> 所有"枚举"一律用**字符串字面量联合 + `as const` 数组**（范例见 `packages/shared/src/errors.ts` 的 `ERROR_CLASSES`）。
> 相对导入必须写**真实扩展名 `.ts`**（`import { x } from './y.ts'`）；写成 `.js` 会 `ERR_MODULE_NOT_FOUND`。
> `tsconfig.base.json` 已开启 `erasableSyntaxOnly`，编译器会替你拦住这些写法。

---

## 1. 一句话定义

SGW 是一个**本地回环的透明观测型 LLM 反向代理**：Codex 的请求原样穿过它到达 sub2api 中继，它只在旁边"记账"，并把账本用一个现代 Web 仪表盘呈现出来。

---

## 2. 不可协商的硬约束（Hard Invariants）

以下 10 条是**验收红线**。任何实现方案若与之冲突，方案作废，不进入讨论。

| 编号 | 约束 | 判定方法 |
|---|---|---|
| **H1** | **请求体字节级不改** | 用同一份 `curl --data-binary @req.json` 直连上游 vs 经过网关，抓包比对 body 的 SHA-256 完全一致 |
| **H2** | **请求头"零白名单"透传** | 除 RFC 9110 §7.6.1 规定的逐跳头外，所有收到请求头（含未知自定义头）原样转发；不得新增、删除、改写任何业务头 |
| **H3** | **响应头/响应体字节级不改** | 客户端收到的字节流与上游返回的一致（含 `Content-Encoding` 压缩字节、原样 `x-request-id`、原样 `x-codex-turn-state`） |
| **H4** | **路径不改写** | 仅把 `base_url` 的 origin+前缀替换为上游 origin+前缀，其余 path 与 query 原样保留（含尾部斜杠语义） |
| **H5** | **鉴权头不改** | 默认不注入、不替换 `Authorization`。上游密钥替换是**显式开关**，默认关闭 |
| **H6** | **零同步阻塞** | 记账逻辑必须在响应路径之外完成；观测分支溢出只能"丢观测"，**绝不允许**因此对主链路产生背压（backpressure）或延迟 |
| **H7** | **首字节延迟增量 < 5ms（p95）** | 压测 / 实测对比：直连 vs 经网关的 TTFB p95 差值 |
| **H8** | **数据不出本机** | 无任何外发遥测/分析/崩溃上报；仅访问上游 + 本地回环监听 |
| **H9** | **默认不落盘内容** | 默认只存**元数据与 token 计数**；prompt / 响应正文落盘必须靠显式开关，且默认关闭 |
| **H10** | **单端口单进程** | 一条命令启动，API + 仪表盘 + 代理同端口；无外部数据库、无 Docker、无 Redis、**无原生模块** |

> **H1~H5 的解释边界**：网关**可以**在内存中读取、解析、缓存请求/响应内容用于记账；**不可以**让这些解析结果影响转发出去的字节。两者的分界线是：**上游与客户端之间流动的字节必须与无网关时完全一致**。
>
> **H2/H3 的"允许差异"穷举**（除此之外任何头差异都算违规）：
> - **请求方向**：删除逐跳头集合（RFC 9110 §7.6.1，含 `Connection` 中列出的每一个头）、`Host`、`Content-Length`——这三类是"必须由发起方按目标重算"的框架头，不属于业务头
> - **响应方向**：删除逐跳头集合；`Content-Length`/`Transfer-Encoding` 由服务端按实际分帧重算
> - **边界澄清**：网关**不**强制把 `Accept-Encoding` 改写为 `identity`（那属于修改请求语义）；**不**新增任何响应头（包括 `X-Accel-Buffering`）；**不**在 SSE 流里注入心跳注释帧。SSE 保活是 `edge.sseKeepAliveMs` 开关，**默认 0 = 关闭**

---

## 3. 术语表（实现时统一命名）

| 术语 | 含义 | 代码标识 |
|---|---|---|
| **Upstream** | 真实上游（你所在环境的中继，如 sub2api/one-api），地址**由使用者手动填写**，不写死在仓库里 `https://relay.example.com/v1` | `upstream.baseUrl` / settings 表 `upstream.baseUrl` |
| **Edge** | 网关对 Codex 暴露的监听地址 `http://127.0.0.1:8787/v1` | `listen.host/port` |
| **Request Event** | 一次「客户端 → 上游」的 HTTP 交换记录（一行摘要） | `RequestEvent` |
| **Usage** | 一次交换消耗的 token 明细（含来源标记） | `UsageRecord` |
| **UsageSource** | usage 数据来源：`upstream` 精确 / `estimated` 估算 | `'upstream' \| 'estimated' \| 'none'` |
| **Session** | 归组维度（Codex 会话 / 线程），用于"这个任务花了多少" | `Session` |
| **Detail Mode** | 请求明细日志总开关 | `logging.detailEnabled` |
| **Body Mode** | 是否把 prompt/响应正文落盘（Detail Mode 的子集） | `logging.bodyEnabled` |
| **Observation Tee** | 单向观察分叉：主链路字节不变，旁路复制一份给记账 | `observeTee()` |
| **Control Plane** | 仪表盘用的本地管理 API，命名空间 `/_sgw/api/*` | `/_sgw/**` |

---

## 4. 模块划分与职责边界（禁止越界）

```
apps/server/src/
├─ index.ts            # 组装：读配置 → 建 DB → 挂路由 → 监听。禁止写业务逻辑
├─ config/             # 配置加载 + 校验 + 热重载（zod schema 是唯一真相源）
├─ edge/               # 对客户端：监听、请求解析、CORS/Origin 校验、SSE 回写
├─ transport/          # 对上游：node:http(s) 请求构造、CA/超时、abort/宽限期排空
├─ observe/            # 唯一允许读 body/SSE 的地方。禁止 import db
├─ pipeline/           # tee 装配 + 事件下发（把 observe 产物交给 recorder）
├─ recorder/           # 唯一允许写 DB 的地方（批量 + 事务）
├─ analytics/          # 只读聚合查询（禁止写库）
├─ control/            # /_sgw/api/* 路由 + 实时推送（SSE）
├─ db/                 # schema、迁移、SQL 语句常量
└─ shared/             # 类型、常量、错误码（与 apps/web 共享）
```

**越界检查（Agent 自检清单）**：

- `observe/**` 里出现 `import.*db` → **违规**
- `analytics/**` 里出现 `INSERT|UPDATE|DELETE` → **违规**
- `transport/**` 里出现对 `req` 的修改（除 header 拷贝） → **违规**
- `edge/**` 里出现 `await recorder.*`（同步等待落库）→ **违规**
- 任何地方出现 `console.log` 打印完整 body/`Authorization` → **违规**

---

## 5. 目录与包结构（冻结）

```
self-gateway/
├─ package.json                # pnpm workspaces 根
├─ pnpm-workspace.yaml
├─ tsconfig.base.json
├─ apps/
│  ├─ server/                  # node:http + node:http(s) client + node:sqlite（见 §4）
│  └─ web/                     # Vite + React 19 + Tailwind v4 + shadcn/ui
├─ packages/
│  ├─ shared/                  # 类型契约、常量、计费表类型（server/web 共用）
│  └─ tokenizer/               # 估算器封装（tiktoken 懒加载 + 启发式兜底）
├─ scripts/
│  ├─ point-codex.ts           # 一键把 Codex 指向网关（备份 + 改 config.toml）
│  └─ capture-probe.ts         # 首帧探针：验证上游行为、SSE 结构、是否带 usage
└─ data/                       # 运行时生成，.gitignore
   ├─ sgw.db                   # SQLite 主库
   └─ bodies/                  # 可选正文落盘（按日分目录）
```

---

## 6. 关键接口契约（TypeScript，实现必须遵守签名语义）

```ts
// packages/shared/src/types.ts

export type UsageSource = 'upstream' | 'estimated' | 'none';

export interface UsageRecord {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  cachedInputTokens: number;      // input_tokens_details.cached_tokens
  cacheWriteTokens: number;       // input_tokens_details.cache_write_tokens
  reasoningTokens: number;        // output_tokens_details.reasoning_tokens
  source: UsageSource;            // upstream 优先；无则 estimated
  estimator?: 'tiktoken' | 'heuristic';
}

export interface TimingRecord {
  enqueuedAt: number;             // 收到请求头
  upstreamConnectAt?: number;     // TCP/TLS 建连完成
  upstreamHeadersAt?: number;     // 收到上游响应头（≈ TTFB）
  firstTokenAt?: number;          // 首个 response.output_text.delta
  completedAt: number;            // 最后一字节 / 结束
}

export interface RequestEvent {
  id: string;                     // ulid，本地生成
  startedAt: number;              // epoch ms
  endpoint: 'responses' | 'models' | 'chat.completions' | 'other';
  method: string;
  path: string;                   // 原样
  query: string | null;
  status: number | null;
  errorClass: string | null;      // 网络错误分类，见 §7
  streamed: boolean;
  upstreamRequestId: string | null;   // 原样取自响应头 x-request-id
  responseId: string | null;          // response.completed.response.id
  model: string | null;
  // ── Codex 身份头（原样取自请求头，见 03 §7）──
  codexSessionId: string | null;      // session-id
  codexThreadId: string | null;       // thread-id
  codexClientRequestId: string | null;// x-client-request-id
  codexOriginator: string | null;     // originator（codex_cli_rs / codex_vscode / …）
  codexSubagent: string | null;       // x-openai-subagent（review/compact/…）
  timing: TimingRecord;
  usage: UsageRecord;
  bytesIn: number;
  bytesOut: number;
  truncated: { request: boolean; response: boolean };
  bodyRef: string | null;         // 正文落盘时的相对路径，未开启为 null
  keyFingerprint: string | null;  // sha256(Authorization).slice(0,8)，用于区分 Key
}

// packages/shared/src/events.ts
export type GatewayEvent =
  | { type: 'request.start';     data: Pick<RequestEvent,'id'|'startedAt'|'path'|'model'> }
  | { type: 'request.firstToken';data: { id: string; at: number } }
  | { type: 'request.end';       data: RequestEvent }
  | { type: 'stats.tick';        data: StatsTick };   // 1s 节流的 KPI 增量
```

```ts
// apps/server/src/observe/observer.ts
/** SSE/JSON 观察器：只读、可丢帧、绝不抛异常到主链路 */
export interface Observer {
  onResponseChunk(chunk: Buffer, isFirst: boolean): void;   // 上游**原始**字节（压缩态）
  finish(): ObserverResult;                                  // 幂等；同步解压 + 解析
  readonly truncated: boolean;
}
export function createObserver(opts: {
  contentType: () => string | null;          // ★ 函数：响应头可能还没到（失败请求没有响应体）
  contentEncodingRaw: () => string | null;   //   同上，惰性读取
  maxBytes: number;                          // 观测缓冲上限，默认 512KB
  onDeltaText?: (text: string) => void;      // 估算器用：只累计 token，不保留文本
}): Observer;

// apps/server/src/observe/pipeline.ts
/**
 * ★ 请求体副本归 pipeline 管（不归 observer）：
 *   只缓冲、不解码；`finish()` 时按**请求头**的 Content-Encoding 懒解码一次，
 *   供估算 / 模型名兜底 / Body Mode 落盘三处复用。
 *   缓冲区上限 maxRequestBytes，identity 编码下解码是零拷贝直通。
 */
export function createPipeline(opts: {
  contentType: () => string | null;
  contentEncoding: () => string | null;
  requestEncoding: ContentEncoding;          // 请求头，转发前已知
  maxBytes: number;
  collectRequest: boolean;                   // 上游没给 usage 时才用得上
  captureRequest: boolean;                   // Body Mode
  maxRequestBytes: number;
  graceDrainMs: number;
}): Pipeline;
```

```ts
// apps/server/src/transport/upstream.ts
/** 唯一与上游通信的出入口。**不做任何 body 变换，不自动解压**（node:http 不会自动解压）。 */
export interface UpstreamResponse {
  status: number;
  rawHeaders: string[];                    // 逐字拷贝，含原始大小写与重复头
  stream: Readable;                        // 上游原始字节流（保持压缩态）
  requestId: string | null;                // 响应头 x-request-id 原样
}
export function forwardUpstream(args: {
  req: http.IncomingMessage;               // 直接 pipe，不读 body
  cfg: UpstreamConfig;
  signal: AbortSignal;
  onResponse(res: UpstreamResponse): void; // 头到达时回调 → 立即回写客户端
}): { upstreamReq: http.ClientRequest };
```

```ts
// apps/server/src/observe/tee.ts
/** 单向观察分叉。主链路 pipe 到客户端；副本喂给 onCopy。溢出=丢弃观测，绝不阻塞主链路。 */
export function teeForObservation(
  src: Readable,                    // 上游响应流
  dst: Writable,                    // 客户端 socket / ServerResponse
  onCopy: (chunk: Buffer) => void,  // 只读副本；内部异常必须被吞掉
  maxBytes: number,                 // 观测缓冲硬上限
): { droppedBytes: () => number; truncated: () => boolean };
```

---

## 7. 错误分类与降级矩阵（必须实现）

| 场景 | 行为 | `errorClass` |
|---|---|---|
| 上游 4xx/5xx | **原样透传**状态码与响应体，不重试、不改写 | `upstream_4xx` / `upstream_5xx` |
| 上游连接超时 | 返回 504，记事件 | `upstream_connect_timeout` |
| DNS/TLS 失败 | 返回 502，记事件，日志提示 CA 配置 | `upstream_tls_error` |
| **客户端中断（Codex 取消）** | **不立即 abort**：先"宽限期排空"（默认 8s，最长到终止事件），拿到 `response.completed` 的 usage 后**再** abort 上游。标记 cancelled，但**保留 usage** | `client_aborted` |
| 上游流中断 | 原样结束 SSE，**不补 data、不发 [DONE]** | `upstream_stream_truncated` |
| usage 缺失 | 走估算器，标记 `source='estimated'` | — |
| ⚠️ usage 存在但缺 `total_tokens`/`input_tokens`/`output_tokens` | **透传不改**（这是上游问题），但记 `errorClass='usage_incomplete'` 并在 UI 顶部告警"该中继的 usage 结构会导致 Codex 本轮失败" | `usage_incomplete` |
| 观测缓冲溢出 | 截断正文，仅保留元数据，标记 `truncated.*` | — |
| 落库失败 | 写 stderr 警告 + 内存队列重试 3 次后丢弃 | — |
| 网关静默过久（接近 Codex 的 300s idle 超时） | 由 `edge.sseKeepAliveMs` 控制，**默认 0（关闭，不动字节流）**；用户可开启以注入 `:\n\n` 注释帧 | — |

**绝对禁止**：网关自身生成任何 SSE 事件、任何 `[DONE]`、任何伪造的 `error` 对象。这是 H3 的直接推论（开启保活时的 `:` 注释帧是唯一例外，且默认关闭）。

> **为什么"客户端中断"要排空**：usage **只存在于** `response.completed` 终止事件里。若客户端一断就 abort 上游，就**永远拿不到 usage**，这一轮就记不了账。sub2api 自己就是这么做的（`passthrough_relay.go`：*"客户端断开后尽力继续读取上游短窗口，捕获延迟 usage/terminal 事件用于计费"*）。这是本网关最重要的实现细节之一。

---

## 8. 实现顺序（Agent 必须按此顺序提交，每步可独立验证）

> **进度：M0（探针）与 M1（纯透传骨架）已完成，59/59 回归通过。以下 1~3 已交付，4 起为 M2。**
> 已在的模块**不要重写**，在其上扩展；动手前先跑一次
> `node scripts/passthrough-regression.mjs` 确认基线是绿的。

1. ~~**骨架**~~ ✅：pnpm workspace + tsconfig + `node:http` 启动（**含 `server.requestTimeout = 0`**）+ 配置加载。验收：`GET /_sgw/api/health` 返回 200。
2. ~~**纯透传**~~ ✅：Edge（`rawHeaders` 逐跳头处理 + `writeHead`/`flushHeaders` + `pipe`）+ transport（`node:http(s)` 客户端 + keepAlive Agent），**不含任何 observe 代码**。验收：H1~H6 全部通过（59 条断言）。
3. ~~**探针**~~ ✅：`scripts/probe-upstream.mjs`（直连身份矩阵 + SSE 解析 + usage 契约校验）与 `scripts/echo-upstream.mjs`（回声上游，捕获真实 Codex 请求）。产物归档在 `notes/`。
4. **观测器**（M2）：tee + SSE 解析 + usage 提取 + 计时。验收：主链路字节仍不变（重跑回归）。
5. **存储**（M2）：`node:sqlite` schema + recorder 批量写 + 保留策略。
6. **统计 API**（M3）：analytics 聚合 + `/_sgw/api/*`。
7. **仪表盘**（M3）：概览 → 请求表 → 详情抽屉 → 设置页。
8. **开关链路**（M3）：Detail/Body Mode 双开关 + **宽限期排空（grace drain）** 端到端生效。
9. **收尾**（M4）：README、冒烟脚本、类型门禁纳入 CI。

> 每一步结束后**必须**重跑 §9 的 H1~H6 回归，不得因为后续功能破坏透传。
>
> **M2 开工前的锚点提示**：`apps/server/src/edge/proxy.ts` 中 `res.on('close')` 附近
> 与 `GraceDrain` 相关的注释，就是 M2-1b「宽限期排空」的插入位置（ADR-15）。

---

## 9. 验收门槛（Definition of Done）

### 9.1 硬约束回归（每次提交必跑）

**已实现为可执行脚本**：`node scripts/passthrough-regression.mjs` → 当前 **59/59 通过**。

- [x] `H1` 请求体 SHA-256 一致（含中文、emoji、大整数、转义字符的 body）
- [x] `H2` 无丢失头（除逐跳头）、**无新增头**、未知自定义头保留
- [x] `H3` 响应体逐字节一致；非逐跳响应头逐字一致；`x-request-id` / `x-codex-turn-state` 原样
- [x] `H4` path 与 query 原样；**上游收到的是 origin-form 请求行**（ADR-19）
- [x] `H5` 未配置 key 替换时 `Authorization` 原样
- [x] `H6` 逐跳头剥离正确：`Connection: X-Foo` 时 `X-Foo` 也被剥离（RFC 9110 §7.6.1 动态规则）
- [x] 附加：gzip 不解压、SSE 逐片到达不被缓冲、上游 4xx 原样透传不包装、
      网关自身错误带 `x-sgw-error`、`/v1/**` 不校验 Host、WS 升级返回 501

### 9.2 流式不破坏验证（"证据法"，三条缺一不可）
1. **语义等价**：同一 prompt 直连与经网关各跑 N=20 次，输出全文与 `usage` 字段一致（模型非确定性下比对 token 计数与结构，不比对逐字文本）
2. **时序不恶化**：TTFB p95 增量 < 5ms；无"首字延迟突发"
3. **字节等价**：开启 `Content-Encoding: gzip` 时，网关透传字节与上游字节 SHA-256 一致
4. **长流存活**：上游静默 > 5 分钟后恢复发送时，连接**未**被网关或 Node 掐断（验证 `requestTimeout=0`）

### 9.3 计数正确性
- [ ] 上游带 usage 时，DB 值与响应里的 usage 逐字段相等（含 `cached_tokens`、`cache_write_tokens`、`reasoning_tokens`）
- [ ] 上游不带 usage 时，`source='estimated'` 且 UI 显示"估算"角标
- [ ] 并发 50 路流式请求下无丢失、无串号（requestId 与 usage 严格配对）
- [ ] **客户端中断后仍记到 usage**（宽限期排空生效）

### 9.4 开关有效性
- [ ] Detail Mode 关闭：DB 中该时间段无请求明细行，但 `rollup_*` 仍在增长
- [ ] Body Mode 关闭：`data/bodies/` 目录为空；打开后落盘内容可被清理任务删除

---

## 10. 明确不做（Out of Scope）

- ❌ 不做多用户、账号体系、团队协作
- ❌ 不做协议转换（Responses ↔ chat/completions 互转）
- ❌ 不做 prompt 改写、内容审核、注入检测、缓存/去重
- ❌ 不做限流、配额、成本硬熔断（v1 只做**观测**，不做**管控**）
- ❌ 不做上游负载均衡 / 多 Key 轮询 / 故障转移
- ❌ 不做 **WebSocket 代理**（Codex 的 `supports_websockets` 默认 `false`；若用户开启，README 明确不支持，须保持默认）
- ❌ 不做云端同步 / 数据导出到外部服务
- ❌ 不做移动端适配（最小支持宽度 1024px）

---

## 11. Agent 协作纪律

1. **先读后写**：动任何模块前先读 `02-architecture-design.md` 对应章节与 §4 边界。
2. **小步提交**：一次提交只推进 §8 中的一个编号步骤，提交信息格式 `sgw(<module>): <what>`。
3. **不猜测协议**：遇到不确定的上游行为（是否返回 usage、是否压缩、事件名），先跑 `capture-probe.ts`，把**实测输出**写进提交说明，禁止凭印象编码。
4. **不偷偷加依赖**：新增运行时依赖必须在本文件或 `03-tech-stack-selection.md` 里有对应选型条目。
5. **不确定就问**：涉及 H1~H10 边界模糊的实现方式，停下来提方案对比，不要自行放宽约束。
6. **敏感值纪律**：任何日志、错误信息、测试夹具中不得出现完整 `Authorization`；统一用 `keyFingerprint`。
