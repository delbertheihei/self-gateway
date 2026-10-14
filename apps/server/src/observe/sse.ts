/**
 * SSE（Server-Sent Events）增量解析器 + Responses 事件语义。
 *
 * 复用的库：`eventsource-parser`（宽容、成熟、纯函数）。我们**不自研**分帧逻辑，
 * 因为它是经典踩坑区：
 *   - 分帧符是 `\n\n`（也接受 `\r\n\r\n`）
 *   - 多行 `data:` 需要用 `\n` 拼接
 *   - **多字节 UTF-8 可能跨分片**：必须按 Buffer 累积到换行再解码，
 *     对每个 chunk 单独 `toString()` 会把中文字符切成两半
 *
 * 本模块只关心**记账需要的东西**：
 *   - `model`（响应里报的真实模型名）
 *   - `response.id`
 *   - **usage**（只在终止事件 `response.completed` / `response.incomplete` 里，
 *     其他事件的 usage 都是 null）
 *   - 首个 `response.output_text.delta` 的时间点（用于 TTFT）
 *   - 失败事件（`response.failed` / `error`）用于错误归因
 */

import { createParser, type EventSourceMessage } from 'eventsource-parser';
import type { UsageRecord } from '@sgw/shared';

export interface SseEvent {
  /** SSE 的 `event:` 字段（Responses API 里通常与 data.type 相同） */
  event: string | null;
  /** 解析后的 data JSON；解析失败为 null */
  data: unknown;
  /** data 的 `type` 字段，便于快速分支 */
  type: string | null;
  /** 原始 data 字符串（诊断用，有上限截断） */
  raw: string;
}

export interface SseScanResult {
  /** 是否为 SSE（由 content-type 判定，调用方传入） */
  isSse: boolean;
  /** 观测到的事件总数 */
  eventCount: number;
  /** 事件类型计数（用于 M0-3 的清单展示与私有事件告警） */
  typeCounts: Map<string, number>;
  /** 出现过的非标准私有事件（codex.* / responsesapi.*） */
  privateEvents: Set<string>;
  /** 终止事件（response.completed / response.incomplete）里提取的 usage */
  usage: UsageRecord | null;
  /** 终止事件的类型 */
  terminalType: string | null;
  /**
   * 终止事件里 usage 缺失的字段名（例如 `usage.total_tokens`）。
   *
   * ★ 这是 M0-2b 告警链路的直接数据源：缺失即意味着 Codex 会整轮硬失败。
   * 必须**精确到字段**，因为用户要把它反馈给中继管理员。
   */
  usageMissingFields: string[];
  /** response.id（Codex 硬失败字段之一） */
  responseId: string | null;
  /** 响应里报的模型名 */
  model: string | null;
  /** 首个文本 delta 的时间（epoch ms）；用于 TTFT */
  firstTokenAt: number | null;
  /** 是否出现 [DONE] 哨兵（非标准 Responses 行为，Codex 可容忍） */
  sawDoneSentinel: boolean;
  /** 失败的终止事件信息 */
  failure: { type: string; message: string | null } | null;
  /** JSON 解析失败的帧数 */
  parseErrors: number;
  /** 观测是否因缓冲上限被截断（调用方设置） */
  truncated: boolean;
  /** 累计的输出文本字符数（用于无 usage 时的估算；不保留文本本身） */
  deltaChars: number;
}

export function emptyScanResult(isSse: boolean): SseScanResult {
  return {
    isSse,
    eventCount: 0,
    typeCounts: new Map(),
    privateEvents: new Set(),
    usage: null,
    terminalType: null,
    usageMissingFields: [],
    responseId: null,
    model: null,
    firstTokenAt: null,
    sawDoneSentinel: false,
    failure: null,
    parseErrors: 0,
    truncated: false,
    deltaChars: 0,
  };
}

/** 事件类型 → 是否属于"终止事件族"（唯一携带 usage 的地方） */
export function isTerminalEvent(type: string | null): boolean {
  return type === 'response.completed' || type === 'response.incomplete';
}

/**
 * 从 Responses 事件里抽取需要计数的输出文本。
 *
 * 只取文本类 delta；工具调用参数也算 output，因此一并纳入。
 * 终止事件带完整 output，用它兜住"delta 丢失"的情况。
 */
