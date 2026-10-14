# SGW 实施路线图 · 验收标准 · 风险清单

> 项目：**SGW / Self Gateway**
> 版本：v1.0 · 设计冻结
> 前置阅读：[`00-agent-dev-spec.md`](./00-agent-dev-spec.md) §8/§9 · [`02-architecture-design.md`](./02-architecture-design.md) §11/§12

---

## 1. 里程碑总览

```
M0 立项与协议探针  ──► M1 纯透传骨架 ──► M2 用量采集与存储 ──► M3 仪表盘与开关 ──► M4 加固与交付
   (0.5–1 天)            (1–1.5 天)          (1–1.5 天)            (2–3 天)           (1 天)
   「搞清上游」          「不破坏」          「记得准」            「看得见」         「用得久」
   ★ 决定成败           ★ 必须最先做        ★ 核心价值            ★ 产品价值          ★ 长期可用
```

**排序铁律**：M1 必须先于 M2/M3 完成并**通过 H1~H5 全绿**。原因：一旦在观测代码存在的前提下调试透传，你无法判断"字节差异"是代理本身的问题还是观测逻辑引入的问题。**透传正确性必须在没有观测代码时被证明。**

---

## 2. M0 · 立项与协议探针（0.5–1 天）

**目的**：在写任何代理代码前，用**非侵入**方式回答 [`01`](./01-requirements-and-scope.md) §6 的 8 个待验证项。所有后续设计都建立在这些实测事实上。

| 任务 | 产出 |
|---|---|
| M0-1 直连上游做一次最小 `POST /v1/responses`（流式 + 非流式各一次），用 `curl -i` / `-N` 保存完整原始响应 | `notes/probe-raw-{stream,json}.txt` |
| M0-2 判定 usage 是否返回、字段名与嵌套位置 | 探针报告 §1 |
| M0-2b ⚠️ **最高优先级：断言 `response.completed.response.usage` 是否含 `input_tokens`/`output_tokens`/`total_tokens`，以及 `response.id` 是否存在**（缺任一 → Codex 整轮硬失败） | 探针报告 §1b。**这一条决定项目是否"能用"** |
| M0-3 列出全部 SSE `event:` 名称与实际频率（含是否有 `codex.*` 私有扩展） | 探针报告 §2 |
| M0-4 记录响应头清单，特别关注 `content-encoding`、`transfer-encoding`、`x-request-id`、`x-codex-turn-state`、限流头 | 探针报告 §3 |
| M0-5 判定 `/v1` 前缀语义（`GET {base}/models` vs `GET {base}/v1/models` 哪个 200） | 探针报告 §4（决定 `stripPrefix`） |
| M0-6 记录 Codex 真实请求头集合（用一个"回声"端点或本地 mock 先接住 Codex，打印 `rawHeaders`） | 探针报告 §5 |
| M0-7 校验假设 A1：把 Codex 指向一个本地空壳 http 服务，看是否报 TLS/scheme 错误 | 探针报告 §6（**决定是否需要 mkcert 兜底**） |
| M0-8 记录 Codex 实际版本与是否启用 `supports_websockets`（若启用会改走 `ws://`，网关不支持） | 探针报告 §7 |

**M0 退出标准**：所有结论都有**实测证据**（原始报文 + 时间戳），无一项是"推测"。

> **M0-6 的小技巧**：先起一个 20 行的 `node -e` HTTP server 监听 8787，把 `req.headers` 落到文件，把 Codex 指过去发一句话，就能拿到真实头集合。这一步同时验证 A1。

---

## 3. M1 · 纯透传骨架（1–1.5 天）—— ✅ 已完成

**目标**：Codex 经网关工作，**功能与直连无法区分**；网关此时是一个"什么都不记"的透明代理。

**完成情况：59/59 回归断言通过**（`node scripts/passthrough-regression.mjs`），`tsc --noEmit` 零错误。

| # | 任务 | 状态 | 实现说明 |
|---|---|---|---|
| M1-1 | pnpm workspace + tsconfig.base + `@sgw/shared` | ✅ | 3 个包；**无 bundler**（Node 22 原生 TS 直跑） |
| M1-2 | 配置加载（含默认值、校验、`data/` 自动创建） | ✅ | 手写校验器 + `defineConfig`；**zod 留到 M2 替换**（M1 保持零依赖） |
| M1-3 | `node:http` 启动 + `/_sgw/api/health` + 优雅关闭 | ✅ | 含 `server.requestTimeout = 0`（ADR-14） |
| M1-4 | Edge：`/v1/**` 捕获、`rawHeaders` 逐跳头剥离、路径拼接、`writeHead`+`flushHeaders`+`pipe` | ✅ | 无 body 缓冲；无新增头 |
| M1-5 | Transport：`node:http(s)` 客户端 + keepAlive Agent + CA + abort 传播 | ✅ | **无 bodyTimeout**；长流不设上限 |
| M1-6 | 错误矩阵实现（[`00`](./00-agent-dev-spec.md) §7），4xx/5xx 原样透传、不重试 | ✅ | 网关自身错误带 `x-sgw-error` + `source: sgw-gateway` |
| M1-7 | 自环检测（上游 == 自己 → 拒绝启动） | ✅ | 配置加载期 + 启动前双重检查 |
| M1-8 | `scripts/point-codex.ts`（备份 → 改行 → 校验 → 打印回滚命令） | ✅ | 实现为 `.mjs`；拒绝 `wire_api="chat"` 与 `supports_websockets=true`；硬编码 `127.0.0.1` |
| M1-9 | **透传回归脚本** | ✅ | 断言上游 + A/B 双配置（absolute / append），覆盖 H1~H6 + gzip + SSE + 4xx + 控制面隔离 |

