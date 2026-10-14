# SGW · Self Gateway

> **本地 AI 用量观测网关** —— 让 Codex 的请求原样穿过本机的一个轻量网关，把"什么时候、哪个会话、用了多少 token"记在你自己机器上。
>
> **状态：M1（透传）/ M2（观测记账）/ M3（仪表盘）已完成并验证；M4 加固进行中。**
> Node.js 22 LTS（**≥ 22.15**，见下）· TypeScript · **零运行时框架** · 无构建步骤（服务端）· 单进程单端口
>
> **Node 版本下限是 22.15**：Codex 会用 `Content-Encoding: zstd` 压缩 `/responses` 请求体，
> 解析/落盘它依赖 `zlib.zstdDecompressSync`（Node 22.15 / 23.8 才加入）。
> 低版本上仍可运行，但压缩请求体的正文副本会退化成原始字节（日志与详情抽屉会明确说明）。

---

## 三条铁律

| 铁律 | 含义 | 如何被证明 |
|---|---|---|
| **不改** | 请求体、请求头、响应体、响应头**字节级不变**（连未知头都不碰、不解压、不重分帧、不新增头） | `scripts/passthrough-regression.mjs` —— **59 条断言全绿** |
| **不慢** | 账在旁路记；观测溢出就丢观测，**绝不给主链路加背压** | `scripts/bench-latency.mjs` —— Δp50 **+0.6ms**、Δp95 **+0.7ms** |
| **不出本机** | 无遥测、无外发；正文默认不落盘；密钥只存指纹 | 代码内无任何网络目标（仅上游 + 回环）；`scripts/robustness-regression.mjs` |

---

## 快速开始

### 1. 准备配置（可选）

上游地址**不在仓库里写死** —— 启动后在仪表盘「设置 → 上游」手动填写即可（改完即时生效、
存本机 `data/sgw.db`，重启后仍然生效）。

如果你更愿意用配置文件：

```powershell
pnpm install
Copy-Item sgw.config.example.ts sgw.config.ts
# 可选：在 sgw.config.ts 里填 upstream.baseUrl 作为启动默认值
#       注意优先级低于设置页里填的值（settings 表 > sgw.config.ts > 内置默认值）
```

> `sgw.config.ts` 已被 `.gitignore` 忽略：每台机器的上游地址/端口都不同，不进版本库。

### 2. 构建仪表盘（一次即可）

```powershell
pnpm --filter @sgw/web build
```

### 3. 启动网关

```powershell
node apps/server/src/index.ts
```

启动日志里会打印一个**带令牌的仪表盘链接**，直接点开：

```
仪表盘：http://127.0.0.1:8787/?token=xxxxx
（首次访问会把这个令牌存入浏览器 localStorage；之后不再需要带在链接里）
```

### 4. 把 Codex 指向网关

```powershell
node scripts/point-codex.mjs --dry-run   # 先看看会改什么（不落盘）
node scripts/point-codex.mjs             # 自动备份 config.toml 后改 base_url
```

然后**重启 Codex**。验证：

```powershell
node scripts/point-codex.mjs --status    # 确认当前指向（只读）
```

### 5. 回滚（一条命令）

```powershell
node scripts/point-codex.mjs --restore
```

---

## 你会得到什么

| 页面 | 内容 |
|---|---|
| **概览** | 6 个 KPI（今日 token / 请求数 / 估算成本 / 失败率 / TTFB p95 / 缓存命中率）、Token 堆叠趋势、构成环形图、模型与会话排行、延迟直方图、最近请求 |
| **请求明细** | 按模型 / 状态 / 来源 / 耗时 / 关键字筛选；keyset 分页；点行打开**详情抽屉**（耗时瀑布、token 分项、Codex 身份头、正文按需查看） |
| **会话** | 按 `session-id` 归组的 token 排行 + 最慢请求列表 |
| **设置** | 明细/正文双开关、保留策略与一键清理、上游热改、**互操作自检**、透传自检、**价格表（内置官方默认值 + 缺价提示 + 一键补齐/重置）**、接入与回滚指引 |

**视觉方向（v2）：现代 SaaS 后台 + 轻量玻璃拟态 + Bento 卡片布局** —— 侧栏与顶栏是悬浮玻璃面板，页面用 12 列 Bento 网格排布卡片（只重排既有卡片的空间占比，不改信息架构）。玻璃只做一层 `backdrop-filter`，并靠 `--sgw-glass-alpha` 兜底：浏览器不支持 `backdrop-filter` 时自动退化为**实色不透明面板**。**深色优先，浅色可切换**（跟随系统），跟随 `prefers-color-scheme` 且无 FOUC。