export function extractDeltaText(type: string | null, data: unknown): string | null {
  if (!type || !data || typeof data !== 'object') return null;
  const obj = data as Record<string, unknown>;
  switch (type) {
    case 'response.output_text.delta':
    case 'response.reasoning_text.delta':
    case 'response.reasoning_summary_text.delta':
    case 'response.refusal.delta':
    case 'response.function_call_arguments.delta':
    case 'response.custom_tool_call_input.delta':
    case 'response.mcp_call.arguments.delta':
    case 'response.audio_transcript.delta':
      return typeof obj.delta === 'string' ? obj.delta : null;
    case 'response.completed': {
      const resp = obj.response as Record<string, unknown> | undefined;
      const output = resp?.output;
      if (!Array.isArray(output)) return null;
      let text = '';
      for (const item of output) {
        const it = item as Record<string, unknown>;
        const content = it.content;
        if (!Array.isArray(content)) continue;
        for (const part of content) {
          const p = part as Record<string, unknown>;
          if (typeof p.text === 'string') text += p.text;
        }
      }
      return text.length ? text : null;
    }
    default:
      return null;
  }
}

/**
 * 从 `response.usage` 提取 UsageRecord，并校验 Codex 的字段契约。
 *
 * ★★ M0-2b 的实现：Codex 的 `ResponseCompleted` 把
 *    `input_tokens` / `output_tokens` / `total_tokens` / `response.id`
 *    声明为**非 `Option`**。缺任一 → Codex 抛
 *    `failed to parse ResponseCompleted: missing field X`，**整轮硬失败**。
 *
 * 网关**不改字节**（改了就是 H3 违规，而且掩盖中继问题），但必须**发现并告警**。
 */
export function extractUsage(usage: unknown): { usage: UsageRecord | null; missing: string[] } {
  const missing: string[] = [];
  if (usage === null || usage === undefined) return { usage: null, missing };
  if (typeof usage !== 'object') return { usage: null, missing: ['usage(非对象)'] };

  const u = usage as Record<string, unknown>;
  const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

  const inputTokens = num(u.input_tokens);
  const outputTokens = num(u.output_tokens);
  const totalTokens = num(u.total_tokens);

  if (inputTokens === null) missing.push('usage.input_tokens');
  if (outputTokens === null) missing.push('usage.output_tokens');
  if (totalTokens === null) missing.push('usage.total_tokens');

  if (missing.length) {
    // 字段不全：仍尽量记录已有值，但标记 complete=false
    return {
      usage: {
        inputTokens: inputTokens ?? 0,
        outputTokens: outputTokens ?? 0,
        totalTokens: totalTokens ?? ((inputTokens ?? 0) + (outputTokens ?? 0)),
        cachedInputTokens: 0,
        cacheWriteTokens: 0,
        reasoningTokens: 0,
        source: 'upstream',
        complete: false,
      },
      missing,
    };
  }

  const inDetails = (u.input_tokens_details ?? {}) as Record<string, unknown>;
  const outDetails = (u.output_tokens_details ?? {}) as Record<string, unknown>;
  const cached = num(inDetails.cached_tokens) ?? 0;
  const cacheWrite = num(inDetails.cache_write_tokens) ?? 0;
  const reasoning = num(outDetails.reasoning_tokens) ?? 0;

  // 嵌套结构存在时，其内部字段也是非 Option —— 缺失同样会让 Codex 失败
  if (u.input_tokens_details && typeof u.input_tokens_details === 'object'
    && num(inDetails.cached_tokens) === null) {
    missing.push('usage.input_tokens_details.cached_tokens');
  }
  if (u.output_tokens_details && typeof u.output_tokens_details === 'object'
    && num(outDetails.reasoning_tokens) === null) {
    missing.push('usage.output_tokens_details.reasoning_tokens');
  }

  return {
    usage: {
      inputTokens: inputTokens!,
      outputTokens: outputTokens!,
      totalTokens: totalTokens!,
      cachedInputTokens: cached,
      cacheWriteTokens: cacheWrite,
      reasoningTokens: reasoning,
      source: 'upstream',
      complete: missing.length === 0,
    },
    missing,
  };
}

/**
 * SSE 扫描器：把收到的**明文**分片喂进来，边收边解析。
 *
 * 使用方式（在 observer 里）：
 *   const scanner = new SseScanner({ maxBytes: 512 * 1024 });
 *   scanner.push(plaintextChunk);
 *   const result = scanner.finish();
 *
 * 纪律：本类**永不抛异常**。任何解析问题都降级为计数/标记。
 */
export class SseScanner {
  private readonly parser: ReturnType<typeof createParser>;
  private readonly maxBytes: number;
  private readonly result: SseScanResult;
  private consumedBytes = 0;
  private readonly onProgress: ((r: SseScanResult) => void) | undefined;
  private readonly onDeltaText: ((text: string) => void) | undefined;

