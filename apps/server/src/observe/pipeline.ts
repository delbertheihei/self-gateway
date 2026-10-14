/**
 * Pipeline —— 把"请求/响应流副本"与"记账"缝在一起。
 *
 * 职责边界（docs/00 §4）：
 *   - 本模块是 `observe/**` 与 `recorder/**` 的**唯一交汇点**
 *   - `observe/**` 不得 import DB；`recorder/**` 不得碰流
 *   - 因此装配逻辑放在这里，两边都保持纯粹
 *
 * ★ H6 保证：本模块所有工作在 `src.on('data')` 的同步回调里完成，
 *   不 await、不 pause、不 throw。观测失败只影响记账，绝不影响转发。
 *
 * ★ 请求体副本的归属：`finish()` 之前只做**缓冲**（不解码），
 *   真正需要明文时才同步解码一次（见 `decodedRequest`）——
 *   这样"上游给了 usage、也不需要落盘正文"的常规路径零解码开销。
 */

import type { UsageRecord } from '@sgw/shared';
import { ZERO_USAGE } from '@sgw/shared';
import { createObserver, type ObserverResult } from './observer.ts';
import { EstEstimator } from './estimator.ts';
import { decodeForStorage, type ContentEncoding } from './decompress.ts';

export interface PipelineOptions {
  /** 惰性读取响应头（可能尚未到达，例如失败请求） */
  contentType: () => string | null;
  contentEncoding: () => string | null;
  /**
   * 惰性判断"这次交换是否失败"（无上游响应，或上游 HTTP ≥ 400）。
   *
   * ★ 为什么必须有它（实测到的真实缺陷）：上游 404/429/5xx 时，请求体是**完整**的
   *   （Codex 的 prompt 有 40KB），估算器会把它算成 33k「input token」。但模型**从未被调用**，
   *   这些 token 根本没发生 —— 却被写进了账本。实测 30 次 404 重试累计 120 万虚假 input，
   *   cached 恒为 0，把缓存命中率从 89% 拖到 61%，区间 token 虚高 23%。
   *
   *   因此：**失败请求的估算值一律丢弃**（宁可记为 0，也不记从未发生的用量）。
   *   只有"上游确实跑了这个请求"（拿到 2xx/3xx 响应）时才允许本地估算兜底。
   */
  isFailedResponse?: () => boolean;
  /**
   * 请求体的 `Content-Encoding`（**转发前就已知**，无需惰性读取）。
   *
   * ★ 为什么必须有它：Codex 会用 zstd 压缩 `/responses` 的请求体。不按它解码时，
   *   ① 落盘的"请求正文"是压缩字节（界面显示乱码）；② 估算器把二进制噪声当文本计数，
   *   估算输入 token 直接失真；③ 请求体里的 `"model"` 正则匹配不到，失败请求落回 `unknown`。
   *   响应侧一直没暴露这个问题，只是因为上游这里返回的是明文 SSE。
   */
  requestEncoding: ContentEncoding;
  maxBytes: number;
  /**
   * 是否收集请求体（用于估算 token）。
   *
   * ★ 由 Edge 传入"**是 LLM 端点的**且全局允许估算"的合取（见 `edge/proxy.ts`）：
   *   中继上还有 `/v1/alpha/search` 这类**非 LLM 端点**，它们的请求体不是 prompt，
   *   响应里也永远没有 usage，估算出来的"token"纯属噪音（会混进 Token 统计与成本）。
   */
  collectRequest: boolean;
  /**
   * 当 `collectRequest` 因**端点类型**被关掉时，写进 `observe_note` 的原因。
   * 空字符串/不传 = 不需要解释（例如全局关掉估算属于用户显式设置）。
   */
  estimateSkipNote?: string;
  /** 是否保留**解码后**的请求体副本（Body Mode） */
  captureRequest: boolean;
  /** 请求体缓冲上限（按**压缩态**字节计，与观测上限同口径） */
  maxRequestBytes: number;
  /** 宽限期排空（客户端断开后继续读上游的上限毫秒数）；0 = 不排空 */
  graceDrainMs: number;
}