### M1 期间发现并修复的三个真实缺陷（都写进了回归断言）

1. **ADR-19 · absolute-form 请求行**：把完整 URL 传给 `http.request({ path })`，Node 发出
   `POST http://host/v1/x HTTP/1.1`，上游 `req.url` 变成绝对 URL。真实中继/WAF 很可能拒绝。
   → 修为只返回 origin-form，并加断言锁死。
2. **ADR-18 · `pathMode='absolute'` 语义含糊导致 bug**：曾被实现成"把入站 path 拼到 base 之后"，
   产生 `/v1/v1/echo-json`。→ 把三种模式的定义写成表（[`02`](./02-architecture-design.md) §4.3），加断言锁死。
3. **回归方法学缺陷**：用"直连同一 path"作为基线，在 `append` 模式下会失真；且回显体包含请求头，
   而网关**必须**剥离 `Connection` 里声明的头 —— 于是"响应体不同"是正确行为的副产品。
   → 改用双配置（`absolute` 做字节比对、`append` 单独验前缀语义）+ 明确区分 H2/H3 两个断言维度。

**M1 退出标准**

- [x] H1~H6 全绿（脚本化，可重复，59 条断言）
- [x] `tsc --noEmit` 零错误
- [x] 用真实 `sgw.config.ts` 启动 → `/health` 正常，上游显示 **reachable**
- [x] 一键回滚脚本已实测（`--status` / `--dry-run` / `--restore`）
- [ ] 真实 Codex 完成一个多轮任务 —— **待用户择机验证**（当前未改配置，避免打断正在使用中的 Codex）

---

## 4. M2 · 用量采集与存储（1–1.5 天）—— ✅ 已完成

**完成情况：80/80 回归断言通过**（`node scripts/observe-regression.mjs`）。

| # | 任务 | 状态 | 实现说明 |
|---|---|---|---|
| M2-1 | `teeForObservation`：单向分叉 + 有界缓冲 + 溢出丢弃计数 | ✅ | 主链路 `pipe` + 旁路 `data` 旁听；副本抛错只计数 |
| M2-1b | **宽限期排空**（客户端断开后继续读上游以取 usage） | ✅ | **实测踩坑**：`pipe` 到已销毁的 `res` 会 pause 源流，必须 `unpipe()` + `resume()` + `read()` 抽干 |
| M2-2 | SSE 增量解析器 | ✅ | 复用 `eventsource-parser`（分帧与多字节 UTF-8 是经典坑区） |
| M2-3 | 按 `Content-Encoding` 旁路解压 | ✅ | **实测修正**：改为「缓冲 + `finish()` 内同步解压」，避免流式解压的异步竞态 |
| M2-4 | Responses / JSON 事件语义 + usage 提取 | ✅ | 含 `cached_tokens` / `cache_write_tokens` / `reasoning_tokens` |
| M2-4b | **usage 完整性校验 + 精确缺失字段清单** | ✅ | `usageMissingFields` 直达 UI 告警文案（用户可转发给管理员） |
| M2-5 | `Estimator`（启发式，分段：CJK 1.6 / 拉丁 3.6 字符每 token） | ✅ | 流式计数，跨 chunk 代理对不丢；**不引入 tiktoken** |
| M2-6 | 计时打点（connect / headers / firstToken / total） | ✅ | 在热路径上只做 `hrtime` 一次相减 |
| M2-7 | `node:sqlite` schema + 迁移 | ✅ | 40 列明细表 + 3 张聚合表 + 10 个索引；`timeout: 5000` 显式传 |
| M2-8 | Recorder：200ms/64 条批量事务 + 幂等 + 重试 3 次 | ✅ | **实测踩坑**：占位符数量与列清单不一致（41 vs 40）导致**静默丢全部明细** → 已改为从列数组推导 + 启动期 schema 自检 |
| M2-9 | 内存累加器 → `rollup_hourly` / `daily_model` / `daily_session` | ✅ | **与明细同事务**，保证聚合与明细一致 |
| M2-10 | Session 归组（`session-id`） | ✅ | 不硬猜；缺失时 `session_id = NULL`，UI 显示"未归组" |
| M2-11 | 保留策略清理任务（按天 / 容量 / 正文目录 / 孤儿引用） | ✅ | 每小时一次 + 启动 30s 后一次；**聚合永不被删** |
| M2-12 | 假上游 fixture + 契约测试 | ✅ | 覆盖 complete / 缺字段 / 无 usage / gzip / 慢终止事件 |

