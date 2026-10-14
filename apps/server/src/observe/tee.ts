/**
 * 单向观察分叉（tee）—— H6 的机械保证。
 *
 * ★★ 这是整个项目最关键的一段代码。★★
 *
 * 目标：主链路字节不变、时序不变；旁路拿一份**只读副本**用于记账。
 * 旁路可以慢、可以丢、可以失败；主链路必须快、必须完整、必须成功。
 *
 * 实现要点（三条都必须做到）：
 *   1. **主链路优先**：`src.pipe(dst)` 的背压由 Node 负责；副本的处理
 *      **绝不** 影响 `src` 的流动状态（不 pause、不 throw、不 await）。
 *   2. **副本有界**：内存上限由**观测器**自己保证（它有界地保留"头部 + 尾部"，
 *      总量不超过 `maxBytes`）。tee **不再**替它丢弃分片 —— 见下面的 ★。
 *   3. **异常吞掉**：`onCopy` 抛错只计数，不上抛。
 *
 * ★★ 为什么 tee 不能截断（实测踩到的第二个坑，2026-10）★★
 *   旧实现里"累计超过 maxBytes 就停止复制"。但 usage **只存在于流末尾的终止事件**
 *   （`response.completed`），一旦在 512KB 处停止投喂，观测器**永远看不到末尾**，
 *   于是所有长响应都退化成"来源=估算"（线上 9/9 条如此），并且 `bytes_out` 也被少算
 *   （它同样只统计到被复制的那一段）。
 *   现在改为：tee 只负责"投喂 + 计数"，**丢弃与否由观测器决定**（它按头/尾切分，
 *   内存开销仍是 `maxBytes`）。`truncated` 字段从此只作诊断用。
 *
 * 为什么不用 `stream.PassThrough` + 两个 pipe：
 *   PassThrough 的 `write()` 返回 false 时会触发背压 —— 如果副本消费者慢，
 *   就会把主链路的 `src` 也拖慢。这正好是我们要避免的。
 *   所以这里让 `src` 只 pipe 一个目标（客户端），副本用 `data` 事件旁听。
 */

import type { Readable, Writable } from 'node:stream';

export interface TeeStats {
  /** 主链路已转发字节数 */
  relayedBytes: number;
  /** 旁路已复制字节数 */
  copiedBytes: number;
  /** 因超出上限而丢弃的字节数 */
  droppedBytes: number;
  /** 是否发生截断 */
  truncated: boolean;
  /** onCopy 抛错次数 */
  copyErrors: number;
}

export interface TeeHandle {
  /** 主链路可读流（已 pipe 到 dst） */
  readonly stats: TeeStats;
  /** 等待主链路结束（含错误） */
  done: Promise<void>;
  /** 主动断开（客户端已走 / 网关关闭时） */
  dispose(): void;
}

export interface TeeOptions {
  /** 上游响应流 */
  src: Readable;
  /** 客户端响应（或任何 Writable） */
  dst: Writable;
  /** 只读副本回调。**必须同步且快**；抛错会被吞掉并计数。 */
  onCopy: (chunk: Buffer, isFirst: boolean) => void;
  /** 观测缓冲上限（字节）。超出即停止复制。 */
  maxBytes: number;
  /** 主链路发生错误时的回调（用于记账，不影响转发） */
  onError?: (err: Error) => void;
  /** 主链路正常结束时的回调 */
  onEnd?: () => void;
}

/**
 * 建立"主链路 pipe + 旁路旁听"的转发。
 *
 * 时序保证：
 *   `src.on('data')` 的监听器只在数据从 `src` 流出时被调用 ——
 *   而 `src` 的流出速度由 `dst` 的背压决定（因为 pipe 是主消费者）。
 *   因此副本天然与主链路同步，且**不会**额外影响流速。
 */
export function teeForObservation(opts: TeeOptions): TeeHandle {
  const { src, dst, onCopy, maxBytes, onError, onEnd } = opts;

  const stats: TeeStats = {
    relayedBytes: 0,
    copiedBytes: 0,
    droppedBytes: 0,
    truncated: false,
    copyErrors: 0,
  };

  let firstChunkSeen = false;
  let settled = false;

  // ── 主链路：pipe 负责背压与收尾 ──
  src.pipe(dst);

  // ── 旁路：旁听 data，只读副本。绝不 pause / 绝不 throw / 绝不丢弃（见文件头 ★）──
  const onData = (chunk: Buffer): void => {
    stats.relayedBytes += chunk.length;
    const isFirst = !firstChunkSeen;
    firstChunkSeen = true;
    try {
      onCopy(chunk, isFirst);
      stats.copiedBytes += chunk.length;
      // 仅作诊断：说明这份响应体已经超过观测预算（真正的丢弃由观测器决定）
      if (stats.copiedBytes > maxBytes) stats.truncated = true;
    } catch {
      // 观测失败绝不影响主链路
      stats.copyErrors++;
    }
  };
  src.on('data', onData);

  const done = new Promise<void>((resolve) => {
    const finish = (): void => {
      if (settled) return;
      settled = true;
      src.off('data', onData);
      resolve();
    };

    src.on('end', () => { onEnd?.(); finish(); });
    src.on('error', (err: Error) => { onError?.(err); finish(); });
    // 客户端提前断开：dst 报错时也要收尾，否则观测永不 finish（内存泄漏）
    dst.on('error', () => { finish(); });
    dst.on('close', () => { if (!dst.writableEnded) finish(); });
  });

  return {
    stats,
    done,
    dispose() {
      if (settled) return;
      settled = true;
      src.off('data', onData);
      src.unpipe(dst);
      try { src.destroy(); } catch { /* 忽略 */ }
    },
  };
}
