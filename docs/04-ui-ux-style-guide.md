# SGW UI/UX 与视觉规范

> 项目：**SGW / Self Gateway**
> 风格定位：**Modern SaaS Console · 轻量玻璃拟态 · Bento 卡片布局 · 深色优先，浅色可切换**
> 版本：v2.0 · 设计冻结
> 前置阅读：[`01-requirements-and-scope.md`](./01-requirements-and-scope.md) §4.4 · [`05-data-model-and-metrics.md`](./05-data-model-and-metrics.md)

---

## 1. 设计原则

| 原则 | 含义 | 反面教材 |
|---|---|---|
| **数字优先** | 首屏回答"我今天花了多少"，KPI 是主角，图表是配角 | 一进来先看到一堆筛选器 |
| **可核对** | 任何聚合数字都能下钻到原始请求行 | 只给一张漂亮的图，点不进去 |
| **诚实标注** | 估算值、截断值、缺失值必须显式标注，不伪装成精确 | 把估算 token 当精确值展示 |
| **零惊吓** | 网关是透明的：UI 上永远能看到"是否在记录正文"的状态 | 偷偷记录正文 |
| **低认知负荷** | 单页信息层级 ≤ 3 层；抽屉而非跳转，保留上下文 | 点详情就离开列表，回来筛选项丢了 |
| **克制的动效** | 只服务于"数据在变"的感知，不做装饰性动画 | 卡片依次飞入 |

**一句话气质**：*像一个精密仪表盘，而不是一个营销落地页。*

---

## 2. 信息架构与路由

```
/                        概览 Overview      ← 默认首页
/trends                  趋势 Trends
/models                  模型分布 Models
/requests                请求明细 Requests   ← 核心排查页
/sessions                会话视图 Sessions
/compare                 对比 Compare (P2)   ← 今日 vs 昨日 / 本周 vs 上周
/settings                设置 Settings
```

**全局壳层（AppShell）**

```
                      ┌─ 12px ─┐
┌ .sgw-shell ──────────┴────────┴──────────────────────────────────────────────────┐
│  极光环境光（--sgw-app-bg）+ 56px 网格底纹：整站唯一的"氛围层"                     │
│                                                                                  │
│  ╭─ Sidebar 244px ─────────────╮   ╭─ TopBar（玻璃条）────────────────────────╮  │
│  │ 悬浮玻璃板                  │   │ Breadcrumb / Title  [时间范围段选] ⟳ ●Live │  │
│  │ · 外层 12px 间距            │   ╰───────────────────────────────────────────╯  │
│  │ · radius-xl + 独立投影      │   ╭─ 告警条（有告警时才出现，玻璃 notice）────╮  │
│  │                             │   ╰───────────────────────────────────────────╯  │
│  │  ◉ 概览 ← 选中：左侧 3px    │   ┌─ <main> 滚动区（唯一滚动容器）───────────┐  │
│  │           光条 + accent-    │   │  Bento 12 列（gap 16px · 同行卡片等高）    │  │
│  │           subtle 底         │   │  ┌── span-3 ──┐┌── span-4 ──┐┌─ span-5 ─┐ │  │
│  │  ◉ 趋势                     │   │  │  KPI Card  ││  卡片      ││  卡片     │ │  │
│  │  ◉ 模型 / 请求 / 会话       │   │  └────────────┘└────────────┘└───────────┘ │  │
│  │  ────────                   │   │  ┌───────── span-8 ────────┐┌─ span-4 ──┐ │  │
│  │  ◉ 设置                     │   │  │ 图表 / 宽表（卡内滚动）  ││  排行      │ │  │
│  │                             │   │  └─────────────────────────┘└───────────┘ │  │
│  │  ╭─────────────────────────╮│   │  内容最大 1680px 居中                       │  │
│  │  │ ● 记录明细              ││   └────────────────────────────────────────────┘  │
│  │  │   含元数据与 Token 计量  ││  ← 底部常驻状态胶囊（在侧栏内，随侧栏一起悬浮）  │
│  │  ╰─────────────────────────╯│     Detail ON / Body ON（Body ON 时整体转警示色）│
│  ╰─────────────────────────────╯                                                  │
└──────────────────────────────────────────────────────────────────────────────────┘
```

**壳层要点（v2）**

- **侧栏是悬浮玻璃板**：`margin: var(--sgw-shell-gap)`（外层 12px 间距，右侧为 0）、圆角 `--sgw-radius-xl`、独立投影 `--sgw-glass-shadow`、自身走 `.sgw-glass` + `.sgw-edge`。v1 的"贴边 240px + 可折叠 64px"在 v2 令牌中已不存在（没有 `--sgw-sidebar-collapsed`）。
- **导航项**：高 40px、`--sgw-radius-sm`、默认透明；选中态（`aria-current="page"`）= `--sgw-accent-subtle` 底 + `--sgw-accent-ring` 描边 + 左侧 **3px `--sgw-accent` 光条**（18px 高胶囊形），比整块填充更克制。
- **顶栏是玻璃条且常驻在滚动区之上**：`.sgw-topbar` 与 `<main>` 是**同级 flex 子项**（都在壳层右列里上下排列），因此它**不是 sticky** —— 正因如此，它不会和表格 sticky 表头抢层级（表头只在自己的滚动容器内 `position: sticky`）。
- **顶栏右侧的固定顺序**（从右往左可读）：页面操作（`right` 插槽，可选）→ 时间范围分段控件 → 刷新 → 运行时长胶囊 → **竖分隔 `.sgw-topbar-sep`** → **外观切换（最右，常驻）**。分隔线的作用是把「会改数据的操作」与「全局外观偏好」分开，避免外观按钮被误读成某个页面的动作。
- **`<main>` 是唯一滚动容器**（`overflow-y: auto`），内容最大 1680px 居中；页面内用 Bento 12 列网格（见 §4.8）排布卡片。

**侧栏底部状态胶囊（反惊吓原则的关键组件）**

| 状态 | 文案 | 视觉 |
|---|---|---|
| 明细关 | `仅聚合` | 中性灰点 + 次级文字 |
| 明细开 | `记录明细` | 主色点 + 呼吸动画 2s |
| 明细开 + 正文开 | `记录正文` | **警示色**点 + 常驻 `⚠` 图标，点击直达设置页 |

---

## 3. 页面线框（Wireframes）

### 3.1 概览 Overview