---

## 5. M3 · 仪表盘与开关（2–3 天）—— ✅ 已完成

**完成情况：端到端冒烟 45/45 通过**（`node scripts/e2e-smoke.mjs`），前端构建产物 94KB gzip。

### M3-A 后端查询层
| # | 任务 | 状态 |
|---|---|---|
| M3A-1 | Analytics 只读连接 + 全部 `/_sgw/api/stats/*`（keyset 分页） | ✅ |
| M3A-2 | 分位直方图合并与插值 | ✅ 24 桶 × 4 字节 BLOB；合并 O(桶数) |
| M3A-3 | `/requests`、`/requests/:id`、`/requests/:id/body`（开关关 → 403 + 指引） | ✅ |
| M3A-4 | `GET/PATCH /settings`（zod 校验 + 热生效 + 广播） | ✅ 含"正文依赖明细"约束 |
| M3A-5 | `GET /_sgw/api/stream`（SSE 广播 + 心跳 + 事件 id） | ✅ 控制面流可自由加心跳（不受 H3 约束） |
| M3A-6 | CSV 流式导出、`POST /selftest`、`POST /upstream/test`、`DELETE /data`、`POST /backup`、`/prices` | ✅ |

### M3-B 前端
| # | 任务 | 状态 | 实现说明 |
|---|---|---|---|
| M3B-1 | 设计令牌落地（`tokens.css` 双主题）+ 深浅色切换 | ✅ | OKLCH 令牌 + Tailwind v4 `@theme`；`index.html` 内联脚本防 FOUC |
| M3B-2 | AppShell：侧栏 + TopBar + 时间范围 + **状态胶囊** | ✅ | 胶囊在正文开启时变警示色（反惊吓原则） |
| M3B-3 | 概览页：6 KPI + 堆叠面积 + 构成环形 + 排行 + 延迟直方图 + 最近请求 | ✅ | 手绘 SVG，**零图表库依赖** |
| M3B-4 | 请求明细页：6 维筛选 + 排序 + keyset 分页 | ✅ | URL 承载视图状态 |
| M3B-5 | 详情抽屉：耗时瀑布 + token 分项 + 元数据 + 正文按需加载 | ✅ | 抽屉而非跳转，保留列表上下文 |
| M3B-6 | 设置页：双开关 + 保留 + 上游热改 + **互操作自检** + 价格表 + 接入指引 | ✅ | 含"复制给中继管理员"的可执行说明 |
| M3B-7 | 实时刷新 | ✅ | 轮询（health 10s / meta 30s / 各页按需）；接口形状已对齐 SSE，可无缝切换 |
| M3B-8 | 空态 / 骨架屏 / 错误态 / 无障碍 | ✅ | 401/403 给出可执行的修复指引 |

### M3 期间发现并修复的产品缺陷
- **关闭明细会隐藏历史明细**（错误语义）：正确行为是"不再记录新请求"，历史数据应照常可见。
  已改为：历史有数据 → 照常返回 + warning + 开启指引；历史为空 → 额外给解释性 notice。
- **SPA fallback 覆盖过窄**：原来只匹配 `/` 与 `/assets/`，深层路由 404。已按 `Accept: text/html` 分派。
- **静态资源必须用绝对路径**：`base: './'` 在 hash 路由下会解析到错误目录。

---

## 6. M4 · 加固与交付（1 天）—— ✅ 已完成

| # | 任务 | 状态 | 结果 |
|---|---|---|---|
| M4-1 | TTFB 基准测试（N=200，A/B/D 交替轮换） | ✅ | **Δp50 +0.61ms · Δp95 +0.68ms**（阈值 2ms / 5ms）；Mann-Whitney 检验 p<0.001 说明增量真实存在但极小；**观测开启与关闭无统计学差异** |
| M4-1b | 内存 | ✅ | 空载 RSS ≈ **94MB**（目标 <120MB） |
| M4-2 | 边界用例（畸形 SSE / 半截流 / 非法 gzip / 5MB 响应 / 2MB 请求 / 超时 / 断连 / 50 并发） | ✅ | **35/35**（`scripts/robustness-regression.mjs`） |
| M4-2b | 长稳测试 | ✅ 脚本就绪 | `scripts/soak.mjs`（RSS 增长 <25% 且句柄不增长）；结果写入 `notes/soak-*.json` |
| M4-3 | README | ✅ | 顶层 `README.md`：快速开始 / 命令速查 / 已知限制 / 备份恢复 / 开机自启 / FAQ |
| M4-3b | 备份/恢复 | ✅ | `VACUUM INTO`（在线安全备份）+ 恢复步骤已写入 README |
| M4-3c | 开机自启文档 | ✅ | 计划任务与 NSSM 两种方式，给步骤不给脚本 |
| M4-3d | 发布前门禁 | ✅ | `scripts/verify-all.mjs` → **219 条断言，约 8 秒** |
| M4-4 | 文档回写 | ✅ | 本文档 + `docs/02` 新增 ADR-18~20 + `docs/03` 选型修正 |

