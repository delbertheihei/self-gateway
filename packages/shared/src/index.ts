/**
 * @sgw/shared 入口。
 *
 * 注意：导出的是**类型与纯函数**，不含任何 I/O，因此 server 与 web 都能安全引用。
 */
export * from './types.ts';
export * from './errors.ts';
export * from './headers.ts';
export * from './ulid.ts';
export * from './histogram.ts';
export * from './pricing.ts';

/** 全局常量 */
export const SGW_VERSION = '0.1.0';
/** 控制面命名空间。与代理路径 /v1/** 完全隔离，避免任何冲突（ADR-9）。 */
export const CONTROL_PREFIX = '/_sgw';
/** 代理路径前缀。除它之外的路径一律不转发到上游（避免浪费额度、污染统计）。 */
export const PROXY_PREFIX = '/v1/';
/** 默认监听端口 */
export const DEFAULT_PORT = 8787;
