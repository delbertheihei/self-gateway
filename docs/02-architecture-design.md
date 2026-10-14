# SGW 架构设计说明书

> 项目：**SGW / Self Gateway**（本地 AI 用量观测网关）
> 版本：v1.0 · 设计冻结
> 前置阅读：[`00-agent-dev-spec.md`](./00-agent-dev-spec.md)（硬约束） · [`01-requirements-and-scope.md`](./01-requirements-and-scope.md)（需求）
> 关联：[`03-tech-stack-selection.md`](./03-tech-stack-selection.md) · [`05-data-model-and-metrics.md`](./05-data-model-and-metrics.md)

---

## 1. 架构目标与核心矛盾

### 1.1 核心矛盾
> **要观测内容，就必须读取内容；要零侵入，就不能碰内容。**

这两者看似冲突。本架构的全部巧妙之处，在于把"读取"与"转发"在**同一条字节流上做单向分叉（tee）**：主链路只做字节搬运，旁路副本用于解析记账。旁路可以慢、可以丢、可以失败，但主链路必须快、必须完整、必须成功。

### 1.2 架构原则

| 原则 | 落地手段 |
|---|---|
| **数据面/观测面物理分离** | `edge` + `transport` 组成数据面，**不 import** 任何 `observe`/`recorder`；观测通过事件总线异步接入 |
| **单向数据流** | 客户端 → 上游 → 客户端；观测数据只从流上"复制"出去，从不"回写"进去 |
| **旁路可丢弃** | 观测缓冲有硬上限（头 1/4 + 尾 3/4），中间段溢出即标记截断；**绝不 backpressure 主链路** |
| **观测面故障隔离** | 观测/落库异常必须被 catch 并降级，主链路无感知 |
| **唯一真相源** | 配置 = zod schema；类型 = `packages/shared`；SQL = `db/sql.ts` 常量 |
| **零依赖外部服务** | SQLite + 内存 + 文件系统，无 Redis / 无 MQ / 无 Docker |

---

## 2. 系统全景

```
┌──────────────────────────────────────────────────────────────────────────────────┐
│                              本机（127.0.0.1）                                     │
│                                                                                  │
│  ┌────────────────────┐                                                          │
│  │  Codex (Desktop)   │  config.toml:                                            │
│  │  wire_api=responses│  base_url = "http://127.0.0.1:8787/v1"                    │
│  │  Authorization: sk-│  (experimental_bearer_token 保持不变)                    │
│  └─────────┬──────────┘                                                          │
│            │  HTTPS?? 否 → 纯 HTTP 回环                                          │
│            │  POST /v1/responses   (SSE 流式)                                     │
│            ▼                                                                     │
│  ┌──────────────────────────────────────────────────────────────────────────┐   │
│  │  SGW 进程 (Node 22/24 · node:http · node:sqlite)          :8787          │   │
│  │                                                                            │   │
│  │  ┌─ 数据面 Data Plane（热路径，零观测依赖） ──────────────────────────┐   │   │
│  │  │  ①Edge 监听/校验  →  ②Transport 组装上游请求  →  ③流式回写客户端   │   │   │
│  │  │     ↑ 逐跳头剥离        ↑ 原样 body stream        ↑ 原样响应头/体   │   │   │
│  │  └───────┬────────────────────────┬─────────────────────────┬─────────┘   │   │
│  │          │ tee(req)               │ tee(res)                │ 计时打点    │   │
│  │          ▼                        ▼                         ▼            │   │
│  │  ┌─ 观测面 Observation Plane（异步，可丢弃） ─────────────────────────┐   │   │
│  │  │  ④Observer: SSE 行解析 / JSON 解析 / gzip 解压 / usage 提取        │   │   │
│  │  │  ⑤UsageResolver: upstream → 估算兜底                               │   │   │
│  │  │  ⑥Pipeline: 组装 RequestEvent + Session 归组                       │   │   │
│  │  └───────┬───────────────────────────────────────────────────────────┘   │   │
│  │          ▼                                                                │   │
│  │  ┌─ 存储面 Storage ──────────────────────────────────────────────────┐   │   │
│  │  │  ⑦Recorder: 200ms/64条 批量事务写 → SQLite(WAL) + 正文文件          │   │   │
│  │  └───────────────────────────────────────────────────────────────────┘   │   │
│  │                                                                            │   │
│  │  ┌─ 控制面 Control Plane (/_sgw/api/*) ──────────────────────────────┐   │   │
│  │  │  ⑧Analytics 只读聚合 ⑨Settings KV ⑩SSE 实时推送 ⑪自检/Selftest    │   │   │
│  │  └───────────────────────────────────────────────────────────────────┘   │   │
│  │                                                                            │   │
│  │  ┌─ 静态资源 ────────────────────────────────────────────────────────┐   │   │
│  │  │  ⑫ 构建后的 SPA（apps/web/dist）由同一 node:http 实例托管          │   │   │
│  │  └───────────────────────────────────────────────────────────────────┘   │   │
│  └────────────────────────────┬─────────────────────────────────────────────┘   │
│                               │ upstream: node:http(s) 客户端, keep-alive, 自定义 CA 可选 │
└───────────────────────────────┼──────────────────────────────────────────────────┘
                                ▼
                  ┌────────────────────────────────────┐
                  │  上游中继（地址由使用者手动填写）    │
                  │  https://relay.example.com/v1      │
                  │  → 真实模型后端                     │
                  └────────────────────────────────────┘
```

---

## 3. 关键设计决策记录（ADR）