### M4 期间发现并修复的实现缺陷（都靠"真实数据 + 截图"才暴露出来）

这一批缺陷有个共同特征：**回归断言全绿，但界面上的数字是错的或不完整的**。
说明"单元/集成断言"只能证明机制没坏，证明不了口径正确 —— 因此 M4 额外做了
"灌真实数据 → 截图 → 人眼核对"这一道工序。

1. **TTFB 口径错误（严重）**
   列表里 TTFB 显示成 `29865785.8min`。根因是 `TimingRecord` 里三个字段的类型注释写的是
   "时间戳"，但 DB 列 `t_upstream_connect` / `t_upstream_headers` / `t_first_token` 存的是
   "相对 enqueuedAt 的毫秒数"，`recorder` 直接把它们当绝对时间戳做减法。
   **修法**：把字段统一改名为 `upstreamConnectMs` / `upstreamHeadersMs` / `firstTokenMs`，
   让"绝对 vs 相对"在字段名上就看得出来，从根上消除歧义（而不只是改对一处减法）。

2. **失败请求的模型名丢失**
   429/500 这类响应没有 usage，上游也不回报模型名，于是这些记录落成 `model = unknown`，
   在"模型分布"里聚成一个无意义的条目。
   **根因**：观测器是在"收到上游响应头"之后才建立的，而失败请求恰恰没有响应体可观测。
   **修法**：把观测器提前到**转发之前**建立，响应头改为**惰性读取**（传函数而不是传值）；
   同时从请求体首片提取 `"model"` 作为兜底。
   修复后 `unknown` 计数从 15 → **0**。

3. **"响应形态"没有落库**
   排查"为什么这条没有 usage"时，无法区分 `binary`/`empty`（本来就不可能有）与
   `sse` 却没拿到 usage（真问题）。**修法**：新增 `observe_shape` / `observe_note` 两列并透出到详情抽屉。

4. **会话展示标签歧义**
   `/stats/by-session` 不返回标签，前端回落到 `title ?? 模型名`，导致三个不同会话在
   "最活跃会话"里显示成同一个模型名，看起来像重复项。
   **修法**：标签由后端统一给出（`title → externalId → ID 前缀`），前端不再自己拼。
   ⚠️ 这一版只修了"谁来决定标签"，没有修"标签的数据源"—— 试用期发现仍然歧义，见下面第 8 条。

5. **关闭明细会隐藏历史明细（产品语义错误）**
   正确语义是"不再记录**新的**请求"，历史数据应照常可见。已改为：
   历史有数据 → 照常返回 + warning + 开启指引；历史为空 → 额外给解释性 notice。

6. **SPA fallback 覆盖过窄 + 静态资源相对路径**
   原来只匹配 `/` 与 `/assets/`，深层路由 404；`base: './'` 在 hash 路由下会解析到错误目录。
   已改为按 `Accept: text/html` 分派 + `base: '/'`。

### 试用期（挂上真实 Codex 流量）发现并修复的缺陷

这一批有个共同特征：**合成上游永远发明文请求体、永远不发 `session-id`**，
所以此前 220 条断言全绿，问题却只在真实流量下出现。

7. **请求正文落盘成乱码（请求侧实体编码被完全忽略）**
   现象：详情抽屉里"请求正文"是乱码，而"响应正文"正常 —— 很容易误判成"前端渲染问题"。
   **根因**：Codex 用 `Content-Encoding: zstd` 压缩 `/responses` 请求体，而网关落盘时存的是
   **原始压缩字节**（响应侧一直没暴露，只因为上游返回的是明文 SSE）。控制面 `JSON.parse`
   失败后回落到 `buf.toString('utf8')`，界面上就是乱码。同一根因还有两个隐性后果：
   估算器把二进制噪声当文本计数（估算输入 token 失真）、请求体里的 `"model"` 正则匹配不到
   （失败请求又退回 `unknown`）。
   **修法**：请求体的 `Content-Encoding` 在**转发前**读取，`pipeline.finish()` 里**懒解码**
   一次供三处复用（估算 / 模型名兜底 / 落盘正文）；响应侧落盘同样按响应头编码解码；
   解码失败一律降级为原始字节并在 `observe_note` 里说明，**绝不丢数据**。
   回归：`observe-regression` 用例 13（含"上游收到的就是原始压缩字节"的 H1 断言）。

