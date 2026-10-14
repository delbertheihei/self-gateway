/**
 * 请求明细页 + 详情抽屉（docs/04 §3.2 / §3.3）。
 *
 * 核心排查路径：筛选 → 表格 → 点行 → 抽屉（不离开列表，保留筛选项）。
 */

import { useMemo, useState } from 'react';
import { api, type RequestRow } from '../lib/api.ts';
import { useAsync, useDebounced } from '../lib/hooks.ts';
import { fmtTokens, fmtInt, fmtMs, fmtTime, fmtDateTime, fmtBytes, fmtCost, shortId } from '../lib/format.ts';
import { Card, Badge, Button, EmptyState, Skeleton, ErrorState, Segmented, Info } from '../components/ui.tsx';
import { IconInbox, IconFile } from '../components/icons.tsx';
import { Waterfall } from '../components/charts.tsx';
import { StatusBadge, UsageBadge } from './Overview.tsx';
import { RequestDrawer } from '../components/RequestDrawer.tsx';
import type { RangePreset } from '../components/shell.tsx';

interface Props {
  range: RangePreset;
  models: string[];
  openId: string | null;
  onOpen: (id: string | null) => void;
  refreshKey: number;
}

const PAGE = 50;

export function RequestsPage({ range, models, openId, onOpen, refreshKey }: Props) {
  const [model, setModel] = useState('');
  const [status, setStatus] = useState<'' | '2xx' | '4xx' | '5xx' | 'error'>('');
  const [usageSource, setUsageSource] = useState<'' | 'upstream' | 'estimated' | 'none'>('');
  const [minDuration, setMinDuration] = useState('');
  const [q, setQ] = useState('');
  const [orderBy, setOrderBy] = useState<'started_at' | 't_total' | 'total_tokens'>('started_at');
  const [order, setOrder] = useState<'asc' | 'desc'>('desc');
  const [pages, setPages] = useState<string[]>([]);   // cursor 栈
  const cursor = pages.length > 0 ? pages[pages.length - 1] : undefined;

  const debouncedQ = useDebounced(q, 350);

  const query = useMemo(() => ({
    range,
    ...(model ? { model } : {}),
    ...(status ? { status } : {}),
    ...(usageSource ? { usageSource } : {}),
    ...(minDuration && Number(minDuration) > 0 ? { minDuration: Number(minDuration) } : {}),
    ...(debouncedQ ? { q: debouncedQ } : {}),
    orderBy,
    order,
    limit: PAGE,
    ...(cursor ? { cursor } : {}),
  }), [range, model, status, usageSource, minDuration, debouncedQ, orderBy, order, cursor, refreshKey]);

  const res = useAsync(async () => api.requests(query), [JSON.stringify(query)], { pollMs: openId ? 0 : 6_000 });
  const page = res.data;
  const rows = page?.data ?? [];
  const notice = page?.notice;
  const hasFilter = Boolean(model || status || usageSource || minDuration || q);

  const resetPage = (): void => setPages([]);

  const toggleSort = (col: typeof orderBy): void => {
    if (orderBy === col) setOrder(order === 'desc' ? 'asc' : 'desc');
    else { setOrderBy(col); setOrder('desc'); }
    resetPage();
  };

  return (
    <div className="flex flex-col gap-4">
      {/* ── 筛选条 ── */}
      <Card padded={false}>
        <div className="flex flex-wrap items-center gap-2" style={{ padding: 'var(--sgw-space-3) var(--sgw-space-4)' }}>
          <select
            className="sgw-input" style={{ width: 150 }} value={model}
            onChange={(e) => { setModel(e.target.value); resetPage(); }}
            aria-label="模型筛选"
          >
            <option value="">全部模型</option>
            {models.map((m) => <option key={m} value={m}>{m}</option>)}
          </select>

          <select
            className="sgw-input" style={{ width: 130 }} value={status}
            onChange={(e) => { setStatus(e.target.value as typeof status); resetPage(); }}
            aria-label="状态筛选"
          >
            <option value="">全部状态</option>
            <option value="2xx">2xx 成功</option>
            <option value="4xx">4xx 客户端</option>
            <option value="5xx">5xx 服务端</option>
            <option value="error">全部失败</option>
          </select>

          <select
            className="sgw-input" style={{ width: 140 }} value={usageSource}
            onChange={(e) => { setUsageSource(e.target.value as typeof usageSource); resetPage(); }}
            aria-label="用量来源筛选"
          >
            <option value="">全部来源</option>
            <option value="upstream">精确（上游）</option>
            <option value="estimated">估算（本地）</option>
            <option value="none">无用量</option>
          </select>

          <input
            className="sgw-input" style={{ width: 110 }} inputMode="numeric" placeholder="耗时 > ms"
            value={minDuration} onChange={(e) => { setMinDuration(e.target.value.replace(/[^0-9]/g, '')); resetPage(); }}
            aria-label="最小耗时"
          />

          <div className="relative min-w-[180px] flex-1">
            <input
              className="sgw-input" placeholder="搜索 path / 模型 / request-id…"
              value={q} onChange={(e) => { setQ(e.target.value); resetPage(); }}
              aria-label="搜索"
            />
          </div>

          {hasFilter && (
            <Button size="sm" onClick={() => {
              setModel(''); setStatus(''); setUsageSource(''); setMinDuration(''); setQ(''); resetPage();
            }}>清除筛选</Button>
          )}

          <div className="ml-auto flex items-center gap-3 sgw-text-2xs text-tertiary">
            <span>共 <span className="tnum text-secondary">{fmtInt(page?.meta.totalApprox ?? 0)}</span> 条</span>
            <a
              className="text-link no-underline hover:underline"
              href={api.exportCsvUrl(range)}
              title="导出当前时间范围的明细为 CSV（含 BOM，Excel 可直接打开）"
            >导出 CSV</a>
          </div>
        </div>
      </Card>

      {/* ── 明细被关闭时的提示（关键：说明聚合仍在工作） ── */}
      {notice && (
        <div className="sgw-notice" data-tone="info">
          <strong>{notice.message}</strong>
          <div className="mt-1 opacity-90">{notice.hint} 概览页的 KPI 与趋势**不受影响**（聚合统计恒写）。</div>
        </div>
      )}

      {/* ── 表格 ── */}
      <Card padded={false}>
        {res.error ? (
          <div style={{ padding: 'var(--sgw-space-5)' }}><ErrorState error={res.error} onRetry={res.reload} /></div>
        ) : res.initial ? (
          <div style={{ padding: 'var(--sgw-space-5)' }}><Skeleton height={320} /></div>
        ) : rows.length === 0 ? (
          <EmptyState
            icon={<IconInbox />}
            title={hasFilter ? '没有匹配的请求' : '还没有请求记录'}
            description={hasFilter
              ? '试试放宽筛选条件或扩大时间范围。'
              : '把 Codex 的 base_url 指向网关后，请求会实时出现在这里。'}
          />
        ) : (
          <>
            <div style={{ overflowX: 'auto' }}>
              <table className="sgw-table">
                <thead>
                  <tr>
                    <SortTh active={orderBy === 'started_at'} order={order} onClick={() => toggleSort('started_at')} style={{ width: 96 }}>时间</SortTh>
                    <th>端点</th>
                    <th style={{ width: 140 }}>模型</th>
                    <th style={{ width: 104 }}>状态</th>
                    <SortTh active={orderBy === 't_total'} order={order} onClick={() => toggleSort('t_total')} style={{ width: 80 }}>耗时</SortTh>
                    <th style={{ width: 76 }}>TTFB</th>
                    <SortTh active={orderBy === 'total_tokens'} order={order} onClick={() => toggleSort('total_tokens')} style={{ width: 90 }}>Token</SortTh>
                    <th style={{ width: 96 }}>来源</th>
                    <th style={{ width: 60 }} />
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => (
                    <tr key={r.id} onClick={() => onOpen(r.id)} title={`完整时间：${fmtDateTime(r.startedAt)}`}>
                      <td className="mono sgw-text-2xs text-tertiary">{fmtTime(r.startedAt)}</td>
                      <td className="mono sgw-text-xs">
                        <span className="truncate">{r.path}</span>
                        {r.truncatedResponse && (
                          <span className="ml-1 sgw-text-2xs text-warn" title="响应体超过观测缓冲（512KB）：只解析了「头部 + 尾部」，中间段未解析。usage 只存在于流末尾的终止事件，因此**仍会被捕获**；转发字节完全未受影响。">✂</span>
                        )}
                      </td>
                      <td className="truncate sgw-text-xs" title={r.model ?? ''}>{r.model ?? '—'}</td>
                      <td><StatusBadge status={r.status} errorClass={r.errorClass} /></td>
                      <td className="tnum sgw-text-xs">{fmtMs(r.totalMs)}</td>
                      <td className="tnum sgw-text-xs text-tertiary">{r.ttfbMs !== null ? fmtMs(r.ttfbMs) : '—'}</td>
                      <td className="tnum sgw-text-xs" title={fmtInt(r.totalTokens)}>
                        {r.totalTokens > 0 ? fmtTokens(r.totalTokens) : '—'}
                      </td>
                      <td><UsageBadge source={r.usageSource} complete={r.usageComplete} /></td>
                      <td className="text-right">
                        {r.hasBody && (
                          <span className="text-accent" title="已保存正文" style={{ display: 'inline-flex', fontSize: 13, lineHeight: 1 }}>
                            <IconFile />
                          </span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {/* 分页：cursor（keyset）分页，避免大表 OFFSET 全扫 */}
            <div className="flex items-center justify-between border-t border-subtle"
              style={{ padding: 'var(--sgw-space-3) var(--sgw-space-4)' }}>
              <span className="sgw-text-2xs text-tertiary">
                第 {pages.length + 1} 页 · 每页 {PAGE} 条
                <Info title="使用 keyset（游标）分页：以 ULID 主键比较定位，避免 OFFSET 在百万行表上退化为全表扫描。" />
              </span>
              <div className="flex items-center gap-2">
                <Button size="sm" disabled={pages.length === 0}
                  onClick={() => setPages((p) => p.slice(0, -1))}>← 上一页</Button>
                <Button size="sm" disabled={!page?.meta.hasMore || !page?.meta.nextCursor}
                  onClick={() => setPages((p) => (page?.meta.nextCursor ? [...p, page.meta.nextCursor] : p))}>下一页 →</Button>
              </div>
            </div>
          </>
        )}
      </Card>

      {openId && (
        <RequestDrawer
          id={openId}
          onClose={() => onOpen(null)}
          models={models}
        />
      )}
    </div>
  );
}

function SortTh({
  children, active, order, onClick, style,
}: {
  children: React.ReactNode;
  active: boolean;
  order: 'asc' | 'desc';
  onClick: () => void;
  style?: React.CSSProperties;
}) {
  return (
    <th style={style}>
      <button
        type="button"
        onClick={onClick}
        className="inline-flex items-center gap-1 border-0 bg-transparent p-0 sgw-text-2xs uppercase tracking-wide"
        style={{ color: active ? 'var(--sgw-text-secondary)' : 'inherit', cursor: 'pointer', font: 'inherit' }}
      >
        {children}
        {active && <span aria-hidden>{order === 'desc' ? '↓' : '↑'}</span>}
      </button>
    </th>
  );
}