```
┌─ TopBar: 概览 ──────────────────── [近 24 小时 ▾] [全部模型 ▾] [● Live] [⟳] ┐
│                                                                             │
│ ┌─ KPI Row (6 × 等宽, gap 16px, 折叠为 2 行 on <1440px) ─────────────────┐ │
│ │ ┌──────────┐┌──────────┐┌──────────┐┌──────────┐┌──────────┐┌────────┐ │ │
│ │ │ 今日 Token││ 请求数    ││ 估算成本  ││ 失败率    ││ TTFB p95 ││缓存命中│ │ │
│ │ │ 1.24M    ││ 386      ││ $4.12 ⓘ  ││ 1.3%     ││ 812 ms   ││ 63.4%  │ │ │
│ │ │ ▲12% vs昨││ ▲8%      ││ ▼3%      ││ ▼0.4pp   ││ ▲40ms    ││ —      │ │ │
│ │ └──────────┘└──────────┘└──────────┘└──────────┘└──────────┘└────────┘ │ │
│ └─────────────────────────────────────────────────────────────────────────┘ │
│                                                                             │
│ ┌─ Token 趋势 (7d) ──────────────────────────────┐┌─ Token 构成 ──────────┐ │
│ │  ▁▂▃▅▇▆▅▃ 堆叠面积图                           ││   ● Input    682K 55% │ │
│ │  legend: ●Input ●Output ●Cached ●Reasoning     ││   ● Output   248K 20% │ │
│ │  [24小时|7天|30天]  粒度: 自动                  ││   ● Cached   254K 20% │ │
│ └────────────────────────────────────────────────┘│   ● Reasoning 60K  5% │ │
│                                                    └───────────────────────┘ │
│ ┌─ 最活跃会话 (Top 5) ───────────────────────────┐┌─ 延迟分布 ────────────┐ │
│ │ c4plus/micro-service · 重构订单校验            ││  p50 ▁▂ 320ms         │ │
│ │ ████████████████░░░░  412K tok · 96 req        ││  p95 ▁▂▃▅ 812ms       │ │
│ │ tts-api · 接入流式合成                          ││  p99     2.4s         │ │
│ │ ██████████░░░░░░░░░░  268K tok · 61 req        ││  [直方图 mini]        │ │
│ └────────────────────────────────────────────────┘└───────────────────────┘ │
│                                                                             │
│ ┌─ 最近请求 ────────────────────────────────────── [查看全部 →] ─────────┐ │
│ │ 时间    端点           模型      状态  耗时   Token  来源              │ │
│ │ 14:32:07 /v1/responses gpt-6-luna 200  3.2s   12.4K  精确              │ │
│ │ 14:31:55 /v1/responses gpt-6-luna 200  1.8s    6.1K  估算 ⓘ           │ │
│ └─────────────────────────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────────────────────┘
```

### 3.2 请求明细 Requests（核心页）

```
┌─ TopBar: 请求明细 ─────────────────────────────────────────────────────────┐
│ ┌─ 筛选条 (sticky, 高度 56px) ───────────────────────────────────────────┐ │
│ │ [近 24 小时 ▾] [模型 ▾] [状态 ▾] [端点 ▾] [耗时 > ▾] [来源 ▾] 🔍 搜索  │ │
│ │ 已选: 模型=ALL 状态=2xx            [清除筛选]        共 386 条 · 1.24M  │ │
│ └─────────────────────────────────────────────────────────────────────────┘ │
│ ┌─ 表格 (行高 44px, 斑马纹关闭, hover 高亮) ─────────────────────────────┐ │
│ │ ☐ 时间▾ 端点 模型 状态 耗时▾ TTFT Token▾ 来源 会话 操作               │ │
│ │ ☐ 14:32:07 /v1/responses luna  ●200  3.2s  480ms  12.4K 精确 ⟶         │ │
│ │ ☐ 14:31:55 /v1/responses luna  ●200  1.8s  210ms   6.1K 估算 ⟶         │ │
│ │ ☐ 14:31:40 /v1/responses luna  ●429  0.3s   —        —    —    ⟶       │ │
│ └─────────────────────────────────────────────────────────────────────────┘ │
│ 分页  [◀ 1 2 3 … 20 ▶]   每页 50 ▾        批量: [导出 CSV] [删除]         │
└─────────────────────────────────────────────────────────────────────────────┘
```

**状态徽标色（Badge）**：`2xx` 成功绿 · `401/403` 鉴权琥珀 · `429` 限流琥珀 · `4xx` 客户端红 · `5xx` 服务端红 · `超时` 红描边 · `中断` 中性

**表格规范**
- 时间列：等宽数字，`HH:mm:ss`，hover 显示完整 ISO + 相对时间
- 耗时：右对齐 + 毫米级等宽；超 p95 的单元格文字转为警示色
- Token 列：千分位，`≥1M` 显示为 `1.24M`，hover 显示精确值
- 来源列：`精确` 用中性灰文字；`估算` 用**虚线边框小徽标 + ⓘ**（悬停解释"上游未返回 usage，本地按 tokenizer 估算"）
- 行点击 → 打开详情抽屉（不离开列表）

### 3.3 详情抽屉（Drawer，右侧悬浮玻璃面板：580px / 窄屏 94vw）

```
┌─────────────────────────────────────────── ✕ ┐
│ /v1/responses · gpt-6-luna                    │
│ ●200 · 3.24s · 14:32:07.412                  │
├── 耗时瀑布 ────────────────────────────────┤
│  排队       ▏ 2ms                            │
│  上游建连   ▏▏ 38ms                          │
│  等待首字节 ▏▏▏▏▏▏▏▏ 214ms                   │
│  首 Token   ▏▏▏▏▏▏▏▏▏▏▏ 320ms                │
│  流式生成   ▏▏▏▏▏▏▏▏▏▏▏▏▏▏▏▏▏▏▏▏▏▏▏ 2.67s   │
│  ▏= 40ms 刻度                               │
├── Token ───────────────────────────────────┤
│  Input 8,420   Output 3,980   Total 12,400  │
│  ├ 缓存命中 6,100 (72.4%)                    │
│  ├ 缓存写入 1,240                            │
│  └ 推理 2,050                                │
│  来源: 上游 usage ✓ 精确                     │
│  估算成本: $0.0184 ⓘ (按当前价格表实时计算；│
│           「—」= 该模型没有价格，不是 0 元)   │
├── 元数据 ──────────────────────────────────┤
│  x-request-id   req_9f2c…      [复制]        │
│  response.id    resp_0a71…     [复制]        │
│  Key 指纹       a3f19c22                     │
│  会话           c4plus/micro-service · #42   │
│  线程           thread_7c1e…   [复制]        │
│  originator     codex_vscode                 │
│  字节数         182 KB ↑ / 96 KB ↓           │
├── 正文 (默认隐藏) ──────────────────────────┤
│  [ 显示请求正文 ] [ 显示响应正文 ]            │
│  ⚠ 正文可能包含代码与密钥，仅在 Body Mode 开启时可用 │
├── 操作 ────────────────────────────────────┤
│  [复制为 cURL]  [复制 JSON]  [删除此记录]     │
└───────────────────────────────────────────────┘
```

### 3.4 设置 Settings