| # | 决策 | 备选方案 | 选择理由 | 代价 |
|---|---|---|---|---|
| **ADR-1** | **本地反向代理**（改 base_url 指向网关） | ①客户端侧插件/SDK 拦截 ②读 Codex 本地日志统计 ③中间人代理（MITM） | ①不支持 ②Codex 日志无 token 明细且格式私有易变 ③需装根证书、侵入 TLS，风险高 | 需改一处配置；网关崩溃会阻断 Codex（可一键回滚） |
| **ADR-2** | **HTTP 回环**（`http://127.0.0.1:8787`） | ①mkcert 自签 HTTPS ②隧道域名 | 零证书摩擦；回环流量不经网卡，无窃听面 | 需验证 Codex 接受 http localhost（假设 A1）；兜底方案见 §9 |
| **ADR-3** | **tee 单向分叉观测** | ①先读全响应再转发 ②边读边缓冲完整副本 ③改请求加 `stream_options.include_usage` | ①严重破坏流式体验 ②高内存 ③违反 H1/H2 | tee 只投喂不丢弃（丢弃由观测器按头/尾决定，见 ADR-25）；需自建 SSE 解析器 |
| **ADR-4** | **零白名单头透传 + 剥逐跳头** | 白名单转发固定头集 | 白名单必然漏掉上游校验所需的自定义头（`originator`、`session_id` 等），一旦漏掉就"看起来像被封号" | 需正确处理逐跳头与 `Host`/`Content-Length` |
| **ADR-5** | **不注入任何东西**（含不注入 `Accept-Encoding: identity`） | 强制 identity 便于观测 | 强制 identity 属于修改请求；且可能让上游走不同代码路径 | 压缩响应需在观测侧解压（`zlib` 流式），成本可接受 |
| **ADR-6** | **usage 优先、估算兜底** | 只信上游 / 只本地估算 | 只信上游则无数据（可能不返回）；只估算则不精确 | 需 UI 显式标注来源，避免误导 |
| **ADR-7** | **聚合恒写 + 明细受开关控制** | 一个开关全关 | 关掉明细后 KPI 仍要可见，否则产品价值归零 | 多一套聚合表与内存累加器 |
| **ADR-8** | **`node:sqlite` 单文件（WAL）+ 分桶直方图** | ①`better-sqlite3` ②JSONL ③DuckDB ④PGlite | **零原生编译摩擦**（Windows 关键）；实测 100 万行插入 ~1s、索引区间查询 ~10ms；不支持 percentile 扩展 → 用直方图替代 | 分位为近似值（UI 已标注）；`DatabaseSync` 需显式 `timeout` |
| **ADR-13** | **手写 `node:http` 代理，不用 `fetch`/代理中间件** | ①原生 fetch ②undici ③Fastify+reply-from ④http-proxy | 实测：`fetch` 对 `connection`/`transfer-encoding`/`content-length`/`keep-alive` **抛错**且**注入** `accept*`/`user-agent` → 直接违反 H2/H3；`undici` 默认 `bodyTimeout=300s` 掐断长流；`@fastify/reply-from ≤12.6.1` 有 CRITICAL CVE（`Connection` 头滥用剥离代理注入头） | 需自写约 60 行头处理与极简路由（约 40 行） |
| **ADR-14** | **`server.requestTimeout = 0`** | 保持 Node 默认 300s | Node 默认会在 300s 后**掐断入站长连接**——LLM 流式任务会超时；上游静默 >5min 是正常现象 | 需自行用 `sseKeepAliveMs`/超时策略兜底，避免真正挂死 |
| **ADR-15** | **客户端中断采用"宽限期排空"** | 立即 abort 上游 | usage **只存在于终止事件** `response.completed`；立即 abort 将**永远拿不到 usage**，该轮无法记账（sub2api 同样做法） | 中断后仍会消耗少量上游 token；需 8s 上限防悬挂 |
| **ADR-16** | **不强制 `Accept-Encoding: identity`** | 强制 identity 便于观测 | 该头属于客户端语义，改写即违反 H2。已选 `node:http`（不会自动解压），故原调研中的"必须强制 identity"前提**不再成立** | 压缩流的观测需在旁路 gunzip（已在 §5.3 设计） |
| **ADR-17** | **不做 WebSocket 代理** | 实现 `ws://…/v1/responses` 转发 | Codex 的 `supports_websockets` **默认 `false`**，且本项目未启用；实现 WS 会引入不受 CORS 约束的通道与额外复杂度 | 若用户手动开启该选项，Codex 会失败 → 网关对 upgrade 返回 501 + 说明；README 明示"保持默认" |
| **ADR-18** | **pathMode 三值为显式枚举，默认 `auto`** | 只提供"剥前缀"一种行为 | 三种语义必须写死，因为**描述含糊曾直接导致实现 bug**：`absolute` 一度被实现成"把入站 path 拼到 base 之后"，产生 `/v1/v1/…`。精确定义见 §4.3 | 配置项多一个；但换来了"不会静默拼错路径" |
| **ADR-19** | **上游请求必须用 origin-form 请求行** | 直接把完整 URL 交给 `http.request({ path })` | 若 `path` 以 `http://` 开头，Node 会原样发出 **absolute-form** 请求行（RFC 7230 §5.3.2），上游 `req.url` 会变成绝对 URL —— 真实中继/WAF 很可能因此拒绝。回归脚本有专门断言锁死 | 需要在 `joinUpstreamPath` 里只返回 `/path?query`，并显式取 URL 的 pathname 部分 |
| **ADR-20** | **`/v1/**` 完全不参与 Host/Origin/Token 校验** | 复用同一套安全中间件 | 向代理请求"读取或要求任何头"都是对 H2 的背离；一旦据此拦请求，就会为"顺手改个头"埋下伏笔。代理路径的访问控制**只靠"仅监听回环"**这一层 | 需要一个显式的测试用例锁死（回归用例 7 已覆盖） |
| **ADR-21** | **观测器在"转发之前"建立，响应头惰性读取** | 收到上游响应头后再建观测器 | 失败请求（429/500/连接失败）恰恰没有响应体可观测 —— 若等响应头才建，这些请求的请求体信息全丢，模型名落成 `unknown`。**实测踩到**：模型分布里凭空多出 `unknown` 条目（15 条）。因此 `contentType` / `contentEncoding` 以函数形式传入，`finish()` 时才求值 | 多一层间接（一次函数调用，基准中不可测量）；换来失败请求也能正确归因 |
| **ADR-22** | **计时字段一律 `*Ms` 命名，区分绝对时间戳与相对毫秒** | 保留 `upstreamHeadersAt` 式命名 + 注释说明 | `*At` 后缀暗示绝对时间戳，而 DB 列存的是相对毫秒，`recorder` 因此做错减法，界面 TTFB 显示成 `29865785.8min`。**教训：同一概念有两种表示时，必须体现在字段名上，注释挡不住误读** —— `TimingRecord` 只保留 `enqueuedAt`/`completedAt` 两个绝对时间戳 | 字段名变长；换来"不会再有人读错单位" |
| **ADR-23** | **失败请求不产生用量；"未知"绝不写成 0** | ①失败也估算（"至少有个数"）②未知字段一律记 0 | 两个**实测踩到**的缺陷同源：①404 重试的请求体被估算成 33k input token，30 次累计 120 万虚假用量并压低缓存命中率；②本地估算的请求 `cached` 恒为 0，被当成"没命中"计入分母，把 89% 显示成 61%。**"没有数据"和"数据是 0"是两件事**：`isFailedResponse` 就地丢弃估算，`cache_known_input_tokens` 单独记录可信分母，缺价格的成本渲染成 `—` 而不是 `$0.0000?` | 需要新列 + 一次精确的历史减法迁移；换来"界面数字与事实一致" |
| **ADR-24** | **成本读时计算，价格表带官方默认值** | ①写入时固化金额（原设计）②只给空价格表让用户手填 | ①固化后"改了价格历史不变"，用户会以为改价没生效；且默认价格永远补不上历史。②用户面对空表无从下手（这正是 `$0.0000?` 的直接成因）。改为：默认价格表启动即**只插不覆盖**地播种，成本**读时**按当前价格表重算（聚合表保留完整 token 分项，重算精确且无需迁移）。`cost_usd` 列仍写，但只作历史留档 | 价格表多一份内置数据（83 条）；历史金额会随改价变化 —— 这恰恰是用户的预期 |
| **ADR-25** | **观测缓冲保留「头部 + 尾部」，tee 不再丢弃分片** | ①只保留开头 N 字节（原设计）②把 `observeMaxBytes` 调大 | Responses 的 `usage` **只存在于流末尾的终止事件**（`response.completed` / `response.incomplete`），其它事件的 `usage` 恒为 null → 只留开头等于**必然**丢 usage。实测：9 条 >512KB 的响应全部落成"来源=估算"，而 102 条 ≤462KB 的全部精确，两个集合完全不重叠；`bytes_out` 也被少算（旧实现里 tee 一超限就停止投喂，计数随之停止）。改为：①观测器按 1:3 切"头 128KB + 尾 384KB"（总内存不变），usage 从尾部捞、model/response.id/TTFT 从头部取；②tee 只负责投喂与计数，**丢弃由观测器决定**；③解压后超限（高压缩比）同样按头/尾切分 | 需要两个扫描器再做合并（头部结尾是半截帧，不能和尾部拼进同一个解析器）；换来"任意长度的响应都能拿到精确 usage" |
| **ADR-9** | **控制面命名空间 `/_sgw/*`** | 复用 `/v1/*` 或独立端口 | 与代理路径零冲突；单端口便利 | 需在 Edge 上按前缀分派 |
| **ADR-10** | **SSE 推送实时更新**（非 WebSocket） | WebSocket / 轮询 | 单向推送足够；复用 HTTP；实现简单；断线自动重连内置 | 无法双向；1s 节流足够 |
| **ADR-11** | **正文落文件、元数据落库** | 全部落库 | 避免 DB 膨胀、便于整目录清理与手动 grep | 需处理文件/记录一致性（孤儿清理） |
| **ADR-12** | **不重试** | 自动重试 5xx | 重试会改变语义（可能重复计费），且掩盖问题 | 上游抖动时用户需自行重试 |

