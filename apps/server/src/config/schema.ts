/**
 * SGW 配置：schema、默认值、加载与热覆盖合并。
 *
 * 设计（docs/03 §4.3 混合式配置）：
 *   - **启动期配置** 放 `sgw.config.ts`（类型化、可注释、可 git 管理），改了要重启
 *   - **运行期设置** 将来放 SQLite settings 表（M3），由仪表盘热改
 *   - **Web 端永不回写 `sgw.config.ts`** —— 避免 UI 意外破坏人类可读的配置
 *
 * ⚠️ 手写校验器而非 zod：本文件属于 M1「纯透传骨架」，M1 的硬性目标是
 *    "零运行时依赖 + 先证明透传正确"。zod 会在 M2/M3 引入（docs/03 §1 的 3 个依赖），
 *    届时用 zod 重写本文件的 validate 部分，schema 形状保持不变。
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_PORT } from '@sgw/shared';

// ─────────────────────────────── 类型 ───────────────────────────────

export interface UpstreamConfig {
  /**
   * 上游基址。**可以为空** —— 表示"尚未配置"，此时可在仪表盘设置页手动填写。
   *
   * 这里写的值只是**启动默认值**：settings 表里的运行期值优先级更高（热改、持久化）。
   * 仓库里绝不预置任何具体域名（那会让每个 clone 都继承别人的内网地址）。
   */
  baseUrl: string;
  /** 'auto' = 由探针/首次请求自动确定；'append' = 剥掉入站前缀；'absolute' = 保留入站 path */
  pathMode: 'auto' | 'append' | 'absolute';
  /** 入站 path 中需要剥掉的前缀（仅 pathMode='append' 时生效） */
  stripPrefix: string;
  /** 显式替换 Authorization（H5：默认关闭 = 原样透传） */
  replaceAuth: false | string;
  authHeader: string;
  caFile: string | null;
  strictSsl: boolean;
  /** 等上游响应头的上限；超时→504。注意：**响应体没有超时**（流式长任务） */
  headersTimeoutMs: number;
  /** 流中途静默达到此值写 warn 日志（不掐断） */
  silentWarnMs: number;
  keepAlive: boolean;
  maxSockets: number;

  // ── usage 契约探针（M0-2b 的运行期防线）──
  /** 探针请求使用的模型名。空字符串 = 未配置（探针跳过，不瞎猜模型） */
  probeModel: string;
  /** 探针使用的完整鉴权头值（如 "Bearer sk-…"）；null = 复用 Codex 最近一次的 Authorization */
  probeAuth: string | null;
  /** 是否在启动后自动跑一次契约探针 */
  probeOnStart: boolean;
}

export interface EdgeConfig {
  /** 只允许回环。改为 0.0.0.0 需显式 allowExternal=true，且 UI 上是只读的 */
  host: string;
  allowExternal: boolean;
  port: number;
  /** 观测缓冲区上限 */
  observeMaxBytes: number;
  /** 观测兜底 finish 超时 */
  observeTimeoutMs: number;
  /** 客户端中断后，为记账继续读上游的宽限期（ADR-15） */
  graceDrainMs: number;
  /**
   * 向代理的 SSE 注入 `:\n\n` 保活注释帧的间隔。**0 = 关闭（默认）**。
   * >0 会改变转发字节，属 H3 例外，必须由用户显式开启。
   */
  sseKeepAliveMs: number;
  /** 必须是 0 —— Node 默认 300s 会掐断长流（ADR-14） */
  requestTimeoutMs: number;
}

export interface SecurityConfig {
  /** 每次安装随机 token（M3 落地；M1 预留）。**只作用于 /_sgw/**，绝不影响 /v1/** */
  requireToken: boolean;
  tokenFile: string | null;
  /** Host 白名单 —— 反 DNS Rebinding 的核心防线 */
  allowedHosts: string[];
  allowedOrigins: string[];
}

export interface LoggingConfig {
  level: 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal';
  /** 是否把完整请求头写入日志。默认关闭（Authorization 可能在其中） */
  logRequestHeaders: boolean;
}

