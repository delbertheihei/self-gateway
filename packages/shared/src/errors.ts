/**
 * 错误分类与错误响应。
 *
 * ★ 边界声明（H3）：
 *   上游的响应 —— 无论 2xx / 4xx / 5xx —— 一律**原样透传**，不包装、不改写、不重试。
 *   只有当**网关自己**无法产生上游响应时（连不上、超时、自环、WS 升级等），
 *   才由网关生成响应。这类响应不是"改写上游响应"，因此可以带 `x-sgw-error` 头。
 *
 * 为什么必须显式标注：Codex 报错时用户需要一眼区分"是上游的问题"还是"网关的问题"。
 * 没有这个头，排障会变成猜测。
 */

/** 错误分类。用字符串字面量联合而非 enum —— Node 22 原生 TS 不支持 enum。 */
export const ERROR_CLASSES = [
  'upstream_4xx',
  'upstream_5xx',
  'upstream_connect_timeout',
  'upstream_headers_timeout',
  'upstream_tls_error',
  'upstream_dns_error',
  'upstream_reset',
  'client_aborted',
  'upstream_stream_truncated',
  'usage_incomplete',
  'websocket_not_supported',
  'self_loop_detected',
  /** 上游地址还没填（这是**正常状态**，不是配置损坏 —— 地址由使用者在设置页手动输入） */
  'upstream_not_configured',
  'config_invalid',
  'internal_error',
] as const;

export type ErrorClass = (typeof ERROR_CLASSES)[number];

/** 网关自身错误 → HTTP 状态码与建议文案 */
export interface GatewayErrorSpec {
  status: number;
  /** 给用户看的一句话 */
  title: string;
  /** 排查建议（可空） */
  hint: string;
  errorClass: ErrorClass;
}

export function specFor(errorClass: ErrorClass): GatewayErrorSpec {
  switch (errorClass) {
    case 'upstream_connect_timeout':
      return { status: 504, title: '连接上游超时', hint: '检查网络、上游地址与端口；若上游在内网，确认 VPN/代理可用。', errorClass };
    case 'upstream_headers_timeout':
      return { status: 504, title: '上游未在约定时间内返回响应头', hint: '可调大 upstream.headersTimeoutMs；若上游本身很慢，这属正常。', errorClass };
    case 'upstream_tls_error':
      return { status: 502, title: '与上游的 TLS 握手失败', hint: '若上游使用内网自签 CA，请在设置中配置 caFile；不要用关闭校验来绕过。', errorClass };
    case 'upstream_dns_error':
      return { status: 502, title: '无法解析上游域名', hint: '检查 upstream.baseUrl 拼写与 DNS/代理设置。', errorClass };
    case 'upstream_reset':
      return { status: 502, title: '上游连接被重置', hint: '上游可能过载或被中间设备阻断；稍后重试。', errorClass };
    case 'self_loop_detected':
      return { status: 508, title: '检测到自我转发（上游指向本网关自己）', hint: '请把 upstream.baseUrl 改为真实上游地址，否则请求会无限循环。', errorClass };
    case 'websocket_not_supported':
      return { status: 501, title: '本网关不支持 WebSocket 传输', hint: '请从 Codex 的 config.toml 中删除 supports_websockets，或设为 false（默认即 false）。', errorClass };
    case 'upstream_not_configured':
      return {
        status: 502,
        title: '尚未配置上游地址',
        hint: '打开仪表盘「设置 → 上游」，手动填写上游地址（改完即时生效，不必重启）；也可以写在 sgw.config.ts 的 upstream.baseUrl 里。',
        errorClass,
      };
    case 'config_invalid':
      return { status: 500, title: '网关配置无效', hint: '打开仪表盘「设置 → 上游」，手动填写上游地址（改完即时生效，无需重启）；也可写在 sgw.config.ts 里。', errorClass };
    case 'client_aborted':
      return { status: 499, title: '客户端提前断开', hint: '通常由用户取消或超时引起，无需处理。', errorClass };
    case 'upstream_stream_truncated':
      return { status: 502, title: '上游流被中断', hint: '网关按原样结束了流，未补发任何事件。', errorClass };
    case 'usage_incomplete':
      return { status: 200, title: '上游 usage 结构不完整', hint: '该结构会让 Codex 整轮对话失败；请联系中继管理员补齐 total_tokens 等字段。', errorClass };
    case 'upstream_4xx':
      return { status: 502, title: '上游返回 4xx', hint: '实际上游响应会被原样透传，此分类仅用于记账。', errorClass };
    case 'upstream_5xx':
      return { status: 502, title: '上游返回 5xx', hint: '实际上游响应会被原样透传，此分类仅用于记账。', errorClass };
    case 'internal_error':
      return { status: 500, title: '网关内部错误', hint: '查看 data/logs/ 下的日志。', errorClass };
  }
}

/** 把 Node 的底层错误映射到我们的分类 */
export function classifyNodeError(err: unknown): ErrorClass {
  const e = err as { code?: string; message?: string } | null | undefined;
  const code = e?.code ?? '';
  const msg = e?.message ?? String(err);

  switch (code) {
    case 'ENOTFOUND':
    case 'EAI_AGAIN':
      return 'upstream_dns_error';
    case 'ECONNREFUSED':
    case 'ECONNRESET':
    case 'EPIPE':
      return 'upstream_reset';
    case 'ETIMEDOUT':
      return 'upstream_connect_timeout';
    case 'CERT_HAS_EXPIRED':
    case 'UNABLE_TO_VERIFY_LEAF_SIGNATURE':
    case 'SELF_SIGNED_CERT_IN_CHAIN':
    case 'DEPTH_ZERO_SELF_SIGNED_CERT':
    case 'ERR_TLS_CERT_ALTNAME_INVALID':
      return 'upstream_tls_error';
    default:
      break;
  }
  if (/certificate|self.signed|unable to verify|ERR_TLS/i.test(msg)) return 'upstream_tls_error';
  if (/timeout/i.test(msg)) return 'upstream_connect_timeout';
  if (/socket hang up|ECONNRESET/i.test(msg)) return 'upstream_reset';
  return 'internal_error';
}

/** 我们自己的中止信号（客户端断开 / 网关关闭 / 宽限期到期） */
export class SgwAbortError extends Error {
  readonly errorClass: ErrorClass;
  constructor(errorClass: ErrorClass, message: string) {
    super(message);
    this.name = 'SgwAbortError';
    this.errorClass = errorClass;
  }
}

/** 判断某次失败是否由我们主动中止引起 */
export function isAbortError(err: unknown): err is SgwAbortError {
  return err instanceof SgwAbortError;
}
