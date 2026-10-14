/**
 * 敏感信息脱敏。
 *
 * 铁的纪律：**Authorization 明文永不进日志、永不进 DB、永不进产物**。
 * 这是 H8/H9 在"日志"这个面上的具体落地。
 */

import crypto from 'node:crypto';

/** 需要脱敏的字段名（小写比较） */
const REDACT_KEYS = new Set([
  'authorization', 'proxy-authorization', 'x-api-key', 'api-key', 'apikey',
  'cookie', 'set-cookie', 'token', 'access_token', 'refresh_token', 'id_token',
  'experimental_bearer_token', 'password', 'secret', 'x-gateway-token',
]);

/** sha256 前 8 位。用于在不存明文的前提下区分不同密钥。 */
export function fingerprint(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex').slice(0, 8);
}

/** 只保留前后几位，中间打码；同时给出指纹便于关联 */
export function redactValue(value: string): string {
  if (value.length <= 12) return '***';
  return `${value.slice(0, 6)}…${value.slice(-4)} <len=${value.length} fp=${fingerprint(value)}>`;
}

/**
 * 深度脱敏。对数组与对象递归处理；对已知敏感键直接打码；
 * 也会处理 `Bearer sk-xxx` 这种"值里藏凭据"的情况。
 */
export function redact(input: unknown, depth = 0): unknown {
  if (depth > 6) return '[深度截断]';
  if (typeof input === 'string') {
    if (/^Bearer\s+\S+/i.test(input)) return 'Bearer ***';
    if (/^sk-[A-Za-z0-9_-]{8,}$/.test(input)) return redactValue(input);
    return input;
  }
  if (Array.isArray(input)) return input.map((v) => redact(v, depth + 1));
  if (input && typeof input === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(input as Record<string, unknown>)) {
      out[k] = REDACT_KEYS.has(k.toLowerCase())
        ? (typeof v === 'string' ? redactValue(v) : '***')
        : redact(v, depth + 1);
    }
    return out;
  }
  return input;
}