```
┌─ 记录设置 ──────────────────────────────────────────────────────────────┐
│  记录请求明细            [ ●———]  关闭后仅保留聚合统计                  │
│  记录请求/响应正文        [ ●———]  ⚠ 正文可能含代码、密钥、隐私数据       │
│  正文单条上限            [ 512 KB ▾]                                    │
├─ 数据保留 ──────────────────────────────────────────────────────────────┤
│  明细保留                [ 30 天 ▾]     正文保留 [ 7 天 ▾]               │
│  容量上限                [ 2 GB ]       当前占用 ████░░░░ 640 MB         │
│  [ 立即清理明细 ]  [ 清理正文 ]  [ 清空全部数据 ]                        │
├─ 设置 ──────────────────────────────────────────────────────────────────┤
│  上游地址  https://relay.example.com/v1       [应用] [测试连通性]        │
│  路径拼接  auto ▾  剥离前缀 /v1               [应用]                     │
│  探针模型  <你的上游真实模型名>                [应用]                     │
│  密钥替换  [ ●———] 关闭时原样透传 Authorization（推荐保持关闭）          │
│  自定义 CA [ 未配置 ]  [选择文件]                                        │
│  宽限期排空 [ 8 秒 ]  客户端中断后为记账继续读上游的时长                  │
│  ── 互操作自检 ──                                                        │
│  ✓ 上游 usage 结构完整（input/output/total 齐全）  上次: 10:22           │
│  ✓ 上游未启用 WebSocket 传输                                            │
├─ 本地访问安全 ──────────────────────────────────────────────────────────┤
│  监听地址  127.0.0.1:8787（只读，仅回环）                                 │
│  本地令牌  [ ●———] 已启用    [重新生成] [复制引导链接]                    │
├─ 价格表 ────────────────────────────────────────────────────────────────┤
│  ⚠ 2 个模型没有价格，成本显示为「—」（不是 0 元）                          │
│     gpt-6.1-sol  my-relay-v2        ← 点模型名一键填入表单                │
│  模型            输入($/1M)  输出($/1M)  缓存($/1M)                       │
│  gpt-6-luna      0.10        0.50        0.01        [编辑] [删除]        │
│  [模型名] [输入] [输出] [缓存(可空)] [添加]                               │
│  [补齐官方默认价格]  [重建为官方默认值]                                   │
│  默认值来源：OpenAI 官方定价页（USD / 1M tokens，2026-10-14 核对 · v1）    │
├─ 透传自检 ──────────────────────────────────────────────────────────────┤
│  [ 运行 H1~H5 回归自检 ]   上次: 2026-02-14 10:22 ✓ 全部通过             │
├─ Codex 接入 ────────────────────────────────────────────────────────────┤
│  当前配置指向: 网关 ✓       [ 复制回滚配置 ]  [ 复制配置片段 ]            │
└─────────────────────────────────────────────────────────────────────────┘
```

---

## 4. 设计令牌（Design Tokens）

> 令牌是**唯一实现真相源**，落在 `apps/web/src/styles/tokens.css`。组件样式**禁止硬编码颜色/间距**，必须引用 `var(--sgw-*)`。
>
> v2 视觉方向：**现代 SaaS 后台 + 轻量玻璃拟态 + Bento 卡片布局**（玻璃只做一层，靠 alpha 与描边层次做纵深）。双主题通过 `[data-theme]` **全量覆盖语义令牌**实现，**不写第二套组件样式**。

### 4.1 色板 · 原始调色板（OKLCH）

```css
:root {
  /* ── 中性阶（深色为基准，浅色走覆盖） ───────────────── */
  --sgw-gray-00: oklch(0.145 0.008 265);
  --sgw-gray-01: oklch(0.180 0.009 265);
  --sgw-gray-02: oklch(0.215 0.010 265);
  --sgw-gray-03: oklch(0.265 0.011 265);
  --sgw-gray-04: oklch(0.330 0.012 265);
  --sgw-gray-05: oklch(0.420 0.013 265);
  --sgw-gray-06: oklch(0.620 0.013 265);
  --sgw-gray-07: oklch(0.780 0.011 265);
  --sgw-gray-08: oklch(0.940 0.006 265);
  --sgw-gray-09: oklch(0.985 0.003 265);

  /* ── 品牌 / 强调 ─────────────────────────────────────── */
  --sgw-brand-300: oklch(0.780 0.130 200);
  --sgw-brand-400: oklch(0.740 0.135 199);
  --sgw-brand-500: oklch(0.660 0.145 200);
  --sgw-brand-600: oklch(0.560 0.140 204);
  --sgw-brand-700: oklch(0.470 0.120 207);

  /* ── 极光（画布环境光）—— 只用于背景，绝不用于文字 ─────── */
  --sgw-aurora-1: oklch(0.66 0.145 200);
  --sgw-aurora-2: oklch(0.62 0.160 275);
  --sgw-aurora-3: oklch(0.70 0.130 165);

  /* ── 语义色（深色底为基准亮度） ───────────────────────── */
  --sgw-success-500: oklch(0.740 0.165 155);
  --sgw-warning-500: oklch(0.810 0.150  85);
  --sgw-danger-500:  oklch(0.670 0.205  25);
  --sgw-info-500:    oklch(0.700 0.150 250);

  /* ── 图表分类色（固定顺序，勿随意改序，保证历史图表颜色稳定） ── */
  --sgw-viz-1: oklch(0.740 0.135 199);   /* Input      · 青   */
  --sgw-viz-2: oklch(0.680 0.155 262);   /* Output     · 蓝   */
  --sgw-viz-3: oklch(0.710 0.160 305);   /* Cached     · 紫   */
  --sgw-viz-4: oklch(0.800 0.140  85);   /* Reasoning  · 琥珀 */
  --sgw-viz-5: oklch(0.740 0.160 155);   /* 成功/其他  · 绿   */
  --sgw-viz-6: oklch(0.680 0.195  25);   /* 错误/其他  · 红   */
}
```

> 浅色主题只**覆盖**语义色与图表色（见 §4.3）；中性阶与极光只定义一次，浅色不改。


### 4.2 语义令牌 · 深色主题（默认）

```css
:root, [data-theme='dark'] {
  color-scheme: dark;

  /* 表面 */
  --sgw-bg-canvas:       var(--sgw-gray-00);
  --sgw-bg-surface:      var(--sgw-gray-01);
  --sgw-bg-raised:       var(--sgw-gray-02);
  --sgw-bg-hover:        var(--sgw-gray-03);
  --sgw-bg-inset:        oklch(0.205 0.010 265);
  --sgw-bg-inset-strong: oklch(0.160 0.009 265);
  --sgw-bg-overlay:      oklch(0.120 0.010 265 / 0.66);   /* 抽屉遮罩 */

  /* 描边 */
  --sgw-border-subtle:  oklch(0.340 0.012 265 / 0.42);
  --sgw-border-default: oklch(0.400 0.013 265 / 0.72);
  --sgw-border-strong:  oklch(0.480 0.014 265 / 0.88);
  --sgw-border-focus:   var(--sgw-brand-400);

  /* 文字 */
  --sgw-text-primary:   oklch(0.965 0.004 265);
  --sgw-text-secondary: oklch(0.800 0.011 265);
  --sgw-text-tertiary:  oklch(0.660 0.013 265);
  --sgw-text-disabled:  oklch(0.520 0.012 265);
  --sgw-text-inverse:   oklch(0.150 0.010 265);
  --sgw-text-link:      var(--sgw-brand-300);

  /* 交互 */
  --sgw-accent:         var(--sgw-brand-500);
  --sgw-accent-hover:   var(--sgw-brand-400);
  --sgw-accent-text:    oklch(0.985 0.010 200);   /* 主色填充上的文字 */
  --sgw-accent-subtle:  oklch(0.660 0.145 200 / 0.16);
  --sgw-accent-ring:    oklch(0.740 0.135 199 / 0.50);

  /* 状态背景（徽标 / 提示条 / notice） */
  --sgw-success-bg: oklch(0.740 0.165 155 / 0.16);
  --sgw-warning-bg: oklch(0.810 0.150  85 / 0.16);
  --sgw-danger-bg:  oklch(0.670 0.205  25 / 0.17);
  --sgw-info-bg:    oklch(0.700 0.150 250 / 0.16);

  /* 阴影（深色下靠"顶部 1px 高光 + 深投影"做纵深） */
  --sgw-shadow-xs: 0 1px 2px oklch(0 0 0 / 0.40);
  --sgw-shadow-sm: 0 2px 8px oklch(0 0 0 / 0.42);
  --sgw-shadow-md: 0 12px 32px -12px oklch(0 0 0 / 0.60);
  --sgw-shadow-lg: 0 28px 64px -24px oklch(0 0 0 / 0.68);
  --sgw-shadow-glow: 0 0 0 1px oklch(0.740 0.135 199 / 0.22),
                     0 10px 30px -12px oklch(0.660 0.145 200 / 0.40);

  /* 图表与 KPI */
  --sgw-viz-grid: oklch(0.420 0.012 265 / 0.30);
  --sgw-kpi-value-grad: linear-gradient(180deg,
    oklch(0.995 0.003 265) 0%, oklch(0.880 0.010 265) 100%);
}
```

