/**
 * SGW 配置示例。
 *
 * 用法：复制为 `sgw.config.ts`（本文件是可选的 —— 留空 upstream.baseUrl 也能启动，
 * 启动后在仪表盘「设置 → 上游」手动填写即可）。
 *   copy sgw.config.example.ts sgw.config.ts
 *
 * 配置策略（docs/03 §4.3）：
 *   - 本文件 = **启动期默认值**（类型化、可注释、可 git 管理）。**仓库里不预置任何具体上游地址。**
 *   - 运行期设置（上游地址/路径拼接/探针模型/鉴权、日志开关、保留策略、价格表）走
 *     SQLite settings 表，由仪表盘热改；**持久化**，重启后仍然生效。
 *   - 优先级：**settings 表 > 本文件 > 内置默认值**。
 *   - **Web 端永不回写本文件** —— 避免 UI 破坏人类可读的配置。
 *
 * ⚠️ Node 22 原生 TS 只支持"可擦除语法"：禁止 enum / namespace / 参数属性。
 */

import { defineConfig } from './apps/server/src/config/schema.ts';

export default defineConfig({
  // ── 监听 ──────────────────────────────────────────────────────────────
  listen: {
    // ★ 只监听回环。不要改成 0.0.0.0 —— 除非你清楚风险，并显式设置 allowExternal。
    host: '127.0.0.1',
    port: 8787,
    allowExternal: false,
  },

  // ── 上游（真实中继）──────────────────────────────────────────────────
  upstream: {
    // ★ **留空即可**：地址由使用者手动填写（仪表盘「设置 → 上游」），改完即时生效、存 SQLite。
    //   这里只是一个"启动默认值"，优先级低于设置页填的值。
    //   刻意不预置任何具体域名 —— 上游地址因环境而异，写死在仓库里会让每个 clone 都继承别人的内网地址。
    //   填写时末尾的 /v1 保留原样（如 https://relay.example.com/v1）。
    baseUrl: '',

    // 入站路径 → 上游路径的拼接方式。
    //   'auto'（推荐）：若入站 path 以 stripPrefix 开头则剥掉，否则原样追加
    //   'append'      ：始终剥掉 stripPrefix
    //   'absolute'    ：保留入站 path 原样（适用于上游 base 不带路径前缀）
    //
    // 为什么要剥：Codex 的 base_url 是 http://127.0.0.1:8787/v1，因此它请求
    // /v1/responses；而上游 base 也带 /v1，直接拼会得到 /v1/v1/responses。
    pathMode: 'auto',
    stripPrefix: '/v1',

    // ★ H5：默认 false = **原样透传** Codex 发来的 Authorization。
    //   只有当你确实需要用另一个 Key 访问上游时，才填具体密钥字符串 —— 但更推荐在
    //   仪表盘「设置 → 上游」里填写（值只存本机 SQLite，不会进版本库）。
    //   注意：填了它意味着客户端身份被替换，属于对"不改"原则的显式例外。
    replaceAuth: false,
    authHeader: 'Authorization',

    // 上游使用内网自签 CA 时，指向 CA 的 PEM 文件
    caFile: null,
    // ★ 保持 true。设为 false 会关闭证书校验（有中间人风险），仅用于排障。
    strictSsl: true,

    // 等上游"响应头"的上限。超时返回 504。注意：**响应体没有超时**（流式长任务必须如此）。
    headersTimeoutMs: 10_000,
    // 流中途上游静默达到此值 → 写一条 warn 日志，但**不掐断**（模型长时间推理是正常的）
    silentWarnMs: 120_000,

    keepAlive: true,
    maxSockets: 32,
  },

  // ── Edge（面向 Codex 的一侧）──────────────────────────────────────────
  edge: {
    // 观测缓冲区上限。它按 1:3 切成「头部 + 尾部」：usage **只存在于流末尾的终止事件**，
    // 所以尾部必须保留 —— 否则所有超过该上限的响应都会退化成"估算"。
    // 调大它只增加内存开销，不改变语义；转发字节完全不受影响。
    observeMaxBytes: 512 * 1024,
    observeTimeoutMs: 3_000,

    // 客户端中断后，为拿到 response.completed 里的 usage 而继续读上游的宽限期（M2 启用，ADR-15）
    graceDrainMs: 8_000,

    // ★ 0 = 关闭（推荐）。>0 会向代理的 SSE 注入 `:\n\n` 保活注释帧，
    //   这会改变转发字节（H3 的唯一例外）。仅在确认中间设备会掐空闲连接时才开启。
    sseKeepAliveMs: 0,

    // ★ 必须是 0：Node 默认 300s 会掐断 LLM 长流（ADR-14）。
    //   配置校验会拒绝非 0 值；想限制"等首字节"请用 upstream.headersTimeoutMs。
    requestTimeoutMs: 0,
  },

  // ── 本地访问安全 ──────────────────────────────────────────────────────
  security: {
    // 每次安装的随机令牌。**只作用于 /_sgw/**，绝不影响 /v1/** 代理路径。
    requireToken: true,
    tokenFile: null,          // null = <dataDir>/.token

    // 留空则自动按监听地址推导（始终包含 127.0.0.1 / localhost / [::1] 的对应端口形式）
    allowedHosts: [],
    allowedOrigins: [],
  },

  // ── 日志 ──────────────────────────────────────────────────────────────
  logging: {
    level: 'info',
    // Authorization 明文永不进日志；此开关只影响"是否记录完整请求头集合"
    logRequestHeaders: false,
  },

  dataDir: './data',
});
