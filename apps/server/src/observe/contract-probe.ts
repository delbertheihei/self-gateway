/**
 * 上游 usage 契约探针 —— M0-2b 的运行时防线。
 *
 * 背景（详见 docs/02 §5.6）：Codex 的 `ResponseCompleted` 把
 * `response.id` / `usage.input_tokens` / `usage.output_tokens` / `usage.total_tokens`
 * 声明为**非 Option**。若中继返回的 `usage` **缺** `total_tokens`，
 * Codex 会抛 `failed to parse ResponseCompleted: missing field total_tokens`，
 * **整轮对话硬失败**。
 *
 * 网关**不能修**这个（改字节就违反 H3，而且会掩盖中继的问题），
 * 但可以**第一时间发现并告知**。这正是本模块的价值。
 *
 * 探针方式：发一个最小的流式请求（`max_output_tokens: 16`），只解析终止事件，
 * 不做别的。开销约几十个 token，用户可在设置页手动触发，也会在启动 30s 后自动跑一次。
 */

import http from 'node:http';
import https from 'node:https';
import { SseScanner, extractUsage } from './sse.ts';
import type { UpstreamAgents } from '../transport/upstream.ts';
import type { Logger } from '../config/logger.ts';

export interface ContractProbeResult {
  checked: boolean;
  complete: boolean | null;
  missingFields: string[];
  checkedAt: number;
  /** 诊断信息：为什么没得出结果 */
  note: string | null;
  /** 观测到的终止事件类型 */
  terminalType: string | null;
  /** 是否看到 usage 字段（区分"没 usage"与"usage 缺字段"） */
  sawUsage: boolean;
}

const EMPTY: ContractProbeResult = {
  checked: false, complete: null, missingFields: [], checkedAt: 0, note: null,
  terminalType: null, sawUsage: false,
};

export interface VerifyOptions {
  baseUrl: string;
  model: string;
  /** 沿用 Codex 发来的鉴权头（原样），不自己造凭据 */
  authorizationHeader: string;
  agents: UpstreamAgents;
  log: Logger;
  timeoutMs?: number;
  /** 入站 path 前缀剥离配置（与代理保持一致） */
  stripPrefix: string;
  pathMode: 'auto' | 'append' | 'absolute';
}

/**
 * 跑一次契约探针。
 *
 * 注意：这是**网关自己发起**的请求，因此不受 H1~H5 约束
 * （那些约束针对"转发客户端的请求"）。
 */
