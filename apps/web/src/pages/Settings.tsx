/**
 * 设置页（docs/04 §3.4）。
 *
 * 承载四类东西：
 *   1. **双开关**（明细 / 正文）—— 带隐私警示，且正文依赖明细
 *   2. 保留策略与一键清理（明确说明"聚合不会被删，KPI 不归零"）
 *   3. 上游与**互操作自检**（usage 契约、WebSocket、路径前缀）
 *   4. 透传自检 + 价格表 + Codex 接入/回滚指引
 *
 * 注意：**主题（外观）切换不在本页** —— v3 起它是随时要改的全局偏好，入口在顶栏最右侧
 * （`components/shell.tsx` 的 `ThemePicker`，见 docs/04 §4.9）。
 */

import { useEffect, useState } from 'react';
import {
  api, type SettingsPayload, type Meta, type Health, type SelfTestReport, type ContractProbe, type PriceRow,
} from '../lib/api.ts';
import { useAsync, type Toast } from '../lib/hooks.ts';
import { fmtBytes, fmtDateTime, fmtRelative, fmtInt, fmtUptime, fmtMs } from '../lib/format.ts';
import { Card, Button, Switch, Badge, Skeleton, ErrorState, Info, Segmented } from '../components/ui.tsx';

interface Props {
  health: Health | null;
  refreshKey: number;
  reloadAll: () => void;
  toast: (kind: Toast['kind'], text: string) => void;
}

