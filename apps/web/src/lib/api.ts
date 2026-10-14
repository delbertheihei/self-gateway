/**
 * 控制面 API 客户端。
 *
 * 两个必须处理的事（否则管理 API 会 401 / 403）：
 *   1. **本地访问令牌**：`X-Gateway-Token`。首次通过 `?token=…` 引导取得，
 *      存入 localStorage，并**立刻从地址栏抹掉**（避免泄漏到历史记录/Referer）。
 *   2. **Origin**：浏览器对非 GET 请求自动带 Origin，服务端做了白名单校验。
 *      同源访问天然通过，无需我们额外处理。
 */

const TOKEN_KEY = 'sgw.token';
const API_BASE = '/_sgw/api';

let tokenCache: string | null = null;

/** 从 URL 引导令牌（一次性），随后清理地址栏 */
export function bootstrapTokenFromUrl(): void {
  const url = new URL(window.location.href);
  const fromUrl = url.searchParams.get('token');
  if (fromUrl) {
    try { localStorage.setItem(TOKEN_KEY, fromUrl); } catch { /* 隐私模式下可能失败 */ }
    tokenCache = fromUrl;
    url.searchParams.delete('token');
    window.history.replaceState({}, '', `${url.pathname}${url.search}${url.hash}`);
    return;
  }
  try { tokenCache = localStorage.getItem(TOKEN_KEY); } catch { tokenCache = null; }
}

export function getToken(): string | null {
  if (tokenCache === null) {
    try { tokenCache = localStorage.getItem(TOKEN_KEY); } catch { tokenCache = null; }
  }
  return tokenCache;
}

export function setToken(t: string): void {
  tokenCache = t;
  try { localStorage.setItem(TOKEN_KEY, t); } catch { /* 忽略 */ }
}

export function clearToken(): void {
  tokenCache = null;
  try { localStorage.removeItem(TOKEN_KEY); } catch { /* 忽略 */ }
}

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly hint: string | null;

  constructor(status: number, code: string, message: string, hint: string | null) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.hint = hint;
  }
}

async function call<T>(
  path: string,
  init: { method?: string; body?: unknown; query?: Record<string, unknown> } = {},
): Promise<T> {
  const url = new URL(`${API_BASE}${path}`, window.location.origin);
  if (init.query) {
    for (const [k, v] of Object.entries(init.query)) {
      if (v === undefined || v === null || v === '') continue;
      url.searchParams.set(k, String(v));
    }
  }

  const headers: Record<string, string> = {};
  const token = getToken();
  if (token) headers['X-Gateway-Token'] = token;
  if (init.body !== undefined) headers['Content-Type'] = 'application/json';

  const res = await fetch(url.toString(), {
    method: init.method ?? 'GET',
    headers,
    ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
  });

  const text = await res.text();
  let parsed: unknown = null;
  try { parsed = text ? JSON.parse(text) : null; } catch { /* 非 JSON（例如 CSV） */ }

  if (!res.ok) {
    const err = (parsed as { error?: { code?: string; message?: string; hint?: string } } | null)?.error;
    throw new ApiError(
      res.status,
      err?.code ?? `HTTP_${res.status}`,
      err?.message ?? res.statusText ?? '请求失败',
      err?.hint ?? null,
    );
  }
  return parsed as T;
}

// ─────────────────────────────── 类型 ───────────────────────────────

export interface RangeMeta { rangeMs: [number, number] }

export interface Summary {
  range: { from: number; to: number };
  requestCount: number;
  errorCount: number;
  estimatedCount: number;
  incompleteCount: number;
  errorRate: number;
  estimatedRatio: number;
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  reasoningTokens: number;
  totalTokens: number;
  uncachedInput: number;
  /**
   * 缓存命中率 = cachedTokens / cacheKnownInput。
   * 分母只含"缓存信息可信"（上游返回完整 usage）的 input —— 本地估算的缓存情况是未知，不是 0。
   */
  cacheHitRate: number;
  cacheKnownInput: number;
  costUsd: number;
  costKnown: boolean;
  /** 缺价格的模型（界面据此提示去设置页补价格） */
  unpricedModels: string[];
  latency: {
    p50: number; p95: number; p99: number; avgMs: number; sampleCount: number;
    buckets: Array<{ from: number; to: number; count: number }>;
  };
  ttfbAvgMs: number;
}

export interface TimeseriesPoint {
  bucketStart: number;
  requestCount: number;
  errorCount: number;
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  reasoningTokens: number;
  totalTokens: number;
  estimatedCount: number;
  incompleteCount: number;
  costUsd: number;
}

export interface ModelBreakdown {
  model: string;
  requestCount: number;
  errorCount: number;
  totalTokens: number;
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  reasoningTokens: number;
  costUsd: number;
  costKnown: boolean;
  share: number;
  p95: number;
}

