/**
 * 会话视图（docs/04 §3，P1）。
 *
 * 回答"哪个任务最烧 token"。会话来自 Codex 请求头的 `session-id`；
 * 缺失时记为"未归组"，**不硬猜**（docs/05 §8）。
 */

import { api, type SessionBreakdown, type RequestRow } from '../lib/api.ts';
import { useAsync } from '../lib/hooks.ts';
import { fmtTokens, fmtInt, fmtCost, fmtTime, shortId, fmtRelative } from '../lib/format.ts';
import { Card, EmptyState, Skeleton, ErrorState, Badge } from '../components/ui.tsx';
import { IconSessions, IconInbox } from '../components/icons.tsx';
import { BarRow, vizVar } from '../components/charts.tsx';
import { StatusBadge, UsageBadge } from './Overview.tsx';
import type { RangePreset } from '../components/shell.tsx';

export function SessionsPage({ range, onOpenRequest, refreshKey }: {
  range: RangePreset;
  onOpenRequest: (id: string) => void;
  refreshKey: number;
}) {
  const sessions = useAsync<SessionBreakdown[]>(
    async () => (await api.bySession(range, 50)).data, [range, refreshKey], { pollMs: 30_000 });

  return (
    <div className="flex flex-col" style={{ gap: 'var(--sgw-bento-page-gap)' }}>
      <Card
        title="会话排行"
        subtitle="按 token 降序。会话标识取自 Codex 请求头 session-id / thread-id"
      >
        {sessions.error ? <ErrorState error={sessions.error} onRetry={sessions.reload} />
          : sessions.initial ? <Skeleton height={240} />
            : (sessions.data?.length ?? 0) === 0 ? (
              <EmptyState
                icon={<IconSessions />}
                title="还没有会话数据"
                description="会话来自 Codex 请求头里的 session-id。如果 Codex 未发送该头，请求会被归入「未归组」而这里为空。"
              />
            ) : (
              <div className="flex flex-col gap-4">
                {sessions.data!.map((x, i) => {
                  const max = Math.max(...sessions.data!.map((y) => y.totalTokens), 1);
                  return (
                    <BarRow
                      key={x.sessionId}
                      label={x.label}
                      value={x.totalTokens}
                      display={`${fmtTokens(x.totalTokens)} · ${fmtCost(x.costUsd, x.costKnown)}`}
                      share={x.totalTokens / max}
                      color={vizVar(i)}
                      sublabel={`${fmtInt(x.requestCount)} 次请求 · 最近活动 ${fmtRelative(x.lastSeenAt)}`}
                    />
                  );
                })}
              </div>
            )}
      </Card>

      <SessionRequestList range={range} refreshKey={refreshKey} onOpenRequest={onOpenRequest} />
    </div>
  );
}

/** 未归组请求：明确显示而不是静默丢弃 */
function SessionRequestList({ range, refreshKey, onOpenRequest }: {
  range: RangePreset;
  refreshKey: number;
  onOpenRequest: (id: string) => void;
}) {
  const res = useAsync<RequestRow[]>(
    async () => (await api.requests({ range, limit: 30, orderBy: 't_total', order: 'desc' })).data,
    [range, refreshKey], { pollMs: 15_000 });

  return (
    <Card title="最慢的请求" subtitle="按总耗时降序 —— 用于定位「卡住的那几次」" padded={false}>
      {res.error ? <div style={{ padding: 'var(--sgw-space-5)' }}><ErrorState error={res.error} onRetry={res.reload} /></div>
        : res.initial ? <div style={{ padding: 'var(--sgw-space-5)' }}><Skeleton height={200} /></div>
          : (res.data?.length ?? 0) === 0 ? <EmptyState icon={<IconInbox />} title="暂无请求记录" /> : (
            <div style={{ overflowX: 'auto' }}>
              <table className="sgw-table">
                <thead>
                  <tr>
                    <th style={{ width: 90 }}>时间</th>
                    <th>端点</th>
                    <th style={{ width: 140 }}>模型</th>
                    <th style={{ width: 104 }}>状态</th>
                    <th style={{ width: 90 }}>耗时</th>
                    <th style={{ width: 130 }}>Token</th>
                    <th style={{ width: 96 }}>来源</th>
                    <th style={{ width: 150 }}>会话</th>
                  </tr>
                </thead>
                <tbody>
                  {res.data!.map((r) => (
                    <tr key={r.id} onClick={() => onOpenRequest(r.id)}>
                      <td className="mono sgw-text-2xs text-tertiary">{fmtTime(r.startedAt)}</td>
                      <td className="mono sgw-text-xs">{r.path}</td>
                      <td className="truncate sgw-text-xs">{r.model ?? '—'}</td>
                      <td><StatusBadge status={r.status} errorClass={r.errorClass} /></td>
                      <td className="tnum sgw-text-xs">{r.totalMs >= 1000 ? `${(r.totalMs / 1000).toFixed(2)}s` : `${Math.round(r.totalMs)}ms`}</td>
                      <td className="tnum sgw-text-xs">{fmtTokens(r.totalTokens)}</td>
                      <td><UsageBadge source={r.usageSource} complete={r.usageComplete} /></td>
                      <td className="whitespace-nowrap">
                        {r.sessionId
                          ? <span className="mono sgw-text-2xs text-tertiary" title={r.sessionId}>{shortId(r.sessionId, 8, 6)}</span>
                          : <Badge tone="neutral" dashed title="该请求没有可用的会话标识（Codex 未发送 session-id / thread-id）">未归组</Badge>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
    </Card>
  );
}
