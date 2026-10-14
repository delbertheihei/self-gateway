/**
 * 请求详情抽屉（docs/04 §3.3）。
 *
 * 用抽屉而非跳转页面，是为了**不丢失列表上下文**（筛选项、滚动位置）。
 * 内容分四块：耗时瀑布 → Token 明细 → 元数据 → 正文（默认隐藏）。
 */

import { useEffect, useState } from 'react';
import { api, ApiError, type RequestRow } from '../lib/api.ts';
import { useAsync } from '../lib/hooks.ts';
import { fmtDateTime, fmtInt, fmtMs, fmtBytes, fmtCost, fmtTokens, shortId } from '../lib/format.ts';
import { Button, Badge, Skeleton, ErrorState, Info } from './ui.tsx';
import { IconClose } from './icons.tsx';
import { Waterfall, vizVar } from './charts.tsx';
import { StatusBadge, UsageBadge } from '../pages/Overview.tsx';

interface Props {
  id: string;
  onClose: () => void;
  models: string[];
}

export function RequestDrawer({ id, onClose, models }: Props) {
  const [showReq, setShowReq] = useState(false);
  const [showRes, setShowRes] = useState(false);
  const [copied, setCopied] = useState<string | null>(null);

  const res = useAsync<RequestRow & Record<string, unknown>>(
    async () => (await api.request(id)).data, [id],
  );
  const r = res.data;

  // Esc 关闭
  useEffect(() => {
    const on = (e: KeyboardEvent): void => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', on);
    return () => window.removeEventListener('keydown', on);
  }, [onClose]);

  const copy = async (label: string, text: string): Promise<void> => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(label);
      setTimeout(() => setCopied(null), 1200);
    } catch { /* 剪贴板不可用时忽略 */ }
  };

  return (
    <>
      {/* 遮罩：玻璃模糊让"上下文还在、但被推远"这件事可感知 */}
      <div
        onClick={onClose}
        aria-hidden
        className="sgw-overlay-enter"
        style={{
          position: 'fixed', inset: 0,
          background: 'var(--sgw-bg-overlay)',
          WebkitBackdropFilter: 'blur(3px)',
          backdropFilter: 'blur(3px)',
          zIndex: 'var(--sgw-z-drawer)' as unknown as number,
        }}
      />
      {/* 抽屉 */}
      <aside
        role="dialog"
        aria-modal="true"
        aria-label="请求详情"
        className="sgw-drawer-enter sgw-glass-strong sgw-edge flex flex-col"
        style={{
          position: 'fixed', top: 'var(--sgw-shell-gap)', right: 'var(--sgw-shell-gap)', bottom: 'var(--sgw-shell-gap)',
          width: 'min(var(--sgw-drawer-width), 94vw)',
          border: '1px solid var(--sgw-border-default)',
          borderRadius: 'var(--sgw-radius-xl)',
          boxShadow: 'var(--sgw-shadow-lg)',
          overflow: 'hidden',
          zIndex: 'var(--sgw-z-drawer)' as unknown as number,
        }}
      >
        <header className="flex flex-none items-start justify-between gap-3 border-b border-subtle"
          style={{ padding: 'var(--sgw-space-4) var(--sgw-space-5)' }}>
          <div className="min-w-0">
            <div className="mono truncate sgw-text-md font-semibold" title={r?.path}>{r?.path ?? '加载中…'}</div>
            <div className="mt-1 flex flex-wrap items-center gap-2">
              {r && <StatusBadge status={r.status} errorClass={r.errorClass} />}
              {r && <Badge tone="neutral">{r.model ?? '未知模型'}</Badge>}
              {r && <UsageBadge source={r.usageSource} complete={r.usageComplete} />}
              {r && <span className="sgw-text-2xs text-tertiary">{fmtDateTime(r.startedAt)}</span>}
            </div>
          </div>
          <Button variant="ghost" size="sm" onClick={onClose} title="关闭（Esc）" >
            <span aria-hidden style={{ display: 'inline-flex', fontSize: 14, lineHeight: 1 }}><IconClose /></span>
            <span className="sr-only">关闭（Esc）</span>
          </Button>
        </header>

        <div className="flex-1 overflow-y-auto" style={{ padding: 'var(--sgw-space-5)' }}>
          {res.error ? <ErrorState error={res.error} onRetry={res.reload} />
            : res.initial || !r ? <div className="flex flex-col gap-3"><Skeleton height={80} /><Skeleton height={120} /><Skeleton height={80} /></div>
              : (
                <div className="flex flex-col gap-5">
                  {/* ── 耗时瀑布 ── */}
                  <Section title="耗时瀑布" info="把一次交换拆成可归因的几段。若「首字节」占比很高，说明大部分时间在等上游（多为上游排队或模型推理），而不是网关。">
                    <Waterfall
                      totalMs={r.totalMs}
                      segments={[
                        { label: '上游建连', ms: num(r.tUpstreamConnect) ?? 0, color: 'var(--sgw-border-strong)', title: 'TCP/TLS 建连耗时（复用连接时接近 0）' },
                        { label: '等待首字节 (TTFB)', ms: Math.max(0, (num(r.tUpstreamHeaders) ?? 0) - (num(r.tUpstreamConnect) ?? 0)), color: vizVar(2), title: '含上游排队与模型首 token 时间' },
                        { label: '首 Token 等待', ms: Math.max(0, (num(r.tFirstToken) ?? 0) - (num(r.tUpstreamHeaders) ?? 0)), color: vizVar(3), title: '收到响应头 → 第一个文本增量' },
                        { label: '流式生成', ms: Math.max(0, r.totalMs - (num(r.tFirstToken) ?? 0)), color: vizVar(0), title: '首个 token → 响应结束（与输出长度正相关）' },
                      ]}
                    />
                    <div className="mt-3 grid grid-cols-2 gap-2 sgw-text-xs">
                      <KV k="总耗时" v={fmtMs(r.totalMs)} />
                      <KV k="响应体字节" v={fmtBytes(r.bytesOut)} />
                    </div>
                  </Section>

                  {/* ── Token ── */}
                  <Section title="Token 明细" info="来源标记很关键：只有「精确」来自上游 usage；「估算」是本地启发式，误差约 ±5–15%。失败请求（HTTP ≥ 400）不产生用量，因此不估算 —— 否则会把从未发生的 token 记进账本、并拖低缓存命中率。">
                    <div className="grid grid-cols-2 gap-2">
                      <KV k="Input" v={fmtInt(r.inputTokens)} mono />
                      <KV k="Output" v={fmtInt(r.outputTokens)} mono />
                      <KV k="缓存命中 (cached)" v={fmtInt(r.cachedTokens)} mono
                        hint="input_tokens_details.cached_tokens，通常有折扣" />
                      <KV k="缓存写入 (cache_write)" v={fmtInt(num(r.cacheWriteTokens) ?? 0)} mono
                        hint="input_tokens_details.cache_write_tokens" />
                      <KV k="推理 (reasoning)" v={fmtInt(r.reasoningTokens)} mono
                        hint="output_tokens_details.reasoning_tokens，是 output 的子集，不重复计入 total" />
                      <KV k="合计 (total)" v={fmtInt(r.totalTokens)} mono />
                    </div>

                    <div className="mt-3 flex flex-wrap items-center gap-3 border-t border-subtle pt-3 sgw-text-xs">
                      <span className="inline-flex items-center gap-1 text-tertiary">
                        来源
                        <UsageBadge source={r.usageSource} complete={r.usageComplete} />
                      </span>
                      {typeof r.estimator === 'string' && <span className="sgw-text-2xs text-tertiary">估算器：{r.estimator}</span>}
                      <span className="inline-flex items-center gap-1 text-tertiary">
                        估算成本
                        <span className="tnum text-primary">{fmtCost(r.costUsd, r.costUsd !== null)}</span>
                        <Info title="按当前价格表实时计算（价格可在设置页调整，改完历史记录也同步更新）。「—」表示该模型没有价格，不是 0 元。实际计费以公司账单为准。" />
                      </span>
                    </div>

                    {!r.usageComplete && (
                      <div className="sgw-notice mt-3" data-tone="danger">
                        ⛔ 上游返回的 usage 缺字段 —— 这会让 Codex 本轮对话直接失败。
                        网关已**原样透传**并记录告警（不修改字节）。请把此记录反馈给中继管理员。
                      </div>
                    )}
                  </Section>

                  {/* ── 元数据 ── */}
                  <Section title="元数据">
                    <div className="grid gap-2">
                      <MetaRow k="x-request-id" v={r.upstreamRequestId} onCopy={copy} copied={copied} />
                      <MetaRow k="response.id" v={r.responseId} onCopy={copy} copied={copied} />
                      <MetaRow k="Key 指纹" v={typeof r.keyFingerprint === 'string' ? r.keyFingerprint : null}
                        hint="sha256(Authorization) 前 8 位。网关永不保存明文密钥" />
                      <MetaRow k="会话" v={r.sessionId} onCopy={copy} copied={copied} />
                      <MetaRow k="线程" v={r.threadId} onCopy={copy} copied={copied} />
                      <MetaRow k="originator" v={r.originator}
                        hint="Codex 客户端标识（codex_cli_rs / codex_vscode / …），决定中继是否认它为官方客户端" />
                      <MetaRow k="子代理" v={typeof r.codexSubagent === 'string' ? r.codexSubagent : null} />
                      <MetaRow k="请求体字节" v={fmtBytes(r.bytesIn)} />
                      <MetaRow k="响应形态" v={r.observeShape}
                        hint="观测判定：sse / json / binary / empty。binary 与 empty 本来就不可能带 usage；若 sse 却没有 usage，说明上游没发终止事件。" />
                      {r.observeNote && <MetaRow k="观测说明" v={r.observeNote} />}
                      <MetaRow k="记录日期" v={typeof r.createdDay === 'string' ? r.createdDay : null} />
                    </div>
                  </Section>

                  {/* ── 正文 ── */}
                  <Section title="正文" info="默认隐藏且需显式开启记录。正文可能含代码、密钥与个人信息，仅保存在本机 data/bodies/ 目录。">
                    {!r.hasBody ? (
                      <div className="sgw-notice text-tertiary">
                        这条记录没有保存正文。<br />
                        原因可能是：①「记录请求/响应正文」当时未开启；② 正文已被清理任务删除。
                        <div className="mt-2">
                          <Hint text="正文记录依赖「记录明细」。两者都在设置页开启后，**新请求**才会带正文。" />
                        </div>
                      </div>
                    ) : (
                      <div className="flex flex-col gap-3">
                        <div className="flex items-center gap-2">
                          <Button size="sm" onClick={() => setShowReq((v) => !v)}>{showReq ? '隐藏' : '显示'}请求正文</Button>
                          <Button size="sm" onClick={() => setShowRes((v) => !v)}>{showRes ? '隐藏' : '显示'}响应正文</Button>
                          <span className="sgw-text-2xs text-tertiary">{fmtBytes(r.bodyBytes)}</span>
                        </div>
                        {showReq && <BodyView id={id} side="request" />}
                        {showRes && <BodyView id={id} side="response" />}
                      </div>
                    )}
                  </Section>

                  {/* ── 操作 ── */}
                  <Section title="操作">
                    <div className="flex flex-wrap gap-2">
                      <Button size="sm" onClick={() => copy('json', JSON.stringify(r, null, 2))}>
                        {copied === 'json' ? '✓ 已复制' : '复制 JSON'}
                      </Button>
                      <Button size="sm" onClick={() => copy('curl', toCurl(r))}>
                        {copied === 'curl' ? '✓ 已复制' : '复制为 cURL'}
                      </Button>
                      <a className="sgw-btn" style={{ height: 26, fontSize: 'var(--sgw-text-xs)' }}
                        href={api.exportCsvUrl('30d')}>导出 CSV</a>
                    </div>
                  </Section>
                </div>
              )}
        </div>
      </aside>
    </>
  );
}