8. **会话标签歧义（第 4 条的修复并不彻底）**
   现象："最活跃会话"里出现两个一模一样的「未命名会话 · 01a13882-3」，外加一个 `gpt-6-sol`。
   **根因有三层**：① `session.title` 被 recorder 写成**模型名**（`model` / `model · endpoint`），
   于是出现以模型名命名的"会话"；② `session` 行只在 `writeDetailBatch` 里 upsert ——
   也就是**只在 Detail Mode 打开时**才写，而 `daily_session` 是聚合、恒写；
   关着明细跑过的会话因此查不到 `external_id`；③ 标签回落时截断成 ID 前 10 字符，
   而 ULID 前 10 字符只覆盖 48 位毫秒时间戳 + 2 位随机 —— 同一毫秒建立的两个会话前缀相同。
   另外 `sessionTouched` 这张"标题映射表"被写进内存后**从未落库**（死代码）。
   **修法**：`title` 不再写模型名（留 NULL，等真正的"首条 prompt 摘要"实现）；
   会话行改由**聚合路径**落库（与 `daily_session` 同源、不依赖 Detail Mode），
   顺带让死掉的 `sessionTouched` 真正生效；标签回落到**完整** session-id（唯一、可核对）；
   新增 v2 迁移：清掉历史模型名标题 + 从 `daily_session` 回填缺失的会话行。
   回归：`observe-regression` 用例 14。

9. **"测试上游 / usage 契约"永久挂起**
   现象：点设置页的自检按钮后界面一直转圈，服务端日志只有一行
   `未处理的 Promise 拒绝：TypeError: Cannot read properties of undefined (reading 'https')`。
   **根因**：`ControlContext.agents` 被声明为可选（`agents?: unknown`），`index.ts` 组装上下文时
   漏传，而路由里的 `agents: ctx.agents as never` 把这个错误**从类型检查里藏了起来**；
   探针在 Promise 执行器里同步抛错 → promise 被拒绝 → `void (async () => …)()` 无人接住 →
   请求永远不会得到响应。
   **修法**：`agents` 改为**必填**（漏接线直接编译失败）；新增 `runAsync()` 作为所有异步路由的
   统一收尾，异常一律变成可读的 500 —— 同类"悬挂"不可能再发生。
   回归：`observe-regression` 用例 15。

10. **估算成本显示成 `$0.0000?`（"没有价格"被当成"0 元"）**
    现象：概览 KPI「估算成本」和会话/模型排行里的成本，长期是一个带问号的 0。
    **根因**：价格表默认为空 → 金额恒为 0；而 `fmtCost()` 把 `costKnown=false` 渲染成
    `$0.0000?` —— 用户看到的既不是 0 也不能用，等于这个 KPI 从第一天起就是废的。
    更深一层：成本在**写入时**固化，所以即使后来补了价格，历史区间也永远是 0。
    **修法**：① 内置官方默认价格表（83 条，启动时**只插不覆盖**地播种，`meta['prices.seed_version']`
    保证用户删掉的行不会复活）；② 成本改为**读时**按当前价格表计算（聚合表保留完整 token 分项，
    重算精确、无需迁移，改价立刻反映到历史区间）；③ `fmtCost()` 把未知渲染成 `—`（部分缺价加 `≈`），
    并在概览与设置页列出**缺价模型**、支持前缀通配与一键补齐/重置。
    回归：`observe-regression` 用例 18。

11. **失败请求的估算用量污染了 token 与缓存命中率**（用户上报"缓存记录是不是有异常"）
    现象：缓存命中率长期偏低（实测 89.0% 显示成 61.1%），区间 token 虚高 23%。
    **根因两层**：① Codex 撞上 404 会立刻重试，每次重试的请求体都有 40KB，估算器把它算成
    33k「input token」记进账本 —— 但模型**从未被调用**；30 次重试累计 120 万虚假 input。
    ② 即使请求成功，本地估算的请求 `cached` 字段也恒为 0，而旧口径拿**全部** `input_tokens`
    当命中率分母，等于把"未知"当成"没命中"。
    **修法**：① 失败请求（无上游响应或 HTTP ≥ 400）**不再产生估算用量**（`PipelineOptions.isFailedResponse`
    惰性求值，`observe_note` 写明原因）；② 新增 `cache_known_input_tokens` 列，命中率分母只含
    "上游返回完整 usage"的输入；③ v3 迁移**逐键减掉**历史污染（聚合是加法累加的，减法精确），
    并把明细行归零为 `usage_source='none'`，避免"请求列表"与"概览"互相矛盾。
    本机实测：−1,204,815 input token，命中率 61.1% → 90.0%，成本从 0 变为 $2.87（补价格后）。
    回归：`observe-regression` 用例 16 / 17。

