# SGW · Self Gateway

> **本地 AI 用量观测网关** —— 让经过公司 sub2api 中继的 Codex 请求原样穿过本机的一个轻量网关，在你自己的机器上记下"什么时候、哪个会话、用了多少 token"。
>
> **状态：M1（透传）/ M2（观测记账）/ M3（仪表盘）/ M4（加固交付）已完成并验证。**
> 发布前门禁：`node scripts/verify-all.mjs` → **219 条断言全绿**，耗时约 8 秒。
> 运行：`node apps/server/src/index.ts`（Node 22.23.3，服务端 3 个运行时依赖、无构建步骤）。

---

## 当前实现进度

| 里程碑 | 状态 | 证据 |
|---|---|---|
| **M0** 协议探针 | ✅ 已完成 | [`scripts/probe-upstream.mjs`](../scripts/probe-upstream.mjs) · [`scripts/echo-upstream.mjs`](../scripts/echo-upstream.mjs) · 报告在 `notes/` |
| **M1** 纯透传骨架 | ✅ 已完成 | [`scripts/passthrough-regression.mjs`](../scripts/passthrough-regression.mjs) → **59/59** |
| **M2** 用量采集与存储 | ✅ 已完成 | [`scripts/observe-regression.mjs`](../scripts/observe-regression.mjs) → **80/80** |
| **M3** 仪表盘与开关 | ✅ 已完成 | [`scripts/e2e-smoke.mjs`](../scripts/e2e-smoke.mjs) → **45/45**；前端 94KB gzip |
| **M4** 加固与交付 | ✅ 已完成 | 健壮性 **36/36** · 性能 Δp50 **+0.61ms** · 长稳 RSS +8.15%（307 请求零丢失）· 发布前门禁 **220 条断言** |

**架构上的最终形态**（与设计文档的差异均已在 `02` 的 ADR 中登记）

```
apps/server/src/
├─ index.ts        组装入口（唯一"接线"处）
├─ config/         zod 校验 · pino 日志 · 脱敏
├─ transport/      node:http(s) 客户端 · 路径拼接（H1~H5 承重墙）
├─ edge/           代理热路径 · 错误矩阵（H6 承重墙）
├─ observe/        tee · SSE 解析 · 估算器 · usage 契约探针
├─ recorder/       唯一写 DB：批量事务 · 聚合累加 · 保留清理
├─ analytics/      只读聚合（禁止 INSERT/UPDATE/DELETE）
├─ control/        /_sgw/api/* · 令牌 · 自检 · 维护 · 事件总线
└─ db/             node:sqlite schema 与 KV
```

**已交付的能力**

```powershell
pnpm start                 # 启动网关（Node 22 原生 TS，无构建）
pnpm verify                # 跑完所有验证（220 条断言，约 10 秒）
pnpm bench                 # TTFB 增量基准（N=200）
pnpm soak                  # 长稳测试
pnpm point:status          # 查看 Codex 当前指向（只读）
pnpm restore               # 一键回滚到直连
```

- ✅ `/v1/**` 透明转发（responses / models / 任意路径，含 SSE 流式、gzip）
- ✅ 逐跳头剥离（含 `Connection` 中列出的动态头，RFC 9110 §7.6.1）
- ✅ 请求体/响应体字节级透传，**不解压、不重分帧、不新增任何头**
- ✅ 上游 `Authorization` 原样透传（`replaceAuth` 默认关闭）
- ✅ usage 精确提取（含 `cached_tokens` / `cache_write_tokens` / `reasoning_tokens`）
- ✅ **usage 契约自检 + 告警**（缺字段会让 Codex 整轮失败 —— 本项目最有价值的附加功能）
- ✅ 无 usage 时启发式估算，UI 显式标注 `估算`
- ✅ **宽限期排空**：客户端按 Esc 后仍能记到 usage
- ✅ 聚合恒写 + 明细受开关控制（关明细不掉 KPI）
- ✅ 错误矩阵 + `x-sgw-error` 标注（区分"网关问题"与"上游问题"）
- ✅ 反 DNS Rebinding（Host 白名单）+ `/v1/**` 作用域隔离 + 本地令牌
- ✅ 保留策略、一键清理、CSV 导出、`VACUUM INTO` 备份
- ✅ 仪表盘 4 页：概览 / 请求明细（详情抽屉+瀑布图）/ 会话 / 设置
- ✅ 双主题（深色优先，跟随系统，无 FOUC）

**仍明确不做**

