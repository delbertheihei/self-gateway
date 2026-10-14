/**
 * 格式化工具 —— 全站统一的数字/单位口径（对应 docs/04 §7.2）。
 *
 * 纪律：单位格式**只在这里定义**，避免"同一份数据在不同页面显示成 1.2M 与 1200000"。
 */

/** token 数：千分位 + K/M 缩写（≥1M 用 M） */
export function fmtTokens(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return '—';
  if (n === 0) return '0';
  if (Math.abs(n) >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (Math.abs(n) >= 10_000) return `${(n / 1000).toFixed(1)}K`;
  return n.toLocaleString('zh-CN');
}

/** 精确整数（hover 用） */
export function fmtInt(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return '—';
  return Math.round(n).toLocaleString('zh-CN');
}

/** 整数缩写（图表刻度）：1.2K / 3.4M */
export function fmtCompact(n: number): string {
  if (!Number.isFinite(n)) return '—';
  if (Math.abs(n) >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (Math.abs(n) >= 1000) return `${(n / 1000).toFixed(n >= 10_000 ? 0 : 1)}K`;
  return String(Math.round(n));
}

/** 毫秒：<1s 显示 ms，否则显示 s */
export function fmtMs(ms: number | null | undefined, digits = 1): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms)) return '—';
  if (ms < 1000) return `${ms < 10 ? ms.toFixed(1) : Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(2)}s`;
  return `${(ms / 60_000).toFixed(1)}min`;
}

/** 字节 */
export function fmtBytes(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return '—';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 ** 3).toFixed(2)} GB`;
}

/** 金额（USD）本体；`$0` / 极小值用科学计数法避免显示成一串 0 */
function fmtUsd(usd: number): string {
  if (usd === 0) return '$0';
  if (usd < 0.001) return `$${usd.toExponential(1)}`;
  if (usd < 1) return `$${usd.toFixed(4)}`;
  return `$${usd.toFixed(2)}`;
}

/**
 * 成本。
 *
 * ★ 口径纪律（曾经写错）：`known=false` 表示"有模型没配价格"，此时金额是**未知**，
 *   不是 0。早期实现把它渲染成 `$0.0000?`，看起来像"花了 0 元"，是个误导性极强的假数字。
 *   现在：完全没有可用价格 → `—`；部分模型缺价格 → 加 `≈` 前缀（并提示去补价格）。
 */
export function fmtCost(usd: number | null | undefined, known = true): string {
  if (usd === null || usd === undefined || !Number.isFinite(usd)) return '—';
  if (!known) return usd > 0 ? `≈${fmtUsd(usd)}` : '—';
  return fmtUsd(usd);
}

/** 百分比 */
export function fmtPct(v: number | null | undefined, digits = 1): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return '—';
  return `${(v * 100).toFixed(digits)}%`;
}

/** 时间（HH:mm:ss） */
export function fmtTime(ts: number | null | undefined): string {
  if (!ts) return '—';
  const d = new Date(ts);
  return [d.getHours(), d.getMinutes(), d.getSeconds()]
    .map((x) => String(x).padStart(2, '0')).join(':');
}

/** 日期时间 */
export function fmtDateTime(ts: number | null | undefined): string {
  if (!ts) return '—';
  const d = new Date(ts);
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} `
    + `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

/** 图表 X 轴刻度：小时 → HH:00；天 → MM-DD */
export function fmtAxisTime(ts: number, bucket: 'hour' | 'day'): string {
  const d = new Date(ts);
  const pad = (n: number): string => String(n).padStart(2, '0');
  if (bucket === 'day') return `${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  return `${pad(d.getHours())}:00`;
}

/** 相对时间 */
export function fmtRelative(ts: number | null | undefined): string {
  if (!ts) return '—';
  const diff = Date.now() - ts;
  if (diff < 0) return '刚刚';
  const s = Math.floor(diff / 1000);
  if (s < 60) return `${s} 秒前`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} 分钟前`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} 小时前`;
  return `${Math.floor(h / 24)} 天前`;
}

/** 时长（秒 → 人类可读） */
export function fmtUptime(sec: number): string {
  if (sec < 60) return `${Math.round(sec)} 秒`;
  if (sec < 3600) return `${Math.floor(sec / 60)} 分 ${Math.round(sec % 60)} 秒`;
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  return `${h} 小时 ${m} 分`;
}

/** 截断长 ID 用于展示（完整值放 title） */
export function shortId(id: string | null | undefined, head = 10, tail = 4): string {
  if (!id) return '—';
  const h = Math.max(0, head);
  const t = Math.max(0, tail);
  if (id.length <= h + t + 1) return id;
  // ★ 必须显式判断 t === 0：`slice(-0)` 等价于 `slice(0)`，会返回**整个字符串**，
  //   渲染出 `01a13871…01a13871-2a56-…` 这种重复内容（会话列曾因此折行）。
  const headPart = h > 0 ? id.slice(0, h) : '';
  const tailPart = t > 0 ? id.slice(-t) : '';
  return [headPart, tailPart].filter(Boolean).join('…');
}

/** 数值趋势：仅用于展示方向，不判断好坏（docs/04 §5） */
export function fmtDelta(current: number, previous: number): { text: string; dir: 'up' | 'down' | 'flat' } {
  if (!Number.isFinite(current) || !Number.isFinite(previous) || previous === 0) {
    return { text: '—', dir: 'flat' };
  }
  const ratio = (current - previous) / previous;
  if (Math.abs(ratio) < 0.005) return { text: '持平', dir: 'flat' };
  const pct = `${Math.abs(ratio * 100).toFixed(0)}%`;
  return { text: ratio > 0 ? `▲ ${pct}` : `▼ ${pct}`, dir: ratio > 0 ? 'up' : 'down' };
}
