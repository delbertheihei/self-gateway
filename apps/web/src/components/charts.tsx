/**
 * 图表组件 —— 手绘 SVG，零图表依赖。
 *
 * 为什么不用 Recharts/uPlot（docs/03 §5.2 的取舍）：
 *   v1 需要的是"堆叠面积趋势 + 环形占比 + 迷你柱状"三种基础图形，
 *   每种手绘约 60~80 行，且能完全掌控主题令牌（切主题时颜色自动跟随 CSS 变量）。
 *   代价：不支持 5 万点以上的密集时序。真需要时按 docs/03 引入 uPlot。
 *
 * 统一规范（docs/04 §5.1）：
 *   - 仅水平网格线
 *   - Y 轴 4 格、SI 缩写
 *   - tooltip 显示完整时间 + 各序列绝对值 + 合计
 *   - 颜色严格用 --sgw-viz-1..6，**禁止**按值动态改色
 */

import { useMemo, useRef, useState } from 'react';
import { fmtCompact, fmtAxisTime, fmtInt, fmtPct } from '../lib/format.ts';

export interface Series {
  key: string;
  label: string;
  colorVar: string;
  values: number[];
}

const VIZ = ['--sgw-viz-1', '--sgw-viz-2', '--sgw-viz-3', '--sgw-viz-4', '--sgw-viz-5', '--sgw-viz-6'];
export const vizVar = (i: number): string => `var(${VIZ[i % VIZ.length]})`;

// ─────────────────────────────── 堆叠面积图 ───────────────────────────────

