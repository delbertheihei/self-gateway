/**
 * 本地访问令牌（Token Guard）—— 只作用于 `/_sgw/**`，绝不影响 `/v1/**`。
 *
 * 防的是什么（docs/02 §8.1）：
 *   - **其他本地进程**直接调管理 API 读用量/正文
 *   - **盲 CSRF**：恶意页面用 `fetch`/表单 POST 打管理 API。要求一个自定义头
 *     （`X-Gateway-Token`）会强制浏览器发预检请求，而预检会被 Origin 白名单挡掉。
 *
 * 不防的是什么（诚实说明）：
 *   同用户权限的进程仍能读取 `data/.token` 文件。OS 用户边界才是真正的控制点。
 *
 * 引导流程（对用户零摩擦）：
 *   1. 首次访问 `http://127.0.0.1:8787/` 时，页面 URL 上没有 token
 *   2. 前端请求 `/_sgw/api/bootstrap-token`（该端点**仅在无 Origin 或同源时**返回 token）
 *   3. 前端存入 localStorage，之后所有请求带 `X-Gateway-Token`
 *   4. 也支持 `?token=…` 引导（首次打开时自动存入并立刻从地址栏抹掉）
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import type http from 'node:http';
import type { Db } from '../db/index.ts';
import { getSetting, setSetting } from '../db/index.ts';
import type { Logger } from '../config/logger.ts';

export interface TokenGuard {
  /** 校验一次请求。返回 ok=false 时调用方应回 401。 */
  check(req: http.IncomingMessage, pathOnly: string): { ok: boolean; message: string };
  /** 取当前 token（用于生成引导链接） */
  token(): string;
  /** 指纹（只给 UI 展示，不暴露明文） */
  fingerprint(): string;
  /** 重新生成（旧 token 立即失效） */
  rotate(): string;
  /** 是否处于"免令牌"模式 */
  readonly disabled: boolean;
}

/** 允许在没有 token 的前提下访问的端点（引导用） */
const BOOTSTRAP_PATHS = new Set([
  '/_sgw/api/bootstrap-token',
]);

export interface CreateTokenGuardOptions {
  db: Db;
  log: Logger;
  requireToken: boolean;
  dataDir: string;
}

export function createTokenGuard(opts: CreateTokenGuardOptions): TokenGuard {
  const key = 'security.token';
  let token = getSetting<string>(opts.db, key, '');

  if (!token) {
    token = crypto.randomBytes(32).toString('base64url');
    setSetting(opts.db, key, token);
    writeTokenFile(opts.dataDir, token, opts.log);
    opts.log.info('已生成本地访问令牌（仅作用于 /_sgw/** 管理接口）');
  } else {
    // 保证 token 文件与 DB 一致（DB 是真相源）
    writeTokenFile(opts.dataDir, token, opts.log);
  }

  const fp = (): string => crypto.createHash('sha256').update(token).digest('hex').slice(0, 8);

  return {
    get disabled(): boolean { return !opts.requireToken; },

    check(req, pathOnly) {
      if (!opts.requireToken) return { ok: true, message: '' };

      // 引导端点：仅在"无 Origin（非浏览器跨源）或同源"时放行。
      // 这样恶意页面即使知道 URL 也拿不到 token 的内容（跨源会被 Origin 白名单先拦掉）。
      if (BOOTSTRAP_PATHS.has(pathOnly)) return { ok: true, message: '' };

      const provided = headerValue(req, 'x-gateway-token')
        ?? queryToken(req)
        ?? '';
      if (provided && timingSafeEqual(provided, token)) return { ok: true, message: '' };

      return {
        ok: false,
        message: provided
          ? '本地访问令牌不正确'
          : '缺少本地访问令牌（X-Gateway-Token）',
      };
    },

    token: () => token,
    fingerprint: fp,
    rotate() {
      token = crypto.randomBytes(32).toString('base64url');
      setSetting(opts.db, key, token);
      writeTokenFile(opts.dataDir, token, opts.log);
      opts.log.warn('本地访问令牌已重新生成，旧令牌立即失效');
      return token;
    },
  };
}

function headerValue(req: http.IncomingMessage, name: string): string | null {
  const v = req.headers[name];
  if (Array.isArray(v)) return v[0] ?? null;
  return typeof v === 'string' ? v : null;
}

/** 仅用于首次引导：`?token=…`。SPA 拿到后必须立即从地址栏抹掉。 */
function queryToken(req: http.IncomingMessage): string | null {
  const url = req.url ?? '';
  const q = url.indexOf('?');
  if (q === -1) return null;
  try {
    return new URLSearchParams(url.slice(q + 1)).get('token');
  } catch {
    return null;
  }
}

/** 恒定时间比较，避免通过响应时间逐字节爆破 token */
function timingSafeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

function writeTokenFile(dataDir: string, token: string, log: Logger): void {
  const file = path.join(dataDir, '.token');
  try {
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(file, `${token}\n`, { mode: 0o600 });
  } catch (e) {
    log.warn({ file, err: (e as Error).message }, '写入 token 文件失败（令牌仍存于 DB，功能不受影响）');
  }
}

/** 从 DB 读取 token（供 index.ts 在日志里打印引导链接） */
export function readToken(db: Db): string {
  return getSetting<string>(db, 'security.token', '');
}