export interface SgwConfig {
  listen: { host: string; port: number; allowExternal: boolean };
  upstream: UpstreamConfig;
  edge: EdgeConfig;
  security: SecurityConfig;
  logging: LoggingConfig;
  dataDir: string;
}

// ─────────────────────────────── 默认值 ───────────────────────────────

export function defaultConfig(): SgwConfig {
  return {
    listen: { host: '127.0.0.1', port: DEFAULT_PORT, allowExternal: false },
    upstream: {
      // ★ 空 = 未配置。上游地址是**运行期手动输入**的（设置页可改、可热生效、存 SQLite），
      //   绝不在代码或仓库里写死某个内网域名。
      baseUrl: '',
      pathMode: 'auto',
      stripPrefix: '/v1',
      replaceAuth: false,
      authHeader: 'Authorization',
      caFile: null,
      strictSsl: true,
      headersTimeoutMs: 10_000,
      silentWarnMs: 120_000,
      keepAlive: true,
      maxSockets: 32,
      // 空 = 未配置探针模型（usage 契约探针会跳过并说明原因，而不是拿一个瞎猜的模型去打上游）
      probeModel: '',
      probeAuth: null,
      probeOnStart: true,
    },
    edge: {
      host: '127.0.0.1',
      allowExternal: false,
      port: DEFAULT_PORT,
      observeMaxBytes: 512 * 1024,
      observeTimeoutMs: 3_000,
      graceDrainMs: 8_000,
      sseKeepAliveMs: 0,
      requestTimeoutMs: 0,
    },
    security: {
      requireToken: true,
      tokenFile: null,
      allowedHosts: [],
      allowedOrigins: [],
    },
    logging: { level: 'info', logRequestHeaders: false },
    dataDir: '',
  };
}

// ─────────────────────────────── 校验 ───────────────────────────────

export class ConfigError extends Error {
  readonly issues: string[];
  constructor(issues: string[]) {
    super(`配置无效：\n  - ${issues.join('\n  - ')}`);
    this.name = 'ConfigError';
    this.issues = issues;
  }
}

type Raw = Record<string, unknown>;

const isPlainObject = (v: unknown): v is Raw =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

function pickString(raw: Raw, key: string, issues: string[]): string | undefined {
  const v = raw[key];
  if (v === undefined) return undefined;
  if (typeof v !== 'string') { issues.push(`${key} 必须是字符串，实际是 ${typeof v}`); return undefined; }
  return v;
}

/** 允许显式 null 的字符串字段（null 是合法值，表示"未配置"） */
function pickNullableString(raw: Raw, key: string, issues: string[]): string | null | undefined {
  const v = raw[key];
  if (v === undefined) return undefined;
  if (v === null) return null;
  if (typeof v !== 'string') { issues.push(`${key} 必须是字符串或 null，实际是 ${typeof v}`); return undefined; }
  return v;
}

function pickNumber(raw: Raw, key: string, issues: string[], min: number, max: number): number | undefined {
  const v = raw[key];
  if (v === undefined) return undefined;
  if (typeof v !== 'number' || !Number.isInteger(v)) { issues.push(`${key} 必须是整数，实际是 ${JSON.stringify(v)}`); return undefined; }
  if (v < min || v > max) { issues.push(`${key} 必须在 [${min}, ${max}] 之间，实际是 ${v}`); return undefined; }
  return v;
}

function pickBool(raw: Raw, key: string, issues: string[]): boolean | undefined {
  const v = raw[key];
  if (v === undefined) return undefined;
  if (typeof v !== 'boolean') { issues.push(`${key} 必须是布尔值，实际是 ${typeof v}`); return undefined; }
  return v;
}

function pickStringArray(raw: Raw, key: string, issues: string[]): string[] | undefined {
  const v = raw[key];
  if (v === undefined) return undefined;
  if (!Array.isArray(v) || v.some((x) => typeof x !== 'string')) {
    issues.push(`${key} 必须是字符串数组`); return undefined;
  }
  return v as string[];
}

/**
 * 校验并归一化一个用户提供的配置片段（来自 sgw.config.ts 的 default export）。
 * 返回的是**完整配置**（默认值 + 覆盖）。
 */
