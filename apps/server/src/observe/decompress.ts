/**
 * 旁路解压 —— 只解压"副本"用于观测，**绝不改转发字节**。
 *
 * ★ H3 的关键：上游若返回 `Content-Encoding: gzip`，我们转发给客户端的仍然是
 * **原始压缩字节**；只在旁路把副本 gunzip 以便解析 SSE/JSON。
 *
 * 为什么这在本架构里很自然：我们用的是 `node:http` 客户端，它**不做自动解压**
 * （这是选它的原因之一，见 docs/03 §2.1）。所以"原始字节"天然可得，
 * 不需要像 fetch 方案那样被迫改写 `Accept-Encoding: identity`（那是 H2 违规，ADR-16）。
 */

import zlib from 'node:zlib';
import { Transform, type TransformCallback } from 'node:stream';

export type ContentEncoding = 'identity' | 'gzip' | 'deflate' | 'br' | 'zstd' | 'unknown';

export function parseContentEncoding(raw: string | null | undefined): ContentEncoding {
  if (!raw) return 'identity';
  const first = raw.split(',')[0]!.trim().toLowerCase();
  switch (first) {
    case '': case 'identity': return 'identity';
    case 'gzip': case 'x-gzip': return 'gzip';
    case 'deflate': return 'deflate';
    case 'br': return 'br';
    case 'zstd': return 'zstd';
    default: return 'unknown';
  }
}

/**
 * 同步解压。失败返回原因，调用方降级（观测器降级为"只统计字节数"，
 * 正文落盘降级为"原样保存原始字节"）。
 *
 * ★ 为什么是同步：见 `observer.ts` 顶部的说明 —— 流式解压是**异步**的，
 *   而 `finish()` 是同步读取结果，流式方案会在"最后一个 tick 还没到"时切断数据。
 *   这里对**已经完整缓冲**的字节做一次性同步解压，没有竞态。
 */
export function decompressSync(
  buf: Buffer,
  encoding: ContentEncoding,
): { ok: true; data: Buffer } | { ok: false; error: string } {
  try {
    switch (encoding) {
      case 'gzip': return { ok: true, data: zlib.gunzipSync(buf) };
      case 'deflate': return { ok: true, data: zlib.inflateSync(buf) };
      case 'br': return { ok: true, data: zlib.brotliDecompressSync(buf) };
      case 'zstd': {
        const maybe = zlib as unknown as { zstdDecompressSync?: (b: Buffer) => Buffer };
        if (typeof maybe.zstdDecompressSync === 'function') {
          return { ok: true, data: maybe.zstdDecompressSync(buf) };
        }
        return { ok: false, error: '当前 Node 版本不支持 zstd 同步解压' };
      }
      case 'identity':
      case 'unknown':
      default:
        return { ok: true, data: buf };
    }
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

/**
 * 把要**落盘的正文副本**解码成明文（H3 不受影响：转发字节照旧）。
 *
 * ★ 为什么需要它：请求与响应两侧的实体都可能带 `Content-Encoding`。
 *   落盘时若原样保存，控制面 `JSON.parse` 会失败并回落到 `buf.toString('utf8')`，
 *   界面上就是**乱码** —— Codex 用 zstd 压缩 `/responses` 请求体后，请求正文一直如此。
 *
 * 失败（截断的压缩流、Node 不支持 zstd、非法 gzip）时**降级为原始字节**：
 * 宁可存下一份看不懂的字节，也不能丢数据；note 会说明原因并透出到详情抽屉。
 */
export function decodeForStorage(
  buf: Buffer,
  encoding: ContentEncoding,
): { data: Buffer; note: string | null } {
  const dec = decompressSync(buf, encoding);
  if (dec.ok) return { data: dec.data, note: null };
  return {
    data: buf,
    note: `正文副本解码失败（Content-Encoding: ${encoding}）：${dec.error}`
      + '。已按原始字节保存（界面可能显示为乱码），转发字节未受影响。',
  };
}

/** 创建解压器；不支持/未知编码时返回 null（调用方降级为"只统计字节数"） */
export function createDecompressor(encoding: ContentEncoding): Transform | null {
  switch (encoding) {
    case 'gzip':
      return zlib.createGunzip();
    case 'deflate':
      // 有的服务端发原始 deflate 而非 zlib 包装；createInflate 两者都能吃
      return zlib.createInflate();
    case 'br':
      return zlib.createBrotliDecompress();
    case 'zstd': {
      const maybe = zlib as unknown as { createZstdDecompress?: () => Transform };
      return typeof maybe.createZstdDecompress === 'function' ? maybe.createZstdDecompress() : null;
    }
    case 'identity':
    case 'unknown':
    default:
      return null;
  }
}

/**
 * 「吞掉错误」的解压流：解压失败**不能**把错误冒泡到主链路。
 * 观测失败 = 少记一条账，绝不能影响正在流式输出的响应。
 *
 * 实现：单个 Transform 子类，内部持有解压器。
 *   - 写入侧：`inner.write(chunk, cb)` 的 cb 在解压器接受该块后才触发 → 天然背压
 *   - 读出侧：解压输出通过 `push()` 交给下游
 *   - 出错时：标记 failed、回调 onError、然后 `push(null)` 干净收尾
 */
class ForgivingDecompressor extends Transform {
  private readonly inner: Transform | null;
  private readonly onError: ((err: Error) => void) | undefined;
  private failed = false;
  private ended = false;

  constructor(encoding: ContentEncoding, onError?: (err: Error) => void) {
    super();
    this.onError = onError;
    this.inner = createDecompressor(encoding);
    if (!this.inner) return;

    this.inner.on('data', (out: Buffer) => { if (!this.destroyed) this.push(out); });
    this.inner.on('end', () => {
      this.ended = true;
      if (!this.destroyed) this.push(null);
    });
    this.inner.on('error', (err: Error) => {
      this.failed = true;
      this.onError?.(err);
      if (!this.destroyed) this.push(null);   // 干净收尾，不抛
    });
  }

  override _transform(chunk: Buffer, _enc: BufferEncoding, cb: TransformCallback): void {
    if (this.failed || this.ended || !this.inner) { cb(); return; }
    this.inner.write(chunk, (err) => {
      if (err) { this.failed = true; this.onError?.(err as Error); }
      cb();
    });
  }

  override _flush(cb: TransformCallback): void {
    if (this.failed || this.ended || !this.inner) { cb(); return; }
    this.inner.end(() => { cb(); });
  }

  override _destroy(err: Error | null, cb: (err?: Error | null) => void): void {
    try { this.inner?.destroy(); } catch { /* 忽略 */ }
    cb(err);
  }
}

export function createForgivingDecompressor(
  encoding: ContentEncoding,
  onError?: (err: Error) => void,
): Transform {
  return new ForgivingDecompressor(encoding, onError);
}