---

## 两个开关（产品核心）

```
记录请求明细  [ ●———]  关掉后：不再写逐请求明细
记录请求/响应正文 [ ●———]  额外把 prompt/响应正文落盘（默认关，带隐私警示）
```

**关键设计：关掉明细后 KPI 仍然完整。**
聚合统计（小时/天/模型/会话）**永远在写**，只有逐请求明享受开关控制。
否则用户一关开关账本就直接归零，产品价值不复存在。

侧栏底部有一个**常驻状态胶囊**，随时告诉你当前在记什么（`仅聚合` / `记录明细` / `⚠ 记录正文`）。

---

## 互操作自检（本项目的额外价值）

Codex 的 `ResponseCompleted` 把 `response.id` / `usage.input_tokens` / `output_tokens` /
`total_tokens` 声明为**非 `Option`**。若中继返回的 `usage` 缺字段，Codex 会抛
`failed to parse ResponseCompleted: missing field total_tokens` 并**整轮对话失败**。

网关**不能修**这个（改字节就违反铁律，而且会掩盖中继的问题），但能**第一时间发现并告知**：

- 启动 30 秒后自动跑一次探针；设置页可手动触发
- 概览页与设置页出现红色横幅，并给出**可直接转发给中继管理员**的说明
- 明确写出"这不是网关的问题，也不是你配置的问题"

> 探测结论（`notes/` 归档）：直连用 `sk-` Key 得到 `403 This account only allows Codex official clients`，
> 用 ChatGPT access_token 得到 `401` —— 说明中继在验"客户端身份"。
> 但这**不影响本方案**：网关不伪造身份，它只透传；真实 Codex 能连通，透传的请求自然也能连通。

---

## 命令速查

```powershell
# 运行
node apps/server/src/index.ts              # 启动网关
pnpm dev                                   # 带 --watch 的开发模式
pnpm --filter @sgw/web dev                 # 前端 HMR（5173，自动代理到 8787）

# 验证（全部应全绿）
node scripts/passthrough-regression.mjs    # 59 条：H1~H6 透传字节不变
node scripts/observe-regression.mjs        # 114 条：usage 提取、契约、开关、宽限期排空、zstd 请求体、会话标签
node scripts/e2e-smoke.mjs                 # 45 条：真实链路 + SPA + 全部 API
node scripts/robustness-regression.mjs     # 36 条：畸形 SSE、大 body、超时、并发
node scripts/bench-latency.mjs --n 200     # 性能：TTFB 增量
node scripts/soak.mjs --minutes 8          # 长稳：RSS 与句柄泄漏

# 探针
node scripts/probe-upstream.mjs            # 直连探针（身份矩阵 + usage 契约）
node scripts/echo-upstream.mjs             # 回声上游：捕获真实 Codex 的请求头与体

# 接入
node scripts/point-codex.mjs --status      # 只读查看
node scripts/point-codex.mjs --dry-run     # 预览改动
node scripts/point-codex.mjs               # 应用（自动备份）
node scripts/point-codex.mjs --restore     # 回滚

# 类型门禁
pnpm typecheck
```

---

## 已实测的结论

| 项目 | 结果 |
|---|---|
| 透传字节不变（H1~H6） | ✅ 59/59（含中文、emoji、大整数、转义字符、gzip、SSE、4xx 透传） |
| 观测与记账正确性 | ✅ 166/166（精确 usage、缺字段告警、估算兜底、gzip 旁路解压、宽限期排空、zstd 请求体、会话标签、**失败请求不计量**、**缓存口径**、**默认价格与读时成本**、**超长响应仍取精确 usage**、**非 LLM 端点不估算**） |
| 端到端可用性 | ✅ 45/45（真实链路 → 记账 → 全部统计 API → SPA 资源） |
| 健壮性 | ✅ 36/36（畸形 SSE、半截流、非法 gzip、5MB 响应、2MB 请求、超时、50 并发无串号） |
| **TTFB 增量** | ✅ Δp50 **+0.61ms**、Δp95 **+0.68ms**（阈值 2ms / 5ms） |
| 观测自身开销 | ✅ 与关闭观测相比无统计学差异（开启后 Δp50 仅 +0.02ms） |
| 内存 | ✅ 空载 RSS ≈ 94MB（目标 <120MB） |
| **长稳（8 分钟）** | ✅ 307 请求 / 307 条记账（**零丢失**）· RSS 增长 **8.15%**（阈值 25%）· 句柄恒为 8（无泄漏） |
| 运行时依赖 | ✅ 服务端 3 个（`zod` / `pino` / `eventsource-parser`），**零原生模块** |
| 类型检查 | ✅ `tsc --noEmit` 零错误 |
| **发布前门禁** | ✅ `pnpm verify` → **306 条断言，约 10 秒** |