export function validateConfig(input: unknown, cwd: string = process.cwd()): SgwConfig {
  const issues: string[] = [];
  if (!isPlainObject(input)) {
    throw new ConfigError(['sgw.config.ts 必须默认导出一个对象（建议用 defineConfig({...})）']);
  }
  const cfg = defaultConfig();
  const raw = input as Raw;

  // ── listen ──
  const listen = isPlainObject(raw.listen) ? raw.listen : {};
  if (raw.listen !== undefined && !isPlainObject(raw.listen)) issues.push('listen 必须是对象');
  const host = pickString(listen, 'host', issues);
  if (host !== undefined) cfg.listen.host = host;
  const port = pickNumber(listen, 'port', issues, 1, 65535);
  if (port !== undefined) { cfg.listen.port = port; cfg.edge.port = port; }
  const allowExternal = pickBool(listen, 'allowExternal', issues);
  if (allowExternal !== undefined) { cfg.listen.allowExternal = allowExternal; cfg.edge.allowExternal = allowExternal; }

  // ── upstream ──
  const up = isPlainObject(raw.upstream) ? raw.upstream : {};
  if (raw.upstream !== undefined && !isPlainObject(raw.upstream)) issues.push('upstream 必须是对象');
  const baseUrl = pickString(up, 'baseUrl', issues);
  if (baseUrl !== undefined) cfg.upstream.baseUrl = baseUrl.trim();
  const pathMode = up.pathMode;
  if (pathMode !== undefined) {
    if (pathMode !== 'auto' && pathMode !== 'append' && pathMode !== 'absolute') {
      issues.push(`upstream.pathMode 必须是 'auto' | 'append' | 'absolute'，实际是 ${JSON.stringify(pathMode)}`);
    } else cfg.upstream.pathMode = pathMode;
  }
  const stripPrefix = pickString(up, 'stripPrefix', issues);
  if (stripPrefix !== undefined) cfg.upstream.stripPrefix = stripPrefix;
  if (up.replaceAuth !== undefined) {
    if (up.replaceAuth === false) cfg.upstream.replaceAuth = false;
    else if (up.replaceAuth === true) issues.push('upstream.replaceAuth 不能是 true —— 必须给出具体密钥字符串或 false（H5）');
    else if (typeof up.replaceAuth === 'string' && up.replaceAuth.trim()) cfg.upstream.replaceAuth = up.replaceAuth.trim();
    else issues.push('upstream.replaceAuth 必须是非空字符串或 false');
  }
  const authHeader = pickString(up, 'authHeader', issues);
  if (authHeader !== undefined) cfg.upstream.authHeader = authHeader;
  const caFile = pickNullableString(up, 'caFile', issues);
  if (caFile !== undefined) cfg.upstream.caFile = caFile ? path.resolve(cwd, caFile) : null;
  const strictSsl = pickBool(up, 'strictSsl', issues);
  if (strictSsl !== undefined) cfg.upstream.strictSsl = strictSsl;
  const headersTimeoutMs = pickNumber(up, 'headersTimeoutMs', issues, 0, 3_600_000);
  if (headersTimeoutMs !== undefined) cfg.upstream.headersTimeoutMs = headersTimeoutMs;
  const silentWarnMs = pickNumber(up, 'silentWarnMs', issues, 0, 86_400_000);
  if (silentWarnMs !== undefined) cfg.upstream.silentWarnMs = silentWarnMs;
  const keepAlive = pickBool(up, 'keepAlive', issues);
  if (keepAlive !== undefined) cfg.upstream.keepAlive = keepAlive;
  const maxSockets = pickNumber(up, 'maxSockets', issues, 1, 1024);
  if (maxSockets !== undefined) cfg.upstream.maxSockets = maxSockets;
  const probeModel = pickString(up, 'probeModel', issues);
  if (probeModel !== undefined && probeModel.trim()) cfg.upstream.probeModel = probeModel.trim();
  const probeAuth = pickNullableString(up, 'probeAuth', issues);
  if (probeAuth !== undefined) cfg.upstream.probeAuth = probeAuth;
  const probeOnStart = pickBool(up, 'probeOnStart', issues);
  if (probeOnStart !== undefined) cfg.upstream.probeOnStart = probeOnStart;

  // ── edge ──
  const edge = isPlainObject(raw.edge) ? raw.edge : {};
  if (raw.edge !== undefined && !isPlainObject(raw.edge)) issues.push('edge 必须是对象');
  const edgeHost = pickString(edge, 'host', issues);
  if (edgeHost !== undefined) cfg.edge.host = edgeHost;
  const observeMaxBytes = pickNumber(edge, 'observeMaxBytes', issues, 0, 64 * 1024 * 1024);
  if (observeMaxBytes !== undefined) cfg.edge.observeMaxBytes = observeMaxBytes;
  const observeTimeoutMs = pickNumber(edge, 'observeTimeoutMs', issues, 0, 600_000);
  if (observeTimeoutMs !== undefined) cfg.edge.observeTimeoutMs = observeTimeoutMs;
  const graceDrainMs = pickNumber(edge, 'graceDrainMs', issues, 0, 600_000);
  if (graceDrainMs !== undefined) cfg.edge.graceDrainMs = graceDrainMs;
  const sseKeepAliveMs = pickNumber(edge, 'sseKeepAliveMs', issues, 0, 600_000);
  if (sseKeepAliveMs !== undefined) cfg.edge.sseKeepAliveMs = sseKeepAliveMs;
  const requestTimeoutMs = pickNumber(edge, 'requestTimeoutMs', issues, 0, 86_400_000);
  if (requestTimeoutMs !== undefined) {
    if (requestTimeoutMs !== 0) {
      issues.push('edge.requestTimeoutMs 必须为 0 —— Node 默认 300s 会掐断 LLM 长流（ADR-14）。'
        + '若确实想限制，请用 upstream.headersTimeoutMs 控制"等首字节"的时间。');
    }
    cfg.edge.requestTimeoutMs = requestTimeoutMs;
  }

  // ── security ──
  const sec = isPlainObject(raw.security) ? raw.security : {};
  if (raw.security !== undefined && !isPlainObject(raw.security)) issues.push('security 必须是对象');
  const requireToken = pickBool(sec, 'requireToken', issues);
  if (requireToken !== undefined) cfg.security.requireToken = requireToken;
  const tokenFile = pickNullableString(sec, 'tokenFile', issues);
  if (tokenFile !== undefined) cfg.security.tokenFile = tokenFile ? path.resolve(cwd, tokenFile) : null;
  const allowedHosts = pickStringArray(sec, 'allowedHosts', issues);
  if (allowedHosts !== undefined) cfg.security.allowedHosts = allowedHosts;
  const allowedOrigins = pickStringArray(sec, 'allowedOrigins', issues);
  if (allowedOrigins !== undefined) cfg.security.allowedOrigins = allowedOrigins;

  // ── logging ──
  const log = isPlainObject(raw.logging) ? raw.logging : {};
  if (raw.logging !== undefined && !isPlainObject(raw.logging)) issues.push('logging 必须是对象');
  const level = log.level;
  if (level !== undefined) {
    const levels = ['trace', 'debug', 'info', 'warn', 'error', 'fatal'];
    if (typeof level !== 'string' || !levels.includes(level)) issues.push(`logging.level 必须是 ${levels.join(' | ')}`);
    else cfg.logging.level = level as LoggingConfig['level'];
  }
  const logRequestHeaders = pickBool(log, 'logRequestHeaders', issues);
  if (logRequestHeaders !== undefined) cfg.logging.logRequestHeaders = logRequestHeaders;

  // ── dataDir ──
  const dataDir = pickString(raw, 'dataDir', issues);
  if (dataDir !== undefined) cfg.dataDir = dataDir;

  // ── 跨字段约束 ──
  // ★ 上游地址**不要求**在配置里写死：它可以在仪表盘设置页手动填写（热改，存 SQLite）。
  //   这里只负责"如果填了就必须合法"。留空是合法配置 —— 启动照常，请求到达时才提示填写。
  if (cfg.upstream.baseUrl) {
    let bad: string | null = null;
    try {
      const u = new URL(cfg.upstream.baseUrl);
      if (u.protocol !== 'http:' && u.protocol !== 'https:') {
        bad = `协议必须是 http/https，实际是 ${u.protocol}`;
      }
    } catch {
      bad = `不是合法 URL：${cfg.upstream.baseUrl}`;
    }
    if (bad) issues.push(`upstream.baseUrl ${bad}`);
  }

  if (!cfg.listen.allowExternal) {
    const ok = cfg.listen.host === '127.0.0.1' || cfg.listen.host === '::1' || cfg.listen.host === 'localhost';
    if (!ok) {
      issues.push(`listen.host = "${cfg.listen.host}" 会暴露到回环之外。`
        + '若确实需要，请显式设置 listen.allowExternal = true（安全风险自负）。');
    }
  }

  if (!cfg.upstream.strictSsl && cfg.upstream.baseUrl.startsWith('https:')) {
    // 不是错误，但必须在日志里警示
    issues.push('upstream.strictSsl = false 将关闭上游证书校验。这不是配置错误，但请确认这是有意为之。');
  }

  const cfgWithPaths = normalizePaths(cfg, cwd);
  const fatal = issues.filter((i) => !i.includes('请确认这是有意为之'));
  if (fatal.length) throw new ConfigError(fatal);
  return cfgWithPaths;
}

