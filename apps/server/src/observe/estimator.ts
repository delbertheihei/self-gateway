/**
 * Token 估算器 —— 上游不返回 usage 时的兜底。
 *
 * 定位（docs/02 §5.5）：**估算只是兜底**，UI 必须标 `估算` 徽标。
 * 精度目标 ±5–15%，因此**不引入 tiktoken**（原生/WASM 依赖与"零原生模块"目标冲突）。
 *
 * 分段启发式：
 *   - CJK（中日韩）：约 1.6 字符/token
 *   - ASCII 字母数字与代码：约 3.6 字符/token
 *   - 空白与标点：并入相邻段统计，不单独计
 *   - 每段额外 +3 token 的"结构开销"（模拟 role/分隔符）
 *
 * 实现为**流式计数器**：可以边收边计，不需要把整段文本留在内存里。
 */

import type { UsageRecord } from '@sgw/shared';

/** 统计口径常量。改这里会同时影响所有估算结果，需谨慎。 */
export const CHARS_PER_TOKEN = {
  /** 拉丁字母/数字/常见符号 */
  latin: 3.6,
  /** 中日韩统一表意文字 + 假名 + 韩文 */
  cjk: 1.6,
  /** 其他（emoji、符号、其他文字） */
  other: 2.2,
} as const;

/** 每段消息的结构开销（role 分隔符、消息边界等） */
const MESSAGE_OVERHEAD_TOKENS = 3;

export type CharClass = 'latin' | 'cjk' | 'other';

/** 判断一个码点属于哪一类 */
export function classifyCodePoint(cp: number): CharClass {
  // CJK 统一表意文字
  if (cp >= 0x4e00 && cp <= 0x9fff) return 'cjk';
  // CJK 扩展 A
  if (cp >= 0x3400 && cp <= 0x4dbf) return 'cjk';
  // 平假名 / 片假名
  if (cp >= 0x3040 && cp <= 0x30ff) return 'cjk';
  // 韩文音节
  if (cp >= 0xac00 && cp <= 0xd7af) return 'cjk';
  // CJK 兼容表意文字
  if (cp >= 0xf900 && cp <= 0xfaff) return 'cjk';
  // 全角标点
  if (cp >= 0xff00 && cp <= 0xffef) return 'cjk';
  // ASCII 可打印 + 常见拉丁
  if (cp >= 0x20 && cp <= 0x7e) return 'latin';
  // 拉丁扩展
  if (cp >= 0xa0 && cp <= 0x24f) return 'latin';
  return 'other';
}

/**
 * 流式估算计数器。
 *
 * 用法：
 *   const c = new TokenCounter();
 *   c.push(text);
 *   c.total();          // 估算 token 数
 *
 * 注意：跨 chunk 的代理对（surrogate pair，如 emoji）需要拼接。为了不计错，
 * 这里保留最后一个未完成的代理项。
 */
export class TokenCounter {
  private latin = 0;
  private cjk = 0;
  private other = 0;
  private segments = 1;
  private pendingHighSurrogate = '';

  push(text: string): void {
    const s = this.pendingHighSurrogate + text;
    this.pendingHighSurrogate = '';

    for (let i = 0; i < s.length; i++) {
      const code = s.charCodeAt(i);

      // 高代理项：可能与下一个组成完整码点
      if (code >= 0xd800 && code <= 0xdbff) {
        if (i + 1 < s.length) {
          const low = s.charCodeAt(i + 1);
          if (low >= 0xdc00 && low <= 0xdfff) {
            const cp = (code - 0xd800) * 0x400 + (low - 0xdc00) + 0x10000;
            this.bump(classifyCodePoint(cp));
            i++;
            continue;
          }
          // 后面没有低代理项：留到下次
          this.pendingHighSurrogate = s.slice(i);
          break;
        }
        this.pendingHighSurrogate = s.slice(i);
        break;
      }

      // 换行视作段边界（消息/代码块之间）
      if (code === 10 || code === 13) { this.segments++; continue; }
      this.bump(classifyCodePoint(code));
    }
  }

  private bump(cls: CharClass): void {
    if (cls === 'latin') this.latin++;
    else if (cls === 'cjk') this.cjk++;
    else this.other++;
  }

  /** 当前估算值（含结构开销） */
  total(): number {
    const body = this.latin / CHARS_PER_TOKEN.latin
      + this.cjk / CHARS_PER_TOKEN.cjk
      + this.other / CHARS_PER_TOKEN.other;
    return Math.max(1, Math.ceil(body) + this.segments * MESSAGE_OVERHEAD_TOKENS);
  }

  get chars(): number { return this.latin + this.cjk + this.other; }

  reset(): void {
    this.latin = 0; this.cjk = 0; this.other = 0;
    this.segments = 1;
    this.pendingHighSurrogate = '';
  }
}

/** 一次性估算一段文本 */
export function estimateText(text: string): number {
  const c = new TokenCounter();
  c.push(text);
  return c.total();
}

/**
 * 双通道估算器：分别累计"输入"与"输出"，最后合成 UsageRecord。
 *
 * 对 Responses API 的请求体：把整个 JSON 文本当作 input 计数即可
 * （instructions / input / tools 都在里面，误差可接受）。
 * 对响应：累计所有 `*delta` 文本作为 output。
 */
export class EstEstimator {
  readonly input = new TokenCounter();
  readonly output = new TokenCounter();
  private inputSeen = false;
  private outputSeen = false;

  pushInput(text: string): void { this.input.push(text); this.inputSeen = true; }
  pushOutput(text: string): void { this.output.push(text); this.outputSeen = true; }

  /** 合成 UsageRecord；完全没数据时返回 null（让上游保持 'none'） */
  build(): UsageRecord | null {
    if (!this.inputSeen && !this.outputSeen) return null;
    const inp = this.inputSeen ? this.input.total() : 0;
    const out = this.outputSeen ? this.output.total() : 0;
    return {
      inputTokens: inp,
      outputTokens: out,
      totalTokens: inp + out,
      cachedInputTokens: 0,
      cacheWriteTokens: 0,
      reasoningTokens: 0,
      source: 'estimated',
      estimator: 'heuristic',
      complete: true,
    };
  }
}

/**
 * 从 Responses API 的事件里抽取需要计数的输出文本。
 *
 * 注意：该函数的**唯一实现**在 `sse.ts`（那里才是事件语义的归属地），
 * 此处重新导出以保持 estimator 的使用者无需知道来源。
 */
export { extractDeltaText } from './sse.ts';