export function StackedAreaChart({
  labels, series, height = 220, bucket = 'hour', onHoverIndex,
}: {
  labels: number[];
  series: Series[];
  height?: number;
  bucket?: 'hour' | 'day';
  onHoverIndex?: (i: number | null) => void;
}) {
  const [hover, setHover] = useState<number | null>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const pad = { top: 10, right: 8, bottom: 22, left: 44 };
  const W = 800;
  const H = height;
  const innerW = W - pad.left - pad.right;
  const innerH = H - pad.top - pad.bottom;

  const n = labels.length;
  const stacks = useMemo(() => {
    const totals = new Array(n).fill(0);
    for (const s of series) for (let i = 0; i < n; i++) totals[i] += s.values[i] ?? 0;
    return totals;
  }, [series, n]);

  const maxY = Math.max(1, ...stacks);
  // Y 轴取整到好看的刻度
  const step = niceStep(maxY / 4);
  const yMax = step * 4;
  const x = (i: number): number => (n <= 1 ? pad.left + innerW / 2 : pad.left + (i / (n - 1)) * innerW);
  const y = (v: number): number => pad.top + innerH - (v / yMax) * innerH;

  // 逐序列累加出堆叠基线
  const bands = useMemo(() => {
    const base = new Array(n).fill(0);
    return series.map((s) => {
      const lower = [...base];
      const upper = base.map((b, i) => b + (s.values[i] ?? 0));
      for (let i = 0; i < n; i++) base[i] = upper[i]!;
      return { series: s, lower, upper };
    });
  }, [series, n]);

  const areaPath = (lower: number[], upper: number[]): string => {
    if (n === 0) return '';
    let d = `M ${x(0)} ${y(upper[0] ?? 0)}`;
    for (let i = 1; i < n; i++) d += ` L ${x(i)} ${y(upper[i] ?? 0)}`;
    for (let i = n - 1; i >= 0; i--) d += ` L ${x(i)} ${y(lower[i] ?? 0)}`;
    return `${d} Z`;
  };

  const yTicks = [0, 1, 2, 3, 4].map((k) => k * step);
  const xTickIdx = pickTicks(n, 6);

  const onMove = (e: React.MouseEvent<SVGSVGElement>): void => {
    const rect = e.currentTarget.getBoundingClientRect();
    const px = ((e.clientX - rect.left) / rect.width) * W;
    const ratio = (px - pad.left) / innerW;
    const idx = Math.round(ratio * (n - 1));
    const clamped = Math.max(0, Math.min(n - 1, idx));
    setHover(clamped);
    onHoverIndex?.(clamped);
  };

  if (n === 0 || series.length === 0) {
    return <div className="flex items-center justify-center sgw-text-xs text-tertiary" style={{ height }}>暂无数据</div>;
  }

  return (
    <div ref={wrapRef} className="relative w-full">
      <svg
        viewBox={`0 0 ${W} ${H}`}
        width="100%"
        height={H}
        preserveAspectRatio="none"
        onMouseMove={onMove}
        onMouseLeave={() => { setHover(null); onHoverIndex?.(null); }}
        role="img"
        aria-label={`按${bucket === 'day' ? '天' : '小时'}的 token 趋势`}
      >
        {/* 水平网格 */}
        {yTicks.map((t) => (
          <line key={t} x1={pad.left} x2={W - pad.right} y1={y(t)} y2={y(t)}
            stroke="var(--sgw-viz-grid)" strokeWidth={1} vectorEffect="non-scaling-stroke" />
        ))}

        {/* 堆叠面积 */}
        {bands.map(({ series: s, lower, upper }, idx) => (
          <path key={s.key} d={areaPath(lower, upper)}
            fill={vizVar(series.findIndex((z) => z.key === s.key))}
            fillOpacity={0.22} stroke={vizVar(idx)} strokeWidth={1.6}
            strokeLinejoin="round" vectorEffect="non-scaling-stroke" />
        ))}

        {/* Y 轴刻度 */}
        {yTicks.map((t) => (
          <text key={`yt-${t}`} x={pad.left - 8} y={y(t) + 3} textAnchor="end"
            fontSize={10} fill="var(--sgw-text-tertiary)" style={{ fontVariantNumeric: 'tabular-nums' }}>
            {fmtCompact(t)}
          </text>
        ))}

        {/* X 轴刻度 */}
        {xTickIdx.map((i) => (
          <text key={`xt-${i}`} x={x(i)} y={H - 6} textAnchor="middle"
            fontSize={10} fill="var(--sgw-text-tertiary)" style={{ fontVariantNumeric: 'tabular-nums' }}>
            {fmtAxisTime(labels[i] ?? 0, bucket)}
          </text>
        ))}

        {/* hover 指示线 */}
        {hover !== null && (
          <>
            <line x1={x(hover)} x2={x(hover)} y1={pad.top} y2={pad.top + innerH}
              stroke="var(--sgw-border-strong)" strokeWidth={1} strokeDasharray="3 3" vectorEffect="non-scaling-stroke" />
            {bands.map(({ series: s, upper }, i) => (
              <circle key={s.key} cx={x(hover)} cy={y(upper[hover] ?? 0)} r={2.5}
                fill={vizVar(i)} stroke="var(--sgw-bg-surface)" strokeWidth={1.5} />
            ))}
          </>
        )}
      </svg>

      {/* 图例 */}
      <div className="mt-1 flex flex-wrap items-center gap-x-4 gap-y-1">
        {series.map((s, i) => (
          <span key={s.key} className="inline-flex items-center gap-1.5 sgw-text-2xs text-secondary">
            <span className="sgw-dot" style={{ background: vizVar(i) }} />
            {s.label}
          </span>
        ))}
      </div>

      {/* tooltip */}
      {hover !== null && (
        <div
          className="sgw-card sgw-edge sgw-glass-strong pointer-events-none absolute"
          style={{
            left: `${(x(hover) / W) * 100}%`,
            top: 4,
            transform: `translateX(${hover > n / 2 ? '-105%' : '5%'})`,
            padding: '8px 10px',
            minWidth: 150,
            borderRadius: 'var(--sgw-radius-md)',
            zIndex: 10,
          }}
        >
          <div className="mb-1 sgw-text-2xs text-tertiary">{new Date(labels[hover] ?? 0).toLocaleString('zh-CN')}</div>
          {series.map((s, i) => (
            <div key={s.key} className="flex items-center justify-between gap-3 sgw-text-2xs">
              <span className="inline-flex items-center gap-1 text-secondary">
                <span className="sgw-dot" style={{ background: vizVar(i) }} />{s.label}
              </span>
              <span className="tnum text-primary">{fmtInt(s.values[hover] ?? 0)}</span>
            </div>
          ))}
          <div className="mt-1 flex items-center justify-between gap-3 border-t border-subtle pt-1 sgw-text-2xs">
            <span className="text-tertiary">合计</span>
            <span className="tnum font-semibold text-primary">{fmtInt(stacks[hover] ?? 0)}</span>
          </div>
        </div>
      )}
    </div>
  );
}