export interface PipelineResult {
  /** 最终 usage（上游精确优先，否则估算，否则 none） */
  usage: UsageRecord;
  /** 上游 usage 是否字段不全（会让 Codex 整轮硬失败） */
  usageMissingFields: string[];
  model: string | null;
  responseId: string | null;
  /** 首个文本 delta 的时间（用于 TTFT 计时） */
  firstTokenAt: number | null;
  /** 客户端是否已断开（宽限期排空期间仍为 true） */
  clientAborted: boolean;
  /** 观测是否截断 */
  truncated: boolean;
  /** 观测诊断信息 */
  note: string | null;
  /** 原始观测结果（供上层做告警判定） */
  raw: ObserverResult;
  stats: { copiedBytes: number; droppedBytes: number; copyErrors: number };
  /**
   * **解码后**的请求体（`captureRequest` 时才有值）。
   * 解码失败时这里放的是原始字节 —— 宁可存一份看不懂的字节，也不能丢数据。
   */
  requestBody: Buffer | null;
  /** 请求体副本不可用（超过缓冲上限被截断，或解码失败） */
  requestTruncated: boolean;
}

export interface Pipeline {
  /** 喂入上游原始字节副本 */
  onResponseChunk(chunk: Buffer): void;
  /** 喂入客户端请求体字节（仅当 collectRequest） */
  onRequestChunk(chunk: Buffer): void;
  /** 标记客户端已断开（进入宽限期排空） */
  markClientAborted(): void;
  /** 是否仍在宽限期排空窗口内 */
  readonly draining: boolean;
  /** 幂等收尾 */
  finish(): PipelineResult;
  readonly truncated: boolean;
}