export function SettingsPage({ health, refreshKey, reloadAll, toast }: Props) {
  const settings = useAsync<SettingsPayload>(async () => (await api.settings()).data, [refreshKey]);
  const meta = useAsync<Meta>(async () => (await api.meta()).data, [refreshKey], { pollMs: 30_000 });

  const [saving, setSaving] = useState(false);
  const [selftest, setSelftest] = useState<SelfTestReport | null>(null);
  const [runningTest, setRunningTest] = useState(false);
  const [probe, setProbe] = useState<ContractProbe | null>(null);
  const [purgeConfirm, setPurgeConfirm] = useState<'detail' | 'bodies' | 'all' | null>(null);

  const patch = async (body: unknown, okText: string): Promise<void> => {
    setSaving(true);
    try {
      await api.patchSettings(body);
      toast('ok', okText);
      settings.reload();
      meta.reload();
      reloadAll();
    } catch (e) {
      toast('error', (e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const runSelftest = async (): Promise<void> => {
    setRunningTest(true);
    try {
      const r = await api.selftest();
      setSelftest(r.data);
      toast(r.data.failed === 0 ? 'ok' : 'warn', r.data.summary);
    } catch (e) {
      toast('error', (e as Error).message);
    } finally {
      setRunningTest(false);
    }
  };

  const runProbe = async (): Promise<void> => {
    setRunningTest(true);
    try {
      const r = await api.upstreamTest();
      setProbe(r.data);
      toast(r.data.complete === false ? 'error' : 'ok', r.data.note ?? 'usage 契约检查完成');
      reloadAll();
    } catch (e) {
      toast('error', (e as Error).message);
    } finally {
      setRunningTest(false); }
  };

  if (settings.error) return <ErrorState error={settings.error} onRetry={settings.reload} />;
  if (settings.initial || !settings.data) return <div className="flex flex-col gap-4"><Skeleton height={200} /><Skeleton height={200} /></div>;

  const s = settings.data;
  const m = meta.data;
  const uc = health?.usageContract;
  const u = s.upstream;
  /**
   * 该值是否来自运行期设置（SQLite），而不是 sgw.config.ts。
   *
   * ★ 防御性读取：正在运行的**旧进程**不会返回 `overrides`，此时按"来自配置文件"显示，
   *   不会白屏（新前端 + 旧进程可以共存）。
   */
  const overrides = new Set(u.overrides ?? []);
  const fromRuntime = (key: string): boolean => overrides.has(key);

  return (
    <div className="sgw-bento sgw-bento-page">
      {/* ══════════ 记录设置 ══════════ */}
      <div className="sgw-span-6">
      <Card
        stretch
        title="记录设置"
        subtitle="关掉明细后 KPI 与趋势照常工作 —— 聚合统计永远在写"
      >
        <div className="flex flex-col gap-5">
          <Switch
            checked={s.logging.detailEnabled}
            disabled={saving}
            onChange={(v) => void patch({ logging: { detailEnabled: v } }, v ? '已开启请求明细记录' : '已关闭请求明细记录（聚合继续统计）')}
            label="记录请求明细"
            hint="逐请求的元数据：时间、模型、状态、耗时、token 数。不含正文。"
          />
          <div className="border-t border-subtle" />
          <div>
            <Switch
              checked={s.logging.bodyEnabled}
              disabled={saving || !s.logging.detailEnabled}
              onChange={(v) => void patch({ logging: { detailEnabled: true, bodyEnabled: v } }, v ? '已开启正文记录' : '已关闭正文记录')}
              label="记录请求 / 响应正文"
              hint={s.logging.detailEnabled
                ? '正文可能包含代码、密钥与个人信息，仅保存在本机 data/bodies/ 目录。'
                : '需先开启「记录请求明细」。'}
            />
            {s.logging.bodyEnabled && (
              <div className="sgw-notice mt-3" data-tone="warn">
                ⚠ 正文正在落盘。它可能包含 API Key、代码片段与个人信息。默认保留 {s.retention.bodyDays} 天，可随时一键清理。
                请勿把 <code>data/</code> 目录提交到版本库（<code>.gitignore</code> 已覆盖）。
              </div>
            )}
          </div>
        </div>
      </Card>
      </div>

      {/* ══════════ 保留与清理 ══════════ */}
      <div className="sgw-span-6">
      <Card stretch title="数据保留与清理" subtitle="清理只删明细与正文，**聚合统计不会被删**（KPI 不归零）">
        <div className="flex flex-col gap-4">
          <div className="grid grid-cols-2 gap-3">
            <NumField label="明细保留（天）" value={s.retention.detailDays} min={0} max={3650}
              onCommit={(v) => void patch({ retention: { detailDays: v } }, `明细保留改为 ${v} 天`)} />
            <NumField label="正文保留（天）" value={s.retention.bodyDays} min={0} max={3650}
              onCommit={(v) => void patch({ retention: { bodyDays: v } }, `正文保留改为 ${v} 天`)} />
            <NumField label="容量上限（GB）" value={Math.round(s.retention.maxDbBytes / 1024 ** 3)} min={0} max={1024}
              onCommit={(v) => void patch({ retention: { maxDbBytes: v * 1024 ** 3 } }, `容量上限改为 ${v} GB`)} />
            <div className="sgw-slab">
              <div className="sgw-label">当前占用</div>
              <div className="tnum sgw-text-sm">
                {fmtBytes(m?.storage.totalBytes ?? 0)}
                <span className="ml-1 sgw-text-2xs text-tertiary">
                  (DB {fmtBytes(m?.storage.dbBytes ?? 0)} · 正文 {fmtBytes(m?.storage.bodiesBytes ?? 0)})
                </span>
              </div>
            </div>
          </div>

          <div className="sgw-text-xs text-tertiary">
            上次清理：
            {m?.lastCleanup
              ? <> {fmtDateTime(m.lastCleanup.ranAt)}（{fmtRelative(m.lastCleanup.ranAt)}）—— 删除明细 {fmtInt(m.lastCleanup.deletedDetailRows)} 行
                {m.lastCleanup.deletedBodyDirs.length > 0 && `，正文目录 ${m.lastCleanup.deletedBodyDirs.length} 个`}</>
              : ' 尚未执行（启动后 30 秒会自动跑一次）'}
          </div>

          <div className="flex flex-wrap gap-2">
            <Button size="sm" disabled={saving} onClick={() => {
              void api.maintenance().then((r) => {
                toast('ok', r.data.reason);
                meta.reload();
              }).catch((e: Error) => toast('error', e.message));
            }}>立即清理</Button>
            <Button size="sm" disabled={saving} onClick={() => {
              void api.backup().then((r) => toast('ok', `已备份到 ${r.data.file}`)).catch((e: Error) => toast('error', e.message));
            }}>备份数据库</Button>
            <Button size="sm" variant="danger" onClick={() => setPurgeConfirm('detail')}>清理明细</Button>
            <Button size="sm" variant="danger" onClick={() => setPurgeConfirm('bodies')}>清理正文</Button>
            <Button size="sm" variant="danger" onClick={() => setPurgeConfirm('all')}>清空全部数据</Button>
          </div>

          {purgeConfirm && (
            <ConfirmPurge
              scope={purgeConfirm}
              onCancel={() => setPurgeConfirm(null)}
              onConfirm={(scope) => {
                void api.purge(scope).then((r) => {
                  toast('ok', `已清理：明细 ${fmtInt(r.data.deletedDetailRows)} 行，正文目录 ${r.data.deletedBodyDirs.length} 个。${r.data.note ?? ''}`);
                  setPurgeConfirm(null);
                  meta.reload(); reloadAll();
                }).catch((e: Error) => toast('error', e.message));
              }}
            />
          )}
        </div>
      </Card>
      </div>

      {/* ══════════ 上游与互操作 ══════════ */}
      <div className="sgw-span-6">
      <Card stretch title="上游与互操作自检" subtitle="这三项决定 Codex 能不能正常工作">
        <div className="flex flex-col gap-4">
          <div className="grid gap-3">
            {/* ── 上游地址：手动输入、热改、持久化 ── */}
            <Field label="上游地址（手动输入 · 可热改 · 不必重启）">
              <DraftInput
                value={u.baseUrl}
                placeholder="https://relay.example.com/v1"
                disabled={saving}
                runtime={fromRuntime('baseUrl')}
                hint={<>配置文件的默认值：<code>{u.configuredBaseUrl || '(未设置)'}</code>；运行时生效的是上面这个值，
                  改完存进本机数据库（<code>data/sgw.db</code>），重启后仍然生效。清空并「应用」= 回落到配置文件的值。</>}
                onApply={(v) => void patch({ upstream: { baseUrl: v } }, '上游地址已更新（即时生效，已持久化）')}
                onClear={() => void patch({ upstream: { baseUrl: null } }, '已清除运行期上游地址（回落到配置文件）')}
              />
            </Field>

            <div className="grid grid-cols-2 gap-3">
              {/* ── 路径拼接：/v1/v1/responses 这类 404 的根源 ── */}
              <div className="sgw-slab">
                <div className="sgw-label flex items-center gap-1">
                  路径拼接 pathMode
                  <Info title="auto：入站 path 以 stripPrefix 开头才剥（推荐）；append：总是剥；absolute：入站 path 原样保留（上游 base 不带路径前缀时用）。" />
                </div>
                <div className="mt-1">
                  <Segmented
                    size="sm"
                    value={(u.pathMode as 'auto' | 'append' | 'absolute') ?? 'auto'}
                    onChange={(v) => void patch({ upstream: { pathMode: v } }, `pathMode 已改为 ${v}（即时生效）`)}
                    options={[
                      { value: 'auto', label: 'auto' },
                      { value: 'append', label: 'append' },
                      { value: 'absolute', label: 'absolute' },
                    ]}
                  />
                </div>
              </div>
              <Field label="剥掉的前缀 stripPrefix">
                <DraftInput
                  value={u.stripPrefix}
                  placeholder="/v1（留空 = 不剥）"
                  disabled={saving}
                  runtime={fromRuntime('stripPrefix')}
                  hint={<>Codex 请求的是 <code>/v1/responses</code>，上游 base 通常也带 <code>/v1</code>，因此默认要剥掉它，否则会拼成 <code>/v1/v1/responses</code>。</>}
                  onApply={(v) => void patch({ upstream: { stripPrefix: v } }, 'stripPrefix 已更新（即时生效）')}
                  onClear={() => void patch({ upstream: { stripPrefix: null } }, '已恢复默认 stripPrefix')}
                />
              </Field>
            </div>

            <div className="grid grid-cols-2 gap-3">
              {/* ── 探针模型：不写死，由用户填 ── */}
              <Field label="探针模型 probeModel（手动输入）">
                <DraftInput
                  value={u.probeModel ?? ''}
                  placeholder="你上游真实存在的模型名"
                  disabled={saving}
                  runtime={fromRuntime('probeModel')}
                  hint={<>usage 契约探针用它发一个最小请求（约几十 token）。
                    {u.probeModel ? '' : '当前未配置 → 探针会自动跳过（不会拿瞎猜的模型去打上游）。'}</>}
                  onApply={(v) => void patch({ upstream: { probeModel: v } }, '探针模型已更新（即时生效）')}
                  onClear={() => void patch({ upstream: { probeModel: null } }, '已清除探针模型（探针将跳过）')}
                />
              </Field>

              <Readonly label="等上游响应头超时" value={`${u.headersTimeoutMs} ms`}
                hint="只作用于收到响应头之前。响应体没有超时 —— LLM 长推理是正常现象" />
            </div>

            {/* ── 鉴权：明文永不回传，只显示"是否已设置" ── */}
            <div className="grid grid-cols-2 gap-3">
              <Field label={`替换鉴权 replaceAuth（${u.replaceAuth ? '已设置' : '未设置'}）`}>
                <DraftInput
                  secret
                  value=""
                  placeholder={u.replaceAuth ? '已设置 —— 输入新值可覆盖' : 'sk-…（留空 = 原样透传 Codex 的 Authorization）'}
                  disabled={saving}
                  runtime={fromRuntime('replaceAuth')}
                  hint={<>默认**原样透传** Codex 发来的 <code>Authorization</code>；只有确实要用另一个 Key 时才填。
                    值只存本机数据库，**不会回显**。{u.replaceAuth && <> 若要回到"原样透传"，点「清除」。</>}</>}
                  onApply={(v) => void patch({ upstream: { replaceAuth: v } }, '替换鉴权已更新（即时生效，密钥只存本机）')}
                  onClear={() => void patch({ upstream: { replaceAuth: false } }, '已清除替换鉴权（恢复原样透传）')}
                />
              </Field>

              <Field label={`探针鉴权 probeAuth（${u.hasProbeAuth ? `已设置 · ${u.probeAuthSource ?? ''}` : '未设置'}）`}>
                <DraftInput
                  secret
                  value=""
                  placeholder={u.hasProbeAuth ? '已设置 —— 输入新值可覆盖' : 'Bearer sk-…（完整头值）'}
                  disabled={saving}
                  runtime={fromRuntime('probeAuth')}
                  hint="仅用于网关自己发起的探针请求，不影响 /v1/** 的透传。值只存本机数据库，不会回显。"
                  onApply={(v) => void patch({ upstream: { probeAuth: v } }, '探针鉴权已更新（即时生效）')}
                  onClear={() => void patch({ upstream: { probeAuth: null } }, '已清除探针鉴权')}
                />
              </Field>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <Readonly label="宽限期排空" value={`${u.graceDrainMs} ms`}
                hint="客户端按 Esc 后，网关继续读上游这么久以捕获 usage，然后才断开。否则这一轮永远记不到账" />
              <Readonly label="上游 TLS 校验" value={u.strictSsl ? '已开启（推荐）' : '⚠ 已关闭'}
                hint={u.strictSsl ? '使用系统 CA 或自定义 CA' : '存在中间人风险，仅用于排障'} />
            </div>
          </div>

          <div className="flex flex-wrap gap-2">
            <Button size="sm" disabled={runningTest} onClick={() => void runProbe()}>
              {runningTest ? '检测中…' : '测试上游 / usage 契约'}
            </Button>
            <Button size="sm" disabled={runningTest} onClick={() => void runSelftest()}>
              {runningTest ? '运行中…' : '运行透传自检'}
            </Button>
          </div>

          {/* usage 契约状态 */}
          <div className="sgw-notice" data-tone={uc?.complete === false ? 'danger' : 'info'}>
            <div className="flex items-center gap-2 font-medium">
              {uc?.complete === false ? '⛔' : uc?.complete === true ? '✓' : '○'}
              上游 usage 结构：
              {uc?.complete === true ? '完整（Codex 可正常工作）'
                : uc?.complete === false ? `不完整 —— 缺 ${uc.missingFields.join(', ')}`
                  : '尚未检测'}
            </div>
            {uc?.complete === false && (
              <div className="mt-2 opacity-95">
                <strong>这不是网关的问题，也不是你配置的问题。</strong>
                上游中继返回的 <code>response.completed.response.usage</code> 缺少 Codex 必需字段，
                Codex 会直接报错 <code>failed to parse ResponseCompleted</code> 并中断本轮对话。
                网关已**原样透传**该响应（不修改字节），并在此处告警。
                <div className="mt-1">可把下面这段发给中继管理员：</div>
                <pre className="mono sgw-code mt-1"
                  style={{ borderColor: 'currentColor' }}>
{`POST ${s.upstream.baseUrl}/responses 的 response.completed.response.usage 缺少字段：${uc.missingFields.join(', ')}
Codex 的 ResponseCompleted 把这些字段声明为非 Option，缺失会导致整轮解析失败。`}
                </pre>
              </div>
            )}
            {uc?.checkedAt && <div className="mt-1 sgw-text-2xs opacity-80">上次检测：{fmtRelative(uc.checkedAt)}</div>}
          </div>

          {probe?.note && (
            <div className="sgw-text-2xs text-tertiary">探针提示：{probe.note}</div>
          )}

          {/* WebSocket 提示 */}
          {m?.sawWebsocketAttempt && (
            <div className="sgw-notice" data-tone="warn">
              ⚠ 检测到 Codex 尝试使用 WebSocket 传输，但本网关只做 HTTP。
              请从 <code>config.toml</code> 中删除 <code>supports_websockets</code>，或设为 <code>false</code>（默认即 false）。
            </div>
          )}

          {/* 自检结果 */}
          {selftest && <SelfTestView report={selftest} />}
        </div>
      </Card>
      </div>

      {/* ══════════ 本地访问与安全 ══════════ */}
      <div className="sgw-span-6">
      <Card stretch title="本地访问与安全" subtitle="令牌与白名单只作用于管理接口（/_sgw/**），绝不影响 /v1/** 代理路径">
        <div className="flex flex-col gap-3">
          <div className="grid grid-cols-2 gap-3">
            <Readonly label="监听地址" value={health?.listen ?? '—'} hint="仅回环。如需暴露到局域网请显式修改配置（有风险）" />
            <Readonly label="本地令牌" value={s.security.requireToken ? `已启用 · 指纹 ${s.security.tokenFingerprint}` : '⚠ 未启用'}
              hint="令牌通过 X-Gateway-Token 请求头发送，可挡住其他本地进程与跨站盲请求" />
          </div>
          <div className="sgw-text-2xs text-tertiary">
            允许的 Host：{s.security.allowedHosts.join(' · ')}
            <Info title="Host 白名单是防御 DNS Rebinding 的核心手段：攻击者域名重绑定到 127.0.0.1 后，浏览器发送的 Host 仍是攻击者域名，因此会被拒绝。" />
          </div>
          <div className="sgw-text-2xs text-tertiary">
            数据目录：<code>{m?.storage.dataDir ?? health?.dataDir ?? '—'}</code>
          </div>
        </div>
      </Card>
      </div>

      {/* ══════════ 价格表 ══════════ */}
      <div className="sgw-span-6">
      <Card stretch title="价格表" subtitle="用于估算成本。支持前缀通配（如 gpt-6-*）与默认行 *">
        <PriceEditor
          prices={m?.prices ?? []}
          unpricedModels={m?.unpricedModels ?? []}
          source={m?.priceSource}
          onSaved={(msg) => { toast('ok', msg); meta.reload(); reloadAll(); }}
          onError={(msg) => toast('error', msg)}
        />
      </Card>
      </div>

      {/* ══════════ Codex 接入 ══════════ */}
      <div className="sgw-span-6">
      <Card stretch title="Codex 接入与回滚" subtitle="只改 base_url 一行；脚本会自动备份并支持一键回滚">
        <CodexGuide port={health?.listen.split(':')[1] ?? '8787'} toast={toast} />
      </Card>
      </div>
    </div>
  );
}

// ─────────────────────────────── 子组件 ───────────────────────────────

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="sgw-label mb-1">{label}</div>
      {children}
    </div>
  );
}

/**
 * 带「应用 / 清除」的手动输入项。
 *
 * 三条设计约束（都是踩过的坑）：
 *   1. **草稿与真值分离**：输入框内是本地草稿，只有点「应用」才提交。
 *      边打字边发 PATCH 会在"输入到一半就是非法 URL"时不断弹错误。
 *   2. **`runtime` 标记**：显式告诉用户"这个值来自运行时设置（SQLite），
 *      而不是 sgw.config.ts" —— 否则改了配置文件却不生效时会一头雾水。
 *   3. **密钥永不回显**：`secret` 模式下外部传入的 `value` 永远是空串，
 *      服务端也只回传"是否已设置"。因此这里不做 dirty 比较，随时可提交。
 */
function DraftInput({
  value, placeholder, disabled, onApply, onClear, hint, runtime, secret = false, applyLabel = '应用',
}: {
  value: string;
  placeholder?: string;
  disabled?: boolean;
  onApply: (v: string) => void;
  onClear?: () => void;
  hint?: React.ReactNode;
  runtime?: boolean;
  secret?: boolean;
  applyLabel?: string;
}) {
  const [draft, setDraft] = useState(value);
  useEffect(() => { setDraft(value); }, [value]);
  const dirty = !secret && draft !== value;
  const canApply = !disabled && (secret ? draft.trim() !== '' : dirty);

  return (
    <div>
      <div className="flex gap-2">
        <input
          className="sgw-input"
          type={secret ? 'password' : 'text'}
          value={draft}
          placeholder={placeholder}
          spellCheck={false}
          autoComplete="off"
          disabled={disabled}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && canApply) onApply(draft.trim()); }}
        />
        <Button size="sm" variant="primary" disabled={!canApply} onClick={() => onApply(draft.trim())}>{applyLabel}</Button>
        {onClear && <Button size="sm" disabled={disabled} onClick={() => onClear()}>清除</Button>}
      </div>
      <div className="mt-1 flex flex-wrap items-start gap-1 sgw-text-2xs text-tertiary">
        {runtime && <Badge tone="accent" dashed title="该值来自 settings 表（运行期设置），优先级高于 sgw.config.ts">来自运行时设置</Badge>}
        {hint && <span className="min-w-0">{hint}</span>}
      </div>
    </div>
  );
}