> 玻璃表面（`--sgw-bg-glass*`）、极光底（`--sgw-app-bg`）、`--sgw-grid-line` 与 `--sgw-glass-*` 同样在本主题块内覆盖，因与玻璃拟态强相关，集中列在 **§4.4**。

### 4.3 语义令牌 · 浅色主题

```css
[data-theme='light'] {
  color-scheme: light;

  /* 表面 */
  --sgw-bg-canvas:       oklch(0.980 0.004 258);
  --sgw-bg-surface:      oklch(1 0 0);
  --sgw-bg-raised:       oklch(0.982 0.003 258);
  --sgw-bg-hover:        oklch(0.960 0.005 258);
  --sgw-bg-inset:        oklch(0.968 0.004 258);
  --sgw-bg-inset-strong: oklch(0.950 0.005 258);
  --sgw-bg-overlay:      oklch(0.320 0.014 265 / 0.34);

  /* 描边 */
  --sgw-border-subtle:  oklch(0.905 0.006 258);
  --sgw-border-default: oklch(0.865 0.007 258);
  --sgw-border-strong:  oklch(0.790 0.009 258);
  --sgw-border-focus:   var(--sgw-brand-600);

  /* 文字 */
  --sgw-text-primary:   oklch(0.215 0.014 265);
  --sgw-text-secondary: oklch(0.455 0.014 265);
  --sgw-text-tertiary:  oklch(0.580 0.014 265);
  --sgw-text-disabled:  oklch(0.720 0.010 265);
  --sgw-text-inverse:   oklch(0.995 0 0);
  --sgw-text-link:      var(--sgw-brand-700);

  /* 交互 */
  --sgw-accent:         oklch(0.560 0.135 204);
  --sgw-accent-hover:   oklch(0.500 0.130 206);
  --sgw-accent-text:    oklch(0.995 0 0);
  --sgw-accent-subtle:  oklch(0.560 0.135 204 / 0.11);
  --sgw-accent-ring:    oklch(0.560 0.135 204 / 0.30);

  /* 语义色：浅色下需降低亮度以保对比度 */
  --sgw-success-500: oklch(0.560 0.145 155);
  --sgw-warning-500: oklch(0.640 0.145  75);
  --sgw-danger-500:  oklch(0.550 0.195  27);
  --sgw-info-500:    oklch(0.540 0.160 255);

  --sgw-viz-1: oklch(0.560 0.135 204);
  --sgw-viz-2: oklch(0.540 0.160 258);
  --sgw-viz-3: oklch(0.550 0.170 302);
  --sgw-viz-4: oklch(0.660 0.150  78);
  --sgw-viz-5: oklch(0.560 0.145 155);
  --sgw-viz-6: oklch(0.560 0.195  27);
  --sgw-viz-grid: oklch(0.880 0.006 258);

  /* 状态背景 */
  --sgw-success-bg: oklch(0.560 0.145 155 / 0.12);
  --sgw-warning-bg: oklch(0.660 0.150  78 / 0.15);
  --sgw-danger-bg:  oklch(0.550 0.195  27 / 0.10);
  --sgw-info-bg:    oklch(0.540 0.160 255 / 0.10);

  /* 阴影：浅色下投影更轻，主要靠描边分层 */
  --sgw-shadow-xs: 0 1px 2px oklch(0.30 0.02 265 / 0.06);
  --sgw-shadow-sm: 0 1px 3px oklch(0.30 0.02 265 / 0.07), 0 1px 2px oklch(0.30 0.02 265 / 0.04);
  --sgw-shadow-md: 0 10px 30px -14px oklch(0.30 0.03 265 / 0.20), 0 2px 6px -2px oklch(0.30 0.03 265 / 0.08);
  --sgw-shadow-lg: 0 28px 60px -26px oklch(0.30 0.03 265 / 0.26), 0 4px 12px -4px oklch(0.30 0.03 265 / 0.10);
  --sgw-shadow-glow: 0 0 0 1px oklch(0.560 0.135 204 / 0.14),
                     0 12px 30px -14px oklch(0.560 0.135 204 / 0.32);

  --sgw-kpi-value-grad: linear-gradient(180deg,
    oklch(0.230 0.016 265) 0%, oklch(0.400 0.020 265) 100%);
}
```

### 4.4 玻璃拟态令牌（v2 新增）

**结构性令牌（与主题无关，定义在 `:root`）**

```css
:root {
  --sgw-glass-blur: 18px;                    /* 玻璃面板的基础模糊半径 */
  --sgw-glass-saturate: 155%;                /* 透过玻璃的色彩饱和度增益 */
  --sgw-glass-alpha: 1;                      /* ★ 无 backdrop-filter 时的实色兜底 */
  --sgw-glass-highlight: none;               /* 顶部 1px 高光（.sgw-edge），深浅色各自覆盖 */
  --sgw-glass-shadow: var(--sgw-shadow-sm);  /* 玻璃面投影，深浅色各自覆盖 */
  --sgw-shell-gap: var(--sgw-space-3);       /* 壳层留白 12px：侧栏/顶栏的悬浮间距 */
  --sgw-app-bg: radial-gradient(120% 80% at 50% -10%, transparent 0%, transparent 100%);
  --sgw-grid-line: transparent;
}
```

**能力探测：不支持 `backdrop-filter` 就退化为实色**

```css
@supports ((backdrop-filter: blur(1px)) or (-webkit-backdrop-filter: blur(1px))) {
  :root { --sgw-glass-alpha: 0.82; }                 /* 深色：玻璃 82% 不透明 */
  [data-theme='light'] { --sgw-glass-alpha: 0.76; }  /* 浅色：玻璃 76% 不透明 */
}
```

**玻璃表面与极光底（按主题覆盖）**