### 数据正确性（靠"灌真实数据 + 人工核对界面"发现并修掉的）

回归断言全绿 ≠ 界面数字正确。M4 专门做了一道"真实数据 → 截图 → 人眼核对"，
之后又把真实 Codex 流量挂上来跑，合计抓出 8 个缺陷：

| 缺陷 | 现象 | 根因与修法 |
|---|---|---|
| 计时单位混淆 | TTFB 显示 `29865785.8min` | `*At` 命名暗示绝对时间戳，实际存相对毫秒 → 字段改名 `upstreamHeadersMs` 等（ADR-22） |
| 失败请求丢失模型名 | 模型分布多出 `unknown` 条目（15 条） | 观测器在收到响应头后才建立，而失败请求没有响应体可观测 → 改为**转发前建立** + 响应头惰性读取（ADR-21）；修复后 `unknown` = 0 |
| 响应形态未落库 | 无法区分"本来就没 usage"与"该有却没有" | 新增 `observe_shape` / `observe_note` 两列并透出到详情抽屉 |
| 会话标签歧义 | 三个不同会话显示成同一个模型名 | 标签改由后端统一给出（`title → externalId → ID 前缀`）；**但这一版没修彻底**，见本表最后一行「会话标签仍歧义」 |
| 关明细隐藏历史 | 关掉开关后历史明细也看不到了 | 正确语义是"不再记录新请求"，历史照常返回 + warning |
| SPA fallback 过窄 | 深层路由 404 | 改按 `Accept: text/html` 分派；静态资源改绝对路径 |
| **请求正文乱码** | 详情抽屉里"请求正文"是乱码，返回值却正常 | Codex 用 `Content-Encoding: zstd` 压缩 `/responses` 请求体，落盘时却原样存了压缩字节（控制面 `JSON.parse` 失败 → 回落 `toString('utf8')`）→ **落盘前按请求头的实体编码解码**（估算器与模型名兜底同步受益） |
| **会话标签仍歧义** | "最活跃会话"里两个「未命名会话 · 01a13882-3」+ 一个 `gpt-6-sol` | ① `session.title` 被写成模型名；② `session` 行只在 Detail Mode 下写，关着明细跑过的会话没有行 → 标签回落到**非唯一**的 ID 前 10 字符（ULID 同毫秒前缀相同）。修法：title 不再用模型名 + 会话行改由**聚合路径**落库 + 标签回落不截断 + v2 迁移回填历史会话 |
| **"测试连通性"永久挂起** | 点「测试上游 / usage 契约」后界面一直转圈，日志只有一行 `unhandledRejection` | `ControlContext.agents` 是可选字段且 `index.ts` 漏接线，被 `as never` 挡住了类型检查 → 改为**必填**；所有异步路由统一经 `runAsync()` 收尾，异常一律变成可读的 500 而不是悬挂 |
| **估算成本显示成 `$0.0000?`** | 概览 KPI 与模型分布里的成本是个"带问号的 0" | 价格表默认为空 → 金额恒为 0；而"没有价格"被当成"0 元"渲染。修法：① 内置**官方默认价格表**（启动即播种，只插不覆盖，可在设置页改）；② 成本改为**读时**按当前价格表计算（改价立刻反映到历史区间）；③ `fmtCost` 把"未知"渲染成 `—`（部分缺价加 `≈`），并列出缺价模型（ADR-24） |
| **失败请求污染缓存命中率** | 缓存命中率长期偏低（实测 89% 显示成 61%），区间 token 虚高 23% | Codex 撞 404 后重试，每次请求体 40KB 被本地估算成 33k input token 记进账本 —— 但模型从未被调用。30 次重试累计 120 万虚假 input（cached 恒为 0）压低了命中率。修法：① 失败请求（无上游响应或 HTTP ≥ 400）**不再产生估算用量**；② 缓存命中率分母改为"缓存信息可信的 input"（新增 `cache_known_input_tokens` 列）；③ v3 迁移逐键减掉历史污染（本机实测 −1,204,815 input，命中率 61.1% → 90.0%） |
| **调通了却显示"估算"** | 15 条估算里 9 条是 200 + SSE，且都带 `✂` 截断标记 | Responses 的 `usage` **只存在于流末尾的终止事件**，而 tee 与观测器都只保留响应**开头** 512KB → 超限就**必然**丢 usage（旁证：9 条 >512KB 全是估算、102 条 ≤462KB 全是精确，两集合完全不重叠）。修法：① 观测缓冲改「头 128KB + 尾 384KB」（内存不变），usage 从尾部捞；② tee 只投喂不丢弃（旧实现超限即停止投喂，`bytes_out` 也被少算）；③ 解压后超限同样切头尾；④ 非 LLM 端点（`/v1/alpha/search`）不再估算；⑤ 截断/中断/非 LLM 的原因写进 `observe_note`（ADR-25） |

