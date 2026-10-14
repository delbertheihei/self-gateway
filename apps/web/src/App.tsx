/**
 * 应用根：路由 + 全局状态（health / meta）+ 主题 + Toast。
 *
 * 数据刷新策略（刻意的简单）：
 *   - `health` 每 10s 轮询（轻量，用于状态胶囊与告警横幅）
 *   - `meta` 每 30s 轮询（模型列表、占用、开关状态）
 *   - 各页自己按需轮询具体统计
 * 若将来引入 SSE 实时推送，只需在这里订阅并把增量合并进来，页面无需改动。
 */

import { useCallback, useEffect, useState } from 'react';
import { api, bootstrapTokenFromUrl, type Health, type Meta } from './lib/api.ts';
import { useAsync, useTheme, useToasts } from './lib/hooks.ts';
import { Sidebar, TopBar, AlertBanner, useHashRoute, useUrlRange } from './components/shell.tsx';
import { ToastHost } from './components/ui.tsx';
import { OverviewPage } from './pages/Overview.tsx';
import { RequestsPage } from './pages/Requests.tsx';
import { SessionsPage } from './pages/Sessions.tsx';
import { SettingsPage } from './pages/Settings.tsx';

// 在首次请求之前完成令牌引导
bootstrapTokenFromUrl();

const TITLES: Record<string, string> = {
  overview: '概览',
  requests: '请求明细',
  sessions: '会话',
  settings: '设置',
};

export function App() {
  const [route, navigate] = useHashRoute();
  const [range, setRange] = useUrlRange();
  const theme = useTheme();
  const { toasts, push, dismiss } = useToasts();
  const [refreshKey, setRefreshKey] = useState(0);
  const [openRequestId, setOpenRequestId] = useState<string | null>(null);

  const health = useAsync<Health>(async () => api.health(), [refreshKey], { pollMs: 10_000 });
  const meta = useAsync<Meta>(async () => (await api.meta()).data, [refreshKey], { pollMs: 30_000 });

  const reloadAll = useCallback(() => setRefreshKey((k) => k + 1), []);

  // 首次加载完成后，若 health 失败给出明确提示（不静默）
  useEffect(() => {
    if (health.error) {
      push('error', `无法连接网关 API：${health.error.message}`);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [health.error]);

  // 快捷键：g+o / g+r / g+s 跳转；Esc 关抽屉
  useEffect(() => {
    let pendingG = false;
    const onKey = (e: KeyboardEvent): void => {
      const target = e.target as HTMLElement | null;
      const typing = target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable);
      if (typing) return;
      if (e.key === 'Escape') { setOpenRequestId(null); return; }
      if (e.key === 'g') { pendingG = true; setTimeout(() => { pendingG = false; }, 800); return; }
      if (pendingG) {
        if (e.key === 'o') navigate('overview');
        else if (e.key === 'r') navigate('requests');
        else if (e.key === 's') navigate('settings');
        pendingG = false;
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [navigate]);

  const h = health.data;

  return (
    <div className="sgw-shell flex" style={{ gap: 'var(--sgw-shell-gap)' }}>
      <Sidebar route={route} onNavigate={navigate} health={h} />

      <div
        className="flex min-w-0 flex-1 flex-col"
        style={{
          overflow: 'hidden',
          paddingTop: 'var(--sgw-shell-gap)',
          paddingRight: 'var(--sgw-shell-gap)',
          paddingBottom: 'var(--sgw-shell-gap)',
        }}
      >
        <TopBar
          title={TITLES[route] ?? '概览'}
          {...(route !== 'settings' ? { range, onRange: setRange } : {})}
          onRefresh={reloadAll}
          refreshing={health.loading || meta.loading}
          health={h}
          theme={{ mode: theme.mode, setMode: theme.setMode }}
        />

        <AlertBanner health={h} onOpenSettings={() => navigate('settings')} />

        <main
          className="min-h-0 flex-1 overflow-y-auto"
          style={{ padding: 'var(--sgw-space-4) 0 var(--sgw-space-8)' }}
        >
          <div className="mx-auto" style={{ maxWidth: 'var(--sgw-content-max)' }}>
            {route === 'overview' && (
              <OverviewPage
                range={range}
                refreshKey={refreshKey}
                onOpenRequest={(id) => { setOpenRequestId(id); navigate('requests'); }}
                onGoRequests={() => navigate('requests')}
              />
            )}
            {route === 'requests' && (
              <RequestsPage
                range={range}
                models={meta.data?.models ?? []}
                openId={openRequestId}
                onOpen={setOpenRequestId}
                refreshKey={refreshKey}
              />
            )}
            {route === 'sessions' && (
              <SessionsPage range={range} refreshKey={refreshKey} onOpenRequest={setOpenRequestId} />
            )}
            {route === 'settings' && (
              <SettingsPage
                health={h}
                refreshKey={refreshKey}
                reloadAll={reloadAll}
                toast={push}
              />
            )}
          </div>
        </main>
      </div>

      <ToastHost toasts={toasts} dismiss={dismiss} />
    </div>
  );
}