```css
/* 深色 */
:root, [data-theme='dark'] {
  --sgw-bg-glass:        oklch(0.205 0.011 265 / var(--sgw-glass-alpha));
  --sgw-bg-glass-strong: oklch(0.195 0.011 265 / var(--sgw-glass-alpha));
  --sgw-bg-glass-subtle: oklch(0.225 0.011 265 / calc(var(--sgw-glass-alpha) * 0.62));
  --sgw-glass-highlight: oklch(1 0 0 / 0.07);
  --sgw-glass-shadow: 0 1px 0 oklch(1 0 0 / 0.05) inset, var(--sgw-shadow-md);
  --sgw-app-bg:
    radial-gradient(70% 52% at 12% -8%, oklch(0.660 0.145 200 / 0.16) 0%, transparent 62%),
    radial-gradient(56% 46% at 92% 2%, oklch(0.620 0.160 275 / 0.14) 0%, transparent 60%),
    radial-gradient(64% 60% at 62% 104%, oklch(0.700 0.130 165 / 0.09) 0%, transparent 64%),
    linear-gradient(180deg, oklch(0.158 0.009 265) 0%, oklch(0.130 0.008 265) 100%);
  --sgw-grid-line: oklch(0.700 0.010 265 / 0.035);
}

/* 浅色 */
[data-theme='light'] {
  --sgw-bg-glass:        oklch(1 0 0 / var(--sgw-glass-alpha));
  --sgw-bg-glass-strong: oklch(0.995 0.002 258 / var(--sgw-glass-alpha));
  --sgw-bg-glass-subtle: oklch(1 0 0 / calc(var(--sgw-glass-alpha) * 0.66));
  --sgw-glass-highlight: oklch(1 0 0 / 0.70);
  --sgw-glass-shadow: 0 1px 0 oklch(1 0 0 / 0.60) inset, var(--sgw-shadow-md);
  --sgw-app-bg:
    radial-gradient(70% 52% at 10% -10%, oklch(0.720 0.135 200 / 0.20) 0%, transparent 60%),
    radial-gradient(58% 48% at 94% 0%, oklch(0.700 0.140 280 / 0.18) 0%, transparent 58%),
    radial-gradient(66% 60% at 58% 106%, oklch(0.760 0.120 165 / 0.14) 0%, transparent 62%),
    linear-gradient(180deg, oklch(0.993 0.003 258) 0%, oklch(0.962 0.006 258) 100%);
  --sgw-grid-line: oklch(0.520 0.020 265 / 0.045);
}
```

**玻璃工具类与极光层**

| 类 / 属性 | 实现 |
|---|---|
| `.sgw-glass` | `background-color: var(--sgw-bg-glass)` + `blur(var(--sgw-glass-blur)) saturate(var(--sgw-glass-saturate))`（18px） |
| `.sgw-glass-strong` | `var(--sgw-bg-glass-strong)` + `blur(calc(var(--sgw-glass-blur) * 1.4))`（浮层：抽屉 / 图表 tooltip / Toast） |
| `.sgw-glass-subtle` | `var(--sgw-bg-glass-subtle)`（alpha × 0.62 / 0.66）+ `blur(calc(var(--sgw-glass-blur) * 0.7))`（内嵌小格 `.sgw-slab`、表格行 hover） |
| `.sgw-edge::before` | 顶部 1px 渐变高光，用 `--sgw-glass-highlight`；两端透明，22%→78% 为实心段 |
| `--sgw-app-bg`（极光环境光） | 由 `body` 的 `background-image` 承载（`background-attachment: fixed`）：深色 3 层径向渐变 + 1 层线性底色 |
| `--sgw-grid-line` | `.sgw-shell::after` 以 56px 网格底纹透出结构参照物，并用径向 mask 淡出到 78% |

**两条纪律（必须遵守）**

1. **玻璃只做一层 `backdrop-filter`，不嵌套多层模糊。** 嵌套模糊会同时输掉性能与可读性；纵深靠 `--sgw-glass-alpha` 与描边（`--sgw-border-subtle` / `--sgw-glass-highlight`）层次表达，不靠叠加模糊。
2. **所有玻璃面都靠 `--sgw-glass-alpha` 兜底。** `@supports (backdrop-filter)` 不成立时 `--sgw-glass-alpha` 保持 `1` → 玻璃底变成实色不透明面板，界面自动退化，**正文绝不会压在极光底色上**。表单控件（`.sgw-input`，底 `--sgw-bg-inset`）与表格 sticky 表头（底 `--sgw-bg-inset-strong`）**始终保持不透明**：可读性优先于装饰。

### 4.5 字体与排版

```css
:root {
  --sgw-font-sans: 'Inter var', 'Inter', 'Noto Sans SC', 'PingFang SC',
    'Microsoft YaHei UI', system-ui, -apple-system, sans-serif;
  --sgw-font-mono: 'JetBrains Mono', 'Cascadia Code', 'SF Mono', Consolas,
    'Liberation Mono', monospace;

  --sgw-text-2xs: 11px;   --sgw-leading-2xs: 15px;
  --sgw-text-xs: 12px;    --sgw-leading-xs: 17px;
  --sgw-text-sm: 13px;    --sgw-leading-sm: 20px;   /* 正文/表格默认 */
  --sgw-text-md: 14px;    --sgw-leading-md: 22px;
  --sgw-text-lg: 16px;    --sgw-leading-lg: 24px;
  --sgw-text-xl: 20px;    --sgw-leading-xl: 28px;
  --sgw-text-2xl: 26px;   --sgw-leading-2xl: 32px;
  --sgw-text-3xl: 34px;   --sgw-leading-3xl: 40px;  /* KPI 数值 */

  --sgw-weight-regular: 400;
  --sgw-weight-medium: 500;
  --sgw-weight-semibold: 600;
  --sgw-weight-bold: 700;
}
```

> 字距（letter-spacing）**不再单列令牌**，而是写在使用它的组件类上：`.sgw-text-2xl` 与 `.sgw-topbar-title` 为 `-0.02em`，`.sgw-card-title` 为 `-0.01em`，`.sgw-kpi` 为 `-0.025em`，`.sgw-label` 与 `.sgw-table th` 为 `0.06em`。

**排版使用规则**

| 用途 | 令牌组合 |
|---|---|
| KPI 数值（`.sgw-kpi`） | `3xl / bold / -0.025em / tabular-nums` + `--sgw-kpi-value-grad` 裁切渐变 |
| KPI 标签（`.sgw-label`） | `2xs / medium / 0.06em / uppercase / text-tertiary` |
| 页面标题（`.sgw-topbar-title`） | `xl / semibold / -0.02em` |
| 卡片标题（`.sgw-card-title`） | `md / semibold / -0.01em` |
| 正文、表格单元格 | `sm / regular` |
| 表格表头 | `2xs / medium / uppercase / 0.06em / text-tertiary` |
| ID / token 串 / 代码 | `mono / sm / tabular-nums` |
| 时间戳 | `mono / xs / tabular-nums` |

> **强制**：所有数字（KPI、表格、图表刻度）必须 `font-variant-numeric: tabular-nums`，否则跳动。

### 4.6 间距 / 圆角 / 层级 / 动效

```css
:root {
  /* 间距（4px 基数） */
  --sgw-space-1: 4px;   --sgw-space-2: 8px;   --sgw-space-3: 12px;
  --sgw-space-4: 16px;  --sgw-space-5: 20px;  --sgw-space-6: 24px;
  --sgw-space-8: 32px;  --sgw-space-10: 40px; --sgw-space-12: 48px;

  /* 圆角 */
  --sgw-radius-xs: 6px;      /* focus 轮廓、骨架块 */
  --sgw-radius-sm: 9px;      /* 按钮、输入框、导航项、内嵌小格 */
  --sgw-radius-md: 14px;     /* notice、状态胶囊 */
  --sgw-radius-lg: 20px;     /* 卡片、KPI、顶栏 */
  --sgw-radius-xl: 26px;     /* 侧栏、抽屉 */
  --sgw-radius-2xl: 32px;    /* 备用（映射给 Tailwind --radius-2xl） */
  --sgw-radius-full: 9999px;

  /* 层级 */
  --sgw-z-sticky: 100;  --sgw-z-dropdown: 200;
  --sgw-z-drawer: 300;  --sgw-z-toast: 500;

  /* 动效 */
  --sgw-duration-fast: 130ms;
  --sgw-duration-base: 200ms;
  --sgw-duration-slow: 320ms;
  --sgw-ease-out:    cubic-bezier(0.16, 1, 0.3, 1);
  --sgw-ease-in-out: cubic-bezier(0.4, 0, 0.2, 1);
}
```