---

## 4. 请求生命周期（时序）

### 4.1 正常流式请求（Responses API，SSE）

```
Codex          Edge            Transport        Upstream        Observer     Recorder
  │              │                 │                │               │            │
  │ POST /v1/responses             │                │               │            │
  │ Authorization: sk-…            │                │               │            │
  ├─────────────►│                 │                │               │            │
  │              │ 记 t0           │                │               │            │
  │              │ 剥逐跳头         │                │               │            │
  │              │ 拼上游 URL       │                │               │            │
  │              ├────────────────►│                │               │            │
  │              │   tee(req) ─────┼────────────────┼──────────────►│ 解析 model │
  │              │                 ├───────────────►│               │            │
  │              │                 │  t_connect     │               │            │
  │              │◄────────────────┤◄───────────────┤  200 + SSE 头  │            │
  │◄─────────────┤  立即回写状态头  │                │               │            │
  │  (首个字节到达客户端 ≈ 上游 TTFB + <5ms)          │               │            │
  │              │                 │  data: {...}   │               │            │
  │              │                 ├───────────────►│ tee(res) ────►│ 行缓冲解析  │
  │◄─────────────┤◄────────────────┤                │               │ 事件分派    │
  │              │                 │   …stream…     │               │            │
  │              │                 │                │  response.completed
  │              │                 │                │               │ usage 提取  │
  │              │                 │                │               ├───────────►│
  │◄─────────────┤  结束           │                │               │  request.end
  │              │ 记 t_end         │                │               │ 200ms 批量 │
  │              │                 │                │               │  事务提交   │
```

**关键点**
- 状态头**在上游响应头到达时立即回写**，不等 body —— 这是 TTFB 只增加常数级开销的原因。
- `tee(res)` 的副本喂给 Observer。**tee 只投喂与计数，不丢弃**；丢弃与否由 Observer 决定：
  它按 **1:3** 保留「头部 128KB + 尾部 384KB」（总内存仍是 `observeMaxBytes`）并发 `truncated` 标记。
  ★ 尾部是必须的：usage **只存在于流末尾的终止事件**（ADR-25）。
- Observer **不持有**主链路 Readable 的引用，不产生 backpressure。
- 尾部单独用一个 `SseScanner` 再与头部结果合并：头部结尾是**半截帧**，
  若和尾部拼进同一个解析器，半截帧会和尾部第一行粘成一行垃圾。
  合并优先级：`usage` 取尾部，`model` / `response.id` / 首 token 时间取头部，计数类字段相加。

### 4.2 客户端中断（Codex 用户按 Esc / 超时）——宽限期排空

```
Codex ──X（连接断开）
Edge: res.on('close') 且 res.writableEnded === false
      ├─► ①不立即 abort！进入「宽限期排空」（grace drain，默认 8s）
      │     继续消费上游流，只为等 response.completed / response.incomplete
      │     - 拿到终止事件 → 提取 usage → 记账（usage 完整保留）
      │     - 宽限期到期或流自然结束 → 进入 ②
      ├─► ②controller.abort() → 上游连接销毁（释放额度）
      └─► ③Observer.finish() 幂等 → errorClass='client_aborted'，usage 若有则记
```

**为什么必须这样做**
> usage **只存在于终止事件**（`response.completed` / `response.incomplete`），其他所有事件的 `usage` 都是 `null`。若客户端一断就 abort 上游，这一轮就**永远无法记账**——而这恰恰是"用户觉得慢、按了 Esc"的高价值场景。
> sub2api 自己就是这么做的（`passthrough_relay.go`：*"客户端断开后尽力继续读取上游短窗口，捕获延迟 usage/terminal 事件用于计费"*）。

**约束**：宽限期必须有上限（默认 `edge.graceDrainMs = 8000`），且排空期间**不再向任何客户端写字节**（连接已断）。排空产生的观测数据照常记账，但 `bytesOut` 不累加（客户端没收到）。

### 4.3 路径拼接（黄金用例）

Codex 的 URL 构造是**纯字符串拼接**（`codex-rs/codex-client/src/provider.rs`）：
```rust
let base = self.base_url.trim_end_matches('/');
let path = path.trim_start_matches('/');
format!("{base}/{path}")           // 若 path 为空则直接用 base
```
因此 `base_url = "http://127.0.0.1:8787/v1"` 时，Codex 实际请求：

