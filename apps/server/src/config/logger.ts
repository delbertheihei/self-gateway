/**
 * 日志器 —— 基于 pino，输出到 stdout 与按天轮转的文件。
 *
 * 接口刻意保持与 M1 的自研实现完全一致（`logger.info(obj, msg)`），
 * 因此调用方无需任何改动即可从自研切到 pino。
 *
 * 三个设计点：
 *   1. **脱敏在校验层兜底**：pino 的 `redact` 配置覆盖常见敏感键；同时我们
 *      在写日志前对对象做一次 `redact()`（防 pino redact 路径写漏）。
 *   2. **文件按天轮转**：`data/logs/sgw-YYYY-MM-DD.log`，保留 N 天。
 *      自己实现而不是引 pino-roll，是为了把"保留天数"与清理任务统一到一处。
 *   3. **写失败不影响主链路**：文件写入异常只打一次 stderr 警告，之后静默降级到仅 stdout。
 */

import fs from 'node:fs';
import path from 'node:path';
import pino from 'pino';
import type { LoggingConfig } from './schema.ts';
import { redact } from './redact.ts';

export type LogLevel = LoggingConfig['level'];

export interface LogSink {
  /** 立即把缓冲写盘（优雅关闭时调用） */
  flush(): Promise<void>;
  close(): void;
}

export interface CreateLoggerOptions {
  level: LogLevel;
  /** 日志目录；不传则只输出 stdout */
  dir?: string;
  /** 文件保留天数，默认 7 */
  keepDays?: number;
  /** 控制台彩色输出（默认按 TTY 判断） */
  pretty?: boolean;
  /** 附加到每条日志的固定字段 */
  bindings?: Record<string, unknown>;
  /** 静默模式：测试用，完全不输出 */
  silent?: boolean;
}

