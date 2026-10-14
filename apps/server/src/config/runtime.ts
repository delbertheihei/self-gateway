/**
 * 运行期可热改的**上游设置**（地址 / 路径拼接 / 探针模型 / 鉴权）。
 *
 * 为什么需要它（设计变更，docs/03 §4.3）：
 *   上游地址这类信息**不该被写死在仓库里**。它因部署环境而异（公司中继、自建 relay、
 *   本机 echo 服务器），而且随时可能变。把它固定进 `sgw.config.ts` 意味着
 *   "改一个地址要停机重启"，也意味着**每个 clone 下来的人都继承了别人的内网域名**。
 *
 * 因此上游设置分两层：
 *   - `sgw.config.ts`：**可选**的启动期默认值（留空即可，不必填）
 *   - `settings` 表：运行期真值（设置页可改，**改完立刻生效，不必重启**，且持久化）
 *
 * 优先级：**settings 表 > sgw.config.ts > 内置默认值**。
 *
 * 存储纪律：
 *   - 键统一加 `upstream.` 前缀，与 recorder 的 `recorder` 键互不干扰
 *   - 本模块**只**处理上游设置；日志/保留策略走 recorder（各司其职）
 *   - 明文密钥（replaceAuth / probeAuth）只落本机 SQLite（`data/` 已被 .gitignore 覆盖），
 *     且**永不回传给前端**，前端只看到"是否已设置"
 */

import { deleteSetting, setSetting, type Db } from '../db/index.ts';
import type { Logger } from './logger.ts';
import type { SgwConfig, UpstreamConfig } from './schema.ts';
import { selfLoopMessage } from './schema.ts';

// ─────────────────────────────── 类型 ───────────────────────────────

/** 可热改的上游键（也是 settings 表里的后缀） */
export const UPSTREAM_KEYS = [
  'baseUrl',
  'stripPrefix',
  'pathMode',
  'probeModel',
  'replaceAuth',
  'probeAuth',
] as const;

export type UpstreamKey = (typeof UPSTREAM_KEYS)[number];

/**
 * 已解析的运行期覆盖值（只含**合法**项）。
 *
 * 语义约定（重要，避免"空字符串"歧义）：
 *   - `baseUrl`     非空字符串；不存在 = 未覆盖
 *   - `stripPrefix` 允许 `''`（= 不剥任何前缀，这是合法配置）
 *   - `pathMode`    三选一
 *   - `probeModel`  非空字符串；不存在 = 未配置（探针跳过）
 *   - `replaceAuth` 非空字符串 = 明文密钥；不存在 = 未覆盖
 *   - `probeAuth`   非空字符串 = 完整鉴权头值；不存在 = 未覆盖
 */
export interface UpstreamOverrides {
  baseUrl?: string;
  stripPrefix?: string;
  pathMode?: UpstreamConfig['pathMode'];
  probeModel?: string;
  replaceAuth?: string;
  probeAuth?: string;
}

export interface ApplyResult {
  /** 真正生效（覆盖了配置文件）的键 */
  applied: UpstreamKey[];
  /** 存在但非法、已被忽略的键（附带原因） */
  rejected: Array<{ key: UpstreamKey; reason: string }>;
}

// ─────────────────────────────── 校验 ───────────────────────────────

const DB_PREFIX = 'upstream.';

function dbKey(key: UpstreamKey): string {
  return `${DB_PREFIX}${key}`;
}

/**
 * 读一个覆盖项，并区分"**没有**这个键"与"键的值是空字符串"。
 *
 * ★ 为什么需要包装格式（`{ v: <值> }`）：`stripPrefix = ''` 是一个**合法且有语义**的值
 *   （= 不剥任何前缀），但裸存空串时无法与"清除该项"区分 —— 于是"设置成空"会变成
 *   "删掉键、回落到配置文件"，重启后行为与设置页显示的不一致。
 *   包装后语义唯一：**键不存在 = 未覆盖；键存在 = 值就是它**（空串也算值）。
 *
 * 兼容裸值（含手工写入的 `upstream.baseUrl`）：不是对象、或对象里没有 `v`，就当作值本身。
 */
function readOverride(db: Db, key: UpstreamKey): { present: boolean; value: unknown } {
  const row = db.get<{ value: string }>('SELECT value FROM settings WHERE key = ?', [dbKey(key)]);
  if (!row) return { present: false, value: undefined };
  let parsed: unknown;
  try { parsed = JSON.parse(row.value); } catch { return { present: true, value: row.value }; }
  if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) && 'v' in parsed) {
    return { present: true, value: (parsed as { v: unknown }).v };
  }
  return { present: true, value: parsed };
}

