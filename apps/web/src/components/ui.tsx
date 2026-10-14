/**
 * 基础 UI 组件（对应 docs/04 §5）。
 *
 * 全部基于令牌（`var(--sgw-*)` 或 Tailwind 语义色），**不硬编码颜色**，
 * 因此两套主题自动生效。不引入组件库（shadcn 的 copy-in 精神，但只取需要的几个）。
 *
 * 玻璃拟态的落点（v2）：面板一律走 `.sgw-glass` 系列 + `.sgw-edge` 顶部高光，
 * **表单控件保持不透明**（`.sgw-input` / 表格 sticky 表头）——那两处可读性优先于装饰。
 */

import type { ReactNode, CSSProperties } from 'react';
import { IconClose, IconInfo, IconWarning } from './icons.tsx';

// ─────────────────────────────── Card ───────────────────────────────

export function Card({
  title, subtitle, actions, children, className = '', padded = true, style, interactive = false, stretch = false,
}: {
  title?: ReactNode;
  subtitle?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
  padded?: boolean;
  style?: CSSProperties;
  /** 整卡可点（有 hover 抬升；无 onClick 的静态卡不应传 true） */
  interactive?: boolean;
  /** Bento 行内让卡片撑满单元格高度（避免同行卡片长短不齐） */
  stretch?: boolean;
}) {
  return (
    <section
      className={`sgw-card sgw-edge sgw-glass ${interactive ? 'sgw-card-interactive' : ''} ${className}`}
      style={stretch ? { display: 'flex', flexDirection: 'column', height: '100%', ...style } : style}
    >
      {(title || actions) && (
        <header
          className="flex flex-none items-start justify-between gap-4 border-b border-subtle"
          style={{ padding: padded ? 'var(--sgw-space-4) var(--sgw-space-5)' : 'var(--sgw-space-3) var(--sgw-space-4)' }}
        >
          <div className="min-w-0">
            {title && <h2 className="sgw-card-title m-0 truncate">{title}</h2>}
            {subtitle && <p className="m-0 mt-1 sgw-text-xs text-tertiary">{subtitle}</p>}
          </div>
          {actions && <div className="flex flex-none items-center gap-2">{actions}</div>}
        </header>
      )}
      <div
        className={stretch ? 'flex-1' : undefined}
        style={{ padding: padded ? 'var(--sgw-space-5)' : 0 }}
      >{children}</div>
    </section>
  );
}

// ─────────────────────────────── KPICard ───────────────────────────────

export function KpiCard({
  label, value, unit, hint, delta, tone = 'neutral', loading, className = '',
}: {
  label: string;
  value: string;
  unit?: string;
  hint?: string;
  delta?: { text: string; dir: 'up' | 'down' | 'flat' };
  tone?: 'neutral' | 'ok' | 'warn' | 'danger';
  loading?: boolean;
  className?: string;
}) {
  return (
    <div className={`sgw-kpi-card sgw-edge sgw-glass ${className}`}>
      <div className="sgw-label mb-2 flex items-center gap-1">
        {label}
        {hint && <Info title={hint} />}
      </div>
      {loading ? (
        <div className="sgw-shimmer" style={{ height: 34, width: '70%' }} />
      ) : (
        <div className="sgw-kpi" data-tone={tone}>
          {value}
          {unit && <span className="ml-1 sgw-text-xs font-medium text-tertiary">{unit}</span>}
        </div>
      )}
      <div className="mt-1 min-h-4 sgw-text-2xs text-tertiary">
        {delta && delta.dir !== 'flat' && <span className="mr-2">{delta.text}</span>}
        {delta && delta.dir === 'flat' && <span className="mr-2 text-disabled">持平</span>}
      </div>
    </div>
  );
}

// ─────────────────────────────── Info tooltip ───────────────────────────────

export function Info({ title }: { title: string }) {
  return (
    <span
      title={title}
      aria-label={title}
      role="img"
      className="inline-flex cursor-help items-center text-tertiary"
      style={{ fontSize: 12, lineHeight: 1, flex: 'none' }}
    >
      <IconInfo />
    </span>
  );
}

// ─────────────────────────────── Badge ───────────────────────────────