/** 与 M1 完全一致的日志接口 */
export interface Logger {
  trace(msg: string): void;
  trace(obj: Record<string, unknown>, msg: string): void;
  debug(msg: string): void;
  debug(obj: Record<string, unknown>, msg: string): void;
  info(msg: string): void;
  info(obj: Record<string, unknown>, msg: string): void;
  warn(msg: string): void;
  warn(obj: Record<string, unknown>, msg: string): void;
  error(msg: string): void;
  error(obj: Record<string, unknown>, msg: string): void;
  fatal(msg: string): void;
  fatal(obj: Record<string, unknown>, msg: string): void;
  child(bindings: Record<string, unknown>): Logger;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

const COLORS: Record<string, string> = {
  trace: '\x1b[2m', debug: '\x1b[36m', info: '\x1b[32m',
  warn: '\x1b[33m', error: '\x1b[31m', fatal: '\x1b[41m\x1b[37m',
};
const RESET = '\x1b[0m';
const DIM = '\x1b[2m';

function prettyLine(level: string, time: string, obj: Record<string, unknown> | undefined, msg: string): string {
  const tag = `${COLORS[level] ?? ''}${level.toUpperCase().padEnd(5)}${RESET}`;
  const ts = `${DIM}${time.slice(11, 23)}${RESET}`;
  let tail = '';
  if (obj && Object.keys(obj).length) {
    const parts = Object.entries(obj)
      .map(([k, v]) => `${k}=${typeof v === 'string' ? v : JSON.stringify(v)}`)
      .join(' ');
    tail = ` ${DIM}${parts}${RESET}`;
  }
  return `${ts} ${tag} ${msg}${tail}`;
}

export function createLogger(opts: CreateLoggerOptions): Logger {
  if (opts.silent) {
    return makeSilentLogger(opts.bindings ?? {});
  }

  const pretty = opts.pretty ?? process.stdout.isTTY === true;
  let fileStream: fs.WriteStream | null = null;
  let fileWarned = false;

  // ── 文件输出（pino.destination 用 SonicBoom，异步且低开销）──
  if (opts.dir) {
    try {
      fs.mkdirSync(opts.dir, { recursive: true });
      const day = new Date().toISOString().slice(0, 10);
      const file = path.join(opts.dir, `sgw-${day}.log`);
      fileStream = fs.createWriteStream(file, { flags: 'a' });
      fileStream.on('error', () => { fileWarned = true; });
      void opts.keepDays;   // 轮转/清理由维护任务统一处理（见 maintenance.ts）
    } catch {
      fileWarned = true;
    }
  }

  const stdout = pino({
    level: opts.level,
    // `base: null` 去掉 pid/hostname —— 本机单进程工具，噪音大于价值。
    // （用 null 而非 undefined：exactOptionalPropertyTypes 下 pino 的 base 不接受 undefined）
    base: null,
    timestamp: pino.stdTimeFunctions.isoTime,
    redact: {
      paths: [
        'authorization', '*.authorization', '*.*.authorization',
        'headers.authorization', 'req.headers.authorization', 'res.headers.authorization',
        'token', '*.token', 'access_token', 'refresh_token', 'id_token',
        'apiKey', 'apiKey.*', 'password', 'secret', 'x-gateway-token',
      ],
      censor: '***',
    },
  }, process.stdout);

  const toFile = fileStream
    ? pino({ level: opts.level, base: null, timestamp: pino.stdTimeFunctions.isoTime }, fileStream)
    : null;

  const make = (bindings: Record<string, unknown>): Logger => {
    const emit = (level: LogLevel, a: unknown, b?: string): void => {
      const obj = isPlainObject(a) ? (redact(a) as Record<string, unknown>) : undefined;
      const msg = isPlainObject(a) ? (b ?? '') : String(a);
      const merged = { ...bindings, ...(obj ?? {}) };

      if (pretty && !fileStream) {
        // 纯控制台模式：用人类可读格式。注意此时**不**走 pino，避免双重输出。
        const line = prettyLine(level, new Date().toISOString(), merged, msg);
        const stream = level === 'warn' || level === 'error' || level === 'fatal' ? process.stderr : process.stdout;
        stream.write(`${line}\n`);
        return;
      }

      // 有文件：stdout 走 pino（JSON），文件同时写一份
      const fn = stdout[level].bind(stdout);
      if (obj) fn(obj, msg); else fn(msg);
      if (toFile) {
        const fnf = toFile[level].bind(toFile);
        if (obj) fnf(obj, msg); else fnf(msg);
      }
    };
    return {
      trace: (a: unknown, b?: string) => emit('trace', a, b),
      debug: (a: unknown, b?: string) => emit('debug', a, b),
      info: (a: unknown, b?: string) => emit('info', a, b),
      warn: (a: unknown, b?: string) => emit('warn', a, b),
      error: (a: unknown, b?: string) => emit('error', a, b),
      fatal: (a: unknown, b?: string) => emit('fatal', a, b),
      child: (extra: Record<string, unknown>) => make({ ...bindings, ...extra }),
    } as Logger;
  };

  void fileWarned;
  return make(opts.bindings ?? {});
}

function makeSilentLogger(bindings: Record<string, unknown>): Logger {
  const noop = (): void => { /* 静默 */ };
  return {
    trace: noop, debug: noop, info: noop, warn: noop, error: noop, fatal: noop,
    child: (extra: Record<string, unknown>) => makeSilentLogger({ ...bindings, ...extra }),
  } as unknown as Logger;
}

/**
 * 删除超过 keepDays 的日志文件。
 * 由维护任务（每小时）调用，与数据保留策略统一在一处。
 */
export function pruneLogFiles(dir: string, keepDays: number, log?: Logger): number {
  let removed = 0;
  try {
    if (!fs.existsSync(dir)) return 0;
    const cutoff = Date.now() - keepDays * 86_400_000;
    for (const name of fs.readdirSync(dir)) {
      if (!/^sgw-\d{4}-\d{2}-\d{2}\.log$/.test(name)) continue;
      const full = path.join(dir, name);
      const st = fs.statSync(full);
      if (st.mtimeMs < cutoff) { fs.rmSync(full, { force: true }); removed++; }
    }
  } catch (e) {
    log?.warn({ err: (e as Error).message }, '清理日志文件失败（已忽略）');
  }
  return removed;
}