| 方法 | Codex 请求的 URL | 时机 |
|---|---|---|
| `POST` | `http://127.0.0.1:8787/v1/responses` | 每一轮对话（主路径），`Accept: text/event-stream` |
| `GET` | `http://127.0.0.1:8787/v1/models?client_version=<ver>` | 模型选择器刷新 |
| `GET`(Upgrade) | `ws://127.0.0.1:8787/v1/responses` | **仅当 `supports_websockets = true`**（默认 false → 本网关不支持） |

> **不存在** `GET/POST /v1/responses/{id}`（因为 `store: false`，服务端不持久化，也就没有按 id 取回流程）。因此 `/v1/models` 的 **query 必须原样保留**，而代理必须是 catch-all，不能枚举路径。

**拼接实现（禁止用 `new URL(path, base)`）**
```ts
// ❌ new URL('/v1/responses', 'https://up/v1').href  → 'https://up/v1/responses' 看似对，
//    但 new URL('responses', 'https://up/v1')  → 'https://up/responses'（吃掉 /v1）
// ✅ 与 Codex 同构的纯字符串拼接
function joinBase(upUrl: URL, incomingUrl: string): string {
  const base = upUrl.href.replace(/\/+$/, '');       // 去尾斜杠
  const path = incomingUrl.replace(/^\/+/, '');      // 去首斜杠，保留 query
  return path ? `${base}/${path}` : base;
}
```
例：`base=https://relay.example.com/v1`，`incoming=/v1/responses`

**三种 `pathMode` 的精确定义（实现后写死，避免歧义再次引发 bug）**

| pathMode | 语义 | 入站 `/v1/responses` + base `https://h/v1` | 入站 `/v1/responses` + base `https://h` |
|---|---|---|---|
| `auto`（默认） | stripPrefix 匹配则剥，否则把入站 path 追加到 base 之后 | `https://h/v1/responses` | `https://h/v1/responses` |
| `append` | 总是尝试剥 stripPrefix，再追加到 base 之后 | `https://h/v1/responses` | `https://h/v1/responses` |
| `absolute` | 入站 path **逐字保留**，**忽略 base 的路径部分** | `https://h/v1/responses` | `https://h/v1/responses` |

三种模式在上表两种情况下的结果**恰好相同** —— 这正是 `auto` 作为默认值足够安全的原因。
要提防的经典 bug 是 **`/v1/v1/responses`**（没剥就拼）。回归脚本对此有专门断言。

**实现要点（都曾是真实 bug）**
1. **禁止用 `new URL(path, base)`**：`new URL('responses','https://up/v1')` → `https://up/responses`（吃掉 `/v1`）；`new URL('/v1/responses', base)` 会把 base 路径整体替换。必须手写字符串拼接。
2. **必须返回 origin-form 请求目标**（`/path?query`），**不是完整 URL**（ADR-19）。
   否则 `http.request({ path: 'https://…' })` 会发出 `POST https://… HTTP/1.1` 的 absolute-form 请求行，上游 `req.url` 变成绝对 URL。
3. 剥前缀时要求"前缀后紧跟 `/` 或结束"，避免把 `/v1beta` 误剥成 `beta`。
4. 拼接后归一化重复斜杠，但 **query 一字不改**。

> **H4 澄清**：这里的"不改写"指**不改变 Codex 发出的语义路径**；把本地 base 前缀换成上游 base 前缀是代理的固有职责，属于"base 替换"而非"路径改写"。

---

## 5. 观测器设计（本架构最核心的模块）

### 5.1 组件分解

```
observe/
├─ observer.ts        # 门面：根据 content-type/encoding 选择解析器
├─ sse-parser.ts      # 增量 SSE 行解析（\n\n 分帧，支持 \r\n，容忍多行 data:）
├─ responses-events.ts# Responses 事件语义：response.created/completed/output_text.delta…
├─ chat-events.ts     # chat.completions chunk 语义（含尾部 usage chunk）
├─ usage-extract.ts   # 从解析结果提取 UsageRecord（含 *_tokens_details）
├─ decompress.ts      # 按 Content-Encoding 惰性建 gunzip/br/deflate 流
├─ json-body.ts       # 非流式响应体解析（有界缓冲）
└─ estimator.ts       # tiktoken 懒加载 → 启发式回退
```

### 5.2 数据流与背压策略

```ts
// 单请求的观测装配（伪代码，签名见 00 §6）
const obs = createObserver({ contentType, contentEncoding, maxBytes: 512 * 1024, ... });

const { toClient } = teeForObservation(resBody, (chunk) => {
  try { obs.onResponseChunk(chunk); }        // 同步、非阻塞、内部只做 push 到有界缓冲
  catch { /* 吞掉：观测失败绝不能冒泡到主链路 */ }
}, maxBytes);

return reply.send(toClient);                  // 主链路只认 toClient
```

**背压规则（H6 的机械保证）**
1. `teeForObservation` 用 `src.on('data')` + 手动 push 到两个目标，**两个目标互不影响**。
2. 观测侧缓冲满 → 丢弃并计数，**不调用** `src.pause()`。
3. 观测侧解析异常 → 记录错误计数，标记 `truncated`，继续丢弃。
4. 观测侧整体在 `setTimeout(observeTimeoutMs)` 后强制 `finish()`（防止悬挂请求泄漏内存）。

### 5.3 解析策略与"零修改"的兼容性

| 上游响应特征 | 观测做法 | 是否修改流量 |
|---|---|---|
| `Content-Type: text/event-stream`，无压缩 | 直接在副本上跑 SSE 解析 | 否 |
| `text/event-stream` + `Content-Encoding: gzip` | 副本经 `zlib.createGunzip()` 后再解析；**转发给客户端的仍是原始压缩字节** | 否 |
| `application/json` | 有界读取副本至 `maxBytes`，`JSON.parse` | 否 |
| `application/json` + gzip | 副本 gunzip 后解析 | 否 |
| 二进制/未知类型 | 只统计字节数，不解析 | 否 |
| SSE 含 chunked + 多字节 UTF-8 跨 chunk | 行缓冲 + `Buffer` concat，避免 `toString()` 切断多字节字符 | 否 |

> **UTF-8 跨 chunk 是真实坑**：SSE 分片可能把一个中文字符切成两半。必须用 `Buffer.concat` 累积到遇到 `\n` 再 `toString('utf8')`，禁止对每个 chunk 单独 `toString()`。

#### 5.3.1 实体编码是**两个方向**的事（Body Mode 落盘必须解码）

| 方向 | 编码从哪来 | 落盘/计算前的处理 |
|---|---|---|
| 请求（客户端 → 网关） | `req.headers['content-encoding']`，**转发前就已知** | pipeline 缓冲副本，`finish()` 时按它**懒解码**：明文既用于落盘，也用于估算与请求体里的 `"model"` 兜底 |
| 响应（上游 → 网关） | 上游响应头，**只有等响应头到达才知道** | 缓冲副本，落盘前按响应头编码解码（观测已截断时不尝试解码，直接存原始字节） |