// ─────────────────────────────── 子组件 ───────────────────────────────

function Section({ title, info, children }: { title: string; info?: string; children: React.ReactNode }) {
  return (
    <section>
      <h3 className="sgw-label mb-2 flex items-center gap-1.5">
        {title}
        {info && <Info title={info} />}
      </h3>
      {children}
    </section>
  );
}

function KV({ k, v, mono, hint }: { k: string; v: string; mono?: boolean; hint?: string }) {
  return (
    <div className="sgw-slab">
      <div className="sgw-label flex items-center gap-1">
        {k}{hint && <Info title={hint} />}
      </div>
      <div className={`${mono ? 'tnum' : ''} sgw-text-sm text-primary`}>{v}</div>
    </div>
  );
}

function MetaRow({
  k, v, hint, onCopy, copied,
}: { k: string; v: string | null; hint?: string; onCopy?: (l: string, t: string) => void; copied?: string | null }) {
  if (!v) {
    return (
      <div className="flex items-baseline justify-between gap-3 sgw-text-xs">
        <span className="flex items-center gap-1 text-tertiary">{k}{hint && <Info title={hint} />}</span>
        <span className="text-disabled">—</span>
      </div>
    );
  }
  return (
    <div className="flex items-baseline justify-between gap-3 sgw-text-xs">
      <span className="flex flex-none items-center gap-1 text-tertiary">{k}{hint && <Info title={hint} />}</span>
      <span className="flex min-w-0 items-center gap-2">
        <span className="mono truncate text-primary" title={v}>{shortId(v, 16, 6)}</span>
        {onCopy && (
          <button
            type="button"
            onClick={() => onCopy(k, v)}
            className="flex-none border-0 bg-transparent p-0 sgw-text-2xs text-link"
            style={{ cursor: 'pointer' }}
            title={`复制完整值：${v}`}
          >
            {copied === k ? '✓' : '复制'}
          </button>
        )}
      </span>
    </div>
  );
}