export function Badge({
  children, tone = 'neutral', dot, dashed, title,
}: {
  children: ReactNode;
  tone?: 'neutral' | 'ok' | 'warn' | 'danger' | 'info' | 'accent';
  dot?: boolean;
  dashed?: boolean;
  title?: string;
}) {
  const map: Record<string, string> = {
    neutral: 'text-secondary',
    ok: 'text-ok',
    warn: 'text-warn',
    danger: 'text-danger',
    info: 'text-info',
    accent: 'text-accent',
  };
  const bg: Record<string, string> = {
    neutral: 'var(--sgw-bg-inset)',
    ok: 'var(--sgw-success-bg)',
    warn: 'var(--sgw-warning-bg)',
    danger: 'var(--sgw-danger-bg)',
    info: 'var(--sgw-info-bg)',
    accent: 'var(--sgw-accent-subtle)',
  };
  return (
    <span
      className={`sgw-badge ${map[tone]}`}
      style={{
        background: bg[tone],
        border: dashed ? `1px dashed ${tone === 'neutral' ? 'var(--sgw-border-strong)' : 'currentColor'}` : '1px solid transparent',
      }}
      title={title}
    >
      {dot && <span className="sgw-dot" style={{ background: 'currentColor' }} />}
      {children}
    </span>
  );
}

// ─────────────────────────────── Switch ───────────────────────────────

export function Switch({
  checked, onChange, disabled, label, hint,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  disabled?: boolean;
  label?: string;
  hint?: string;
}) {
  return (
    <label className={`flex items-start gap-3 ${disabled ? 'opacity-60' : 'cursor-pointer'}`}>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        aria-label={label}
        disabled={disabled}
        onClick={() => { if (!disabled) onChange(!checked); }}
        className="relative flex-none rounded-full transition-colors"
        style={{
          width: 42, height: 24, marginTop: 1,
          background: checked
            ? 'linear-gradient(180deg, var(--sgw-brand-400), var(--sgw-brand-600))'
            : 'var(--sgw-border-strong)',
          border: 'none',
          boxShadow: checked ? 'var(--sgw-shadow-glow)' : 'none',
          cursor: disabled ? 'not-allowed' : 'pointer',
        }}
      >
        <span
          className="absolute rounded-full transition-all"
          style={{
            width: 18, height: 18, top: 3, left: checked ? 21 : 3,
            background: checked ? 'var(--sgw-accent-text)' : 'var(--sgw-bg-surface)',
            boxShadow: 'var(--sgw-shadow-xs)',
          }}
        />
      </button>
      {(label || hint) && (
        <span className="min-w-0">
          {label && <span className="block text-primary">{label}</span>}
          {hint && <span className="mt-0.5 block sgw-text-xs text-tertiary">{hint}</span>}
        </span>
      )}
    </label>
  );
}

// ─────────────────────────────── Button ───────────────────────────────

export function Button({
  children, onClick, variant = 'secondary', disabled, size = 'md', title, type = 'button',
}: {
  children: ReactNode;
  onClick?: () => void;
  variant?: 'secondary' | 'primary' | 'danger' | 'ghost';
  disabled?: boolean;
  size?: 'sm' | 'md';
  title?: string;
  type?: 'button' | 'submit';
}) {
  const variantClass = variant === 'primary' ? 'sgw-btn-primary'
    : variant === 'danger' ? 'sgw-btn-danger'
      : variant === 'ghost' ? 'sgw-btn-ghost' : '';
  return (
    <button
      type={type}
      className={`sgw-btn ${variantClass}`}
      disabled={disabled}
      title={title}
      onClick={onClick}
      style={size === 'sm' ? { height: 28, fontSize: 'var(--sgw-text-xs)', padding: '0 var(--sgw-space-2)' } : undefined}
    >
      {children}
    </button>
  );
}

// ─────────────────────────────── Empty / Skeleton / Error ───────────────────────────────

export function EmptyState({
  title, description, action, icon,
}: { title: string; description?: ReactNode; action?: ReactNode; icon?: ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 text-center" style={{ padding: 'var(--sgw-space-10) var(--sgw-space-5)' }}>
      <div
        className="grid place-items-center text-tertiary"
        style={{
          width: 52, height: 52, marginBottom: 2,
          borderRadius: 'var(--sgw-radius-md)',
          background: 'var(--sgw-bg-glass-subtle)',
          border: '1px solid var(--sgw-border-subtle)',
          fontSize: 24,
        }}
        aria-hidden
      >
        {icon}
      </div>
      <div className="sgw-text-md font-semibold text-primary">{title}</div>
      {description && <div className="max-w-md sgw-text-xs text-tertiary">{description}</div>}
      {action && <div className="mt-2">{action}</div>}
    </div>
  );
}

export function Skeleton({ height = 16, width = '100%', className = '' }: { height?: number; width?: number | string; className?: string }) {
  return <div className={`sgw-shimmer ${className}`} style={{ height, width }} />;
}

