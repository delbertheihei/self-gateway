/**
 * SGW 共享类型契约。
 *
 * 严格对齐 `docs/00-agent-dev-spec.md` §6。任何字段增删都必须同步更新该文档。
 *
 * ⚠️ Node 22 原生 TS 限制：只支持"可擦除语法"（erasable syntax）。
 *    禁止 enum / namespace / 参数属性 / 装饰器元数据。因此所有"枚举"一律用
 *    字符串字面量联合 + `as const` 数组表达（见本文件与 errors.ts）。
 */

// ─────────────────────────────── 用量 ───────────────────────────────

/** usage 数据来源：上游精确 / 本地估算 / 完全不可得 */
export type UsageSource = 'upstream' | 'estimated' | 'none';

export interface UsageRecord {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  /** input_tokens_details.cached_tokens —— 命中缓存读取的部分 */
  cachedInputTokens: number;
  /** input_tokens_details.cache_write_tokens —— 写入缓存的部分 */
  cacheWriteTokens: number;
  /** output_tokens_details.reasoning_tokens —— 是 output 的子集，不重复计入 total */
  reasoningTokens: number;
  source: UsageSource;
  estimator?: 'tiktoken' | 'heuristic';
  /**
   * upstream usage 字段是否齐全。false 时**上游会让 Codex 整轮硬失败**
   * （Codex 的 ResponseCompleted 把 input/output/total_tokens 声明为非 Option）。
   * 网关不改字节，只记录并告警。见 docs/02 §5.6。
   */
  complete: boolean;
}

export const ZERO_USAGE: UsageRecord = {
  inputTokens: 0,
  outputTokens: 0,
  totalTokens: 0,
  cachedInputTokens: 0,
  cacheWriteTokens: 0,
  reasoningTokens: 0,
  source: 'none',
  complete: true,
};

// ─────────────────────────────── 计时 ───────────────────────────────

/**
 * 计时记录。
 *
 * ★ 口径纪律（曾经因歧义写错，导致列表里 TTFB 显示成 29865785.8min）：
 *   - `enqueuedAt` / `completedAt` 是**绝对时间戳**（epoch ms）
 *   - `upstreamConnectMs` / `upstreamHeadersMs` / `firstTokenMs` 是**相对 enqueuedAt 的毫秒数**
 *     （与 DB 列 `t_upstream_connect` / `t_upstream_headers` / `t_first_token` 一一对应）
 *   - `totalMs` 是总耗时（毫秒）
 *
 * 这样命名后，"绝对 vs 相对"在字段名上就能看出来，避免再混淆。
 */
export interface TimingRecord {
  /** 收到客户端请求头（绝对时间戳） */
  enqueuedAt: number;
  /** 上游 TCP/TLS 建连完成（相对 enqueuedAt，毫秒） */
  upstreamConnectMs?: number;
  /** 收到上游响应头 ≈ TTFB（相对 enqueuedAt，毫秒） */
  upstreamHeadersMs?: number;
  /** 首个文本 delta（相对 enqueuedAt，毫秒） */
  firstTokenMs?: number;
  /** 完成（或中断）（绝对时间戳） */
  completedAt: number;
  /** 总耗时（毫秒），由 Edge 在 finish() 时算好 */
  totalMs?: number;
}

// ─────────────────────────────── 端点分类 ───────────────────────────────

export type EndpointKind = 'responses' | 'models' | 'chat.completions' | 'other';

/** 观测到的响应形态（决定"能不能从中取 usage"） */
export type ObserveShape = 'sse' | 'json' | 'binary' | 'empty' | 'unknown';

// ─────────────────────────────── 请求事件 ───────────────────────────────

export interface RequestEvent {
  /** 本地生成的 ULID，单调递增便于 keyset 分页 */
  id: string;
  startedAt: number;
  method: string;
  /** 原样保留的 path（不含 query） */
  path: string;
  query: string | null;
  endpoint: EndpointKind;
  status: number | null;
  /** 见 errors.ts 的 ErrorClass */
  errorClass: string | null;
  streamed: boolean;
  /** 原样取自响应头 x-request-id —— Codex 的唯一关联 ID，必须保留 */
  upstreamRequestId: string | null;
  /** response.completed.response.id（M2） */
  responseId: string | null;
  model: string | null;

  // ── Codex 身份头（原样取自请求头，仅本地归因用；见 docs/03 §7）──
  codexSessionId: string | null;
  codexThreadId: string | null;
  codexClientRequestId: string | null;
  codexOriginator: string | null;
  codexSubagent: string | null;

  timing: TimingRecord;
  usage: UsageRecord;
  /**
   * 观测到的响应形态：`sse` / `json` / `binary` / `empty` / `unknown`。
   *
   * 用途：排查"为什么这条记录没有 usage" —— `binary` / `empty` 本来就不可能有 usage，
   * 而 `sse` 却拿不到 usage 才是真正需要关注的问题。
   */
  observeShape: ObserveShape;
  /** 观测侧的说明（解压失败降级、usage 缺字段等）；正常时为 null */
  observeNote: string | null;
  bytesIn: number;
  bytesOut: number;
  truncated: { request: boolean; response: boolean };
  /** 正文落盘相对路径；Body Mode 关闭时为 null */
  bodyRef: string | null;
  /** sha256(Authorization).slice(0,8)，永不存明文 */
  keyFingerprint: string | null;
}

// ─────────────────────────────── 控制面事件（SSE 推送） ───────────────────────────────
export interface StatsTick {
  at: number;
  requestDelta: number;
  tokenDelta: number;
  errorDelta: number;
}

export type GatewayEvent =
  | { type: 'request.start'; data: Pick<RequestEvent, 'id' | 'startedAt' | 'path' | 'model'> }
  | { type: 'request.firstToken'; data: { id: string; at: number } }
  | { type: 'request.end'; data: RequestEvent }
  | { type: 'stats.tick'; data: StatsTick }
  | { type: 'settings.changed'; data: { settings: unknown } }
  | { type: 'alert'; data: { level: 'info' | 'warn' | 'error'; code: string; message: string } };

// ─────────────────────────────── 健康检查 ───────────────────────────────

export interface HealthReport {
  ok: boolean;
  version: string;
  uptimeSec: number;
  node: string;
  listen: string;
  upstream: {
    baseUrl: string;
    stripPrefix: string;
    pathMode: 'auto' | 'append' | 'absolute';
    reachable: boolean | null;
    lastProbeAt: number | null;
    lastError: string | null;
  };
  /** ⚠️ 上游 usage 结构是否完整；false 意味着 Codex 会整轮失败 */
  usageContract: {
    checked: boolean;
    complete: boolean | null;
    missingFields: string[];
    checkedAt: number | null;
  };
  logging: {
    detailEnabled: boolean;
    bodyEnabled: boolean;
  };
  security: {
    requireToken: boolean;
    allowedHosts: string[];
  };
  dataDir: string;
}