> **真实教训**：Codex 会用 `Content-Encoding: zstd` 压缩 `/responses` 请求体。
> 曾经只有**响应侧**做了旁路解压，请求侧原样保存压缩字节 —— 于是详情抽屉里"请求正文"是乱码，
> 而"响应正文"正常（上游返回明文 SSE），看起来像前端渲染 bug。
> 落盘副本解码失败时一律降级为原始字节并在 `observe_note` 说明：**宁可存一份看不懂的字节，也不能丢数据**。
> 转发字节始终不变（H3）：这里解压的永远只是副本。

### 5.4 usage 提取优先级

```
1. 非流式: body.usage                                  → source='upstream'
2. Responses 流: 事件 response.completed → .response.usage → source='upstream'
   （若事件中无 usage，尝试 response.in_progress 累积的最后一次 usage）
3. chat 流: 末个 chunk 的 usage 字段（若上游返回）        → source='upstream'
4. 均无: estimator.estimate(requestBody, responseText)  → source='estimated'
5. 连估算输入都不可得: 全 0                              → source='none'
```
**多 usage 事件处理**：若同一请求出现多个 usage（少见，如 `response.completed` 重复），**取最后一个非零值**（累计语义），并记一条 warn。

### 5.5 估算器（Estimator）

```ts
// packages/tokenizer
export interface Estimator {
  readonly kind: 'tiktoken' | 'heuristic';
  countText(text: string): number;
  countMessage(m: { role: string; content: unknown }): number;   // +4 消息开销
}
// 1) 懒加载 tiktoken（动态 import，失败则永久降级）
// 2) 启发式: 英文/代码 tokens ≈ chars / 3.6 ; CJK ≈ chars / 1.6
//    混合文本按 Unicode 区段加权
// 3) 请求侧遍历 input 数组（含 tools/instructions），响应侧拼接 output_text.delta
```
- tiktoken 作为**可选依赖**（`optionalDependencies`），加载失败不影响网关启动
- 估算误差在 UI 标注 `±5–15%`（CJK 与代码混合场景误差更大）

### 5.6 usage 完整性自检（**最高优先级互操作防线**）

Codex 的 `ResponseCompleted` 反序列化（`codex-rs/codex-api/src/sse/responses.rs`）把 `response.id`、`usage.input_tokens`、`usage.output_tokens`、`usage.total_tokens` 声明为**非 `Option`**。因此：

| 上游 `response.completed` 的实际形态 | Codex 的行为 | 本网关的行为 |
|---|---|---|
| 完全没有 `usage` 字段 | ✅ 正常（`token_usage = None`），但**记不了账** | 走估算器，`source='estimated'` |
| `"usage": null` | ✅ 同上 | 同上 |
| `usage` 字段完整 | ✅ 正常 | `source='upstream'`，逐字段记账 |
| ⚠️ `usage` 存在但**缺 `total_tokens`** | ❌ **整轮硬失败**：`failed to parse ResponseCompleted: missing field total_tokens` | **原样透传**（不改上游字节），但记 `errorClass='usage_incomplete'` + **UI 顶部红色告警** |
| ⚠️ `response` 缺 `id` | ❌ 同上硬失败 | 同上 |

**实现要求**
```
① 启动时（或首次真实请求后）执行一次 usage 探针：
   发一个最小的 /v1/responses 流式请求（max_output_tokens=16, store=false）
   解析 response.completed → 断言 input_tokens / output_tokens / total_tokens / response.id
② 断言失败 → 设置页与概览页显示告警横幅：
   「上游中继的 usage 结构不完整（缺 X），这会导致 Codex 本轮对话失败。请联系中继管理员。」
③ 运行期：每次记账前校验字段完整性；缺失则累加 usage_incomplete 计数并保留原始事件片段
   （脱敏后存 data/logs/，供排查用，默认仅保留最后 20 条）
```

> **这是本网关超出"统计用量"之外的额外价值**：它能在用户还没抱怨之前，就定位到"是上游中继的返回结构导致 Codex 报错"，而不是让用户以为是自己环境的问题。此项对应 FR-A13，必须在 M0 探针阶段就验证。

---

## 6. 数据面实现要点

### 6.1 逐跳头处理（RFC 9110 §7.6.1）

**必须剥离（请求方向）**
```
Connection, Proxy-Connection, Keep-Alive, Proxy-Authenticate, Proxy-Authorization,
TE, Trailer, Transfer-Encoding, Upgrade
+ 由 Connection 头中列出的每一个头（动态，MUST）
+ Host（HTTP 客户端按上游 URL 重写，属框架头，非业务头）
+ Content-Length（body 由客户端按实际流分帧重算；body 字节不变）
```
**必须剥离（响应方向）**：同上集合（`Content-Encoding` 是**实体头，必须保留**——我们不解压转发）

**必须保留（原样）**：`Authorization`、`originator`、`session-id`、`thread-id`、`x-client-request-id`、`x-codex-turn-state`、`x-codex-beta-features`、`x-codex-routing-hint`、`x-oai-attestation`、`User-Agent`、`Accept`、`Accept-Encoding`、`Content-Type`、`x-request-id`、`openai-model`、`x-models-etag`、`x-codex-safety-buffering-*`、整个 `x-codex-*` 限流族、以及**所有未知头**。

> **实现铁律**：不做白名单。用 **`req.rawHeaders`**（扁平数组，保留**原始大小写**与**重复头**）逐字重建头袋，只在遇到逐跳集合时跳过。
> **反例**：不要用 `req.headers`（小写化）或 WHATWG `Headers`（会把重复 `set-cookie` 逗号合并 → 破坏逐字要求）。
> **不要**强制改写 `Accept-Encoding` 为 `identity`：那是修改请求语义（H2）。已选 `node:http` 客户端**不做自动解压**，所以"解压后再转发导致 `ZlibError`"这个 fetch 特有的坑天然不存在（ADR-16）。

### 6.2 流式转发的具体做法

```ts
// ── 服务端（Edge）全局设置：必须关掉默认的 300s 入站超时 ──
server.requestTimeout = 0;          // ← 不关掉的话，长流 5 分钟后被 Node 掐断
server.headersTimeout = 60_000;
server.keepAliveTimeout = 65_000;

server.on('request', (req, res) => {
  const upReq = http.request({
    hostname: up.hostname, port: up.port, protocol: up.protocol,
    path: joinBase(up, req.url), method: req.method,
    headers: filterHeaders(req.rawHeaders),     // 逐字拷贝 - 逐跳头（§6.1）
    agent: keepAliveAgent,
  }, (upRes) => {
    res.writeHead(upRes.statusCode!, filterHeaders(upRes.rawHeaders));
    res.flushHeaders();                          // ★ 头立即上线，不等 body → TTFB 只加常数开销
    req.socket.setNoDelay(true);                 // 关 Nagle
    res.socket?.setNoDelay(true);
    teeForObservation(upRes, res, onCopy, maxBytes);   // 唯一的分叉点
  });
  req.pipe(upReq);                               // 请求体流式转发（不解 JSON，H1）
  res.on('close', () => { if (!res.writableEnded) graceDrain(upReq, obs); });
});
```