> `prefers-reduced-motion: reduce` 由 `@layer base` **全局兜底**（`animation-duration` / `transition-duration` 一律 `0.01ms !important`、`animation-iteration-count: 1`），不再逐令牌置零 —— 玻璃与 Bento 的动效（`.sgw-rise` / `.sgw-drawer-enter` / `.sgw-shimmer` / `.sgw-pulse` / 行闪）因此自动受约束。

### 4.7 布局令牌

```css
:root {
  --sgw-sidebar-width: 244px;
  --sgw-topbar-height: 60px;
  --sgw-content-max: 1680px;
  --sgw-drawer-width: 580px;
  --sgw-shell-gap: var(--sgw-space-3);        /* 侧栏/顶栏的悬浮留白 12px */
  --sgw-bento-gap: var(--sgw-space-4);        /* Bento 12 列网格间距 16px */
  --sgw-bento-page-gap: var(--sgw-space-4);   /* 页级区块间距 16px（<900px 降为 12px） */
}
```

**断点（Tailwind v4 覆盖）**：`sm 640` · `md 768`（最低可用） · `lg 1024`（设计基线） · `xl 1280` · `2xl 1536` · `3xl 1680`

| 宽度 | 行为 |
|---|---|
| ≥1440 | 内容居中最大 1680；KPI **6 列**；Bento 按 `span-*` 类排布（见 §4.8） |
| 1024–1439 | KPI **3 列**；Bento 宽块收成整行（`span-8/7/6/5 → 12`）、`span-4`/`span-3` 收成半行（→ 6） |
| <900 | KPI **2 列**；Bento 全部单列；网格与页级间距降为 `--sgw-space-3`（12px） |

### 4.8 Bento 网格规范（v2 新增）

> Bento 网格**只重排既有卡片的空间占比，不改信息架构**：栅格化的是"谁占多宽"，不是"页面有哪些区块"。

```css
.sgw-bento {
  display: grid;
  grid-template-columns: repeat(12, minmax(0, 1fr));
  gap: var(--sgw-bento-gap);              /* 16px */
  align-items: stretch;                   /* ★ 同一行的卡片等高 */
}
.sgw-bento-page { gap: var(--sgw-bento-page-gap); }   /* 页级区块间距，16px */
.sgw-bento > * { min-width: 0; }          /* ★ 允许格子内部截断/滚动，不撑破网格 */

/* 跨列工具类（12 列制） */
.sgw-span-3  { grid-column: span 3; }
.sgw-span-4  { grid-column: span 4; }
.sgw-span-5  { grid-column: span 5; }
.sgw-span-6  { grid-column: span 6; }
.sgw-span-7  { grid-column: span 7; }
.sgw-span-8  { grid-column: span 8; }
.sgw-span-12 { grid-column: span 12; }
```

- **列宽类只有** `.sgw-span-3 / -4 / -5 / -6 / -7 / -8 / -12`；需要更细的切分时，在卡片**内部**再分栏，而不是继续切细 12 列网格。
- **`align-items: stretch` + 卡片 `stretch` 属性**（`height: 100%`）一起保证同行卡片等高 —— Bento 网格参差不齐会显得像没排完版。
- **`.sgw-bento > *` 一律 `min-width: 0`**：宽表靠**卡片内部**横向滚动，绝不允许把网格格子撑破。

**塌缩规则（照 `tokens.css` 文件末尾的媒体查询）**

```css
@media (max-width: 1439px) {
  .sgw-span-8, .sgw-span-7, .sgw-span-6, .sgw-span-5 { grid-column: span 12; }
  .sgw-span-4 { grid-column: span 6; }
  .sgw-span-3 { grid-column: span 6; }
  /* KPI 一行的目标布局：≥1440 六列 / 1024–1439 三列（3+3）/ <900 两列 */
  .sgw-kpi-grid { grid-template-columns: repeat(3, minmax(0, 1fr)); }
}
@media (max-width: 899px) {
  .sgw-span-8, .sgw-span-7, .sgw-span-6, .sgw-span-5,
  .sgw-span-4, .sgw-span-3 { grid-column: span 12; }
  .sgw-kpi-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  :root { --sgw-bento-gap: var(--sgw-space-3); --sgw-bento-page-gap: var(--sgw-space-3); }
}
```

**速查表**

| 媒体查询 | Bento 跨列 | `.sgw-kpi-grid` | 网格间距 |
|---|---|---|---|
| ≥1440px（默认，无媒体查询） | 按 `span-*` 类生效 | `repeat(6, minmax(0, 1fr))` | `--sgw-bento-gap` = 16px |
| 900–1439px | `span-8/7/6/5 → span 12`；`span-4 → span 6`；`span-3 → span 6` | `repeat(3, …)` | 16px |
| <900px | `span-8/7/6/5/4/3 → span 12`（全部单列） | `repeat(2, …)` | `--sgw-bento-gap` 与 `--sgw-bento-page-gap` → `--sgw-space-3`（12px） |

即 KPI 一行：**≥1440 六列 · 900–1439 三列 · <900 两列**。

### 4.9 主题切换规范

- 属性驱动：`<html data-theme="dark|light">`，令牌全量覆盖，**不写第二套组件样式**
- 三态：`跟随系统 / 深色 / 浅色`，默认**跟随系统**（系统无偏好 → 深色）
- **切换入口固定为顶栏最右侧**（`components/shell.tsx` 的 `ThemePicker`，见 §5）：主题是随时想改的全局偏好，**不放设置页**，也不需要先导航；三个选项用图标承载（显示器 / 月牙 / 太阳），文字语义交给 `title` + `aria-label`
- 持久化：`localStorage['sgw.theme']`；首屏用内联脚本设置以避免闪烁（FOUC）
- `<meta name="color-scheme" content="dark light">` + 切换时同步 `color-scheme` CSS
- 图表颜色**必须**从 CSS 变量读取（`getComputedStyle`），保证切主题时图表同步换色
- 玻璃令牌同样随主题覆盖（`--sgw-glass-alpha` 深 0.82 / 浅 0.76，`--sgw-glass-shadow`、`--sgw-glass-highlight`、`--sgw-app-bg`、`--sgw-grid-line` 各一套，见 §4.4）

---

## 5. 组件规范