---

## 目录结构

```
self-gateway/
├─ apps/
│  ├─ server/src/
│  │  ├─ index.ts            # 组装入口（唯一允许"接线"的地方）
│  │  ├─ config/             # zod 校验 + pino 日志 + 脱敏
│  │  ├─ transport/          # 对上游：node:http(s) + 路径拼接（H1~H5 承重墙）
│  │  ├─ edge/               # 对客户端：代理热路径 + 错误矩阵（H6 承重墙）
│  │  ├─ observe/            # 旁路观测：tee / SSE 解析 / 估算 / 契约探针
│  │  ├─ recorder/           # 唯一写 DB 的地方：批量事务 + 聚合累加 + 清理
│  │  ├─ analytics/          # 只读聚合（禁止出现 INSERT/UPDATE/DELETE）
│  │  ├─ control/            # /_sgw/api/* + 令牌 + 自检 + 维护任务 + 事件总线
│  │  └─ db/                 # node:sqlite schema 与 KV
│  └─ web/                   # Vite + React 19 + Tailwind v4（不引入组件库/图表库）
├─ packages/shared/src/      # 类型契约 + 逐跳头 + 错误分类 + ULID + 分位直方图
├─ scripts/                  # 回归 / 探针 / 基准 / 接入脚本
├─ docs/                     # 8 份设计文档（需求→架构→选型→UI→数据→路线图）
└─ data/                     # 运行时数据（.gitignore）：sgw.db / bodies/ / logs/
```

---

## 已知限制（诚实清单）

1. **不做 WebSocket 代理**。Codex 的 `supports_websockets` 默认为 `false`；若你手动打开它，网关会明确返回 `501` 并在设置页提示关掉。
2. **分位是近似值**。基于 24 桶固定直方图插值（为了把分位查询从 O(行数) 降到 O(桶数)），精度受桶宽限制，UI 已标注。
3. **成本是本地估算**。按**可编辑价格表**计算，仅供参考；实际计费以公司账单为准。
   出厂内置官方定价（USD / 1M tokens），自建中继改名或改价的模型请在设置页修正；
   **缺价格的模型显示 `—`（不是 0 元）**。成本按当前价格表实时计算，改价后历史区间同步更新。
4. **无上游 usage 时退化**为启发式估算（±5–15% 误差），UI 显示 `估算` 徽标。
   **失败请求（无上游响应或 HTTP ≥ 400）不估算、不计量** —— 模型没被调用就不该有 token。
   长响应不再因此退化：观测缓冲保留「头部 + 尾部」，流末尾的 usage 一定在观测范围内（ADR-25）。
   **非 LLM 端点**（`/v1/alpha/search` 之类）不做本地估算，避免凭空产生 token。
5. **同用户的其他本地进程**仍能读取 `data/.token`；令牌只提高门槛，OS 用户边界才是真正的控制点。
6. **不做协议转换**（Responses ↔ chat/completions）、不做限流/配额熔断、不做多 Key 轮询 —— 见 `docs/00` §10。
7. **长稳测试**目前为 8 分钟量级；4 小时级 soak 建议在正式长期使用前跑一次（`pnpm` 脚本已就绪）。

---

## 备份与恢复

