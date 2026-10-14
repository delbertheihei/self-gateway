/**
 * 观测器门面 —— 把"上游响应字节副本"变成结构化的记账信息。
 *
 * 职责（单一）：读副本 → 缓冲 → 解压 → 解析 → 汇总。
 * **禁止**：触碰 DB、触碰 recorder、抛异常到主链路。
 * 这是模块边界里 `observe/**` 唯一允许读 body 的地方（docs/00 §4）。
 *
 * ★ 一个关键实现决策（曾经写错）：**解压放在 finish() 里同步做，而不是流式做**。
 *
 *   最初实现用 `zlib.createGunzip()` 流式解压，结果 gzip 场景下 usage 全是 0 ——
 *   因为解压是**异步**的（要等到下一个 tick 才 emit data），而 `finish()` 是同步读取结果，
 *   于是"流被切断"而解析器什么都没收到。
 *
 *   改成"先缓冲压缩字节，finish() 时一次性同步解压"后：
 *     - 没有异步竞态（finish 之后不可能再有数据到达，因为调用方在 stream 'end' 后才 finish）
 *     - 代码路径单一，identity / gzip / deflate / br 用同一套逻辑
 *     - 内存仍有硬上限（maxBytes），不会因为压缩炸弹而失控
 *   `docs/02 §5.3` 的表述已同步更新。
 */

import type { UsageRecord } from '@sgw/shared';
import { parseContentEncoding, decompressSync, type ContentEncoding } from './decompress.ts';
import { SseScanner, extractUsage, type SseScanResult } from './sse.ts';

export type ResponseShape = 'sse' | 'json' | 'binary' | 'empty';

export interface ObserverResult {
  shape: ResponseShape;
  contentEncoding: ContentEncoding;
  contentType: string | null;
  /** 解压后的明文字节数 */
  plainBytes: number;
  /** 上游原始字节数（压缩态） */
  rawBytes: number;
  /** 观测缓冲是否被截断 */
  truncated: boolean;
  /** SSE 扫描结果（shape==='sse' 时有意义） */
  scan: SseScanResult | null;
  /** 非流式 JSON 体的 usage */
  usage: UsageRecord | null;
  /** JSON 体里读到的模型名 */
  model: string | null;
  /** JSON 体里读到的 response.id / id */
  responseId: string | null;
  /** usage 缺字段清单（会让 Codex 整轮失败） */
  usageMissingFields: string[];
  /** 解压或解析过程中的错误信息（仅诊断） */
  note: string | null;
}

export interface Observer {
  /** 喂入**上游原始字节**（压缩态即可，内部缓冲后在 finish 同步解压） */
  onResponseChunk(chunk: Buffer, isFirst: boolean): void;
  /** 幂等收尾。★ 必须在主链路 stream 'end' 之后调用 */
  finish(): ObserverResult;
  readonly truncated: boolean;
}

export interface CreateObserverOptions {
  /**
   * 响应头读取器。
   *
   * ★ 为什么是函数而不是值（实测踩到）：观测器必须在**收到请求时**就建立
   * （否则失败请求——例如上游 429/500——的请求体根本不会被观测，模型名会落成 `unknown`），
   * 而 `content-type` / `content-encoding` 只有等**上游响应头到达**才知道。
   * 因此这里传入惰性读取器，在 `finish()` 时才求值。
   */
  contentType: () => string | null;
  contentEncodingRaw: () => string | null;
  /** 观测缓冲上限（对**压缩态**原始字节计数） */
  maxBytes: number;
  /** 每见到一段输出 delta 就回调（估算器用，不保留文本） */
  onDeltaText?: (text: string) => void;
}

function detectShape(contentType: string | null, firstChunk: Buffer | null): ResponseShape {
  const ct = (contentType ?? '').toLowerCase();
  if (ct.includes('text/event-stream')) return 'sse';
  if (ct.includes('json')) return 'json';
  if (ct.startsWith('text/')) return 'json';
  if (firstChunk) {
    const head = firstChunk.subarray(0, 256).toString('utf8').trimStart();
    if (head.startsWith('event:') || head.startsWith('data:') || head.startsWith(':')) return 'sse';
    if (head.startsWith('{') || head.startsWith('[')) return 'json';
  }
  if (ct === '') return 'empty';
  return 'binary';
}

