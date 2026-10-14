/**
 * 极简 ULID 实现（零依赖）。
 *
 * 为什么自己写而不是用 npm 的 `ulid`：本项目的硬约束是"运行时依赖越少越好"
 * （docs/03 §1：仅 3 个依赖）。ULID 的算法只有几十行，而它带来的收益很实在：
 *   - 26 字符、字典序 == 时间序 → **keyset（cursor）分页可以直接按 id 比较**，
 *     不需要 `ORDER BY started_at OFFSET n`（大表 offset 会退化成全扫）
 *   - 天然按时间单调，便于按日清理与调试
 *
 * Crockford Base32：`0123456789ABCDEFGHJKMNPQRSTVWXYZ`（去掉 I L O U，避免与 1 0 混淆）
 *
 * ⚠️ Node 22 原生 TS 只支持可擦除语法，故不使用 enum / namespace。
 */

const ENCODING = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const ENCODING_LEN = 32;
const TIME_LEN = 10;      // 48 bit 时间戳 → 10 字符
const RANDOM_LEN = 16;    // 80 bit 随机 → 16 字符
export const ULID_LENGTH = TIME_LEN + RANDOM_LEN;   // 26

/** 处理单调递增：同一毫秒内生成的 ULID 必须严格大于前一个 */
let lastTime = -1;
let lastRandom: number[] = [];

/** 用 CSPRNG 填充 80 bit 随机部分 */
function randomChars(): number[] {
  const bytes = new Uint8Array(RANDOM_LEN);
  globalThis.crypto.getRandomValues(bytes);
  const out: number[] = new Array(RANDOM_LEN);
  for (let i = 0; i < RANDOM_LEN; i++) out[i] = bytes[i]! % ENCODING_LEN;
  return out;
}

/** 同毫秒内 +1（按 Crockford 字母表进位） */
function incrementRandom(chars: number[]): number[] {
  const next = [...chars];
  for (let i = next.length - 1; i >= 0; i--) {
    if (next[i]! < ENCODING_LEN - 1) {
      next[i] = next[i]! + 1;
      return next;
    }
    next[i] = 0;   // 进位溢出则继续向前；极端情况下回绕（80bit 空间下可忽略）
  }
  return next;
}

function encodeTime(ms: number): string {
  let t = ms;
  const out: string[] = new Array(TIME_LEN);
  for (let i = TIME_LEN - 1; i >= 0; i--) {
    out[i] = ENCODING[t % ENCODING_LEN]!;
    t = Math.floor(t / ENCODING_LEN);
  }
  return out.join('');
}

/** 生成一个 ULID（对同一毫秒内的多次调用保证单调递增） */
export function ulid(now: number = Date.now()): string {
  let random: number[];
  if (now === lastTime) {
    random = incrementRandom(lastRandom);
  } else {
    random = randomChars();
  }
  lastTime = now;
  lastRandom = random;
  let out = encodeTime(now);
  for (let i = 0; i < RANDOM_LEN; i++) out += ENCODING[random[i]!]!;
  return out;
}

const ULID_RE = /^[0-9A-HJKMNP-TV-Z]{26}$/;

/** 校验是否为合法 ULID（用于路由参数校验，避免把任意字符串当 id 查库） */
export function isUlid(value: string): boolean {
  return ULID_RE.test(value);
}

/** 从 ULID 还原时间戳（诊断与按时间过滤用） */
export function ulidTime(id: string): number {
  if (!isUlid(id)) return Number.NaN;
  let t = 0;
  for (let i = 0; i < TIME_LEN; i++) {
    const idx = ENCODING.indexOf(id[i]!);
    if (idx === -1) return Number.NaN;
    t = t * ENCODING_LEN + idx;
  }
  return t;
}
