/**
 * 应用壳层：悬浮玻璃侧栏 + 玻璃顶栏 + 状态胶囊（docs/04 §2）。
 *
 * 路由用手写的 hash 路由（4 个页面，不需要 react-router）。
 * 关键设计：
 *   - **URL 承载视图状态**（range / 筛选条件），刷新后保持
 *   - **侧栏底部常驻状态胶囊**：Body Mode 开启时变警示色 —— 这是"反惊吓原则"的落点
 *
 * 视觉（v2）：侧栏是一块**悬浮玻璃板**（不贴边、圆角、投影），顶栏是吸附在滚动区
 * 顶部的玻璃条 —— 内容从它底下穿过时能看见模糊，这正是玻璃拟态的信息价值。
 */

import { useEffect, useState, type ReactNode } from 'react';
import { Badge, Segmented, Button } from './ui.tsx';
import {
  IconOverview, IconRequests, IconSessions, IconSettings, IconRefresh,
  IconMonitor, IconMoon, IconSun,
} from './icons.tsx';
import type { Health } from '../lib/api.ts';
import type { ThemeMode } from '../lib/hooks.ts';
import { fmtUptime } from '../lib/format.ts';

export type Route = 'overview' | 'requests' | 'sessions' | 'settings';
export type RangePreset = '1h' | '24h' | '7d' | '30d' | 'month';

const NAV: Array<{ id: Route; label: string; icon: ReactNode }> = [
  { id: 'overview', label: '概览', icon: <IconOverview /> },
  { id: 'requests', label: '请求明细', icon: <IconRequests /> },
  { id: 'sessions', label: '会话', icon: <IconSessions /> },
  { id: 'settings', label: '设置', icon: <IconSettings /> },
];