- ❌ WebSocket 代理（收到 upgrade 明确返回 501 并提示关闭 `supports_websockets`）
- ❌ 协议转换、prompt 改写、限流/配额熔断、多 Key 轮询
- ❌ 精确 SQL 分位（用直方图近似替代，UI 已标注）
- ❌ 多用户 / 云端同步 / 移动端

---

## 这是什么（30 秒版）

```
Codex ──► http://127.0.0.1:8787/v1 ──► 本机网关 ──► https://relay.example.com/v1 ──► 模型
            （只改 config.toml 一行）      │        （上游地址在设置页手动填写，可热改）
                                            └──► 旁路记账 ──► 本地 SQLite ──► 现代化仪表盘
```

**三条铁律**

1. **不改**：请求体、请求头、响应体、响应头**字节级不变**（连未知头都不碰）
2. **不慢**：账在旁路记，观测溢出就丢观测，**绝不给主链路加背压**（首字节延迟增量 p95 < 5ms）
3. **不出本机**：无遥测、无外发；正文默认不落盘；密钥只存指纹

---

## 文档索引

| # | 文档 | 读者 | 内容 |
|---|---|---|---|
| **00** | [Agent 开发定义文档](./00-agent-dev-spec.md) | **编码 Agent（首选入口）** | 10 条硬约束、模块边界、接口契约、错误矩阵、实现顺序、验收门槛 |
| **01** | [需求与范围说明书](./01-requirements-and-scope.md) | 产品 / 决策者 | 痛点、目标与非目标、用户故事、功能与非功能需求、待验证项 |
| **02** | [架构设计说明书](./02-architecture-design.md) | 架构 / 后端 | 全景图、25 条 ADR、请求生命周期、观测器设计、数据面实现、安全、部署 |
| **03** | [技术选型说明书](./03-tech-stack-selection.md) | 架构 / 后端 / 前端 | 逐层选型 + **否决理由**、三条实测证据、版本基线、与 Codex 的对接约束 |
| **04** | [UI/UX 与视觉规范](./04-ui-ux-style-guide.md) | 前端 / 设计 | 页面线框、**完整设计令牌**（双主题）、组件规范、图表规范、无障碍 |
| **05** | [数据模型与指标体系](./05-data-model-and-metrics.md) | 后端 / 数据 | SQLite DDL、设置项、指标字典、分位直方图、控制面 API 契约、保留策略 |
| **06** | [路线图·验收·风险](./06-roadmap-acceptance-risks.md) | 项目 / QA | M0~M4 里程碑、工作量、四层验收标准、测试策略、风险清单、运维手册 |

**建议阅读顺序**：决策者读 `01` → 架构师读 `02`+`03` → 前端读 `04` → 后端读 `05` → 项目经理读 `06` → **Agent 从 `00` 开始**。

**调研底稿**（证据来源，非交付规范）
- [`_research/codex-gateway-research.md`](../_research/codex-gateway-research.md) — Codex / sub2api **源码级**调研（Rust 与 Go 源码、openai-python 类型、RFC 9110）
- [`research/ai-usage-gateway-tech-research.md`](../research/ai-usage-gateway-tech-research.md) — 技术选型**本机实测**报告（Node 22.23.3 / SQLite 3.51.3，含 100 万行基准）

---

## 已确认的关键决策

| 议题 | 决策 |
|---|---|
| 暴露方式 | `http://127.0.0.1:8787/v1`（纯 HTTP 回环，零证书摩擦；mkcert HTTPS 仅作兜底） |
| UI 风格 | **Modern Dark DevTools · 深色优先 + 浅色可切换**（跟随系统，无 FOUC） |
| 存储 | 单文件 SQLite（`node:sqlite`）+ 明细可关 + 自动清理；**聚合恒写，明细受开关控制** |
| 运行时 | Node.js + TypeScript（**以 Node 22.23.3 为准**；原生 TS 直跑，无构建步骤） |
| 运行时依赖 | **M1：0 个**。M2+ 计划共 3 个：`zod` / `pino` / `eventsource-parser`。零原生模块、零框架、零打包 |

---

## 四个"如果不做就会踩坑"的发现

这些不是理论风险，是从源码与实测中挖出来的、会真实毁掉项目的问题：

### 1. 用 `fetch` 做代理，从原理上不可能满足"不改请求头"
原生 `fetch` 对 `connection`/`transfer-encoding`/`content-length`/`keep-alive` **直接抛 `TypeError`**（而代理必然收到这些头），并且会**注入** `accept`、`accept-language`、`sec-fetch-mode`、`user-agent`、`accept-encoding`。
→ 因此选 **`node:http` 客户端**：能拿到 `rawHeaders`，保留原始大小写与重复头，且不会自动解压。
（另：`@fastify/reply-from ≤ 12.6.1` 有一个 CRITICAL CVE，正是 `Connection` 头滥用导致代理注入头被剥离——这从反面印证了"手写这 60 行头处理"的价值。）