**禁用清单**
- ❌ `res.end(await readAll(upRes))` / 任何整包缓冲
- ❌ 任何压缩中间件（`compression` 等）：会按压缩块缓冲 → 摧毁流式，且改变响应字节
- ❌ 设置 `Content-Length`（重分帧后必然过期 → Node 会报错或截断）
- ❌ 自行重新分帧 SSE（不补 `event:`、不补 `[DONE]`）
- ❌ 新增响应头（含 `X-Accel-Buffering: no`、`Cache-Control: no-cache`）。这些都是"重写响应"，违反 H3；若确需，走开关且默认关闭

**启用清单**
- `flushHeaders()`：状态行与响应头先于首个 token 上线
- `setNoDelay(true)`（两侧）：关闭 Nagle，避免每个 delta 多几十毫秒
- `pipe()` 而非手写 `for await` + `write()`：`pipe` 自动传播 backpressure，`res.write()` 返回 `false` 时无需人工处理
- SSE 保活：`edge.sseKeepAliveMs` 开关，**默认 0 = 关闭**（注入 `:\n\n` 注释帧属于改动字节流，只在用户明确开启时生效）

### 6.3 上游连接器（`node:http` / `node:https` 客户端）

| 关注点 | 方案 |
|---|---|
| 连接复用 | `new http.Agent({ keepAlive: true, keepAliveMsecs: 30_000, maxSockets: 32, noDelay: true })`（`https` 用 `https.Agent`） |
| 自定义 CA | `https.Agent({ ca: fs.readFileSync(caFile) })`；未配置则用系统 CA |
| 自签/内网证书 | `strictSsl=false` 时 `rejectUnauthorized: false`（UI 需警示） |
| 超时 | **headersTimeout（等首字节）默认 10s**；**请求体与响应体不设超时**（`node:http` 客户端默认就无超时 → 这正是选它的原因之一） |
| 中断传播 | 单个 `AbortController`；`res.on('close')` → **先 grace drain，后 abort**（§4.2） |
| 代理回环检测 | 启动时校验 `upstream.baseUrl` 的 host:port 不等于自己的 `listen.host:port`（防自我转发死循环） |
| TLS 版本/SNI | 交给 Node 默认；如需指定 `servername`/`minVersion` 走配置 |

> **为什么不选 `undici`**：它的 `Client`/`Agent` 默认 `bodyTimeout = 300_000ms`（监控**连续 body chunk 之间**的间隔）。模型静默超过 5 分钟是**正常现象**，会被它当成超时并抛 `TypeError: terminated`。虽然可以显式置 0，但"默认就会掐断 LLM 流"是一个不该被记住的陷阱；`node:http` 客户端默认无此超时。

### 6.4 错误映射与降级

见 [`00-agent-dev-spec.md`](./00-agent-dev-spec.md) §7 的错误矩阵。架构层面补充：
- **上游 4xx/5xx 原样透传**（含 body 与 `x-request-id`），网关**不包装**错误 JSON
- 网关自身错误（如上游不可达）才生成响应，且明确标注来源：响应头 `x-sgw-error: <class>`（这是**网关自身**产生的响应，不违反 H3，因为此时没有可透传的上游响应）
- **不重试**上游请求（重试会改变语义、可能重复计费、并掩盖问题）
- ⚠️ **静默挂死的防护**：Codex 侧 `stream_idle_timeout_ms` 默认 **300_000ms**、`stream_max_retries` 默认 **5**。网关若"什么都不做地挂住"，Codex 会进入**重连循环**而不是给出干净的错误——这比直接失败更糟。因此网关必须：
  1. 上游首字节超过 `upstream.headersTimeoutMs`（默认 10s）→ 立即返回 504 + `x-sgw-error`
  2. 流中途上游静默：**不主动掐断**（可能只是在推理），但记录 `silentMs`；若超过 `upstream.silentWarnMs`（默认 120s）则写一条结构化 warn 日志（不改变转发行为）
  3. 网关自身的任何异常必须转换成明确的 HTTP 错误，**不允许**留下半开的连接

---

## 7. 控制面与前端集成

### 7.1 路由分派

```
node:http 请求分派（顺序敏感）:
  ① /v1/**  → edge/  (透明代理，含 SSE)
       ↑ ★ 此路径**只有**「只监听回环」这一层访问控制。
         绝不校验 Host/Origin/Token，绝不读取或要求 X-Gateway-Token
         —— 向代理请求读取/添加任何头都是 H2 违规（见 03 §6.2 作用域铁律）
  ② Upgrade: websocket 且 path=/v1/responses
       → 明确拒绝 501 + 说明（本网关不支持 WS，见 ADR-17）
  ③ method=GET 且 Host/Origin/Token 校验通过：
       /_sgw/api/**   → control/     (管理 API，JSON)
       /_sgw/assets/**→ 静态资源（SPA 构建产物）
       /              → index.html（SPA fallback；仅当 Accept 含 text/html）
  ④ 其他            → 404（不代理非 /v1 路径）
```
> `/v1/**` 之外的路径**不代理**：防止把随机探测流量转发到上游（浪费配额、污染统计）。若未来需要支持其他前缀，用 `proxy.prefixes` 扩展。
> **不引入任何路由器框架**：匹配规则就是一张 `[method, RegExp, handler]` 表（约 40 行），因为代理路径本来就要绕过框架语义（见 [`03`](./03-tech-stack-selection.md) §4）。

### 7.2 实时推送（SSE）

```
GET /_sgw/api/stream        → text/event-stream  （同源 GET，受 Host/Origin/Token 校验）
event: request.start   data: {id, startedAt, path, model}
event: request.end     data: RequestEvent（不含正文）
event: stats.tick      data: {reqDelta, tokenDelta, errorDelta}   // 1s 节流
event: settings.changed data: {settings}
event: alert           data: {level, code, message}     // 如 usage_incomplete
: heartbeat            （每 15s 注释帧 —— 这是**控制面**流，属于网关自己的响应，可自由加）
id: <递增序号>          （配合 Last-Event-ID 支持断线补发）
```
- 多客户端支持（`Set<ServerResponse>` 广播）；客户端 `close` 自动移除
- 推送**只发元数据**，正文必须另行请求（避免把大 payload 塞进推送通道）
- **注意区分**：控制面 SSE 的心跳是自己的协议，可以加；`/v1/**` 代理的 SSE **不加心跳**（H3）