  constructor(opts: {
    maxBytes?: number;
    onProgress?: (r: SseScanResult) => void;
    /** 每见到一段输出 delta 就回调（用于"无 usage 时估算"的增量计数，不保留文本） */
    onDeltaText?: (text: string) => void;
  } = {}) {
    this.maxBytes = opts.maxBytes ?? 512 * 1024;
    this.onProgress = opts.onProgress;
    this.onDeltaText = opts.onDeltaText;
    this.result = emptyScanResult(true);
    this.parser = createParser({
      onEvent: (msg: EventSourceMessage) => { this.handleEvent(msg); },
      onError: () => { this.result.parseErrors++; },
    });
  }

  push(chunk: Buffer): void {
    this.consumedBytes += chunk.length;
    // 超出观测预算后只计字节，不再解析（保护内存）
    if (this.consumedBytes > this.maxBytes) {
      this.result.truncated = true;
      return;
    }
    try {
      // eventsource-parser 负责分帧与多字节安全（它内部按行处理）
      this.parser.feed(chunk.toString('utf8'));
    } catch {
      this.result.parseErrors++;
    }
    this.onProgress?.(this.result);
  }

  private handleEvent(msg: EventSourceMessage): void {
    const raw = msg.data ?? '';
    if (raw.trim() === '[DONE]') { this.result.sawDoneSentinel = true; return; }

    let data: unknown = null;
    try { data = raw ? JSON.parse(raw) : null; } catch { this.result.parseErrors++; }

    const type = (data && typeof data === 'object' && typeof (data as { type?: unknown }).type === 'string')
      ? (data as { type: string }).type
      : (msg.event ?? null);

    this.result.eventCount++;
    if (type) {
      this.result.typeCounts.set(type, (this.result.typeCounts.get(type) ?? 0) + 1);
      if (type.startsWith('codex.') || type.startsWith('responsesapi.')) {
        this.result.privateEvents.add(type);
      }
    }

    if (!data || typeof data !== 'object') return;
    const obj = data as Record<string, unknown>;

    // 首个文本 delta → TTFT
    if (this.result.firstTokenAt === null
      && (type === 'response.output_text.delta' || type === 'response.reasoning_text.delta'
        || type === 'response.reasoning_summary_text.delta')) {
      this.result.firstTokenAt = Date.now();
    }

    // 输出文本增量计数（不保留文本，只累计字符数 + 回调给估算器）
    const deltaText = extractDeltaText(type, data);
    if (deltaText) {
      this.result.deltaChars += deltaText.length;
      try { this.onDeltaText?.(deltaText); } catch { this.result.parseErrors++; }
    }

    const resp = obj.response as Record<string, unknown> | undefined;
    if (resp && typeof resp === 'object') {
      if (typeof resp.id === 'string' && !this.result.responseId) this.result.responseId = resp.id;
      if (typeof resp.model === 'string' && !this.result.model) this.result.model = resp.model;
    }

    // 终止事件：唯一携带 usage 的地方（含 response.failed 的错误信息）
    if (isTerminalEvent(type)) {
      this.result.terminalType = type;
      if (resp && resp.usage !== undefined) {
        const r = extractUsage(resp.usage);
        if (r.usage) this.result.usage = r.usage;
        // ★ 精确记录缺了哪些字段 —— 这是"上游会让你失败"的可执行证据
        this.result.usageMissingFields = r.missing;
      }
      // response.id 也是 Codex 的非 Option 字段
      if (!this.result.responseId) this.result.usageMissingFields.push('response.id');
      else {
        this.result.usageMissingFields = this.result.usageMissingFields.filter((f) => f !== 'response.id');
      }
    } else if (type === 'response.failed' || type === 'error') {
      const err = (resp?.error ?? obj.error) as Record<string, unknown> | undefined;
      const message = err && typeof err.message === 'string' ? err.message : null;
      this.result.failure = { type: type ?? 'error', message };
    }
  }

  /** 幂等收尾 */
  finish(): SseScanResult {
    try { this.parser.reset({ consume: true }); } catch { /* 忽略 */ }
    return this.result;
  }
}

/** 一次性解析一个完整 SSE 响应体（非流式场景 / 测试用） */
export function scanSseBody(body: Buffer, maxBytes = 8 * 1024 * 1024): SseScanResult {
  const s = new SseScanner({ maxBytes });
  s.push(body);
  return s.finish();
}