/** 合法的上游地址？返回错误原因，null = 合法 */
export function validateBaseUrl(value: string, listenPort?: number): string | null {
  let u: URL;
  try {
    u = new URL(value);
  } catch {
    return `不是合法 URL：${value}（示例：https://relay.example.com/v1）`;
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    return `协议必须是 http/https，实际是 ${u.protocol}`;
  }
  if (listenPort !== undefined) {
    const msg = selfLoopMessage(value, listenPort);
    if (msg) return msg;
  }
  return null;
}

/** 归一化 stripPrefix：必须是空串或以 `/` 开头（否则路径拼接会产出意外结果） */
export function normalizeStripPrefix(raw: unknown): string {
  const v = String(raw ?? '').trim();
  if (v === '' || v === '/') return '';
  if (!v.startsWith('/')) throw new Error(`stripPrefix 必须以 / 开头（或留空），实际是 ${JSON.stringify(raw)}`);
  if (v.includes('?') || v.includes('#')) throw new Error(`stripPrefix 不能包含 ? 或 #，实际是 ${JSON.stringify(raw)}`);
  // `/v1/` → `/v1`（末尾斜杠会让 startsWith 匹配失败）
  return v.replace(/\/+$/, '');
}

export function normalizePathMode(raw: unknown): UpstreamConfig['pathMode'] {
  if (raw === 'auto' || raw === 'append' || raw === 'absolute') return raw;
  throw new Error(`pathMode 必须是 'auto' | 'append' | 'absolute'，实际是 ${JSON.stringify(raw)}`);
}

/**
 * 归一化用户填的密钥。
 *
 * 用户经常把界面上复制来的 `Bearer sk-xxx` 整段贴进来，而 `Bearer` 是由网关自己加上的，
 * 因此这里**主动剥掉**前缀，避免拼成 `Bearer Bearer sk-xxx`（真实踩过的坑）。
 */
export function normalizeSecret(raw: unknown, field: string): string {
  const v = String(raw ?? '').trim();
  if (v === '') throw new Error(`${field} 不能是空字符串（要取消请传 null / false）`);
  return v.replace(/^Bearer\s+/i, '').trim();
}

export function normalizeProbeModel(raw: unknown): string {
  const v = String(raw ?? '').trim();
  if (v === '') throw new Error('probeModel 不能是空字符串（要清空请传 null）');
  if (/\s/.test(v)) throw new Error(`probeModel 不能包含空白字符，实际是 ${JSON.stringify(raw)}`);
  return v;
}

export function normalizeProbeAuth(raw: unknown): string {
  const v = String(raw ?? '').trim();
  if (v === '') throw new Error('probeAuth 不能是空字符串（要清空请传 null）');
  // probeAuth 是**完整**鉴权头值（如 "Bearer sk-…"），这里不剥前缀 —— 与 replaceAuth 语义不同
  return v;
}

// ─────────────────────────────── 读取与落库 ───────────────────────────────

/**
 * 从 settings 表读出上游覆盖值。
 *
 * 非法值**不抛出**、也不静默吞掉：记一条 warn 并忽略该项，
 * 否则一个手改坏的 DB 值会让网关起不来（而它本来只是个可选项）。
 *
 * `listenPort` 传入后会额外做自环检查（防止热改把网关打成无限自转发）。
 */
export function readUpstreamOverrides(
  db: Db,
  listenPort?: number,
): { values: UpstreamOverrides; rejected: ApplyResult['rejected'] } {
  const values: UpstreamOverrides = {};
  const rejected: ApplyResult['rejected'] = [];

  const baseUrl = readOverride(db, 'baseUrl');
  if (baseUrl.present) {
    const v = typeof baseUrl.value === 'string' ? baseUrl.value.trim() : '';
    // 显式空值 = 未配置地址（不报警告：这与"从来没填过"是同一个状态）
    if (v !== '') {
      const bad = validateBaseUrl(v, listenPort);
      if (bad) rejected.push({ key: 'baseUrl', reason: bad });
      else values.baseUrl = v;
    }
  }

  const strip = readOverride(db, 'stripPrefix');
  if (strip.present) {
    // ★ 空串是**合法值**（= 不剥任何前缀），必须原样保留 —— 这正是引入包装格式的原因
    try { values.stripPrefix = normalizeStripPrefix(strip.value); }
    catch (e) { rejected.push({ key: 'stripPrefix', reason: (e as Error).message }); }
  }

  const mode = readOverride(db, 'pathMode');
  if (mode.present) {
    if (mode.value === 'auto' || mode.value === 'append' || mode.value === 'absolute') values.pathMode = mode.value;
    else rejected.push({ key: 'pathMode', reason: `未知取值 ${JSON.stringify(mode.value)}` });
  }

  const model = readOverride(db, 'probeModel');
  if (model.present && typeof model.value === 'string' && model.value.trim() !== '') {
    values.probeModel = model.value.trim();
  }

  const replace = readOverride(db, 'replaceAuth');
  if (replace.present && typeof replace.value === 'string' && replace.value.trim() !== '') {
    values.replaceAuth = replace.value.trim();
  }

  const probeAuth = readOverride(db, 'probeAuth');
  if (probeAuth.present && typeof probeAuth.value === 'string' && probeAuth.value.trim() !== '') {
    values.probeAuth = probeAuth.value.trim();
  }

  return { values, rejected };
}