12. **"调通了却是估算"：长响应的 usage 必然丢失**（用户上报"为什么有些请求调通了、来源却是估算"）
    现象：15 条 `estimated` 里 9 条是 200 + SSE + `/v1/responses`，且都带 `✂` 截断标记；
    另有 5 条是 `/v1/alpha/search`（非 LLM 端点）、1 条是客户端按 Esc。
    **根因（两层，缺一不可）**：
    ① Responses 的 `usage` **只存在于流末尾的终止事件**，而 `tee` 与观测器都只保留响应**开头**
    的 512KB —— 一旦超限就**必然**丢 usage；旁证：9 条 >512KB 的全是估算，
    102 条 ≤462KB 的全是精确，两个集合完全不重叠，日志里 `observeTruncated` 恰好 9 次。
    ② `tee` 一旦超限就**停止投喂**观测器，于是连"尾部"都到不了观测器，`bytes_out` 也被少算。
    **修法**：① 观测器改为「头部 128KB + 尾部 384KB」（总内存不变），usage 从尾部捞、
    model/response.id/TTFT 从头部取，尾部单独用一个扫描器再合并（头部结尾是半截帧）；
    ② `tee` 只投喂与计数，**丢弃与否由观测器决定**；③ 解压后超限（高压缩比）同样按头尾切分；
    ④ 非 LLM 端点不再估算；⑤ 客户端中断 / 非 LLM 端点 / 截断的原因都写进 `observe_note`。
    回归：`observe-regression` 用例 19（含 gzip 高压缩比）与用例 20。

### M4 期间的额外加固
- 配置校验拒绝 `edge.requestTimeoutMs ≠ 0`（ADR-14 的强制项）
- 启动期 `assertSchemaMatches()` 自检：列清单与建表语句不一致时**立刻报错**而不是静默丢数据
- 日志按天轮转 + 保留 7 天（与数据保留策略统一在一处）
- `/v1/**` 的作用域铁律加了专门的回归断言（用例 7），防止将来"顺手加个校验"破坏 H2
- 发布前门禁把**前端类型检查**也纳入（原先只查服务端，前端错误漏检）

---

## 7. 工作量估算

| 里程碑 | 人日（人工） | AI Agent 辅助预估 | 说明 |
|---|---|---|---|
| M0 | 0.5–1 | 0.5 | 主要是观测与判断，代码量极小 |
| M1 | 1–1.5 | 0.5–1 | 透传逻辑少但需严谨；回归脚本占一半 |
| M2 | 1–1.5 | 0.5–1 | SSE 解析器与导出器是难点 |
| M3 | 2–3 | 1.5–2.5 | 前端页面数量决定上限 |
| M4 | 1 | 0.5 | 测试与文档 |
| **合计** | **5.5–8** | **3.5–5.5** | 不含 v2 特性 |

> **AI 辅助的加速比在"样板代码"上最高（前端页面、CRUD 端点），在"边界正确性"上最低（SSE 解析、逐跳头、透传回归）**。建议把后者留人工把关。

---

## 8. 验收标准（Definition of Done，四层）

### L1 功能验收
| ID | 标准 | 验证方式 |
|---|---|---|
| A1 | Codex 经网关可完成多轮对话 + 工具调用 + 推理，无功能差异 | 人工跑真实任务 3 次 |
| A2 | 用量统计与上游 `usage` 逐字段一致（精确命中场景） | 自动比对脚本 |
| A3 | 缺失 usage 时显示估算并标注 | 假上游注入无 usage 场景 |
| A4 | Detail / Body 双开关端到端生效且无需重启 | Playwright |
| A5 | 保留策略与一键清理生效，聚合不被误删 | Playwright + DB 断言 |
| A6 | 仪表盘 7 个路由可用、可下钻、可筛选 | Playwright 冒烟 |
| A7 | 实时推送 < 1s | 计时断言 |
| A8 | 一键回滚成功 | 手工 + 脚本幂等 |
| A9 | **长流不被掐断**：上游静默 6 分钟后恢复，连接仍存活 | 假上游计时测试 |
| A10 | **客户端中断仍能记账**：第 3s 断开、上游第 5s 发出终止事件 → usage 入账 | 假上游脚本 |
| A11 | **usage 完整性告警生效**：上游发缺 `total_tokens` 的终止事件 → UI 出现告警且响应字节未被改动 | 字节比对 + UI 断言 |

### L2 非功能验收
| ID | 标准 | 阈值 |
|---|---|---|
| B1 | TTFB 增量 | p50 < 2ms，p95 < 5ms |
| B2 | 空载内存 | RSS < 120MB |
| B3 | 50 并发流式内存 | RSS < 350MB |
| B4 | 空闲 CPU | < 0.5% |
| B5 | 长稳 4h | RSS 增长 < 15%，无 fd 泄漏 |
| B6 | 冷启动 | 到可服务 < 1s |
| B7 | 数据零外发 | 抓包/防火墙确认仅有上游连接 |

### L3 完整性验收
- [ ] 硬约束 H1~H10 全绿（[`00`](./00-agent-dev-spec.md) §9.1）
- [ ] 错误矩阵 11 种场景全部按预期行为（[`00`](./00-agent-dev-spec.md) §7）
- [ ] 越界检查清单（`00` §4）零违规
- [ ] **`pnpm i` 全程零原生编译**（`node:sqlite` 内置；无 node-gyp 输出）
- [ ] 两套主题对比度合规
- [ ] 无 `console.log` 泄漏敏感信息