// ─────────────────────────────── 环形占比 ───────────────────────────────

export function DonutChart({
  segments, size = 148, thickness = 16, centerLabel, centerValue,
}: {
  segments: Array<{ key: string; label: string; value: number; color: string }>;
  size?: number;
  thickness?: number;
  centerLabel?: string;
  centerValue?: string;
}) {
  const total = segments.reduce((n, s) => n + s.value, 0);
  const r = (size - thickness) / 2;
  const c = 2 * Math.PI * r;
  let offset = 0;

  if (total <= 0) {
    return <div className="flex items-center justify-center sgw-text-xs text-tertiary" style={{ height: size }}>暂无数据</div>;
  }

  return (
    <div className="flex items-center gap-5">
      <div className="relative flex-none" style={{ width: size, height: size }}>
        <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} role="img" aria-label="token 构成占比">
          <g transform={`rotate(-90 ${size / 2} ${size / 2})`}>
            {segments.map((s) => {
              const frac = s.value / total;
              const dash = frac * c;
              const el = (
                <circle
                  key={s.key}
                  cx={size / 2} cy={size / 2} r={r}
                  fill="none" stroke={s.color} strokeWidth={thickness}
                  strokeDasharray={`${dash} ${c - dash}`}
                  strokeDashoffset={-offset}
                  strokeLinecap="butt"
                />
              );
              offset += dash;
              return el;
            })}
          </g>
        </svg>
        <div className="absolute inset-0 flex flex-col items-center justify-center">
          <div className="sgw-text-2xs text-tertiary">{centerLabel}</div>
          <div className="tnum sgw-text-lg font-bold text-primary">{centerValue}</div>
        </div>
      </div>
      <ul className="m-0 min-w-0 flex-1 list-none space-y-1.5 p-0">
        {segments.map((s) => (
          <li key={s.key} className="flex items-center justify-between gap-3 sgw-text-xs">
            <span className="inline-flex min-w-0 items-center gap-1.5 text-secondary">
              <span className="sgw-dot" style={{ background: s.color }} />
              <span className="truncate">{s.label}</span>
            </span>
            <span className="flex flex-none items-baseline gap-2">
              <span className="tnum text-primary">{fmtCompact(s.value)}</span>
              <span className="tnum w-10 text-right text-tertiary">{fmtPct(s.value / total, 1)}</span>
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

// ─────────────────────────────── 迷你柱状（延迟分布）───────────────────────────────

export function MiniBars({
  buckets, height = 64, accentLast = true,
}: {
  buckets: Array<{ from: number; to: number; count: number }>;
  height?: number;
  accentLast?: boolean;
}) {
  const max = Math.max(1, ...buckets.map((b) => b.count));
  const total = buckets.reduce((n, b) => n + b.count, 0);
  if (total === 0) {
    return <div className="flex items-center justify-center sgw-text-2xs text-tertiary" style={{ height }}>暂无延迟样本</div>;
  }
  return (
    <div className="flex items-end gap-[2px]" style={{ height }}>
      {buckets.map((b, i) => {
        const h = Math.max(2, (b.count / max) * height);
        return (
          <div
            key={`${b.from}-${b.to}`}
            title={`${b.from}–${b.to}ms：${fmtInt(b.count)} 次（${fmtPct(b.count / total, 1)}）`}
            style={{
              flex: 1,
              height: h,
              background: accentLast && i >= buckets.length - 3 ? 'var(--sgw-accent)' : 'var(--sgw-viz-2)',
              opacity: 0.55 + 0.45 * (b.count / max),
              borderRadius: 2,
              minWidth: 2,
            }}
          />
        );
      })}
    </div>
  );
}

// ─────────────────────────────── 横向条形（排行）───────────────────────────────

export function BarRow({
  label, value, display, share, color, sublabel, onClick,
}: {
  label: string;
  value: number;
  display: string;
  share: number;
  color: string;
  sublabel?: string;
  onClick?: () => void;
}) {
  return (
    <div
      className={`group ${onClick ? 'cursor-pointer' : ''}`}
      onClick={onClick}
      role={onClick ? 'button' : undefined}
      tabIndex={onClick ? 0 : undefined}
      onKeyDown={onClick ? (e) => { if (e.key === 'Enter') onClick(); } : undefined}
    >
      <div className="flex items-baseline justify-between gap-3 sgw-text-xs">
        <span className="min-w-0 truncate text-primary" title={label}>{label}</span>
        <span className="flex-none tnum text-secondary">{display}</span>
      </div>
      <div className="mt-1.5 h-1.5 w-full overflow-hidden rounded-full" style={{ background: 'var(--sgw-bg-inset-strong)' }}>
        <div className="h-full rounded-full transition-all" style={{ width: `${Math.max(1, share * 100)}%`, background: color }} />
      </div>
      {sublabel && <div className="mt-0.5 sgw-text-2xs text-tertiary">{sublabel}</div>}
    </div>
  );
}

// ─────────────────────────────── 瀑布图（详情抽屉）───────────────────────────────

export interface WaterfallSegment {
  label: string;
  ms: number;
  color: string;
  title?: string;
}

export function Waterfall({ segments, totalMs }: { segments: WaterfallSegment[]; totalMs: number }) {
  const total = Math.max(1, totalMs);
  const filled = segments.reduce((n, s) => n + Math.max(0, s.ms), 0);
  const idle = Math.max(0, total - filled);
  return (
    <div>
      <div className="flex h-3.5 w-full overflow-hidden rounded-full" style={{ background: 'var(--sgw-bg-inset-strong)' }}>
        {segments.map((s) => (
          <div
            key={s.label}
            title={s.title ?? `${s.label}：${s.ms.toFixed(1)}ms`}
            style={{ width: `${(Math.max(0, s.ms) / total) * 100}%`, background: s.color, minWidth: s.ms > 0 ? 2 : 0 }}
          />
        ))}
        {idle > 0.5 && <div title={`其他/空闲：${idle.toFixed(1)}ms`} style={{ width: `${(idle / total) * 100}%`, background: 'var(--sgw-border-default)', opacity: 0.5 }} />}
      </div>
      <ul className="m-0 mt-3 list-none space-y-1.5 p-0">
        {segments.map((s) => (
          <li key={s.label} className="flex items-center justify-between gap-3 sgw-text-xs">
            <span className="inline-flex items-center gap-2 text-secondary">
              <span className="sgw-dot" style={{ background: s.color }} />
              {s.label}
            </span>
            <span className="tnum text-primary">{s.ms < 1 ? '<1ms' : `${s.ms.toFixed(s.ms < 100 ? 1 : 0)}ms`}</span>
          </li>
        ))}
        {idle > 0.5 && (
          <li className="flex items-center justify-between gap-3 sgw-text-xs">
            <span className="inline-flex items-center gap-2 text-tertiary">
              <span className="sgw-dot" style={{ background: 'var(--sgw-border-default)' }} />
              其他 / 空闲
            </span>
            <span className="tnum text-tertiary">{idle.toFixed(0)}ms</span>
          </li>
        )}
      </ul>
    </div>
  );
}

// ─────────────────────────────── 工具 ───────────────────────────────

/** 把最大值拆成好看的刻度步长（1/2/5 × 10^n） */
function niceStep(raw: number): number {
  if (!Number.isFinite(raw) || raw <= 0) return 1;
  const exp = Math.floor(Math.log10(raw));
  const base = 10 ** exp;
  const norm = raw / base;
  const mult = norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 5 ? 5 : 10;
  return mult * base;
}

/** 从 n 个点里挑最多 k 个刻度下标（含首尾） */
function pickTicks(n: number, k: number): number[] {
  if (n <= 1) return n === 1 ? [0] : [];
  if (n <= k) return Array.from({ length: n }, (_, i) => i);
  const out: number[] = [];
  const stride = (n - 1) / (k - 1);
  for (let i = 0; i < k; i++) out.push(Math.round(i * stride));
  return [...new Set(out)];
}