/** 把相对路径解析为绝对路径，并补全默认的 Host/Origin 白名单 */
function normalizePaths(cfg: SgwConfig, cwd: string): SgwConfig {
  const dataDir = cfg.dataDir ? path.resolve(cwd, cfg.dataDir) : path.resolve(cwd, 'data');
  const host = cfg.listen.host;
  const port = cfg.listen.port;

  // Host 白名单默认根据监听地址推导；并始终包含 localhost/127.0.0.1 的所有形式，
  // 避免用户用 localhost 打开仪表盘时被自己挡住（这是"可用性"与"防重绑定"的平衡点：
  // 被挡住的攻击面是"任意域名"，而不是这两个回环别名）。
  const hostVariants = new Set<string>(cfg.security.allowedHosts);
  for (const h of [host, '127.0.0.1', 'localhost', '[::1]']) {
    hostVariants.add(`${h}:${port}`);
  }
  if (port === 80) {
    for (const h of [host, '127.0.0.1', 'localhost']) hostVariants.add(h);
  }

  const originVariants = new Set<string>(cfg.security.allowedOrigins);
  for (const h of [host === 'localhost' ? 'localhost' : host, '127.0.0.1', 'localhost']) {
    originVariants.add(`http://${h}:${port}`);
  }

  return {
    ...cfg,
    dataDir,
    security: {
      ...cfg.security,
      tokenFile: cfg.security.tokenFile ?? path.join(dataDir, '.token'),
      allowedHosts: [...hostVariants],
      allowedOrigins: [...originVariants],
    },
  };
}