### L4 交付物验收
- [ ] `README.md`：3 步接入 + 回滚 + FAQ
- [ ] 全部文档与实现一致（无"文档说了但没做"）
- [ ] 备份/恢复演练记录
- [ ] 已知限制清单（估算误差、明细关闭时的语义、v1 不做的事）

---

## 9. 测试策略

### 9.1 透传回归（H1~H5 的机械化验证）

```
步骤：
 ① 用同一份 fixture 请求（req.json，含 reasoning + tools + 中文 + 二进制安全字符）
 ② A 组：直连上游  curl --data-binary @req.json -H "Authorization: sk-…" https://upstream/v1/responses
 ③ B 组：经网关  curl --data-binary @req.json -H "Authorization: sk-…" http://127.0.0.1:8787/v1/responses
 ④ 断言：
    H1  sha256(req.json) 无关（同一份）→ 关键在上游侧收到的 body：用"回声上游"验证
    H2  回声上游返回它收到的头集合 → 断言 B 组头集合 ⊇ A 组，差值 ⊆ HOP_BY_HOP
    H3  sha256(响应体 A) == sha256(响应体 B)；x-request-id 相同
    H4  用回声上游返回它收到的 path+query → 断言与 A 组一致
    H5  断言回声上游看到的 Authorization 与发出的一致（未配置 key 替换时）
 ⑤ 压缩通道单独跑一遍（Accept-Encoding: gzip）验证字节一致
```
**回声上游**（`tests/fixtures/echo-upstream.ts`）：一个本地 HTTP 服务，把它收到的 method/path/query/headers/body-hash 以 JSON 返回，用于精确断言"上游到底看到了什么"。**这是验证 H1/H2/H4/H5 的关键工具**——不能用真实上游，因为真实上游不会告诉你它收到了什么。

### 9.2 假上游（可控 SSE 回放）
按脚本回放以下场景，逐一断言网关行为：
| 场景 | 断言 |
|---|---|
| 标准 Responses SSE（带 usage） | DB 字段与脚本中的 usage 完全相等 |
| SSE 无 usage | `source='estimated'`，估算值在合理区间 |
| gzip 压缩 SSE | 客户端收到原始压缩字节；usage 仍被提取 |
| 中途断开（半截 SSE） | 客户端收到已收到的部分；`error_class='upstream_stream_truncated'`；**不补 `[DONE]`** |
| 429 + JSON 错误体 | 状态码与 body 原样透传 |
| 慢首字节 5s | 网关不超时（`headersTimeoutMs` 默认 10s > 5s），TTFB 如实记录 |
| **上游静默 6 分钟后继续** | 连接**未**被掐断（验证 `requestTimeout=0`，无 `bodyTimeout`） |
| 客户端中途断开 | 上游连接被 abort（假上游能观察到 `close`） |
| 跨 chunk UTF-8 中文 | 解析不错字、不崩溃 |

### 9.3 TTFB 增量测量方法（可复现）
```
样本：N = 200 次（同一固定 prompt，关闭模型随机性影响：使用 max_output_tokens 固定的短请求）
分组：A 直连 / B 经网关，交替执行以消除时间漂移（A,B,A,B,…）
指标：记录每组 TTFB（首字节到达时间 - 请求发出时间）
统计：报告中位数差与 p95 差；用 Mann-Whitney U 检验判断差异是否显著
判据：p50 差 < 2ms 且 p95 差 < 5ms 视为通过
注意：本地回环测量受 Node 事件循环抖动影响，采样需在同一进程外进行（用独立脚本）
```

### 9.4 长稳与内存
- 4 小时、每 30s 一次请求（含 1/10 为流式长响应）
- 每 60s 采样 `process.memoryUsage().rss` + `activeHandles` 计数
- 判据：RSS 增长 < 15%，`activeHandles` 不单调增长（无泄漏）

---

## 10. 执行风险清单（与架构风险分开）