### 7.3 前端服务方式
- **生产**：`apps/web/dist` 由同一 `node:http` 实例托管（手写静态处理器约 30 行 + SPA fallback），单端口
- **开发**：Vite dev server（5173）把 `/_sgw` 与 `/v1` 代理到 8787，保留 HMR；此时 Host/Origin 白名单需**仅在 dev 模式**额外接受 `localhost:5173`
- 静态产物预压缩（构建期生成 `.gz`/`.br`），首屏 < 1s（本地）

---

## 8. 安全设计

### 8.1 威胁模型（"localhost 不是安全边界"）

浏览器会从**任意网页**向 `127.0.0.1:8787` 发起请求。攻击者页面读不到响应（CORS 拦截），但**能发起**请求；而 **DNS Rebinding** 连"读"的限制都能绕过。

| 威胁 | 场景 | 缓解 |
|---|---|---|
| **DNS Rebinding**（首要威胁） | 恶意域名先解析到攻击者 IP 加载 JS，再改解析到 `127.0.0.1`；于是浏览器与网关都看到 `Host: evil.com`，攻击者即可**读取全部用量、正文，并窃取上游 API Key** | **①`Host` 白名单**：必须 ∈ {`127.0.0.1:8787`, `localhost:8787`, `[::1]:8787`}，否则 403（**核心防线**，因为浏览器发送的是被重绑定的主机名） |
| **盲 CSRF** | 恶意页面用 `fetch` 或**无需 JS 的 `<form>` POST** 打 `/_sgw/api/settings` 打开正文记录 | **②`Origin` 白名单且 fail-closed**：带 `Origin` 且不在白名单 → 403；**无 `Origin` 时只允许 `GET`/`HEAD`**（浏览器跨源非 GET 与表单 POST 必带 `Origin`）。**③必须的自定义头 `X-Gateway-Token`** 强制预检，攻击者无法满足 |
| **恶意页面读取响应** | 若网关发出 `Access-Control-Allow-Origin: *` 或反射 `Origin`，CORS 保护即失效 | **④永不发 CORS 头**（本项目没有任何合法的跨源消费方） |
| **跨站 WebSocket** | WebSocket **不受 CORS 约束**，页面可直连 `ws://127.0.0.1:8787` 并读取一切 | **⑤不实现 WebSocket**（ADR-17）；若将来实现，必须在 `upgrade` 里校验 `Origin` |
| **本地其他进程** | 同机其他程序直接调 `/_sgw/api/*` | ⑥每次安装生成 32 字节随机 **`X-Gateway-Token`**（存 `data/.token`，SPA 自动携带）。**边界诚实说明**：同用户权限的进程仍可读取 token 文件，OS 用户边界才是真正的控制点 |
| **密钥泄漏** | 日志/DB 打印 `Authorization` | 只存 `keyFingerprint`（`sha256` 前 8 位）；pino `redact` 覆盖 `req.headers.authorization`；上游 Key **永不进入 SPA**（UI 只显示掩码 + `hasCustomKey` 布尔） |
| **正文泄漏** | Body Mode 落盘了含密钥的 prompt | 默认关闭 + 开关处醒目警示 + 保留 7 天 + 一键清理 + `.gitignore` 覆盖 `data/` |
| **静态资源侧信道** | 通过缓存判断是否访问过某记录 | API 响应 `Cache-Control: no-store`；`X-Content-Type-Options: nosniff`；`CSP: default-src 'self'; connect-src 'self'` |
| **端口占用冲突** | 8787 被其他程序占用 | 启动自检 + 明确报错 + 配置可改端口 |
| **自我转发死循环** | 上游地址误配为网关自己 | 启动校验 host:port≠自己；运行期检测并拒绝 + 告警 |

### 8.2 强制配置
```ts
listen.host 必须 === '127.0.0.1' || '::1'      // 拒绝 0.0.0.0 / 双栈 ::，除非显式 allowExternal=true
```
UI 上该字段**只读展示**，不提供修改入口（避免手滑暴露到局域网）。

### 8.3 隐私声明（UI 必须有）
> 所有数据仅保存在本机 `data/` 目录；网关不发送任何遥测；上游流量不被修改；正文默认不记录。
> 查看/导出正文时提示："导出内容可能包含代码、密钥与个人信息，请勿提交到公共仓库。"

---

## 9. 部署与运行

### 9.1 运行形态
```
node apps/server/src/index.ts            # 生产（Node 原生 TS 或 tsx，无构建步骤）
pnpm dev                                 # 开发（tsx watch + vite dev）
```
- 无 Docker、无服务注册、无外部 DB、**无原生模块**（`pnpm i` 永不触发 node-gyp）
- 数据目录：`data/`（相对进程 CWD）；可用 `SGW_DATA_DIR` 覆盖
- 日志：`data/logs/sgw-YYYY-MM-DD.log`（pino，按天轮转，保留 7 天）+ 控制台

### 9.2 接入步骤（用户视角，3 步）