// ─────────────────────────────── defineConfig（类型辅助） ───────────────────────────────

/** 让 sgw.config.ts 获得补全与拼写检查。深 Partial 便于只写关心的字段。 */
export interface SgwConfigInput {
  listen?: Partial<SgwConfig['listen']>;
  upstream?: Partial<UpstreamConfig>;
  edge?: Partial<EdgeConfig>;
  security?: Partial<SecurityConfig>;
  logging?: Partial<LoggingConfig>;
  dataDir?: string;
}

export function defineConfig(input: SgwConfigInput): SgwConfigInput {
  return input;
}

// ─────────────────────────────── 加载 ───────────────────────────────

export interface LoadResult {
  config: SgwConfig;
  source: string;
  warnings: string[];
}

const CONFIG_CANDIDATES = ['sgw.config.ts', 'sgw.config.mts', 'sgw.config.js', 'sgw.config.mjs', 'sgw.config.json'];

/**
 * 按顺序查找并加载配置。
 * 优先级：SGW_CONFIG 环境变量 > cwd 下的候选文件 > 内置默认值（baseUrl 为空 → 校验失败）。
 */
export async function loadConfig(opts: { cwd?: string; envFile?: string } = {}): Promise<LoadResult> {
  const cwd = opts.cwd ?? process.cwd();
  const warnings: string[] = [];

  const explicit = opts.envFile ?? process.env.SGW_CONFIG;
  let file: string | null = null;
  if (explicit) {
    const abs = path.resolve(cwd, explicit);
    if (!fs.existsSync(abs)) throw new ConfigError([`SGW_CONFIG 指定的文件不存在：${abs}`]);
    file = abs;
  } else {
    for (const name of CONFIG_CANDIDATES) {
      const abs = path.join(cwd, name);
      if (fs.existsSync(abs)) { file = abs; break; }
    }
  }

  let rawInput: unknown = {};
  let source = '(内置默认值 —— 未找到配置文件)';

  if (file) {
    source = file;
    if (file.endsWith('.json')) {
      try { rawInput = JSON.parse(fs.readFileSync(file, 'utf8')); }
      catch (e) { throw new ConfigError([`${file} 不是合法 JSON：${(e as Error).message}`]); }
    } else {
      // Node 22 原生支持直接 import .ts（可擦除语法）。用 file:// URL 保证 Windows 路径正确。
      const mod = await import(pathToFileUrl(file));
      rawInput = mod.default ?? mod.config ?? {};
      if (!mod.default && !mod.config) {
        throw new ConfigError([`${file} 必须默认导出配置对象：export default defineConfig({...})`]);
      }
    }
  }

  const config = validateConfig(rawInput, cwd);

  // 上游指向自己 → 自环（在 index.ts 里还会再检查一次实际监听地址）
  warnings.push(...detectSelfLoop(config));

  if (!config.upstream.baseUrl) {
    warnings.push('未配置上游地址 —— 网关可以启动，但 /v1/** 转发会返回 502。'
      + '请打开仪表盘 → 设置 → 上游，手动填写上游地址（改完即时生效，不必重启；也可以填在 sgw.config.ts 里）。');
  }

  if (config.edge.sseKeepAliveMs > 0) {
    warnings.push(`edge.sseKeepAliveMs = ${config.edge.sseKeepAliveMs} 会向代理的 SSE 注入保活注释帧，`
      + '这会改变转发字节（H3 例外）。若非必要请设为 0。');
  }
  if (!config.upstream.strictSsl) {
    warnings.push('upstream.strictSsl = false：已关闭上游 TLS 证书校验，存在中间人风险。');
  }

  return { config, source, warnings };
}