export function createPipeline(opts: PipelineOptions): Pipeline {
  const estimator = new EstEstimator();

  const observer = createObserver({
    contentType: opts.contentType,
    contentEncodingRaw: opts.contentEncoding,
    maxBytes: opts.maxBytes,
    // 输出文本增量直接喂给估算器：不保留文本，只累计 token
    onDeltaText: (text) => { estimator.pushOutput(text); },
  });

  const stats = { copiedBytes: 0, droppedBytes: 0, copyErrors: 0 };
  const state = { clientAborted: false, abortAt: 0, truncated: false };
  let finished: PipelineResult | null = null;

  // ── 请求体副本（压缩态）──
  // ★ 为什么要缓冲而不是像响应那样"边收边解析"：请求侧唯一的消费者都需要**整段**字节 ——
  //   gzip/zstd 的尾块必须看到流末尾才能解出，而 finish() 是同步读取结果。
  //   缓冲有硬上限（maxRequestBytes），且一旦用完就在 finish 时释放。
  const rawRequest: Buffer[] = [];
  let rawRequestBytes = 0;
  let requestTruncated = false;
  /** 解码结果缓存：估算器 / 模型名兜底 / 落盘正文三处共用，最多解一次 */
  let requestDecoded: Buffer | null = null;
  let requestDecodeNote: string | null = null;

  /**
   * 懒解码：只有真的要用到请求体明文时才付出解压开销。
   *
   * 三个消费者：① 上游没给 usage 时的估算；② 响应里没有模型名时的兜底；
   * ③ Body Mode 落盘。identity 编码下 `decodeForStorage` 是零拷贝直通，开销可忽略。
   */
  function decodedRequest(): Buffer {
    if (requestDecoded !== null) return requestDecoded;
    const dec = decodeForStorage(Buffer.concat(rawRequest), opts.requestEncoding);
    requestDecoded = dec.data;
    if (dec.note !== null) {
      // 解码失败：正文副本视为不可用（落盘的是原始字节），并如实标注
      requestDecodeNote = dec.note;
      requestTruncated = true;
    }
    return requestDecoded;
  }

  return {
    onRequestChunk(chunk: Buffer): void {
      try {
        if (rawRequestBytes + chunk.length > opts.maxRequestBytes) { requestTruncated = true; return; }
        rawRequest.push(chunk);
        rawRequestBytes += chunk.length;
      } catch { stats.copyErrors++; }
    },

    onResponseChunk(chunk: Buffer): void {
      try {
        observer.onResponseChunk(chunk, stats.copiedBytes === 0);
        stats.copiedBytes += chunk.length;
        if (observer.truncated) state.truncated = true;
      } catch {
        stats.copyErrors++;
      }
    },

    markClientAborted(): void {
      if (state.clientAborted) return;
      state.clientAborted = true;
      state.abortAt = Date.now();
    },

    get draining(): boolean {
      if (!state.clientAborted || opts.graceDrainMs <= 0) return false;
      return Date.now() - state.abortAt <= opts.graceDrainMs;
    },

    get truncated(): boolean { return state.truncated; },

    finish(): PipelineResult {
      if (finished) return finished;

      const raw = observer.finish();
      const hasRequest = rawRequestBytes > 0;

      // ── usage 优先级（docs/02 §5.4）──
      //   1. 上游非流式 usage
      //   2. 上游 SSE 终止事件 usage
      //   3. 本地估算
      //   4. none
      let usage: UsageRecord;
      const missing: string[] = [];
      /** 估算值因"请求失败"被丢弃 —— 需要在 observeNote 里说明，否则用户看到 0 会以为网关坏了 */
      let estimateDropped = false;
      /** 惰性求值一次并记住：它决定"要不要估算"以及"说明怎么写" */
      const failedRequest = opts.isFailedResponse?.() === true;

      const upstream = raw.usage ?? raw.scan?.usage ?? null;
      if (upstream) {
        usage = upstream;
        // ★ 缺字段清单必须精确（用户要拿它去问中继管理员）。
        //   来源：SSE 扫描器在终止事件上算出的 usageMissingFields。
        if (!upstream.complete) {
          const fromScan = raw.scan?.usageMissingFields ?? [];
          missing.push(...(fromScan.length > 0
            ? fromScan
            : ['usage.input_tokens', 'usage.output_tokens', 'usage.total_tokens']));
        }
      } else {
        // ★ 只有上游**没给** usage 时才需要估算，也就只有这时才值得解码请求体 ——
        //   正常路径（上游给了 usage）零解码开销，热路径不受影响。
        if (opts.collectRequest && hasRequest) {
          estimator.pushInput(decodedRequest().toString('utf8'));
        }
        const estimated = estimator.build();
        if (estimated && failedRequest) {
          // 请求失败：估算值代表"如果跑了会用多少"，不是"实际用了多少" → 丢弃
          estimateDropped = true;
          usage = { ...ZERO_USAGE };
        } else {
          usage = estimated ?? { ...ZERO_USAGE };
        }
      }

      // ★ 下面三行的**顺序敏感**：`model` 与 `requestBody` 都可能触发懒解码，
      //   而解码失败会写入 `requestDecodeNote` —— 因此 `note` 必须最后求值，
      //   否则"正文副本解码失败"的说明会被悄悄丢掉。
      //
      // 模型名优先级：响应体里报的（最权威）→ 请求体里声明的 → null
      const model = raw.model ?? raw.scan?.model
        ?? (hasRequest ? extractRequestModel(decodedRequest()) : null);

      // Body Mode：拿解码后的明文落盘（而不是压缩字节 —— 那在界面上就是乱码）
      const requestBody = opts.captureRequest && hasRequest ? decodedRequest() : null;

      const note = [
        raw.note,
        requestDecodeNote,
        failedRequest
          ? '请求失败（无上游响应或 HTTP ≥ 400）—— 模型未被调用'
            + `${estimateDropped ? '，本地估算已丢弃' : ''}，不计入 token 与缓存统计`
          : null,
        // ★ 客户端中断（Esc）后又没在宽限期内等到终止事件：这一轮**确实消耗了上游 token**，
        //   因此保留估算是对的；但必须写明白，否则用户看到"来源=估算"会以为网关没记准。
        state.clientAborted && usage.source === 'estimated'
          ? `客户端中断：宽限期（${opts.graceDrainMs}ms）内未收到 usage 终止事件，已按请求体与输出增量估算`
          : null,
        // 失败的原因更根本，因此失败时不再重复说"非 LLM 端点"
        !failedRequest && !opts.collectRequest && opts.estimateSkipNote && usage.source === 'none'
          ? opts.estimateSkipNote
          : null,
      ].filter((s): s is string => Boolean(s)).join(' ') || null;

      finished = {
        usage,
        usageMissingFields: missing,
        model,
        responseId: raw.responseId ?? raw.scan?.responseId ?? null,
        firstTokenAt: raw.scan?.firstTokenAt ?? null,
        clientAborted: state.clientAborted,
        truncated: state.truncated || raw.truncated,
        note,
        raw,
        stats,
        requestBody,
        requestTruncated,
      };
      return finished;
    },
  };
}

/**
 * 从解码后的请求体里取 `"model"` 字段。
 *
 * 为什么需要它：失败请求（429/500）上游往往不返回模型名，于是那些记录会落成
 * `model = unknown`，在"模型分布"里聚成一个无意义的条目。而请求体里本来就写着模型名。
 * 只扫前 64KB（模型名一定在靠前的部分），不解析整个 JSON。
 */
const REQUEST_MODEL_RE = /"model"\s*:\s*"([^"]{1,120})"/;
function extractRequestModel(buf: Buffer): string | null {
  const head = buf.length > 65536 ? buf.subarray(0, 65536) : buf;
  return REQUEST_MODEL_RE.exec(head.toString('utf8'))?.[1] ?? null;
}

export type { ContentEncoding };