/** 供说明文字用的 KB 显示 */
function kb(bytes: number): string {
  return `${Math.round(bytes / 1024)}KB`;
}

/**
 * 尾部切片的帧对齐：尾部是从流中间截下来的，可能落在某一帧的**内部**。
 * 从第一个完整帧边界（`\n\n`）之后开始解析，既避免把半截 JSON 喂给解析器，
 * 也保证切片起点是 UTF-8 安全的位置（`\n` 是 ASCII，多字节字符不可能跨界）。
 * 找不到边界（或边界太远）时原样返回 —— 解析器会忽略它以非 `data:` 开头的垃圾行。
 */
function frameAligned(buf: Buffer): Buffer {
  const idx = buf.indexOf('\n\n');
  if (idx === -1 || idx > 8192) return buf;
  return buf.subarray(idx + 2);   // 可能为空（边界正好在末尾）—— 调用方会跳过空切片
}

export function createObserver(opts: CreateObserverOptions): Observer {
  // 编码在 finish() 时才求值（响应头可能尚未到达）
  const encodingOf = (): ContentEncoding => parseContentEncoding(opts.contentEncodingRaw());
  const maxBytes = Math.max(0, opts.maxBytes);

  /**
   * 缓冲切成**头 + 尾**两段（总容量仍是 maxBytes，内存开销不变）。
   *
   * ★ 为什么必须留"尾"（实测到的真实缺陷）：
   *   Responses 的 `usage` **只存在于流末尾的终止事件**（`response.completed` /
   *   `response.incomplete`），其它事件的 `usage` 恒为 null。
   *   旧实现只保留响应**开头**的 maxBytes 字节，于是**任何超过上限的响应都必然丢掉 usage**
   *   —— 实测：9 条 >512KB 的响应全部落成"来源=估算"，而 102 条 ≤462KB 的响应全部拿到精确值，
   *   两个集合完全不重叠（日志里 `observeTruncated` 恰好出现 9 次）。
   *
   *   头留给"开头的少量信息"（`response.created` 里的 model / response.id、
   *   首 token 时间、输出增量的前半段），尾专捞**流末尾的终止事件**。
   *   两种情况都在 finish() 里按头/尾切分：
   *     ① 原始字节超限（`identity` / 未知编码可分段；压缩流无法只解一段 → 明确降级并说明）；
   *     ② 压缩流**解压后**超限（明文已在内存里，照样切头尾 —— 高压缩比的长响应同样能拿到 usage）。
   */
  const headCap = maxBytes <= 0 ? 0 : Math.max(1, Math.floor(maxBytes / 4));
  const tailCap = Math.max(0, maxBytes - headCap);

  const headChunks: Buffer[] = [];
  let headBytes = 0;
  /**
   * 尾部滚动缓冲：超限时丢**最旧**的分片（usage 在末尾，所以丢头留尾）。
   *
   * 用"起始下标 + 定期压缩"而不是 `Array.shift()`：`shift()` 是 O(n)，
   * 而分片可能很小（几百字节），长响应下会有上万个分片 —— 那会变成 O(n²)。
   */
  const tailChunks: Buffer[] = [];
  let tailStart = 0;
  let tailBytes = 0;
  let droppedBytes = 0;

  let rawBytes = 0;
  let firstChunk: Buffer | null = null;
  let shape: ResponseShape | null = null;

  function pushTail(chunk: Buffer): void {
    if (tailCap <= 0) { droppedBytes += chunk.length; return; }
    tailChunks.push(chunk);
    tailBytes += chunk.length;
    while (tailBytes > tailCap && tailStart < tailChunks.length) {
      const first = tailChunks[tailStart]!;
      const excess = tailBytes - tailCap;
      if (first.length <= excess) {
        tailStart++;
        tailBytes -= first.length;
        droppedBytes += first.length;
      } else {
        tailChunks[tailStart] = first.subarray(excess);
        tailBytes -= excess;
        droppedBytes += excess;
      }
    }
    // 已消费的分片攒够一批再压缩，摊还成本 O(1)
    if (tailStart > 512) {
      tailChunks.splice(0, tailStart);
      tailStart = 0;
    }
  }

  return {
    onResponseChunk(chunk: Buffer, isFirst: boolean): void {
      rawBytes += chunk.length;
      if (isFirst) {
        firstChunk = chunk;
        shape = detectShape(opts.contentType(), chunk);
      }
      if (headBytes < headCap) {
        const room = headCap - headBytes;
        if (chunk.length <= room) {
          headChunks.push(chunk);
          headBytes += chunk.length;
          return;
        }
        headChunks.push(chunk.subarray(0, room));
        headBytes += room;
        pushTail(chunk.subarray(room));
        return;
      }
      pushTail(chunk);
    },

    get truncated(): boolean { return droppedBytes > 0; },

    finish(): ObserverResult {
      const encoding = encodingOf();
      const head = Buffer.concat(headChunks);
      const tailRaw = tailStart < tailChunks.length
        ? Buffer.concat(tailChunks.slice(tailStart))
        : null;
      const wasTruncated = droppedBytes > 0;
      if (shape === null) shape = detectShape(opts.contentType(), firstChunk);

      const base: ObserverResult = {
        shape: shape ?? 'empty',
        contentEncoding: encoding,
        contentType: opts.contentType(),
        plainBytes: 0,
        rawBytes,
        truncated: wasTruncated,
        scan: null,
        usage: null,
        model: null,
        responseId: null,
        usageMissingFields: [],
        note: null,
      };

      if (shape === 'binary') return base;

      // ── 取出交给解析器的明文片段 ──
      //   ① 未超限：拿到的就是**完整明文**（头 + 尾即全部原始字节），照旧一次性同步解压；
      //   ② 原始字节超限：压缩流无法只解一段 → 明确降级并说明原因（不再笼统报"解压失败"）；
      //      identity / 未知编码则可以分别解析"头"与"尾"；
      //   ③ 解压后超限（压缩比很高）：明文已在内存里，同样切成"头 + 尾"——
      //      usage 在末尾，只留开头等于必然丢 usage。
      let usable: Buffer;
      let tailUsable: Buffer | null = null;

      const sliceTail = (buf: Buffer): Buffer | null =>
        tailCap > 0 && buf.length > tailCap ? frameAligned(buf.subarray(buf.length - tailCap)) : null;

      let full: Buffer | null = null;
      if (!wasTruncated) {
        const raw = tailRaw ? Buffer.concat([head, tailRaw]) : head;
        const dec = decompressSync(raw, encoding);
        if (!dec.ok) {
          return {
            ...base,
            note: `解压失败（${encoding}）：${dec.error}。观测降级为仅统计字节数；转发字节未受影响。`,
            truncated: true,
          };
        }
        full = dec.data;
        base.plainBytes = full.length;
      } else if (encoding !== 'identity' && encoding !== 'unknown') {
        return {
          ...base,
          note: `响应体 ${kb(rawBytes)} 超过观测上限 ${kb(maxBytes)}：压缩流（Content-Encoding: ${encoding}）`
            + '无法只解一段，观测降级为仅统计字节数；转发字节未受影响。',
          truncated: true,
        };
      }

      if (full) {
        if (full.length <= maxBytes) {
          usable = full;
        } else {
          base.truncated = true;
          usable = full.subarray(0, headCap);
          tailUsable = sliceTail(full);
          base.note = `解压后 ${kb(full.length)}（原始 ${kb(rawBytes)}）超过观测上限 ${kb(maxBytes)}：`
            + '中间段未解析，已分别解析「头部」与「尾部」（usage 只存在于流末尾的终止事件，因此尾部必须保留）。';
        }
      } else {
        usable = head;
        tailUsable = tailRaw ? frameAligned(tailRaw) : null;
        base.plainBytes = usable.length + (tailUsable?.length ?? 0);
        base.note = `响应体 ${kb(rawBytes)} 超过观测上限 ${kb(maxBytes)}：中间 ${kb(droppedBytes)} 未保留，`
          + '已分别解析「头部」与「尾部」（usage 只存在于流末尾的终止事件，因此尾部必须保留）。';
      }

      // ── 解析 ──
      if (shape === 'sse') {
        const scannerOpts = {
          maxBytes: Math.max(maxBytes, 1024 * 1024),
          ...(opts.onDeltaText ? { onDeltaText: opts.onDeltaText } : {}),
        };
        const headScan = new SseScanner(scannerOpts);
        headScan.push(usable);
        let scan = headScan.finish();
        if (tailUsable && tailUsable.length > 0) {
          // ★ 尾部单独用一个扫描器：头部结尾是**半截帧**，若与尾部拼进同一个解析器，
          //   半截帧会和尾部第一行粘成一行垃圾。分开扫、再合并，语义才干净。
          const tailScan = new SseScanner(scannerOpts);
          tailScan.push(tailUsable);
          scan = mergeScans(scan, tailScan.finish());
        }
        base.scan = scan;
        base.usage = scan.usage;
        base.model = scan.model;
        base.responseId = scan.responseId;
        base.usageMissingFields = scan.usageMissingFields;
        return base;
      }

      if (shape === 'json') {
        try {
          const parsed = JSON.parse(usable.toString('utf8')) as Record<string, unknown>;
          const resp = (parsed.response ?? parsed) as Record<string, unknown>;
          if (typeof resp.model === 'string') base.model = resp.model;
          if (typeof resp.id === 'string') base.responseId = resp.id;
          if (resp.usage !== undefined) {
            const r = extractUsage(resp.usage);
            base.usage = r.usage;
            base.usageMissingFields = r.missing;
          }
          if (base.responseId === null) base.usageMissingFields.push('response.id');
        } catch (e) {
          // 截断导致的解析失败必须带上"为什么截断"，否则用户只看到一句看不懂的 JSON 错误
          const msg = `JSON 解析失败：${(e as Error).message}`;
          base.note = base.note ? `${base.note} ${msg}` : msg;
        }
        return base;
      }

      return base;
    },
  };
}