function pathToFileUrl(p: string): string {
  const u = new URL('file://');
  // Windows 盘符路径需要特殊处理
  const norm = p.replace(/\\/g, '/');
  u.pathname = norm.startsWith('/') ? norm : `/${norm}`;
  return u.href;
}

/**
 * 上游地址是否指向本网关自己？返回可读原因，null = 没问题。
 *
 * ★ 必须在**两处**都用它：启动期校验，以及运行期热改（settings 表 / 设置页）。
 *   只在启动期查的话，用户把地址改成 `http://127.0.0.1:8787/v1` 就会把网关打成
 *   无限自转发 —— 现场表现是整个网关卡死，而不是报错。
 */
export function selfLoopMessage(baseUrl: string, listenPort: number): string | null {
  try {
    const u = new URL(baseUrl);
    const loopback = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);
    const upPort = u.port ? Number(u.port) : (u.protocol === 'https:' ? 443 : 80);
    if (loopback.has(u.hostname) && upPort === listenPort) {
      return `指向本网关自己（${u.host}）—— 会导致请求无限循环。`
        + `请改为真实上游地址，或把监听端口改成其他端口。`;
    }
  } catch { /* URL 非法由 validateBaseUrl 负责报错 */ }
  return null;
}

/** 检测 upstream.baseUrl 是否指向本网关自己（防无限自转发） */
export function detectSelfLoop(cfg: SgwConfig): string[] {
  if (!cfg.upstream.baseUrl) return [];
  const msg = selfLoopMessage(cfg.upstream.baseUrl, cfg.listen.port);
  return msg ? [`upstream.baseUrl ${msg}`] : [];
}

export const __filename = fileURLToPath(import.meta.url);