| # | 风险 | 概率 | 影响 | 应对 |
|---|---|---|---|---|
| E1 | **先做观测再做透传**，导致字节差异无法归因 | 中 | 高（返工） | 严格执行 M1 优先级；M1 完成前禁止提交任何 observe 代码（CI 检查 `observe/` 目录为空） |
| E2 | 假设 A1 错误（Codex 拒绝 http） | **低**（源码调研已证实纯 http 可用，无 scheme 白名单） | 高（阻塞接入） | M0-7 实测确认；mkcert 兜底与配置位已预留 |
| E2b ⚠️ | **上游 usage 缺 `total_tokens`** → Codex 整轮硬失败，且网关**无法修**（改字节就违反 H3） | 中 | **高** | M0-2b 提前断言；运行期 `usage_incomplete` 计数 + UI 常驻告警；README 写明"这是上游中继的问题，需联系管理员"，并给出"直连上游复现"的对比方法（观察点：探针输出、告警计数） |
| E2c | 用户误开 `supports_websockets` 或误用 `localhost` → 完全不可用 | 中 | 中高 | `point-codex.ts` 拒绝写入 WS 键 + 硬编码 `127.0.0.1`；README 顶格警示（观察点：Codex 报错文案、日志出现 `Upgrade: websocket`、`http://[::1]:8787`） |
| E3 | 上游 usage 字段名与 OpenAI 官方不一致 | 中 | 中 | 提取器做容错（`input_tokens`/`prompt_tokens` 双读）；M0 实测确认 |
| E4 | SSE 解析器在真实流量下遇到未预期帧 | 中 | 中 | 宽容解析 + 失败即降级为估算（绝不抛异常到主链路）；记录原始帧样本供分析 |
| E5 | 范围蔓延（想加限流/告警/多 Provider） | 高 | 中 | [`00`](./00-agent-dev-spec.md) §10 明确 Out of Scope；v2 候选登记在 [`01`](./01-requirements-and-scope.md) §2.3 |
| E6 | 前端页面数量膨胀（7 个路由）拖长 M3 | 中 | 中 | 先交 Overview + Requests + Settings（P0 三页），其余按 P1 顺延 |
| E7 | 正文落盘后忘记关，磁盘/隐私受损 | 中 | 中 | 状态胶囊常驻警示 + 默认 7 天自动清理 + 容量上限强制生效 |
| E8 | 单机调试时网关崩溃影响正常工作 | 中 | 中 | 一键回滚 + 启动自检 + 崩溃前 flush 尽力而为 |
| E9 | 长流被 Node 默认 300s `requestTimeout` 掐断（用户以为模型卡死） | **高（若不处理）** | 高 | M1 第一步就写 `server.requestTimeout = 0`；纳入 §9.2 长流存活测试（观察点：一次 >5min 的空闲流） |
| E10 | 时间统计口径不一致导致图表与表格对不上 | 中 | 低 | [`05`](./05-data-model-and-metrics.md) §5 指标字典为唯一口径；聚合与明细同源同事务 |
| — | ~~原生模块装不上~~ → **已消除**：选 `node:sqlite`（Node 内置），`pnpm i` 零原生编译 | — | — | 若将来确实需要精确 SQL 分位，需切 `better-sqlite3`（[`03`](./03-tech-stack-selection.md) §3.2），届时此项风险重新激活 |

---

## 11. 运维手册要点

| 场景 | 操作 |
|---|---|
| **日常启动** | `pnpm start`（或计划任务开机自启）；浏览器书签 `http://127.0.0.1:8787` |
| **回到直连** | `Copy-Item ~/.codex/config.toml.sgw-backup ~/.codex/config.toml -Force` |
| **DB 膨胀** | 设置页看占用 → 缩短 `detailDays`/`bodyDays` → 一键清理 → 确认聚合仍在 |
| **统计异常（全是估算）** | 检查上游是否改了返回结构 → 看 `data/logs/` 中 `usage_missing` 计数 → 跑 `/upstream/test` |
| **Codex 报错 5xx** | 看请求详情页对应记录的 `error_class` → 若是 `upstream_*` 则是上游问题；若网关自身错误会带 `x-sgw-error` |
| **备份** | 设置页「备份」→ `data/backup-YYYYMMDD.db`（`VACUUM INTO`，可在网关运行时执行） |
| **升级** | 停网关 → 备份 → 拉新代码 → `pnpm i && pnpm build` → 启动（自动迁移 + 迁移前自动备份） |
| **彻底卸载** | 回滚 config.toml → 删除项目目录（数据全在 `data/`） |

---

## 12. 上线检查单（Go-Live Checklist）

```
□ M0 探针报告已归档，8 项结论均有实测证据（尤其 M0-2b usage 字段完整性）
□ H1~H5 回归脚本全绿，且最近一次运行时间在 24h 内
□ 真实 Codex 任务跑通 3 次（含一次长任务、一次工具调用密集任务）
□ 长流存活已验证：上游静默 > 5 分钟未被掐断（server.requestTimeout = 0）
□ 客户端中断后仍能记账（宽限期排空生效）
□ TTFB 增量基准已完成并记录（p50/p95）
□ Detail Mode 默认关闭 ✓    Body Mode 默认关闭 ✓
□ /v1/** 路径不校验 Host/Origin/Token，且不读取 X-Gateway-Token（作用域铁律已测）
□ 未启用 WebSocket 代理，且 README 已警示不要开 supports_websockets
□ config.toml 示例中使用 127.0.0.1（非 localhost）
□ data/ 已在 .gitignore；无任何密钥进入版本库
□ 状态胶囊在 Body Mode 开启时显示警示色
□ 一键回滚命令已实测一次
□ 保留策略生效（可在设置页看到当前占用与下次清理）
□ 备份/恢复演练完成
□ 已知限制清单已写入 README（含"上游 usage 缺字段需联系中继管理员"）
```
