/**
 * 延迟分桶直方图 —— 分位计算的存储格式与算法。
 *
 * 为什么不用 SQL 分位函数（[`docs/03`](../../../docs/03-tech-stack-selection.md) §3.2 有实测）：
 *   - 100 万行下 `row_number()` 窗口精确分位需 **824ms**，且在时间桶上无法复用
 *   - `node:sqlite` **不提供** `percentile()` / `median()`（SQLite percentile 扩展是编译期选项）
 *
 * 改用固定分桶直方图：每行 24 桶 × 4 字节 = **96 字节 BLOB**。
 * 任意时间范围只需把桶相加（O(24) 而非 O(行数)），分位在线性插值得到。
 *
 * 代价：分位是**近似值**，UI 必须标注（见 docs/04 §6）。
 * 权衡理由：仪表盘的用途是"发现异常"，不是"出具权威 SLA 报告"。
 */

/** 分桶上界（毫秒）。覆盖 1ms ~ 130s，超出最后一桶的并入末桶。 */
export const LAT_BUCKETS_MS: readonly number[] = [
  1, 2, 5, 10, 20, 50, 100, 150, 200, 300, 400, 500,
  750, 1000, 1500, 2000, 3000, 5000, 8000, 12000, 20000, 40000, 80000, 130000,
];

export const LAT_BUCKET_COUNT = LAT_BUCKETS_MS.length;
export const LAT_HIST_BYTES = LAT_BUCKET_COUNT * 4;   // Uint32 × 24 = 96

/** 创建一个空直方图 */
export function emptyHist(): Uint32Array {
  return new Uint32Array(LAT_BUCKET_COUNT);
}

/** 找到毫秒值应落入的桶下标（二分查找；超出则落末桶） */
export function bucketIndex(ms: number): number {
  if (!Number.isFinite(ms) || ms <= 0) return 0;
  let lo = 0;
  let hi = LAT_BUCKET_COUNT - 1;
  if (ms > LAT_BUCKETS_MS[hi]!) return hi;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (ms <= LAT_BUCKETS_MS[mid]!) hi = mid;
    else lo = mid + 1;
  }
  return lo;
}

/** 记一次观测 */
export function histAdd(hist: Uint32Array, ms: number): void {
  const i = bucketIndex(ms);
  hist[i] = hist[i]! + 1;
}

/** 直方图相加（合并时间范围的核心操作） */
export function histMerge(dst: Uint32Array, src: Uint32Array): Uint32Array {
  const n = Math.min(dst.length, src.length);
  for (let i = 0; i < n; i++) dst[i] = dst[i]! + src[i]!;
  return dst;
}

/** 序列化为 BLOB（little-endian uint32） */
export function histToBlob(hist: Uint32Array): Uint8Array {
  const buf = new Uint8Array(LAT_HIST_BYTES);
  const view = new DataView(buf.buffer);
  for (let i = 0; i < LAT_BUCKET_COUNT; i++) view.setUint32(i * 4, hist[i] ?? 0, true);
  return buf;
}

/** 从 BLOB 反序列化（容忍长度不足/损坏：按已读到的部分填充） */
export function histFromBlob(blob: unknown): Uint32Array {
  const out = emptyHist();
  if (!blob) return out;
  const bytes = blob instanceof Uint8Array
    ? blob
    : (typeof blob === 'string' ? base64ToBytes(blob) : null);
  if (!bytes || bytes.length < 4) return out;
  const usable = Math.min(LAT_BUCKET_COUNT, Math.floor(bytes.length / 4));
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let i = 0; i < usable; i++) out[i] = view.getUint32(i * 4, true);
  return out;
}

function base64ToBytes(s: string): Uint8Array | null {
  try { return new Uint8Array(Buffer.from(s, 'base64')); } catch { return null; }
}

/** 总观测数 */
export function histTotal(hist: Uint32Array): number {
  let n = 0;
  for (let i = 0; i < hist.length; i++) n += hist[i]!;
  return n;
}

/**
 * 分位（线性插值，返回毫秒）。
 *
 * 语义：桶 `i` 代表区间 `(LAT_BUCKETS_MS[i-1], LAT_BUCKETS_MS[i]]`。
 * 在桶内按均匀分布插值 —— 这是直方图分位的标准近似做法。
 * 空直方图返回 NaN，调用方需处理（UI 显示 `—`）。
 */
export function histPercentile(hist: Uint32Array, p: number): number {
  const total = histTotal(hist);
  if (total === 0) return Number.NaN;
  const clampedP = Math.min(1, Math.max(0, p));
  const target = clampedP * total;

  let cum = 0;
  for (let i = 0; i < hist.length; i++) {
    const count = hist[i]!;
    if (count === 0) continue;
    const before = cum;
    cum += count;
    if (cum >= target) {
      const lower = i === 0 ? 0 : LAT_BUCKETS_MS[i - 1]!;
      const upper = LAT_BUCKETS_MS[i]!;
      const within = count === 0 ? 0 : (target - before) / count;
      return lower + (upper - lower) * Math.min(1, Math.max(0, within));
    }
  }
  return LAT_BUCKETS_MS[LAT_BUCKET_COUNT - 1]!;
}

/** 一次性取多个分位，避免重复累加 */
export function histPercentiles(hist: Uint32Array, ps: readonly number[]): number[] {
  return ps.map((p) => histPercentile(hist, p));
}

/** 直方图 → 迷你柱状数据（UI 用） */
export function histToBuckets(hist: Uint32Array): Array<{ from: number; to: number; count: number }> {
  return LAT_BUCKETS_MS.map((to, i) => ({
    from: i === 0 ? 0 : LAT_BUCKETS_MS[i - 1]!,
    to,
    count: hist[i] ?? 0,
  }));
}
