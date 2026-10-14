/**
 * 共享的运行时状态类型。
 *
 * 单独成文件是为了避免 `index.ts` ↔ `control/**` 的循环依赖：
 * control 层需要读取运行时状态，但不应该 import 入口文件。
 */

import type { ExchangeRecord } from '../edge/proxy.ts';

export interface RuntimeState {
  startedAt: number;
  /** **当前生效**的上游地址（可能来自 settings 表的热改，转发逐请求读它） */
  upstreamBaseUrl: string;
  /**
   * 启动时 `sgw.config.ts` 里的上游设置**快照**。
   *
   * ★ 为什么必须快照（两个真实 bug 都出在这里）：
   *   1. `applyUpstreamOverrides` 与热改都是**原地改** `cfg.upstream`，
   *      于是 `cfg.upstream` 再也不能回答"配置文件里到底写的是什么" ——
   *      设置页要显示"配置写的是 X，运行时生效的是 Y"就必须留一份快照。
   *   2. "清除运行期覆盖"必须回落到**配置文件的值**，而不是硬编码默认值
   *      （曾经把 stripPrefix 清成 ''、把 replaceAuth 留在旧密钥上）。
   */
  configUpstream: {
    baseUrl: string;
    stripPrefix: string;
    pathMode: 'auto' | 'append' | 'absolute';
    probeModel: string;
    probeAuth: string | null;
    /** 配置文件里是否写死了替换鉴权密钥（写死则运行期无法关闭） */
    replaceAuthFixed: boolean;
  };
  /** 当前被 settings 表覆盖的上游键（供设置页标注"这个值来自运行时"） */
  upstreamOverrides: string[];
  upstreamStatus: {
    reachable: boolean | null;
    lastProbeAt: number | null;
    lastError: string | null;
  };
  usageContract: {
    checked: boolean;
    complete: boolean | null;
    missingFields: string[];
    checkedAt: number | null;
  };
  exchangeCount: number;
  lastExchange: ExchangeRecord | null;
  lastCleanup: {
    ranAt: number;
    reason: string;
    deletedDetailRows: number;
    deletedBodyDirs: string[];
  } | null;
  sawWebsocketAttempt: boolean;
  /** 上游 /models 探测返回的 HTTP 状态码（用于诊断 stripPrefix 是否正确） */
  upstreamProbeStatus: number | null;
}