function BodyView({ id, side }: { id: string; side: 'request' | 'response' }) {
  const res = useAsync(async () => api.requestBody(id, side), [id, side]);
  if (res.error) {
    const e = res.error as ApiError;
    return (
      <div className="sgw-notice" data-tone="warn">
        <div className="text-warn">{e.message}</div>
        {e.hint && <div className="mt-1 text-tertiary">{e.hint}</div>}
      </div>
    );
  }
  if (res.initial || !res.data) return <Skeleton height={120} />;
  const text = typeof res.data.data.raw === 'string'
    ? res.data.data.raw
    : JSON.stringify(res.data.data.raw, null, 2);
  return (
    <div>
      <div className="mb-1 flex items-center justify-between sgw-text-2xs text-tertiary">
        <span>
          {side === 'request' ? '请求正文' : '响应正文'} · {fmtBytes(res.data.data.bytes)}
          {res.data.data.truncated && <span className="ml-1 text-warn">（观测侧截断）</span>}
        </span>
        <span className="text-warn">⚠ {res.data.warning}</span>
      </div>
      <pre
        className="mono sgw-code"
        style={{
          maxHeight: 420, borderRadius: 'var(--sgw-radius-md)',
          whiteSpace: 'pre-wrap', wordBreak: 'break-all',
        }}
      >{text}</pre>
    </div>
  );
}

function Hint({ text }: { text: string }) {
  return <span className="sgw-text-2xs text-tertiary">{text.split('**').map((p, i) => (i % 2 === 1 ? <strong key={i}>{p}</strong> : p))}</span>;
}

function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

/** 生成一个"可复现但**不含密钥**"的 cURL 片段 */
function toCurl(r: RequestRow & Record<string, unknown>): string {
  const q = typeof r.query === 'string' && r.query ? r.query : '';
  const origin = window.location.origin.replace(/\/_sgw.*$/, '');
  return [
    `curl -N -X ${r.method} 'http://127.0.0.1:8787${r.path}${q}' \\`,
    `  -H 'content-type: application/json' \\`,
    `  -H 'originator: codex_cli_rs' \\`,
    `  -H 'authorization: Bearer $YOUR_API_KEY' \\`,
    `  --data-binary @request.json`,
    '',
    `# 注意：网关不保存明文 Authorization（只存指纹），因此这里用占位符。`,
    `# 网关地址：${origin}`,
  ].join('\n');
}