> **实现期额外发现（ADR-19）**：还有第二个更隐蔽的坑 —— 若把**完整 URL** 交给 `http.request({ path })`，Node 会原样发出 **absolute-form 请求行**（`POST http://host/v1/x HTTP/1.1`，RFC 7230 §5.3.2），上游 `req.url` 会变成绝对 URL。真实中继/WAF 很可能因此拒绝。回归脚本现在有一条断言专门锁死"上游收到的必须是 origin-form"。

### 2. Node 默认会在 5 分钟后掐断你的流
`node:http` **服务端** `requestTimeout` 默认 `300_000ms`。LLM 推理静默超过 5 分钟是正常现象，而 Codex 自己的 `stream_idle_timeout_ms` 也是 300s、且会**重连 5 次**——于是你看到的是"Codex 莫名其妙卡住重连"，而不是一个干净的错误。
→ 必须 `server.requestTimeout = 0`，且写入 M1 的第一步。

### 3. 客户端一断就 abort 上游，等于这一轮永远记不到账
usage **只存在于终止事件** `response.completed`。用户按 Esc 时若立刻 abort 上游，就再也拿不到 usage——而这恰恰是最需要记账的高价值场景。
→ 采用**宽限期排空**（默认 8s）：客户端断开后继续读上游，直到拿到终止事件再 abort。sub2api 自己就是这么做的。

### 4. 上游的 `usage` 缺一个字段，会让 Codex 整轮失败
Codex 的 `ResponseCompleted` 把 `input_tokens`/`output_tokens`/`total_tokens`/`response.id` 声明为**非 `Option`**：缺 `total_tokens` 时它不降级，而是抛 `failed to parse ResponseCompleted: missing field total_tokens`。
→ 这**不是**网关能修的（改字节就违反铁律 1），但网关能**第一时间发现并告诉你**：启动探针 + 运行期 `usage_incomplete` 告警。这是本网关超出"统计用量"之外的额外价值。

---

## 快速上手（实现完成后）

```powershell
pnpm install && pnpm start        # 启动网关
start http://127.0.0.1:8787       # 打开仪表盘
pnpm tsx scripts/point-codex.ts    # 一键把 Codex 指向网关（自动备份）
```

```toml
# C:\Users\<你>\.codex\config.toml —— 只改这一行
[model_providers.OpenAI]
base_url = "http://127.0.0.1:8787/v1"
```

**回滚**
```powershell
Copy-Item "$env:USERPROFILE\.codex\config.toml.sgw-backup" "$env:USERPROFILE\.codex\config.toml" -Force
```

> ⚠️ **用 `127.0.0.1`，不要写 `localhost`**：Codex 对 localhost 存在优先解析 IPv6 的已知缺陷。
> ⚠️ **不要设置 `supports_websockets`**：本网关只做 HTTP，不代理 WebSocket（收到 upgrade 会明确返回 501）。

### 探针实测结论（M0，已归档在 `notes/`）

| 项 | 结论 |
|---|---|
| Codex 是否接受纯 `http://127.0.0.1` | ✅ 源码无 scheme 白名单；`http→ws` 映射证明它预期非 TLS base_url |
| 上游 `/v1/responses` 是否可达 | ✅ 网关探测显示 **reachable**（`/models` 有响应） |
| 直连探测是否成功 | ⚠️ 用 `config.toml` 的 `sk-` Key 直发得到 **403** `This account only allows Codex official clients`；用 ChatGPT access_token 得到 **401** —— 说明中继在验"客户端身份"，而**真实 Codex 当前工作正常**，因此网关只要真透传就能用 |
| 上游 usage 字段完整性（M0-2b） | ⏳ 待真实流量经过时自动确认（`/_sgw/api/health` 的 `usageContract` 字段会反映） |

> 403 那条恰好验证了设计取向：**网关不伪造身份**，它只透传。真实 Codex 能连通，透传的请求自然也能连通。

---

## 当前不做（v1 边界）

多用户 · 协议转换 · prompt 改写 · 限流/配额熔断 · 多 Key 轮询 · WebSocket 代理 · 云端同步 · 移动端

已登记的 v2 候选见 [`01`](./01-requirements-and-scope.md) §2.3。