export interface SessionBreakdown {
  sessionId: string;
  externalId: string | null;
  title: string | null;
  /** 展示用标签（后端已确定，前端直接用，避免多会话显示成同一个名字） */
  label: string;
  lastSeenAt: number;
  requestCount: number;
  totalTokens: number;
  costUsd: number;
  costKnown: boolean;
}

export interface RequestRow {
  id: string;
  startedAt: number;
  method: string;
  path: string;
  endpoint: string;
  status: number | null;
  errorClass: string | null;
  model: string | null;
  sessionId: string | null;
  threadId: string | null;
  originator: string | null;
  upstreamRequestId: string | null;
  responseId: string | null;
  totalMs: number;
  ttfbMs: number | null;
  firstTokenMs: number | null;
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  reasoningTokens: number;
  totalTokens: number;
  usageSource: string;
  usageComplete: boolean;
  observeShape: string;
  observeNote: string | null;
  bytesIn: number;
  bytesOut: number;
  costUsd: number | null;
  hasBody: boolean;
  bodyBytes: number | null;
  truncatedResponse: boolean;
}

export interface Page<T> {
  data: T[];
  meta: { nextCursor: string | null; hasMore: boolean; totalApprox: number; rangeMs: [number, number] };
  warnings?: string[];
  notice?: { code: string; message: string; hint: string };
}

export interface Health {
  ok: boolean;
  version: string;
  uptimeSec: number;
  node: string;
  listen: string;
  upstream: {
    baseUrl: string; stripPrefix: string; pathMode: string;
    reachable: boolean | null; lastProbeAt: number | null; lastError: string | null;
  };
  usageContract: { checked: boolean; complete: boolean | null; missingFields: string[]; checkedAt: number | null };
  logging: { detailEnabled: boolean; bodyEnabled: boolean };
  security: { requireToken: boolean; allowedHosts: string[] };
  dataDir: string;
}

/** 一条价格（USD / 1M tokens）。通配：`gpt-6-*`、`*` */
export interface PriceRow {
  model: string;
  inputPerMtok: number;
  outputPerMtok: number;
  cachedPerMtok: number | null;
  reasoningPerMtok: number | null;
}

export interface Meta {
  models: string[];
  /** 本机出现过的模型里还没有价格的（提示用户去补，否则成本显示为未知） */
  unpricedModels: string[];
  priceSource: { label: string; url: string; crossCheckUrl: string; retrievedAt: string; currency: string; unit: string; version: number };
  counts: { events: number; sessions: number; hasDetail: boolean };
  settings: {
    detailEnabled: boolean; bodyEnabled: boolean; bodyMaxBytes: number; bodyCompress: boolean;
    detailDays: number; bodyDays: number; maxDbBytes: number; maxBodyBytes: number; autoVacuum: boolean;
  };
  prices: PriceRow[];
  storage: { dataDir: string; dbBytes: number; bodiesBytes: number; totalBytes: number };
  lastCleanup: { ranAt: number; reason: string; deletedDetailRows: number; deletedBodyDirs: string[] } | null;
  sawWebsocketAttempt: boolean;
  upstreamProbeStatus: number | null;
  restartedNeeded: boolean;
}

export interface SettingsPayload {
  logging: { detailEnabled: boolean; bodyEnabled: boolean; bodyMaxBytes: number; bodyCompress: boolean };
  retention: { detailDays: number; bodyDays: number; maxDbBytes: number; maxBodyBytes: number; autoVacuum: boolean };
  /**
   * 上游设置。
   *
   * ★ 带 `?` 的字段是**后加的**：正在运行的旧进程不会返回它们。前端一律做防御性读取
   *   （`?? 默认值`），这样"新前端 + 旧进程"不会白屏，只是少几项而已。
   */
  upstream: {
    /** 运行时生效的上游地址 */
    baseUrl: string;
    /** 启动时 sgw.config.ts 里写的值（快照，仅供对照显示） */
    configuredBaseUrl: string;
    /** 被运行期设置（SQLite）覆盖的键 */
    overrides?: string[];
    stripPrefix: string;
    pathMode: string;
    /** 探针模型；未配置 = 空串 */
    probeModel?: string;
    /** 是否已配置"替换鉴权"（密钥本身永不回传） */
    replaceAuth: boolean;
    authHeader?: string;
    hasProbeAuth: boolean;
    probeAuthSource?: string | null;
    caFile: string | null;
    strictSsl: boolean;
    headersTimeoutMs: number;
    graceDrainMs: number;
  };
  security: { requireToken: boolean; tokenFingerprint: string; allowedHosts: string[] };
  edge: { observeMaxBytes: number; sseKeepAliveMs: number; requestTimeoutMs: number };
}

export interface SelfTestCheck {
  id: string;
  name: string;
  group: string;
  ok: boolean;
  detail: string;
  ref?: string;
}