export function ErrorState({ error, onRetry }: { error: Error; onRetry?: () => void }) {
  const isAuth = /TOKEN/.test(error.message) || /401/.test(error.message);
  const isHost = /HOST|ORIGIN/.test(error.message);
  return (
    <div className="sgw-card sgw-edge sgw-glass" style={{ padding: 'var(--sgw-space-5)', borderColor: 'var(--sgw-danger-500)' }}>
      <div className="flex items-start gap-3">
        <span className="text-danger" style={{ fontSize: 18, lineHeight: 1 }}><IconWarning /></span>
        <div className="min-w-0 flex-1">
          <div className="font-semibold text-primary">
            {isAuth ? '未通过本地令牌校验' : isHost ? '访问被安全策略拒绝' : '请求失败'}
          </div>
          <div className="mt-1 break-words sgw-text-xs text-tertiary">{error.message}</div>
          {isAuth && (
            <div className="mt-2 sgw-text-xs text-tertiary">
              请在启动日志里找到带 <code className="text-accent">?token=…</code> 的仪表盘链接并打开一次；
              或把 <code>SGW_TOKEN</code> 环境变量设为令牌值后刷新。
            </div>
          )}
          {isHost && (
            <div className="mt-2 sgw-text-xs text-tertiary">
              请使用 <code>http://127.0.0.1:端口</code> 访问，而不是 localhost 之外的其他主机名。
            </div>
          )}
          {onRetry && <div className="mt-3"><Button onClick={onRetry}>重试</Button></div>}
        </div>
      </div>
    </div>
  );
}

// ─────────────────────────────── Toasts ───────────────────────────────

export function ToastHost({ toasts, dismiss }: {
  toasts: Array<{ id: number; kind: 'ok' | 'warn' | 'error'; text: string }>;
  dismiss: (id: number) => void;
}) {
  if (toasts.length === 0) return null;
  const tone = (k: string): string => (k === 'ok' ? 'var(--sgw-success-500)' : k === 'warn' ? 'var(--sgw-warning-500)' : 'var(--sgw-danger-500)');
  return (
    <div className="fixed flex flex-col gap-2" style={{ right: 20, bottom: 20, zIndex: 'var(--sgw-z-toast)' as unknown as number }}>
      {toasts.map((t) => (
        <div
          key={t.id}
          role="status"
          onClick={() => dismiss(t.id)}
          className="sgw-card sgw-edge sgw-glass-strong flex cursor-pointer items-center gap-2.5 shadow-lg"
          style={{ minWidth: 260, maxWidth: 420, padding: '10px 14px', borderLeft: `3px solid ${tone(t.kind)}` }}
        >
          <span style={{ color: tone(t.kind), fontSize: 14, lineHeight: 1 }} aria-hidden>
            {t.kind === 'ok' ? '✓' : '!'}
          </span>
          <span className="sgw-text-xs text-primary">{t.text}</span>
        </div>
      ))}
    </div>
  );
}

// ─────────────────────────────── Tabs / Segmented ───────────────────────────────

/**
 * 分段控件。
 *
 * `label` 允许传 ReactNode：顶栏的「外观」切换用**纯图标**三段控件（toolbar 里横向空间
 * 是稀缺资源，文字让给数据），此时必须同时给出 `title` 与 `ariaLabel` —— 图标本身
 * `aria-hidden`，语义只能靠这两者承载（docs/04 §7.1）。
 */
export function Segmented<T extends string>({
  value, onChange, options, size = 'md',
}: {
  value: T;
  onChange: (v: T) => void;
  options: Array<{ value: T; label: ReactNode; title?: string; ariaLabel?: string; iconOnly?: boolean }>;
  size?: 'sm' | 'md';
}) {
  return (
    <div role="tablist" className="sgw-segmented" data-size={size}>
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          role="tab"
          aria-selected={o.value === value}
          aria-label={o.ariaLabel}
          title={o.title}
          data-icon-only={o.iconOnly ? 'true' : undefined}
          onClick={() => onChange(o.value)}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

// ─────────────────────────────── IconButton ───────────────────────────────

export function IconButton({
  label, onClick, children, variant = 'secondary', size = 'md', disabled,
}: {
  label: string;
  onClick?: () => void;
  children: ReactNode;
  variant?: 'secondary' | 'ghost';
  size?: 'sm' | 'md';
  disabled?: boolean;
}) {
  return (
    <Button variant={variant} size={size} onClick={onClick} title={label} disabled={disabled}>
      <span aria-hidden style={{ display: 'inline-flex', fontSize: 15, lineHeight: 1 }}>{children}</span>
      <span className="sr-only">{label}</span>
    </Button>
  );
}

/** 供需要"关闭"语义的地方复用（保持图标一致） */
export const CloseIcon = IconClose;