/**
 * 把运行期覆盖**写入** `cfg.upstream`（原地改）。
 *
 * 为什么原地改而不用"重新构造 cfg"：`forwardUpstream` 每次请求都从 `cfg.upstream` 读
 * pathMode / stripPrefix / replaceAuth，因此原地改 = 下一次请求立刻生效（热改）。
 * 连接池等**启动期**参数（caFile / strictSsl / keepAlive / maxSockets）刻意不在此列 ——
 * 它们需要重建 agent，属于"必须重启"的那一类。
 */
export function applyUpstreamOverrides(cfg: SgwConfig, db: Db, log: Logger): ApplyResult {
  const { values, rejected } = readUpstreamOverrides(db, cfg.listen.port);
  const applied: UpstreamKey[] = [];

  if (values.baseUrl !== undefined) { cfg.upstream.baseUrl = values.baseUrl; applied.push('baseUrl'); }
  if (values.stripPrefix !== undefined) { cfg.upstream.stripPrefix = values.stripPrefix; applied.push('stripPrefix'); }
  if (values.pathMode !== undefined) { cfg.upstream.pathMode = values.pathMode; applied.push('pathMode'); }
  if (values.probeModel !== undefined) { cfg.upstream.probeModel = values.probeModel; applied.push('probeModel'); }
  if (values.replaceAuth !== undefined) { cfg.upstream.replaceAuth = values.replaceAuth; applied.push('replaceAuth'); }
  if (values.probeAuth !== undefined) { cfg.upstream.probeAuth = values.probeAuth; applied.push('probeAuth'); }

  for (const r of rejected) {
    log.warn({ key: r.key, reason: r.reason }, 'settings 表里的上游设置非法，已忽略该项（其余项照常生效）');
  }
  if (applied.length > 0) {
    // ★ 绝不把密钥值写进日志，只记键名
    log.info({ applied }, '已应用 settings 表中的上游运行期设置（优先级高于 sgw.config.ts）');
  }
  return { applied, rejected };
}

/**
 * 写入 / 清除单个覆盖项。
 *
 * ★ `null` = **清除**（删键 → 回落到 sgw.config.ts）；空字符串 = **值本身**
 *   （`stripPrefix = ''` 是有语义的：不剥任何前缀）。二者绝不能混为一谈。
 */
export function persistUpstreamOverride(db: Db, key: UpstreamKey, value: string | null): void {
  if (value === null) deleteSetting(db, dbKey(key));
  // 包一层 { v } ：这样"键存在但值为空串"与"键不存在"可以区分（见 readOverride 的说明）
  else setSetting(db, dbKey(key), { v: value });
}

/** 当前被运行期覆盖的键（供设置页显示"这个值来自哪里"） */
export function listUpstreamOverrides(db: Db, listenPort?: number): UpstreamKey[] {
  return Object.keys(readUpstreamOverrides(db, listenPort).values) as UpstreamKey[];
}

// ─────────────────────────────── 探针鉴权解析 ───────────────────────────────

/**
 * 为上游探针找一个可用的鉴权头值。
 *
 * 优先级：**运行期 replaceAuth（DB）> 配置文件 replaceAuth > probeAuth（DB > 配置）**。
 * **绝不**凭空造凭据 —— 找不到就返回 null，由调用方提示"未配置探针鉴权"。
 */
export function resolveProbeAuthHeader(cfg: SgwConfig, db: Db): { value: string | null; source: string | null } {
  if (cfg.upstream.replaceAuth !== false) {
    return { value: `Bearer ${cfg.upstream.replaceAuth}`, source: 'replaceAuth' };
  }
  const stored = readOverride(db, 'probeAuth');
  if (stored.present && typeof stored.value === 'string' && stored.value.trim()) {
    return { value: stored.value.trim(), source: 'probeAuth(运行时)' };
  }
  if (cfg.upstream.probeAuth) return { value: cfg.upstream.probeAuth, source: 'probeAuth(配置文件)' };
  return { value: null, source: null };
}