/**
 * 合并"头部扫描"与"尾部扫描"。
 *
 * 优先级刻意如此：
 *   - **usage 取自尾部**（终止事件在流末尾；头部不可能有）
 *   - **model / response.id / 首 token 时间取自头部**（`response.created` 在最前面，
 *     它比终止事件更早、也更贴近"这次请求到底调了谁"）
 *   - 计数类字段（事件数、delta 字符数）相加 —— 两段的字节范围不重叠，不会重复计数
 */
function mergeScans(head: SseScanResult, tail: SseScanResult): SseScanResult {
  const typeCounts = new Map(head.typeCounts);
  for (const [k, v] of tail.typeCounts) typeCounts.set(k, (typeCounts.get(k) ?? 0) + v);
  const usageFrom = tail.usage ? tail : head;
  return {
    isSse: true,
    eventCount: head.eventCount + tail.eventCount,
    typeCounts,
    privateEvents: new Set([...head.privateEvents, ...tail.privateEvents]),
    usage: tail.usage ?? head.usage,
    terminalType: tail.terminalType ?? head.terminalType,
    usageMissingFields: [...usageFrom.usageMissingFields],
    responseId: head.responseId ?? tail.responseId,
    model: head.model ?? tail.model,
    firstTokenAt: head.firstTokenAt ?? tail.firstTokenAt,
    sawDoneSentinel: head.sawDoneSentinel || tail.sawDoneSentinel,
    failure: head.failure ?? tail.failure,
    parseErrors: head.parseErrors + tail.parseErrors,
    truncated: head.truncated || tail.truncated,
    deltaChars: head.deltaChars + tail.deltaChars,
  };
}