function Readonly({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="sgw-slab">
      <div className="sgw-label flex items-center gap-1">{label}{hint && <Info title={hint} />}</div>
      <div className="mono truncate sgw-text-xs text-primary" title={value}>{value}</div>
    </div>
  );
}

function NumField({
  label, value, min, max, onCommit,
}: { label: string; value: number; min: number; max: number; onCommit: (v: number) => void }) {
  const [v, setV] = useState(String(value));
  useEffect(() => { setV(String(value)); }, [value]);
  return (
    <div className="sgw-slab">
      <div className="sgw-label">{label}</div>
      <input
        className="sgw-input mt-1" style={{ height: 26 }} inputMode="numeric" value={v}
        onChange={(e) => setV(e.target.value.replace(/[^0-9]/g, ''))}
        onBlur={() => {
          const n = Math.max(min, Math.min(max, Number(v) || 0));
          setV(String(n));
          if (n !== value) onCommit(n);
        }}
        onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
      />
    </div>
  );
}

function ConfirmPurge({
  scope, onCancel, onConfirm,
}: { scope: 'detail' | 'bodies' | 'all'; onCancel: () => void; onConfirm: (s: 'detail' | 'bodies' | 'all') => void }) {
  const [ack, setAck] = useState(false);
  const label = scope === 'detail' ? '清空所有请求明细' : scope === 'bodies' ? '清空所有已保存的正文' : '清空全部数据（明细 + 正文 + 会话）';
  return (
    <div className="sgw-notice" data-tone="danger">
      <div className="font-semibold text-danger">{label}</div>
      <div className="mt-1 text-tertiary">
        此操作**不可撤销**。聚合统计（KPI、趋势、模型分布）**不会被删除**，因此概览页数据仍然可见。
      </div>
      <label className="mt-2 flex items-center gap-2 text-tertiary">
        <input type="checkbox" checked={ack} onChange={(e) => setAck(e.target.checked)} />
        我知道此操作无法恢复
      </label>
      <div className="mt-2 flex gap-2">
        <Button size="sm" variant="danger" disabled={!ack} onClick={() => onConfirm(scope)}>确认清理</Button>
        <Button size="sm" onClick={onCancel}>取消</Button>
      </div>
    </div>
  );
}

