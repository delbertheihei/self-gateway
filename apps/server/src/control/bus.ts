/**
 * 事件总线 —— 把内部事件广播给所有订阅者（SSE 实时推送的后端）。
 *
 * 设计要点：
 *   - **同步分发**：订阅者回调必须在微秒级完成，否则会拖慢主链路。
 *     SSE 推送只做"写 socket"（带缓冲），不做序列化重活。
 *   - **背压保护**：单订阅者缓冲超过阈值即断开它，绝不阻塞发布方（H6 的延伸）。
 *   - **异常隔离**：任一订阅者抛错只移除它，不影响其他订阅者与主链路。
 */

import type { GatewayEvent } from '@sgw/shared';
import type { Logger } from '../config/logger.ts';

export interface Subscriber {
  /** 推送一条事件（实现方负责自身缓冲与背压） */
  send(event: GatewayEvent): void;
  /** 断开时通知（用于清理） */
  close(reason: string): void;
  /** 标识（日志用） */
  readonly label: string;
}

export interface EventBus {
  subscribe(sub: Subscriber): () => void;
  publish(event: GatewayEvent): void;
  readonly subscriberCount: number;
  closeAll(reason: string): void;
}

export function createEventBus(log: Logger): EventBus {
  const subs = new Set<Subscriber>();

  return {
    subscribe(sub: Subscriber): () => void {
      subs.add(sub);
      return () => { subs.delete(sub); };
    },

    publish(event: GatewayEvent): void {
      if (subs.size === 0) return;
      for (const sub of [...subs]) {
        try {
          sub.send(event);
        } catch (e) {
          // 单个订阅者失败不能影响其他人，更不能冒泡到代理主链路
          log.warn({ label: sub.label, err: (e as Error).message }, 'SSE 订阅者推送失败，已移除');
          subs.delete(sub);
          try { sub.close('push-failed'); } catch { /* 忽略 */ }
        }
      }
    },

    get subscriberCount(): number { return subs.size; },

    closeAll(reason: string): void {
      for (const sub of [...subs]) {
        try { sub.close(reason); } catch { /* 忽略 */ }
      }
      subs.clear();
    },
  };
}

/**
 * KPI 增量节流器：`stats.tick` 每秒最多推一次，避免高频请求把 SSE 淹没。
 */
export function createStatsTicker(args: {
  intervalMs?: number;
  onTick: (delta: { requestDelta: number; tokenDelta: number; errorDelta: number }) => void;
}): { add(usage: { tokens: number; isError: boolean }): void; stop(): void } {
  const intervalMs = args.intervalMs ?? 1_000;
  let pending = { requestDelta: 0, tokenDelta: 0, errorDelta: 0 };

  const timer = setInterval(() => {
    if (pending.requestDelta === 0 && pending.tokenDelta === 0 && pending.errorDelta === 0) return;
    const snapshot = pending;
    pending = { requestDelta: 0, tokenDelta: 0, errorDelta: 0 };
    try { args.onTick(snapshot); } catch { /* 忽略 */ }
  }, intervalMs);
  timer.unref?.();

  return {
    add(usage): void {
      pending.requestDelta++;
      pending.tokenDelta += usage.tokens;
      if (usage.isError) pending.errorDelta++;
    },
    stop(): void { clearInterval(timer); },
  };
}