> ⚠️ **必须写 `127.0.0.1`，不要写 `localhost`**：Codex 存在 localhost 优先解析 IPv6 的已知缺陷（[#21773](https://github.com/openai/codex/issues/21773) / [#19525](https://github.com/openai/codex/issues/19525)），会导致连不上。

```toml
# 1. 备份后修改 C:\Users\<user>\.codex\config.toml
[model_providers.OpenAI]
base_url = "http://127.0.0.1:8787/v1"     # ← 只改这一行（注意是 127.0.0.1）
wire_api = "responses"                     # ← 不要改；chat 已被 Codex 移除（硬报错）
requires_openai_auth = true
experimental_bearer_token = "sk-****"      # ← 保持不变
# supports_websockets                         ← 不要设置/保持 false（本网关不支持 WS）
```
```powershell
# 2. 启动网关
pnpm start
# 3. 打开仪表盘
start http://127.0.0.1:8787
```
> `scripts/point-codex.ts` 自动完成"备份 → 改行 → 校验 → 输出回滚命令"，且**硬编码 `127.0.0.1`**、**明确拒绝写入 `supports_websockets = true`**。

### 9.3 兜底方案：若 Codex 拒绝 http（假设 A1 不成立）

**调研结论：A1 成立的概率极高** —— Codex 的 `url_for_path()` 是纯字符串拼接，**没有 scheme 白名单**，且 `websocket_url_for_path()` 显式把 `http→ws`（说明它预期存在非 TLS 的 base_url）。issue #21773 中 `base_url = "http://127.0.0.1:8000/v1"` 被证实可用，其报错文案也直接印出 `http://localhost:8000/v1/responses`。

因此本方案**降级为纯兜底**（M4 可选，配置位预留）：
```
1. mkcert -install                     # 把本地 CA 装入 Windows 受信任根
2. mkcert 127.0.0.1                    # 得 127.0.0.1.pem / 127.0.0.1-key.pem
3. settings.edge.tls = { certFile, keyFile }   # node:https.createServer 选项
4. base_url = "https://127.0.0.1:8787/v1"
5. Codex 侧需信任该 CA：mkcert -install 已解决；若 Codex 用独立 CA bundle，
   需设置 NODE_EXTRA_CA_CERTS 指向 mkcert 的 rootCA.pem
```

### 9.4 回滚
```powershell
# 一条命令恢复直连
Copy-Item "$env:USERPROFILE\.codex\config.toml.sgw-backup" "$env:USERPROFILE\.codex\config.toml" -Force
```

---

## 10. 性能预算与容量

| 环节 | 预算 | 说明 |
|---|---|---|
| Edge 处理（含头处理） | < 1ms | 无 body 读取；`rawHeaders` 逐字拷贝 |
| tee 分叉 | < 0.2ms/64KB | 一次 memcpy |
| Observer 解析 | 异步，不占主链路 | SSE 解析 ~50MB/s 足够 |
| Recorder 写入 | 200ms 批量，单事务 | 实测 100 万行单事务插入 ~1s（`node:sqlite`） |
| 空闲内存 | < 120MB | Node 基线 + `node:http` + SQLite mmap（**无框架/无原生模块**，比 Fastify 方案更低） |
| 50 并发流式 | < 350MB | 每流观测缓冲上限 512KB → 最坏 25MB |
| 空闲 CPU | ≈ 0% | 无定时轮询（清理任务 1h 一次） |
| 长流存活 | 无限 | `server.requestTimeout = 0`（ADR-14） |

**首字节增量测量方法**：用同一 prompt 直连 / 经网关各 200 次，比较 TTFB 分布（p50/p95/p99），并在 UI 自检页展示历史结果。详见 [`06`](./06-roadmap-acceptance-risks.md) §9.3。

---

## 11. 测试与验证架构

| 层级 | 手段 | 覆盖 |
|---|---|---|
| **单元** | SSE 解析器（畸形帧、跨 chunk UTF-8、多行 data）、逐跳头过滤、分位直方图、估算器 | 纯函数，Vitest |
| **契约** | 假上游（`tests/fixtures/fake-upstream.ts`）按脚本回放 SSE 序列（含 gzip / usage 缺失 / 中途断开 / 429） | 观测器 + 错误矩阵 |
| **透传回归** | `scripts/passthrough-regression.ts`：直连 vs 经网关，比对 body SHA-256、头集合、状态码、响应体 hash | H1~H5 |
| **性能** | `scripts/bench-ttfb.ts`：N=200 对比 TTFB 分位 | H7 |
| **端到端** | Playwright：开关切换 → 明细/正文落盘行为 → 清理任务生效 → 实时表格插入 | FR-C/D 关键路径 |
| **真实冒烟** | 把 Codex 真实指向网关跑一个任务，人工确认流式、工具调用、推理无异常 | 假设 A1/A2/A3 |
| **长流存活** | 假上游发一个事件后静默 6 分钟再继续（或首字节延迟 5min） | `requestTimeout=0` 生效，连接未被掐断 |
| **宽限期排空** | 客户端在第 3 秒断开，假上游在第 5 秒才发 `response.completed` | usage 被记录，`errorClass='client_aborted'`，宽限期到期后上游被 abort |
| **usage 完整性** | 假上游发缺 `total_tokens` 的 `response.completed` | 字节原样透传 + `usage_incomplete` 计数 + UI 告警（**不修改响应**） |

---

## 12. 风险登记册（架构视角）

| 风险 | 概率 | 影响 | 缓解 | 触发器/观察点 |
|---|---|---|---|---|
| R1 上游不返回 usage | 中 | 数据退化为估算 | 估算器 + UI 标注；探针尽早确认 | 首帧探针输出 |
| R2 上游 SSE 结构非标准 | 低 | 解析失败 | 解析器做宽容设计（只关心 `event:`/`data:` 与 usage 字段）；失败即降级为估算 | 探针输出事件清单 |
| **R2b** ⚠️ **上游 usage 缺 `total_tokens`** | **中** | **高（Codex 整轮硬失败）** | §5.6 的 usage 完整性自检 + UI 告警横幅；**只能在网关上"发现并告知"，不能通过改字节去修**（改了就是 H3 违规，而且掩盖中继问题） | 探针 + `usage_incomplete` 计数 |
| R3 Codex 拒绝 http base_url | 低 | 无法接入 | mkcert HTTPS 兜底（§9.3，配置位已预留） | 首次切换后 Codex 报错 |
| R4 上游按 `Origin`/`User-Agent` 校验 | 低 | 请求被拒 | 全量头透传天然规避 | 出现 4xx 时的响应体 |
| R5 压缩响应观测不到 usage | 中 | 估算退化 | 观测侧 gunzip（不解压转发） | `Content-Encoding` 非空 |
| R6 SSE 长连接导致内存缓慢增长 | 中 | 内存泄漏 | 观测缓冲硬上限 + finish 超时 + 定期 heap 采样 | RSS 曲线 |
| R7 SQLite 写锁争用 | 低 | 记录丢失 | 单写者 + 批量 + `busy_timeout` + 内存重试队列 | `DB_BUSY` 计数 |
| R8 网关自身崩溃阻断 Codex | 中 | 工作中断 | 一键回滚脚本 + 开机自启 + 崩溃日志；README 首屏写回滚方式 | 进程存活告警（`/_sgw/api/health`） |
| R9 正文落盘泄漏密钥 | 中 | 隐私 | 默认关闭 + 警示 + 短期保留 + 一键清理 | 设置页开关状态胶囊 |
| R10 端口被占用 | 低 | 启动失败 | 启动自检 + 可改端口 + 明确报错文案 | 启动日志 |
| **R11** 长流被 Node 默认 300s `requestTimeout` 掐断 | **高（若不处理）** | 高中断 | `server.requestTimeout = 0` + M1 阶段即写入；纳入长流存活测试（`06` §9.2） | 一次 >5min 的空闲流测试 |
| **R12** 用户误开 Codex `supports_websockets` → 改走 `ws://` | 低 | 高（完全不可用） | 切换脚本拒绝写入该键；README 顶格警示；网关对 WS upgrade 返回 501 + 说明 | 请求日志出现 `Upgrade: websocket` |
| **R13** 用户误用 `localhost`（IPv6 缺陷） | 中 | 中（连不上，易误判为网关故障） | 切换脚本硬编码 `127.0.0.1`；Host 白名单同时接受两者以免误伤；README 加粗提示 | Codex 报 `error sending request for url (http://[::1]:8787/…)` |