```powershell
# 在线备份（VACUUM INTO，安全且紧凑）—— 也可在设置页点「备份数据库」
node -e "const{openDb}=await import('./apps/server/src/db/index.ts');const{createRecorder}=await import('./apps/server/src/recorder/index.ts');const{createLogger}=await import('./apps/server/src/config/logger.ts');const db=openDb({dataDir:'./data',log:createLogger({level:'fatal',silent:true})});const r=createRecorder({db,log:createLogger({level:'fatal',silent:true}),dataDir:'./data'});console.log(r.backup());" --input-type=module
```

**恢复**：停止网关 → 用备份文件覆盖 `data/sgw.db`（并删除 `sgw.db-wal` / `sgw.db-shm`）→ 启动。

**迁移**：`meta.schema_version` 记录版本；升级时自动建表，并在需要迁移时提示。

---

## 开机自启（Windows，可选）

```powershell
# 方式一：任务计划程序（推荐，无需额外软件）
$action  = New-ScheduledTaskAction -Execute "node.exe" `
  -Argument "apps\server\src\index.ts" -WorkingDirectory "C:\Workspace\AI\self-gateway"
$trigger = New-ScheduledTaskTrigger -AtLogOn
Register-ScheduledTask -TaskName "SGW Self Gateway" -Action $action -Trigger $trigger `
  -Description "本地 AI 用量观测网关" -RunLevel Limited

# 方式二：NSSM 注册为服务
nssm install SGW "C:\Program Files\nodejs\node.exe" "apps\server\src\index.ts"
nssm set SGW AppDirectory "C:\Workspace\AI\self-gateway"
nssm start SGW
```

---

## 常见问题

**Q：Codex 报 `error sending request for url (http://localhost:8787/...)`**
用 `127.0.0.1` 而不是 `localhost`。Codex 存在 `localhost` 优先解析 IPv6 的已知缺陷（[openai/codex#21773](https://github.com/openai/codex/issues/21773)）。`point-codex.mjs` 已硬编码 `127.0.0.1`。

**Q：Codex 突然报 `failed to parse ResponseCompleted: missing field total_tokens`**
去设置页看顶部的红色横幅。这是**上游中继的 usage 结构不完整**，不是网关或你的配置问题。页面提供了可直接转发给管理员的说明。网关不会替你修改响应字节。

**Q：仪表盘打开是 401 / 403**
- 401：缺少本地令牌。打开启动日志里的 `?token=…` 链接一次即可。
- 403：Host 不在白名单。请用 `http://127.0.0.1:端口` 访问。

**Q：为什么关掉明细后请求列表是空的，但概览还有数？**
这是设计：明细开关只控制"是否记录逐请求元数据"，聚合统计**永远在写**，所以 KPI 与趋势不受影响。列表页会给出明确提示与开启指引；已存在的历史明细也**不会被隐藏**。

**Q：网关会不会拖慢 Codex？**
实测 Δp50 +0.61ms、Δp95 +0.68ms（本地最小上游，N=200，Mann-Whitney 检验）。观测开启与关闭之间无统计学差异。真实使用中的瓶颈在上游排队与模型推理，不在网关。

**Q：把我的 prompt 存下来了吗？**
默认**没有**。「记录请求/响应正文」是独立开关，默认关闭，且需要先开明细。开启后正文存放在 `data/bodies/`，默认 7 天自动清理，可一键清空。

---

## 文档索引

| 文档 | 内容 |
|---|---|
| [`docs/00-agent-dev-spec.md`](docs/00-agent-dev-spec.md) | 10 条硬约束、模块边界、接口契约、错误矩阵、验收门槛 |
| [`docs/01-requirements-and-scope.md`](docs/01-requirements-and-scope.md) | 需求、用户故事、FR/NFR、待验证项 |
| [`docs/02-architecture-design.md`](docs/02-architecture-design.md) | 全景图、**25 条 ADR**、请求生命周期、观测器、数据面、安全 |
| [`docs/03-tech-stack-selection.md`](docs/03-tech-stack-selection.md) | 逐层选型 + 否决理由 + 实测证据 |
| [`docs/04-ui-ux-style-guide.md`](docs/04-ui-ux-style-guide.md) | 页面线框、设计令牌（双主题）、组件与图表规范 |
| [`docs/05-data-model-and-metrics.md`](docs/05-data-model-and-metrics.md) | SQLite DDL、指标字典、分位直方图、控制面 API |
| [`docs/06-roadmap-acceptance-risks.md`](docs/06-roadmap-acceptance-risks.md) | 里程碑、四层验收、测试策略、风险清单 |
| [`docs/README.md`](docs/README.md) | 文档导航与实现进度 |