export function useHashRoute(): [Route, (r: Route) => void] {
  const parse = (): Route => {
    const h = window.location.hash.replace(/^#\/?/, '') || 'overview';
    return (NAV.some((n) => n.id === h) ? h : 'overview') as Route;
  };
  const [route, setRoute] = useState<Route>(parse);
  useEffect(() => {
    const on = (): void => setRoute(parse());
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, []);
  return [route, (r) => { window.location.hash = `#/${r}`; }];
}

export function useUrlRange(): [RangePreset, (r: RangePreset) => void] {
  const read = (): RangePreset => {
    const v = new URLSearchParams(window.location.search.slice(1)).get('range');
    return (['1h', '24h', '7d', '30d', 'month'] as const).includes(v as RangePreset) ? (v as RangePreset) : '24h';
  };
  const [range, setRange] = useState<RangePreset>(read);
  useEffect(() => {
    const on = (): void => setRange(read());
    window.addEventListener('popstate', on);
    return () => window.removeEventListener('popstate', on);
  }, []);
  return [range, (r) => {
    setRange(r);
    const url = new URL(window.location.href);
    url.searchParams.set('range', r);
    window.history.replaceState({}, '', url);
  }];
}

// ─────────────────────────────── 侧栏 ───────────────────────────────

export function Sidebar({ route, onNavigate, health }: {
  route: Route;
  onNavigate: (r: Route) => void;
  health: Health | null;
}) {
  const detail = health?.logging.detailEnabled === true;
  const body = health?.logging.bodyEnabled === true;

  return (
    <aside className="sgw-sidebar sgw-edge sgw-glass">
      <div className="flex items-center gap-2.5" style={{ padding: 'var(--sgw-space-2) var(--sgw-space-2) var(--sgw-space-4)' }}>
        <span className="sgw-brand-mark">SG</span>
        <span className="min-w-0">
          <span className="block truncate sgw-text-md font-semibold leading-tight">Self Gateway</span>
          <span className="block sgw-text-2xs text-tertiary">v{health?.version ?? '—'}</span>
        </span>
      </div>

      <nav className="flex flex-1 flex-col gap-1 overflow-y-auto" aria-label="主导航">
        {NAV.map((n) => (
          <button
            key={n.id}
            type="button"
            onClick={() => onNavigate(n.id)}
            aria-current={n.id === route ? 'page' : undefined}
            className="sgw-nav-item"
          >
            {n.icon}
            {n.label}
          </button>
        ))}
      </nav>

      {/* ★ 状态胶囊：反惊吓原则的关键组件 */}
      <div style={{ paddingTop: 'var(--sgw-space-3)' }}>
        <button
          type="button"
          onClick={() => onNavigate('settings')}
          className="sgw-capsule"
          data-state={body ? 'body' : detail ? 'detail' : 'aggregate'}
          title={body
            ? '正在记录请求/响应正文。正文可能含代码与密钥，仅保存在本机 data/bodies/。'
            : detail ? '正在记录请求明细（元数据）' : '仅记录聚合统计'}
        >
          <span
            className={`sgw-dot ${detail && !body ? 'sgw-pulse' : ''}`}
            style={{ background: body ? 'var(--sgw-warning-500)' : detail ? 'var(--sgw-accent)' : 'var(--sgw-text-disabled)' }}
          />
          <span className="min-w-0 flex-1">
            <span className="block sgw-text-xs font-medium" style={{ color: body ? 'var(--sgw-warning-500)' : 'var(--sgw-text-secondary)' }}>
              {body ? '⚠ 记录正文' : detail ? '记录明细' : '仅聚合'}
            </span>
            <span className="block sgw-text-2xs text-tertiary">
              {body ? '含代码与密钥风险' : detail ? '含元数据与 Token 计量' : 'KPI 仍完整'}
            </span>
          </span>
        </button>
      </div>
    </aside>
  );
}

// ─────────────────────────────── 顶栏 ───────────────────────────────

/** 主题状态由 `App` 的 `useTheme()` 持有，这里只负责展示与改值 */
export interface ThemeControls {
  mode: ThemeMode;
  setMode: (m: ThemeMode) => void;
}

/**
 * 外观切换（v3 从设置页「外观」卡片搬到顶栏最右侧）。
 *
 * 为什么是图标而不是文字：主题是**随时想改的全局偏好**，不该要求先导航到设置页；
 * 但顶栏右侧已有时间范围分段控件，塞进「跟随系统 / 深色 / 浅色」三个中文标签会挤掉数据区。
 * 因此用三段图标控件，语义交给 `title`（悬停）与 `aria-label`（读屏），并在最右侧
 * 用一道竖分隔与左侧的「操作类」控件区分开。
 */
function ThemePicker({ mode, onChange }: { mode: ThemeMode; onChange: (m: ThemeMode) => void }) {
  return (
    <Segmented
      value={mode}
      onChange={onChange}
      options={[
        { value: 'system', label: <IconMonitor />, iconOnly: true, title: '外观：跟随系统', ariaLabel: '外观：跟随系统' },
        { value: 'dark', label: <IconMoon />, iconOnly: true, title: '外观：深色', ariaLabel: '外观：深色' },
        { value: 'light', label: <IconSun />, iconOnly: true, title: '外观：浅色', ariaLabel: '外观：浅色' },
      ]}
    />
  );
}

export function TopBar({
  title, range, onRange, onRefresh, refreshing, right, health, theme,
}: {
  title: string;
  range?: RangePreset;
  onRange?: (r: RangePreset) => void;
  onRefresh?: () => void;
  refreshing?: boolean;
  right?: ReactNode;
  health: Health | null;
  theme: ThemeControls;
}) {
  const uc = health?.usageContract;
  const unreachable = health?.upstream.reachable === false;

  return (
    <header className="sgw-topbar sgw-edge sgw-glass">
      <div className="flex min-w-0 items-center gap-3">
        <h1 className="sgw-topbar-title truncate">{title}</h1>
        {uc?.complete === false && (
          <Badge tone="danger" dot title={`上游 usage 缺字段：${uc.missingFields.join(', ')} —— 这会让 Codex 整轮对话失败`}>
            上游 usage 结构异常
          </Badge>
        )}
        {unreachable && <Badge tone="warn" dot title={health?.upstream.lastError ?? ''}>上游不可达</Badge>}
      </div>

      <div className="flex flex-none items-center gap-2">
        {right}
        {range && onRange && (
          <Segmented
            value={range}
            onChange={onRange}
            options={[
              { value: '1h', label: '1 小时' },
              { value: '24h', label: '24 小时' },
              { value: '7d', label: '7 天' },
              { value: '30d', label: '30 天' },
              { value: 'month', label: '本月' },
            ]}
          />
        )}
        {onRefresh && (
          <Button
            onClick={onRefresh}
            title="刷新数据"
            size="sm"
            variant="ghost"
          >
            <span
              className={refreshing ? 'sgw-pulse' : ''}
              aria-hidden
              style={{ display: 'inline-flex', fontSize: 15, lineHeight: 1 }}
            >
              <IconRefresh />
            </span>
            <span className="sr-only">刷新数据</span>
          </Button>
        )}
        {health && (
          <Badge tone={health.usageContract.checked && health.usageContract.complete === false ? 'danger' : 'neutral'}
            title={`运行 ${fmtUptime(health.uptimeSec)} · Node ${health.node} · 数据目录 ${health.dataDir}`}>
            {fmtUptime(health.uptimeSec)}
          </Badge>
        )}
        {/* ★ 最右侧：外观（主题）切换 —— 全局偏好，不属于任何单个页面的「操作」 */}
        <span className="sgw-topbar-sep" aria-hidden />
        <ThemePicker mode={theme.mode} onChange={theme.setMode} />
      </div>
    </header>
  );
}

// ─────────────────────────────── 全局告警横幅 ───────────────────────────────

export function AlertBanner({ health, onOpenSettings }: { health: Health | null; onOpenSettings: () => void }) {
  if (!health) return null;
  const alerts: Array<{ tone: 'danger' | 'warn'; text: string; action?: ReactNode }> = [];

  const uc = health.usageContract;
  if (uc.checked && uc.complete === false) {
    alerts.push({
      tone: 'danger',
      text: `上游中继返回的 usage 结构不完整（缺 ${uc.missingFields.join(', ') || '未知字段'}）—— `
        + '这会让 Codex 本轮对话直接失败。**这不是网关的问题，也不是你配置的问题**，请把该信息反馈给中继管理员。',
    });
  }
  if (health.upstream.reachable === false) {
    alerts.push({
      tone: 'warn',
      text: `上游连通性探测失败：${health.upstream.lastError ?? '未知原因'}。请求到达时仍会尝试转发，但请检查 upstream.baseUrl 与网络。`,
      action: <Button size="sm" onClick={onOpenSettings}>去设置</Button>,
    });
  }

  if (alerts.length === 0) return null;
  return (
    <div className="flex flex-col gap-2" style={{ paddingTop: 'var(--sgw-space-3)' }}>
      {alerts.map((a, i) => (
        <div key={i} role="alert" className="sgw-notice sgw-edge flex items-start justify-between gap-3"
          data-tone={a.tone}>
          <span className="min-w-0">
            <strong className="mr-1">{a.tone === 'danger' ? '⛔' : '⚠'}</strong>
            {a.text.split('**').map((part, idx) => (idx % 2 === 1 ? <strong key={idx}>{part}</strong> : part))}
          </span>
          {a.action}
        </div>
      ))}
    </div>
  );
}