| 组件 | 规格 |
|---|---|
| **Card** | `.sgw-card sgw-edge sgw-glass`：`1px border-subtle` · `radius-lg`(20px) · `--sgw-glass-shadow`（顶部 1px 高光 + `shadow-md`）· 玻璃底 `--sgw-bg-glass`；头部 padding `space-4 space-5` + 下边框 `border-subtle`，内容区 `space-5`；**静态卡不给 hover 反馈**（避免"看起来能点"），可点卡才加 `.sgw-card-interactive`（见 §6） |
| **KPI Card** | `.sgw-kpi-card`：最小高度 108px · `radius-lg` · padding `space-4 space-5` · `--sgw-glass-shadow`；上：`.sgw-label`（2xs/uppercase/tertiary）；中：`.sgw-kpi`（3xl/bold/tabular）；下：环比（2xs/tertiary，`▲/▼` + 文案）；右上角极光晕（`::after` 132px 径向 `accent-subtle`）；**无左侧色条**（避免视觉噪音）；hover 抬升 2px + `border-strong`。数值用 `--sgw-kpi-value-grad` 裁切渐变，但 `data-tone` 为 **ok / warn / danger（含 neutral）时必须回退成实色**（`background: none` + `-webkit-text-fill-color: currentColor`），保证告警可辨识 |
| **Delta** | `▲/▼ + 百分比 + "vs 昨日"`；涨跌**不用红绿判断好坏**（token 涨不是坏事）→ 统一中性色，仅当"失败率/延迟"这类明确指标才用语义色 |
| **Badge** | `.sgw-badge`：高 21px · `radius-full` · padding `0 7px` · 2xs/medium；底色按语义取 `--sgw-*-bg`（neutral 用 `--sgw-bg-inset`，accent 用 `--sgw-accent-subtle`）；状态点用 6px `.sgw-dot`（currentColor）；`估算` 徽标 = `1px dashed`（neutral 描边 `--sgw-border-strong`，其余 currentColor） |
| **Button** | `.sgw-btn`：高 34px（md）/ 28px + `text-xs`（sm）；`radius-sm` · padding `0 space-3`（sm 为 `0 space-2`）· `border-default` · 玻璃底 `--sgw-bg-glass`（blur 0.6×）；hover → `bg-hover` + `border-strong`；active → `translateY(0.5px)`；disabled → opacity 0.48；primary = `linear-gradient(180deg, brand-400, brand-600)` + `--sgw-accent-text` + `--sgw-shadow-glow`；danger = danger 渐变 + `0 8px 20px -14px --sgw-danger-500`，hover `brightness(1.08)`；ghost = 透明、无 blur |
| **Switch** | 宽 42 × 高 24，滑块 18px（开时左移 21px）；轨道开启 = `linear-gradient(180deg, brand-400, brand-600)` + `--sgw-shadow-glow`，关闭 = `--sgw-border-strong`；滑块开 `--sgw-accent-text` / 关 `--sgw-bg-surface` + `--sgw-shadow-xs`；`transition-colors`；`role="switch"` + `aria-checked`；disabled 整行 opacity 0.6 |
| **Table** | `.sgw-table`：`table-layout: auto` · `border-spacing: 0`；表头 `position: sticky; top: 0; z-index: 1`，**底色必须不透明**（`--sgw-bg-inset-strong`，否则行会从底下透出来），下边框 `border-default`，padding `space-2 space-4`，2xs/medium/uppercase/0.06em/tertiary；单元格 padding `11px space-4`、`border-subtle` 下边框、末行无边框；行 hover `--sgw-bg-glass-subtle` + `cursor: pointer`；斑马纹**关闭**；宽表靠卡片内部横向滚动 |
| **Drawer** | 右侧**悬浮玻璃面板**：`position: fixed` 且四边留 `--sgw-shell-gap`，宽 `min(--sgw-drawer-width, 94vw)`（580px），`radius-xl` + `border-default` + `--sgw-shadow-lg` + `.sgw-glass-strong`；入场 `sgw-drawer-in` 320ms `ease-out`（`translateX(24px) → 0` + 淡入）；遮罩 `--sgw-bg-overlay` + `backdrop-filter: blur(3px)`，`z-index: --sgw-z-drawer`；`Esc` 关闭；焦点陷阱；关闭后焦点回到触发行 |
| **Toast** | 右下角（`right/bottom: 20px`，`z-index: --sgw-z-toast`），最多 3 条堆叠；`.sgw-glass-strong` 玻璃浮层 + `--sgw-shadow-lg` + 左侧 3px 语义色条（成功/警告/失败）；4.2s 自动消失；点击关闭 |
| **EmptyState** | 图标容器 52×52（`radius-md` + `--sgw-bg-glass-subtle` 底 + `border-subtle`，图标 24px/tertiary）+ 标题（md/semibold）+ 说明（xs/tertiary，`max-w-md`）+ 可选主行动按钮；容器 padding `space-10 space-5`；文案示例："还没有请求记录 —— 把 Codex 指向网关后，数据会实时出现在这里 [查看接入步骤]" |
| **Segmented** | `.sgw-segmented`：**胶囊形**（`radius-full`）· padding 3px · `border-subtle` · 底 `--sgw-bg-inset`；选项高 24px（`data-size="sm"` 为 20px + 2xs）、`radius-full`、默认 tertiary，hover → secondary；**选中项白底**（`--sgw-bg-surface`）+ `border-subtle` + primary/semibold + `--sgw-shadow-xs` |
| **Input** | `.sgw-input`：高 34px · padding `0 space-3` · `radius-sm` · `border-default` · **不透明底** `--sgw-bg-inset`（表单控件不用玻璃，可读性优先）；placeholder 用 `text-disabled`；focus → `border-focus` + `0 0 0 3px --sgw-accent-ring`（无 outline）；`select.sgw-input` 用纯 CSS 三角箭头（`appearance: none`） |
| **Notice** | `.sgw-notice`：`1px border-default` · `radius-md` · padding `space-3` · xs/leading-xs · 默认底 `--sgw-bg-glass-subtle` + secondary 文字；`data-tone` = `info` / `warn` / `danger` 时分别改用 `--sgw-info-bg`、`--sgw-warning-bg`、`--sgw-danger-bg` 作底，对应 `--sgw-*-500` 作描边与文字色 |
| **Slab** | `.sgw-slab`：内嵌玻璃小格（KV / 只读字段 / 统计格）；padding `7px space-3` · `border-subtle` · `radius-sm` · 底 `--sgw-bg-glass-subtle` |
| **Code** | `.sgw-code`：等宽代码块（配置片段 / 正文查看器）；padding `space-3` · `border-subtle` · `radius-sm` · 底 `--sgw-bg-inset`（不透明）· 文字 secondary · 2xs/leading-2xs · `overflow: auto` |
| **Skeleton** | 与真实内容同尺寸；`shimmer` 1.6s 循环；KPI 与表格各一套 |
| **Waterfall** | 横向分段条，5 段（排队/建连/TTFB/首token/生成）；颜色：中性灰渐变 + accent 末段；刻度线每 40ms 或自动；hover 显示该段绝对值 |
| **TimeRangePicker** | 顶栏右侧的 `.sgw-segmented` 胶囊分段控件，预设 `1 小时 / 24 小时 / 7 天 / 30 天 / 本月`（与 `RangePreset` 一致，v2 未实现"自定义 + 双侧日历"）；选中态写入 URL `?range=` 以保持可分享，图表随之按小时/天切换桶宽 |
| **ThemePicker** | 顶栏**最右侧**的 `.sgw-segmented` 三段**图标**控件（`data-icon-only="true"`）：显示器 `跟随系统` / 月牙 `深色` / 太阳 `浅色`；选项高 24px、左右 padding 收窄到 8px、图标 14px（与文字段视觉等重）；每段**必须**同时给 `title`（悬停）与 `aria-label`（读屏），因为图标本身 `aria-hidden`；左侧以 `.sgw-topbar-sep`（1×22px `--sgw-border-subtle`）与操作类控件分隔。用图标而非中文标签的原因：顶栏横向空间让给数据（§4.9） |
| **CopyButton** | 点击 `✓` 反馈 1.2s；复制长 ID 时截断显示 `req_9f2c…` + 完整值 tooltip |