export interface SelfTestReport {
  ranAt: number;
  durationMs: number;
  passed: number;
  failed: number;
  checks: SelfTestCheck[];
  summary: string;
}

export interface ContractProbe {
  checked: boolean;
  complete: boolean | null;
  missingFields: string[];
  checkedAt: number;
  note: string | null;
  terminalType: string | null;
  sawUsage: boolean;
}

// ─────────────────────────────── 端点 ───────────────────────────────

export const api = {
  health: () => call<Health>('/health'),
  version: () => call<{ version: string; node: string; pid: number }>('/version'),
  meta: () => call<{ data: Meta }>('/meta'),

  summary: (range: string) => call<{ data: Summary; warnings?: string[] }>('/stats/summary', { query: { range } }),
  timeseries: (range: string, bucket = 'auto', breakdown = 'type') =>
    call<{ data: TimeseriesPoint[] | { models: string[]; points: Array<{ bucketStart: number; byModel: Record<string, TimeseriesPoint> }> } }>(
      '/stats/timeseries', { query: { range, bucket, breakdown } }),
  byModel: (range: string, limit = 20) =>
    call<{ data: ModelBreakdown[] }>('/stats/by-model', { query: { range, limit } }),
  bySession: (range: string, limit = 20) =>
    call<{ data: SessionBreakdown[] }>('/stats/by-session', { query: { range, limit } }),
  latency: (range: string) => call<{ data: Summary['latency'] }>('/stats/latency', { query: { range } }),

  requests: (q: {
    range: string; model?: string; status?: string; endpoint?: string;
    usageSource?: string; minDuration?: number; sessionId?: string; q?: string;
    cursor?: string; limit?: number; orderBy?: string; order?: string;
  }) => call<Page<RequestRow>>('/requests', { query: q }),

  request: (id: string) => call<{ data: RequestRow & Record<string, unknown> }>(`/requests/${id}`),
  requestBody: (id: string, side: 'request' | 'response') =>
    call<{ data: { id: string; side: string; bytes: number; truncated: boolean; raw: unknown }; warning: string }>(
      `/requests/${id}/body`, { query: { side } }),

  sessions: (limit = 100) => call<{ data: SessionBreakdown[] }>('/sessions', { query: { limit } }),

  settings: () => call<{ data: SettingsPayload }>('/settings'),
  patchSettings: (patch: unknown) =>
    call<{ data: unknown; restartedNeeded: boolean }>('/settings', { method: 'PATCH', body: patch }),

  selftest: () => call<{ data: SelfTestReport }>('/selftest', { method: 'POST', body: {} }),
  upstreamTest: () => call<{ data: ContractProbe }>('/upstream/test', { method: 'POST', body: {} }),
  maintenance: () => call<{ data: { ranAt: number; reason: string; deletedDetailRows: number; deletedBodyDirs: string[]; dbBytes: number; bodyBytes: number } }>(
    '/maintenance', { method: 'POST', body: {} }),
  backup: () => call<{ data: { file: string; bytes: number } }>('/backup', { method: 'POST', body: {} }),
  purge: (scope: 'detail' | 'bodies' | 'all', before?: number) =>
    call<{ data: { deletedDetailRows: number; deletedBodyDirs: string[]; note?: string; sizes: { dbBytes: number; bodiesBytes: number } } }>(
      '/data', { method: 'DELETE', body: before ? { scope, before } : { scope } }),

  prices: () => call<{ data: PriceRow[]; meta: { source: Meta['priceSource'] } }>('/prices'),
  putPrices: (prices: PriceRow[]) =>
    call<{ data: { updated: number; prices: PriceRow[] } }>('/prices', { method: 'PUT', body: { prices } }),
  deletePrice: (model: string) =>
    call<{ data: { deleted: string; prices: PriceRow[] } }>('/prices', { method: 'DELETE', query: { model } }),
  /** 恢复官方默认价格：默认只补缺失的模型；overwrite=true 连已改过的行也重置 */
  restoreDefaultPrices: (overwrite = false) =>
    call<{ data: { inserted: number; overwritten: number; prices: PriceRow[]; source: Meta['priceSource'] } }>(
      '/prices/defaults', { method: 'POST', body: { overwrite } }),

  exportCsvUrl: (range: string) => `${API_BASE}/export/requests.csv?range=${encodeURIComponent(range)}`,
};

/**
 * 开发调试用的引导链接（把 token 拼进 URL）。
 *
 * 端口默认取**当前页面**的端口 —— 不要写死 8787：网关端口是可配置的（listen.port），
 * 写死会让"改成 8899 跑"的场景生成一个指向错误端口的链接。
 */
export function bootstrapUrl(port = window.location.port || '8787'): string {
  const t = getToken();
  const host = window.location.hostname || '127.0.0.1';
  return t ? `http://${host}:${port}/?token=${t}` : `http://${host}:${port}/`;
}
