/**
 * 概览页（docs/04 §3.1）。
 *
 * 信息密度排序刻意如此：**KPI → 趋势 → 构成 → 排行 → 最近请求**，
 * 保证"打开就能回答我今天花了多少"。
 */

import { useMemo, useState } from 'react';
import { api, type Summary, type TimeseriesPoint, type ModelBreakdown, type SessionBreakdown, type RequestRow } from '../lib/api.ts';
import { useAsync } from '../lib/hooks.ts';
import { fmtTokens, fmtInt, fmtCost, fmtPct, fmtMs, fmtTime, fmtCompact, shortId } from '../lib/format.ts';
import { Card, KpiCard, Badge, EmptyState, Skeleton, ErrorState, Button, Info } from '../components/ui.tsx';
import { IconChart, IconInbox, IconSessions } from '../components/icons.tsx';
import { StackedAreaChart, DonutChart, MiniBars, BarRow, vizVar, type Series } from '../components/charts.tsx';
import type { RangePreset } from '../components/shell.tsx';

interface Props {
  range: RangePreset;
  onOpenRequest: (id: string) => void;
  onGoRequests: () => void;
  refreshKey: number;
}

export function OverviewPage({ range, onOpenRequest, onGoRequests, refreshKey }: Props) {
  const [hoverIdx, setHoverIdx] = useState<number | null>(null);

  const summary = useAsync<Summary>(async () => (await api.summary(range)).data, [range, refreshKey], { pollMs: 15_000 });
  const seriesRes = useAsync<{ labels: number[]; points: TimeseriesPoint[]; bucket: 'hour' | 'day' }>(async () => {
    const r = await api.timeseries(range, 'auto', 'type');
    const points = Array.isArray(r.data) ? r.data : [];
    const bucket: 'hour' | 'day' = (range === '1h' || range === '24h') ? 'hour' : 'day';
    return { labels: points.map((p) => p.bucketStart), points, bucket };
  }, [range, refreshKey], { pollMs: 20_000 });
  const models = useAsync<ModelBreakdown[]>(async () => (await api.byModel(range, 8)).data, [range, refreshKey], { pollMs: 30_000 });
  const sessions = useAsync<SessionBreakdown[]>(async () => (await api.bySession(range, 6)).data, [range, refreshKey], { pollMs: 30_000 });
  const recent = useAsync<RequestRow[]>(async () => (await api.requests({ range, limit: 8 })).data, [range, refreshKey], { pollMs: 5_000 });

  const s = summary.data;
  const ts = seriesRes.data;
  const detailEnabled = !(recent.data === null && recent.error === null);

  const chartSeries: Series[] = useMemo(() => {
    if (!ts) return [];
    const pick = (k: keyof TimeseriesPoint, label: string, i: number): Series => ({
      key: k as string, label, colorVar: vizVar(i),
      values: ts.points.map((p) => Number(p[k] ?? 0)),
    });
    return [
      pick('inputTokens', 'Input', 0),
      pick('outputTokens', 'Output', 1),
      pick('cachedTokens', 'Cached', 2),
      pick('reasoningTokens', 'Reasoning', 3),
    ];
  }, [ts]);

  const donut = useMemo(() => {
    if (!s) return [];
    return [
      { key: 'in', label: 'Input（未缓存）', value: s.uncachedInput, color: vizVar(0) },
      { key: 'cached', label: 'Cached（缓存命中）', value: s.cachedTokens, color: vizVar(2) },
      { key: 'out', label: 'Output', value: Math.max(0, s.outputTokens - s.reasoningTokens), color: vizVar(1) },
      { key: 'reason', label: 'Reasoning（推理）', value: s.reasoningTokens, color: vizVar(3) },
    ].filter((x) => x.value > 0);
  }, [s]);

  if (summary.error) return <ErrorState error={summary.error} onRetry={summary.reload} />;

  const hoveredPoint = hoverIdx !== null ? ts?.points[hoverIdx] : null;
  const usageHint = s && s.estimatedCount > 0
    ? `其中 ${fmtInt(s.estimatedCount)} 次为本地估算（上游未返回 usage），误差约 ±5–15%`
    : '全部来自上游 usage，精确值';

  return (
    <div className="sgw-bento sgw-bento-page">
      {/* ── KPI（Bento 第一行：整行 12 跨列，内部自适应 6 列） ── */}
      <div className="sgw-span-12 sgw-kpi-grid">
        <KpiCard
          label={range === '1h' ? '近 1 小时 Token' : range === '24h' ? '近 24 小时 Token' : '区间 Token'}
          value={s ? fmtTokens(s.totalTokens) : '—'}
          hint={`Input + Output 合计。${usageHint}`}
          loading={summary.initial}
        />
        <KpiCard
          label="请求数"
          value={s ? fmtInt(s.requestCount) : '—'}
          hint="完成的 HTTP 交换数（含失败）"
          loading={summary.initial}
        />
        <KpiCard
          label="估算成本"
          value={s ? fmtCost(s.costUsd, s.costKnown) : '—'}
          hint={costHint(s)}
          loading={summary.initial}
        />
        <KpiCard
          label="失败率"
          value={s ? fmtPct(s.errorRate) : '—'}
          tone={s && s.errorRate > 0.05 ? 'warn' : 'neutral'}
          hint="状态码 ≥400 或发生错误的比例（客户端主动取消不计入）"
          loading={summary.initial}
        />
        <KpiCard
          label="TTFB p95"
          value={s ? fmtMs(s.latency.p95) : '—'}
          hint="收到请求 → 上游响应头。含上游排队时间"
          loading={summary.initial}
        />
        <KpiCard
          label="缓存命中率"
          value={s ? fmtPct(s.cacheHitRate) : '—'}
          hint={cacheHint(s)}
          loading={summary.initial}
        />
      </div>

      {/* ── 趋势 + 构成（Bento 主视觉行：8 + 4） ── */}
      <div className="sgw-span-8">
        <Card
          stretch
          title="Token 趋势"
          subtitle={hoveredPoint
            ? `${new Date(hoveredPoint.bucketStart).toLocaleString('zh-CN')} · ${fmtInt(hoveredPoint.requestCount)} 次请求 · ${fmtInt(hoveredPoint.totalTokens)} tokens`
            : `按${ts?.bucket === 'day' ? '天' : '小时'}聚合（鼠标悬停查看明细）`}
          actions={<Info title="输入/输出/缓存/推理四项堆叠。注意 reasoning 是 output 的子集，此处单独展示便于观察推理占比。" />}
        >
          {seriesRes.initial ? <Skeleton height={220} /> : chartSeries.length === 0 ? (
            <EmptyState icon="∿" title="还没有请求记录" description="把 Codex 指向网关后，数据会实时出现在这里。" />
          ) : (
            <StackedAreaChart
              labels={ts?.labels ?? []}
              series={chartSeries}
              bucket={ts?.bucket ?? 'hour'}
              onHoverIndex={setHoverIdx}
            />
          )}
        </Card>
      </div>

      <div className="sgw-span-4">
        <Card stretch title="Token 构成" subtitle="区间内的分项占比">
          {summary.initial ? <Skeleton height={148} /> : donut.length === 0 ? (
            <EmptyState icon={<IconChart />} title="暂无数据" />
          ) : (
            <DonutChart
              segments={donut}
              centerLabel="合计"
              centerValue={fmtTokens(s?.totalTokens ?? 0)}
            />
          )}
        </Card>
      </div>

      {/* ── 模型 + 会话 + 延迟（Bento 自定义行：4 + 4 + 4） ── */}
      <div className="sgw-span-4">
        <Card stretch title="模型分布" subtitle="按 token 排序">
          {models.initial ? <Skeleton height={120} /> : (models.data?.length ?? 0) === 0 ? (
            <EmptyState icon={<IconChart />} title="暂无模型数据" />
          ) : (
            <div className="flex flex-col gap-3">
              {models.data!.map((m, i) => (
                <BarRow
                  key={m.model}
                  label={m.model}
                  value={m.totalTokens}
                  display={`${fmtTokens(m.totalTokens)} · ${fmtCost(m.costUsd, m.costKnown)}`}
                  share={m.share}
                  color={vizVar(i)}
                  sublabel={`${fmtInt(m.requestCount)} 次 · p95 ${fmtMs(m.p95)}${m.errorCount > 0 ? ` · ${m.errorCount} 次失败` : ''}`}
                />
              ))}
            </div>
          )}
        </Card>
      </div>

      <div className="sgw-span-4">
        <Card stretch title="最活跃会话" subtitle="按 token 排序，Codex 的 session-id 归组">
          {sessions.initial ? <Skeleton height={120} /> : (sessions.data?.length ?? 0) === 0 ? (
            <EmptyState icon={<IconSessions />} title="暂无会话数据"
              description="会话来自 Codex 请求头里的 session-id；若为空说明尚未有请求经过网关。" />
          ) : (
            <div className="flex flex-col gap-3">
              {sessions.data!.map((x, i) => {
                const max = Math.max(...sessions.data!.map((y) => y.totalTokens), 1);
                return (
                  <BarRow
                    key={x.sessionId}
                    label={x.label}
                    value={x.totalTokens}
                    display={fmtTokens(x.totalTokens)}
                    share={x.totalTokens / max}
                    color={vizVar(i)}
                    sublabel={`${fmtInt(x.requestCount)} 次请求 · 最近 ${fmtTime(x.lastSeenAt)}`}
                  />
                );
              })}
            </div>
          )}
        </Card>
      </div>

      <div className="sgw-span-4">
        <Card stretch title="延迟分布" subtitle="总耗时（收到请求 → 响应结束）">
          {summary.initial ? <Skeleton height={100} /> : (
            <div className="flex flex-col gap-3">
              <div className="grid grid-cols-3 gap-2">
                {[['p50', s?.latency.p50], ['p95', s?.latency.p95], ['p99', s?.latency.p99]].map(([k, v]) => (
                  <div key={String(k)} className="sgw-slab">
                    <div className="sgw-label">{String(k)}</div>
                    <div className="tnum sgw-text-md font-semibold">{typeof v === 'number' ? fmtMs(v) : '—'}</div>
                  </div>
                ))}
              </div>
              <MiniBars buckets={s?.latency.buckets ?? []} height={56} />
              <div className="flex items-center justify-between sgw-text-2xs text-tertiary">
                <span>样本 {fmtInt(s?.latency.sampleCount ?? 0)} 次</span>
                <span className="inline-flex items-center gap-1">
                  分位为近似值 <Info title="分位基于固定分桶直方图（24 桶）在线性插值得到，精度受桶宽限制。这是为了把分位查询从 O(行数) 降到 O(桶数)。" />
                </span>
              </div>
            </div>
          )}
        </Card>
      </div>

      {/* ── 最近请求（Bento 收尾行：整行 12 跨列） ── */}
      <div className="sgw-span-12">
      <Card
        title="最近请求"
        subtitle={detailEnabled ? '最新的 8 条（实时刷新）' : undefined}
        padded={false}
        actions={<Button size="sm" onClick={onGoRequests}>查看全部 →</Button>}
      >
        {recent.initial ? (
          <div style={{ padding: 'var(--sgw-space-5)' }}><Skeleton height={140} /></div>
        ) : recent.error ? (
          <div style={{ padding: 'var(--sgw-space-5)' }}><ErrorState error={recent.error} onRetry={recent.reload} /></div>
        ) : (recent.data?.length ?? 0) === 0 ? (
          <EmptyState
            icon={<IconInbox />}
            title="还没有请求记录"
            description="如果刚关掉了「记录请求明细」，这里会为空 —— 但上方 KPI 与趋势仍然照常统计（聚合恒写）。"
            action={<Button onClick={onGoRequests}>去查看请求明细</Button>}
          />
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <table className="sgw-table">
              <thead>
                <tr>
                  <th style={{ width: 90 }}>时间</th>
                  <th>端点</th>
                  <th style={{ width: 130 }}>模型</th>
                  <th style={{ width: 80 }}>状态</th>
                  <th style={{ width: 80 }}>耗时</th>
                  <th style={{ width: 90 }}>Token</th>
                  <th style={{ width: 80 }}>来源</th>
                </tr>
              </thead>
              <tbody>
                {recent.data!.map((r) => (
                  <tr key={r.id} onClick={() => onOpenRequest(r.id)}>
                    <td className="mono sgw-text-2xs text-tertiary">{fmtTime(r.startedAt)}</td>
                    <td className="mono sgw-text-xs">{r.path}</td>
                    <td className="truncate sgw-text-xs" title={r.model ?? ''}>{r.model ?? '—'}</td>
                    <td><StatusBadge status={r.status} errorClass={r.errorClass} /></td>
                    <td className="tnum sgw-text-xs">{fmtMs(r.totalMs)}</td>
                    <td className="tnum sgw-text-xs">{r.totalTokens > 0 ? fmtCompact(r.totalTokens) : '—'}</td>
                    <td><UsageBadge source={r.usageSource} complete={r.usageComplete} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
      </div>
    </div>
  );
}

// ─────────────────────────────── 共用徽标 ───────────────────────────────

/**
 * 成本提示。
 *
 * ★ 这里解释的是"为什么金额可能是未知"：本地价格表按模型名匹配，
 *   中继改过名字的模型（默认表里没有）需要用户在设置页补价格。
 *   把口径说清楚比给一个假数字重要得多。
 */
function costHint(s: Summary | null): string {
  if (!s) return '按本地价格表估算，仅供参考；实际计费以公司账单为准';
  if (s.unpricedModels.length === 0) {
    return '按本地价格表实时计算（当前区间全部模型都有价格）；实际计费以公司账单为准';
  }
  const names = s.unpricedModels.slice(0, 3).join('、');
  const more = s.unpricedModels.length > 3 ? ` 等 ${s.unpricedModels.length} 个` : '';
  return `未配置价格的模型：${names}${more} —— 去「设置 → 价格表」补上后立即生效（不是 0 元，是未知）`;
}

/** 缓存命中率提示：把分母口径写清楚，否则用户会以为数字算错了 */
function cacheHint(s: Summary | null): string {
  const base = 'cached_tokens ÷ 缓存信息可信的 input_tokens；本地估算的请求缓存情况未知，已从分母剔除';
  if (!s || s.cacheKnownInput === 0) return `${base}（当前区间还没有上游返回 usage 的请求）`;
  return `${base}（分母 ${fmtCompact(s.cacheKnownInput)} tokens）`;
}

export function StatusBadge({ status, errorClass }: { status: number | null; errorClass: string | null }) {
  if (status === null) {
    return <Badge tone="danger" dot title={errorClass ?? '网络错误'}>{errorClass === 'client_aborted' ? '中断' : '错误'}</Badge>;
  }
  const tone = status < 300 ? 'ok' : status < 400 ? 'info' : status === 429 ? 'warn' : status < 500 ? 'danger' : 'danger';
  const text = status < 300 ? '成功' : status === 401 || status === 403 ? '鉴权' : status === 429 ? '限流' : status < 500 ? '客户端错误' : '服务端错误';
  return <Badge tone={tone} dot title={`HTTP ${status}${errorClass ? ` · ${errorClass}` : ''}`}>{status} {text}</Badge>;
}

export function UsageBadge({ source, complete }: { source: string; complete: boolean }) {
  if (source === 'upstream' && complete) {
    return <span className="sgw-text-2xs text-tertiary" title="上游返回了完整 usage，精确值">精确</span>;
  }
  if (source === 'upstream' && !complete) {
    return <Badge tone="danger" dashed title="上游 usage 缺字段 —— 这会让 Codex 本轮对话失败；网关已原样透传并记录告警">usage 不完整</Badge>;
  }
  if (source === 'estimated') {
    return <Badge tone="warn" dashed title="上游未返回 usage，本地按 tokenizer 启发式估算，误差约 ±5–15%">估算</Badge>;
  }
  return (
    <span className="sgw-text-2xs text-disabled"
      title="没有可用的用量数据：上游未返回 usage，且请求失败/无法估算（失败请求不会把请求体估算成 token）">—</span>
  );
}