export async function verifyUsageContract(opts: VerifyOptions): Promise<ContractProbeResult> {
  const timeoutMs = opts.timeoutMs ?? 30_000;

  // ★ 地址与模型都是**可选的运行期设置**，未配置时绝不能"拿空值去打上游" ——
  //   那会得到一个 400，看起来像"上游坏了"，实际是本地没填。
  if (!opts.baseUrl) {
    return { ...EMPTY, checked: true, checkedAt: Date.now(), note: '未配置上游地址，探针未执行' };
  }
  if (!opts.model) {
    return { ...EMPTY, checked: true, checkedAt: Date.now(), note: '未配置探针模型，探针未执行' };
  }

  // 构造上游 URL：与代理同样的剥前缀逻辑，但只发一个最小请求
  const base = opts.baseUrl.replace(/\/+$/, '');
  const basePath = (() => {
    try { return new URL(base).pathname.replace(/\/+$/, ''); } catch { return ''; }
  })();

  let target: URL;
  try {
    const u = new URL(base);
    // /responses 追加到 base 之后（与代理的 append/auto 语义一致）
    const tail = opts.pathMode === 'absolute' ? '/responses' : '/responses';
    u.pathname = `${basePath}${tail}`.replace(/\/{2,}/g, '/');
    target = u;
  } catch (e) {
    return { ...EMPTY, checked: true, checkedAt: Date.now(), note: `baseUrl 非法：${(e as Error).message}` };
  }

  const body = JSON.stringify({
    model: opts.model,
    instructions: 'Reply with the single word: ok',
    input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'ping' }] }],
    tools: [],
    store: false,
    stream: true,
    max_output_tokens: 16,
  });

  return new Promise<ContractProbeResult>((resolve) => {
    const transport = target.protocol === 'https:' ? https : http;
    const agent = target.protocol === 'https:' ? opts.agents.https : opts.agents.http;

    const scanner = new SseScanner({ maxBytes: 2 * 1024 * 1024 });
    let done = false;
    const finish = (r: ContractProbeResult): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(r);
    };

    const timer = setTimeout(() => {
      try { req.destroy(); } catch { /* 忽略 */ }
      finish({ ...EMPTY, checked: true, checkedAt: Date.now(), note: `探针超时（${timeoutMs}ms）` });
    }, timeoutMs);
    timer.unref?.();

    const req = transport.request({
      protocol: target.protocol,
      hostname: target.hostname,
      port: target.port || (target.protocol === 'https:' ? 443 : 80),
      path: `${target.pathname}${target.search}`,
      method: 'POST',
      headers: {
        authorization: opts.authorizationHeader,
        'content-type': 'application/json',
        accept: 'text/event-stream',
        'user-agent': 'sgw-contract-probe/1.0',
        'accept-encoding': 'identity',   // 探针自己的请求：为可解析性而要求明文
        'content-length': String(Buffer.byteLength(body)),
      },
      agent,
    });

    req.on('response', (res) => {
      const ct = String(res.headers['content-type'] ?? '');
      if (!ct.includes('text/event-stream')) {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => { if (chunks.length < 8) chunks.push(c); });
        res.on('end', () => {
          const snippet = Buffer.concat(chunks).toString('utf8').slice(0, 300);
          opts.log.warn({ status: res.statusCode, contentType: ct, snippet }, 'usage 契约探针：响应不是 SSE');
          finish({
            ...EMPTY, checked: true, checkedAt: Date.now(),
            note: `上游返回 ${res.statusCode} 且非 SSE：${snippet.slice(0, 160)}`,
          });
        });
        return;
      }
      res.on('data', (c: Buffer) => { scanner.push(c); });
      res.on('end', () => {
        const scan = scanner.finish();
        const terminal = scan.terminalType;
        const sawUsage = scan.usage !== null;

        if (!terminal) {
          finish({
            ...EMPTY, checked: true, checkedAt: Date.now(),
            note: scan.failure
              ? `流以 ${scan.failure.type} 结束：${scan.failure.message ?? '(无 message)'}`
              : '流中没有终止事件（response.completed / response.incomplete）',
            terminalType: null,
          });
          return;
        }

        if (!sawUsage) {
          finish({
            checked: true, complete: null, missingFields: [], checkedAt: Date.now(),
            note: '上游未返回 usage（对 Codex 安全，但用量只能本地估算）',
            terminalType: terminal, sawUsage: false,
          });
          return;
        }

        // 复算一次字段完整性（scan.usage.complete 已由 extractUsage 给出）
        const usage = scan.usage!;
        const missing: string[] = [];
        // 重新从原始 usage 判断（scan 只保留了归一化后的 UsageRecord）
        if (!usage.complete) {
          if (usage.inputTokens === 0 && usage.outputTokens === 0 && usage.totalTokens === 0) {
            missing.push('usage.input_tokens', 'usage.output_tokens', 'usage.total_tokens');
          }
        }
        if (scan.responseId === null) missing.push('response.id');

        finish({
          checked: true,
          complete: missing.length === 0,
          missingFields: missing,
          checkedAt: Date.now(),
          note: missing.length === 0
            ? null
            : `⚠️ 上游 usage 结构不完整（缺 ${missing.join(', ')}）—— 这会让 Codex 整轮对话失败`,
          terminalType: terminal,
          sawUsage: true,
        });
      });
    });

    req.on('error', (e) => {
      finish({
        ...EMPTY, checked: true, checkedAt: Date.now(),
        note: `探针请求失败：${e.message}`,
      });
    });

    req.write(body);
    req.end();
  });
}

/** 从一次真实交换的扫描结果里判定契约（用于运行期持续校验，零额外请求） */
export function inspectScanForContract(scan: {
  usage: { complete: boolean } | null;
  responseId: string | null;
  terminalType: string | null;
}): { complete: boolean | null; missing: string[] } {
  if (!scan.terminalType) return { complete: null, missing: [] };
  if (!scan.usage) return { complete: null, missing: [] };
  const missing: string[] = [];
  if (!scan.usage.complete) missing.push('usage(input_tokens/output_tokens/total_tokens)');
  if (scan.responseId === null) missing.push('response.id');
  return { complete: missing.length === 0, missing };
}

export { extractUsage };