### 5.1 图表规范（统一由 `packages/shared` 的 viz 配置驱动）

- **网格**：仅水平线，`--sgw-viz-grid`，1px；垂直网格默认关闭
- **轴**：Y 轴 4 格，刻度用 SI 缩写（`1.2K / 3.4M`）；X 轴时间自适应（小时 → `14:00`，天 → `02-14`）
- **Tooltip**：跟随光标，显示完整时间 + 各序列绝对值 + 合计；浮层用 **`.sgw-glass-strong`（玻璃浮层）** —— `--sgw-bg-glass-strong` + `blur(calc(var(--sgw-glass-blur) * 1.4))` + `--sgw-glass-shadow` + `radius-md`；坐标轴 / 网格 / 图例规则不变
- **Legend**：图表上方左对齐，可点击隐藏/显示序列（状态存 URL query，便于分享）
- **面积图**：堆叠，`fill-opacity 0.18`，线宽 2px，圆滑曲线 `monotone`
- **空数据**：不画空坐标系，显示 EmptyState
- **单点数据**：显示为点 + 提示"数据不足，趋势仅供参考"
- **颜色**：严格按 `--sgw-viz-1..6` 顺序分配，**禁止**按值动态改色

---

## 6. 状态与交互细节

| 场景 | 交互 |
|---|---|
| **Live 开关** | 开启时顶栏 `●` 呼吸 + 每 1s 拉增量；关闭时显示"已暂停"与最后更新时间 |
| **新请求进入** | 表格顶部插入行，行背景闪 `accent-subtle` 800ms 后淡出（尊重 reduced-motion，则只插入不闪） |
| **长任务进行中** | 请求表中"进行中"行显示脉冲点，耗时列实时累加；完成后落定为最终值 |
| **估算值** | 任何估算数字右上角 `ⓘ`，tooltip："上游未返回 usage，本地按 tokenizer 估算，误差约 ±5–15%" |
| **开关切换** | 开关立即乐观更新 → 请求 `/_sgw/api/settings` → 失败则回滚 + Toast 报错 |
| **删除/清理** | 二次确认弹窗，需输入 `确认` 或勾选"我知道无法恢复"；危险操作按钮用 danger 填充 |
| **错误页** | 网关自身错误（DB 锁、端口占用）在顶部常驻告警条，含"如何修复"折叠说明 |
| **上游 usage 告警** | 若上游返回的 `usage` 缺字段（会导致 Codex 整轮失败），概览页与设置页显示**常驻红色横幅**：`上游中继的 usage 结构不完整（缺 total_tokens）—— 这会让 Codex 本轮对话失败。→ [查看诊断] [复制给管理员的信息]`。文案必须明确"**这不是网关的问题，也不是你配置的问题**" |
| **WS 不支持提示** | 若日志中出现 `Upgrade: websocket`，设置页显示提示：`检测到 Codex 尝试使用 WebSocket 传输，本网关不支持。请从 config.toml 中删除 supports_websockets 或设为 false。` |
| **长请求进行中提示** | 请求耗时超过 60s 时，详情抽屉的瀑布图旁显示"仍在生成中…"，并提示"上游静默超过 5 分钟属正常现象，网关不会主动断开" |
| **键盘** | `/` 聚焦搜索 · `Esc` 关抽屉 · `g o/g r/g s` 跳转页面 · `j/k` 表格上下移动 · `Enter` 打开详情 |
| **可点卡片 hover** | 只有 `.sgw-card-interactive` 才抬升：`translateY(-2px)` + `border-strong` + 投影加深为 `--sgw-glass-shadow, --sgw-shadow-lg`（`:focus-within` 改为 `--sgw-accent-ring` 描边）。**静态卡不加 hover 反馈**——避免"看起来能点"的误导 |
| **玻璃动效** | 所有玻璃相关动效（`.sgw-rise` 面板入场、`.sgw-drawer-enter`、行闪、`shimmer`、hover 抬升）一律受 `prefers-reduced-motion: reduce` 约束：`@layer base` 把 `animation-duration` / `transition-duration` 压到 `0.01ms`，界面直接落到静止终态 |

---

## 7. 无障碍与文案

### 7.1 无障碍（Accessibility）
- 对比度：正文 ≥ 4.5:1，大号数字 ≥ 3:1，**两套主题都必须验算**
- **玻璃拟态带来的新约束**：面板必须有足够的 `--sgw-glass-alpha` 才能保证压在极光底色上的正文 ≥ 4.5:1（深色 0.82 / 浅色 0.76）；极光底色本身随主题变化，**两套主题都要分别验算**，不能只验一套
- **必须支持 `@supports` 回退**：不支持 `backdrop-filter` 时 `--sgw-glass-alpha` 保持 `1` → 玻璃面退化为实色不透明面板，正文绝不压在极光底色上；表单控件与表格 sticky 表头本就保持不透明
- 本次核对方式：用无头 Chrome 对 **4 个页面（概览 / 请求明细 / 会话 / 设置）× 深色、浅色两套主题**逐个截图核对
- 不仅靠颜色：状态 = 颜色 + 图标/文字（如 `●200 OK`）
- 焦点可见：所有可聚焦元素 `focus-visible` 显示 2px `accent-ring`
- 语义标签：图表提供 `aria-label` 与"数据表替代视图"入口（表格形式呈现同一份数据）
- `prefers-reduced-motion` 时禁用所有非必要动画
- 图标按钮必须有 `aria-label`；纯装饰 `svg` 用 `aria-hidden`

### 7.2 文案原则
- 用**动词 + 结果**描述开关：`记录请求明细` 而非 `详细模式`
- 危险提示写清**后果**与**范围**：`正文可能包含代码、密钥与个人信息，仅保存在本机 data/bodies/ 目录`
- 估算/缺失如实说明，不用"约"字糊弄：显式 `估算` 徽标
- 空状态给**下一步动作**，不止说"暂无数据"
- 中英混排：专有名词保留英文（Token、TTFB、p95、SSE、Codex），其余中文
- 单位统一：`Token` 用 K/M 缩写；时间 `1.24s`；成本 `$4.12`

---

## 8. 前端页面 → 数据契约映射

| 页面元素 | 数据来源 | 端点（见 `05` §6） |
|---|---|---|
| KPI 卡 | 区间聚合 | `GET /_sgw/api/stats/summary?range=…` |
| 趋势面积图 | 时间桶 | `GET /_sgw/api/stats/timeseries?bucket=hour\|day` |
| Token 构成 | 分项聚合 | 同上（`breakdown=type`） |
| 模型分布 | 分组聚合 | `GET /_sgw/api/stats/by-model` |
| 会话排行 | 分组聚合 | `GET /_sgw/api/stats/by-session` |
| 延迟分布 | 分位 + 直方图 | `GET /_sgw/api/stats/latency` |
| 请求表 | 明细分页 | `GET /_sgw/api/requests?…` |
| 详情抽屉 | 单条 + 正文 | `GET /_sgw/api/requests/:id` · `…/body` |
| Live 推送 | SSE | `GET /_sgw/api/stream` |
| 设置页 | 配置读写 | `GET/PATCH /_sgw/api/settings` |
| 透传自检 | 任务触发 | `POST /_sgw/api/selftest` |