function SelfTestView({ report }: { report: SelfTestReport }) {
  const [open, setOpen] = useState(report.failed > 0);
  const groups = [...new Set(report.checks.map((c) => c.group))];
  return (
    <div className="sgw-slab" style={{ padding: 0, overflow: 'hidden' }}>
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className="flex w-full items-center justify-between border-0 bg-transparent text-left"
        style={{ padding: '8px 12px', cursor: 'pointer' }}
      >
        <span className="flex items-center gap-2 sgw-text-xs">
          <span className={report.failed === 0 ? 'text-ok' : 'text-danger'}>{report.failed === 0 ? '✓' : '✗'}</span>
          <span className="text-primary">透传自检：{report.passed} 通过{report.failed > 0 ? ` / ${report.failed} 失败` : ''}</span>
          <span className="sgw-text-2xs text-tertiary">{report.durationMs}ms</span>
        </span>
        <span className="sgw-text-2xs text-tertiary">{open ? '收起' : '展开'}</span>
      </button>
      {open && (
        <div style={{ padding: '0 12px 12px' }}>
          <div className="mb-2 sgw-text-2xs text-tertiary">{report.summary}</div>
          {groups.map((g) => (
            <div key={g} className="mb-3">
              <div className="sgw-label mb-1">{g}</div>
              <ul className="m-0 list-none space-y-1 p-0">
                {report.checks.filter((c) => c.group === g).map((c) => (
                  <li key={c.id} className="flex items-start gap-2 sgw-text-2xs">
                    <span className={c.ok ? 'text-ok' : 'text-danger'}>{c.ok ? '✓' : '✗'}</span>
                    <span className="min-w-0">
                      <span className="text-secondary">{c.name}</span>
                      {c.ref && <code className="ml-1 text-tertiary">{c.ref}</code>}
                      <span className="mt-0.5 block text-tertiary">{c.detail}</span>
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * 价格表编辑器。
 *
 * 三件事必须都在这里做好，否则"成本"这个数字就会长期不可信：
 *   1. **默认值**：内置官方价格（启动时自动播种），用户不必从零手填；
 *   2. **可编辑**：中继常改模型名/改价，必须能就地改（含缓存价 —— 它直接决定命中率的收益）；
 *   3. **缺口可见**：本机出现过但没价格的模型要直接列出来，一键补。
 *
 * 成本是**读时**按当前价格表计算的，因此这里改完立刻全站生效（含历史区间），不需要重算。
 */
function PriceEditor({
  prices, unpricedModels, source, onSaved, onError,
}: {
  prices: PriceRow[];
  unpricedModels: string[];
  source?: Meta['priceSource'];
  onSaved: (m: string) => void;
  onError: (m: string) => void;
}) {
  const [rows, setRows] = useState(prices);
  useEffect(() => { setRows(prices); }, [prices]);
  const [model, setModel] = useState('');
  const [inp, setInp] = useState('');
  const [outp, setOutp] = useState('');
  const [cached, setCached] = useState('');
  const [busy, setBusy] = useState(false);
  /** 正在编辑的模型名（null = 新增模式） */
  const [editing, setEditing] = useState<string | null>(null);
  const [confirmReset, setConfirmReset] = useState(false);

  const resetForm = (): void => {
    setModel(''); setInp(''); setOutp(''); setCached(''); setEditing(null);
  };

  const startEdit = (r: PriceRow): void => {
    setEditing(r.model);
    setModel(r.model);
    setInp(String(r.inputPerMtok));
    setOutp(String(r.outputPerMtok));
    setCached(r.cachedPerMtok === null ? '' : String(r.cachedPerMtok));
  };

  const save = (next: PriceRow[], msg: (n: number) => string): void => {
    setBusy(true);
    void api.putPrices(next)
      .then((r) => onSaved(msg(r.data.updated)))
      .catch((e: Error) => onError(e.message))
      .finally(() => setBusy(false));
  };

  const commit = (): void => {
    const name = model.trim();
    if (!name) return;
    const n = (v: string): number => (v.trim() === '' ? 0 : Number(v));
    const next = [
      // 改名时要把旧名字那行删掉，否则会留下一个孤儿条目
      ...rows.filter((r) => r.model !== name && r.model !== editing),
      {
        model: name,
        inputPerMtok: n(inp),
        outputPerMtok: n(outp),
        cachedPerMtok: cached.trim() === '' ? null : Number(cached),
        reasoningPerMtok: null,
      },
    ];
    save(next, (c) => `价格表已更新（${c} 条）`);
    resetForm();
  };

  return (
    <div className="flex flex-col gap-3">
      {/* 缺口提示：本机出现过但没价格的模型 */}
      {unpricedModels.length > 0 && (
        <div className="sgw-notice" data-tone="warn">
          <div className="font-medium">
            ⚠ {unpricedModels.length} 个模型没有价格，它们的成本会显示为「—」（不是 0 元）
          </div>
          <div className="mt-1 flex flex-wrap items-center gap-1">
            {unpricedModels.map((name) => (
              <button
                key={name}
                type="button"
                className="mono border-0 bg-transparent sgw-text-2xs text-accent"
                style={{ cursor: 'pointer', textDecoration: 'underline' }}
                onClick={() => { setEditing(null); setModel(name); setInp(''); setOutp(''); setCached(''); }}
              >{name}</button>
            ))}
          </div>
          <div className="mt-1 sgw-text-2xs text-tertiary">点模型名填入下面的表单，填好单价后「添加」即可（也支持 gpt-6-* 这种前缀通配）。</div>
        </div>
      )}

      {/* 新增 / 编辑 */}
      <div className="flex flex-wrap items-center gap-2">
        <input className="sgw-input" style={{ width: 170 }} placeholder="模型名或 gpt-6-*" value={model}
          onChange={(e) => setModel(e.target.value)} spellCheck={false} />
        <input className="sgw-input" style={{ width: 100 }} placeholder="输入 $/1M" inputMode="decimal" value={inp}
          onChange={(e) => setInp(e.target.value)} />
        <input className="sgw-input" style={{ width: 100 }} placeholder="输出 $/1M" inputMode="decimal" value={outp}
          onChange={(e) => setOutp(e.target.value)} />
        <input className="sgw-input" style={{ width: 110 }} placeholder="缓存 $/1M（可空）" inputMode="decimal" value={cached}
          onChange={(e) => setCached(e.target.value)} />
        <Button size="sm" disabled={busy || !model.trim() || (inp === '' && outp === '')} onClick={commit}>
          {editing ? '保存修改' : '添加'}
        </Button>
        {editing && <Button size="sm" disabled={busy} onClick={resetForm}>取消</Button>}
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" disabled={busy} onClick={() => {
          setBusy(true);
          void api.restoreDefaultPrices(false)
            .then((r) => onSaved(`已补齐官方默认价格（新增 ${r.data.inserted} 条，覆盖 ${r.data.overwritten} 条）`))
            .catch((e: Error) => onError(e.message))
            .finally(() => setBusy(false));
        }}>补齐官方默认价格</Button>
        <Button size="sm" variant="danger" disabled={busy} onClick={() => setConfirmReset(true)}>重建为官方默认值</Button>
      </div>

      {confirmReset && (
        <div className="sgw-notice" data-tone="danger">
          <div className="font-semibold text-danger">把价格表重置为官方默认值？</div>
          <div className="mt-1 text-tertiary">
            已存在的同名模型会被**覆盖**为官方价格（你为自建中继改过的价格会丢失）。
            通配行与你自己添加的其它模型保持不动。
          </div>
          <div className="mt-2 flex gap-2">
            <Button size="sm" variant="danger" disabled={busy} onClick={() => {
              setConfirmReset(false);
              setBusy(true);
              void api.restoreDefaultPrices(true)
                .then((r) => onSaved(`已重置 ${r.data.overwritten} 条为官方默认价`))
                .catch((e: Error) => onError(e.message))
                .finally(() => setBusy(false));
            }}>确认重置</Button>
            <Button size="sm" onClick={() => setConfirmReset(false)}>取消</Button>
          </div>
        </div>
      )}

      {rows.length === 0 ? (
        <div className="sgw-text-xs text-tertiary">
          还没有价格数据。未配置价格的模型，成本显示为 <code>—</code>（token 统计不受影响）。
        </div>
      ) : (
        <div style={{ maxHeight: 320, overflowY: 'auto' }}>
          <table className="sgw-table">
            <thead>
              <tr>
                <th>模型</th>
                <th style={{ width: 92 }}>输入 /1M</th>
                <th style={{ width: 92 }}>输出 /1M</th>
                <th style={{ width: 96 }}>缓存 /1M</th>
                <th style={{ width: 96 }} />
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.model} style={{ cursor: 'default' }}>
                  <td className="mono sgw-text-xs">{r.model}</td>
                  <td className="tnum sgw-text-xs">${r.inputPerMtok}</td>
                  <td className="tnum sgw-text-xs">${r.outputPerMtok}</td>
                  <td className="tnum sgw-text-xs">{r.cachedPerMtok === null ? '—' : `$${r.cachedPerMtok}`}</td>
                  <td className="whitespace-nowrap text-right">
                    <button
                      type="button" className="border-0 bg-transparent sgw-text-2xs text-accent" style={{ cursor: 'pointer' }}
                      onClick={() => startEdit(r)}
                    >编辑</button>
                    <button
                      type="button" className="ml-2 border-0 bg-transparent sgw-text-2xs text-danger" style={{ cursor: 'pointer' }}
                      onClick={() => {
                        setBusy(true);
                        void api.deletePrice(r.model).then(() => onSaved(`已删除 ${r.model}`))
                          .catch((e: Error) => onError(e.message))
                          .finally(() => setBusy(false));
                      }}
                    >删除</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div className="sgw-text-2xs text-tertiary">
        成本**按当前价格表实时计算**，因此改价后历史区间的数字也会跟着更新（含缓存折扣）；
        实际计费以公司账单为准。
        {source && (
          <>
            <br />
            默认值来源：
            <a href={source.url} target="_blank" rel="noreferrer noopener">{source.label}</a>
            （{source.currency} / {source.unit}，{source.retrievedAt} 核对 · 表版本 v{source.version}）。
            自建中继常改模型名或单价，请以中继账单为准修正。
          </>
        )}
      </div>
    </div>
  );
}

function CodexGuide({ port, toast }: { port: string; toast: (k: Toast['kind'], t: string) => void }) {
  const snippet = `[model_providers.OpenAI]
base_url = "http://127.0.0.1:${port}/v1"
wire_api = "responses"
requires_openai_auth = true
experimental_bearer_token = "sk-****"   # 保持原样
# supports_websockets  ← 不要设置（本网关不支持 WS）`;

  const copy = (text: string, label: string): void => {
    void navigator.clipboard.writeText(text).then(
      () => toast('ok', `${label} 已复制到剪贴板`),
      () => toast('error', '复制失败，请手动选择文本'),
    );
  };

  return (
    <div className="flex flex-col gap-3">
      <ol className="m-0 list-decimal space-y-2 pl-5 sgw-text-xs text-secondary">
        <li>
          启动网关：<code>node apps/server/src/index.ts</code>
        </li>
        <li>
          一键指向本地网关（会自动备份 <code>config.toml</code>）：
          <pre className="mono mt-1 sgw-code" style={{ background: 'var(--sgw-bg-inset)', color: 'var(--sgw-text-secondary)' }}>
{`node scripts/point-codex.mjs            # 指向网关
node scripts/point-codex.mjs --status   # 查看当前指向（只读）
node scripts/point-codex.mjs --dry-run  # 预览改动`}
          </pre>
        </li>
        <li>
          重启 Codex（或新开会话）使其生效。
        </li>
        <li>
          <strong>回滚（一条命令）</strong>：
          <pre className="mono mt-1 sgw-code" style={{ background: 'var(--sgw-bg-inset)', color: 'var(--sgw-text-secondary)' }}>
{`node scripts/point-codex.mjs --restore`}
          </pre>
        </li>
      </ol>

      <div>
        <div className="mb-1 flex items-center justify-between">
          <span className="sgw-label">config.toml 片段</span>
          <Button size="sm" onClick={() => copy(snippet, 'config.toml 片段')}>复制</Button>
        </div>
        <pre className="mono sgw-code" style={{ background: 'var(--sgw-bg-inset)', color: 'var(--sgw-text-secondary)' }}>{snippet}</pre>
      </div>

      <div className="sgw-notice" data-tone="info">
        <div>⚠ <strong>用 <code>127.0.0.1</code>，不要写 <code>localhost</code></strong>：Codex 对 localhost 存在优先解析 IPv6 的已知缺陷（#21773）。</div>
        <div className="mt-1">⚠ 不要设置 <code>supports_websockets</code>：本网关只做 HTTP。</div>
      </div>
    </div>
  );
}
