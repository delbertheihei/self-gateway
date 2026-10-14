/**
 * React 数据获取与主题。
 *
 * 为什么不用 TanStack Query（docs/03 §5.3 的取舍）：
 *   本仪表的读取模式很简单：一个"当前时间范围 + 各种维度"，加上 SSE/轮询刷新。
 *   一个 40 行的 `useAsync` 就够，省掉一个依赖与 React 19 兼容性风险。
 *   若将来要做复杂的缓存失效与乐观更新，再引入 Query 也不迟（接口形状已对齐）。
 */

import { useCallback, useEffect, useRef, useState } from 'react';

export interface AsyncState<T> {
  data: T | null;
  error: Error | null;
  loading: boolean;
  /** 首次加载完成前为 true（用于骨架屏） */
  initial: boolean;
  reload: () => void;
}

/** 带自动重载的异步取数 */
export function useAsync<T>(
  fn: () => Promise<T>,
  deps: unknown[],
  opts: { pollMs?: number; enabled?: boolean } = {},
): AsyncState<T> {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<Error | null>(null);
  const [loading, setLoading] = useState(true);
  const [initial, setInitial] = useState(true);
  const [nonce, setNonce] = useState(0);
  const alive = useRef(true);
  const fnRef = useRef(fn);
  fnRef.current = fn;

  const enabled = opts.enabled !== false;

  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; };
  }, []);

  const run = useCallback(async () => {
    if (!enabled) { setLoading(false); setInitial(false); return; }
    setLoading(true);
    try {
      const r = await fnRef.current();
      if (!alive.current) return;
      setData(r);
      setError(null);
    } catch (e) {
      if (!alive.current) return;
      setError(e as Error);
    } finally {
      if (alive.current) { setLoading(false); setInitial(false); }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled]);

  useEffect(() => {
    void run();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, nonce, run]);

  useEffect(() => {
    if (!opts.pollMs || !enabled) return;
    const t = setInterval(() => { void run(); }, opts.pollMs);
    return () => clearInterval(t);
  }, [opts.pollMs, enabled, run]);

  const reload = useCallback(() => { setNonce((n) => n + 1); }, []);
  return { data, error, loading, initial, reload };
}

// ─────────────────────────────── 主题 ───────────────────────────────

export type ThemeMode = 'system' | 'dark' | 'light';
const THEME_KEY = 'sgw.theme';

function systemPrefers(): 'dark' | 'light' {
  return window.matchMedia?.('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
}

export function applyTheme(mode: ThemeMode): void {
  const resolved = mode === 'system' ? systemPrefers() : mode;
  document.documentElement.setAttribute('data-theme', resolved);
}

export function useTheme(): { mode: ThemeMode; setMode: (m: ThemeMode) => void; resolved: 'dark' | 'light' } {
  const [mode, setModeState] = useState<ThemeMode>(() => {
    try { return (localStorage.getItem(THEME_KEY) as ThemeMode) ?? 'system'; } catch { return 'system'; }
  });
  const [resolved, setResolved] = useState<'dark' | 'light'>(() => (mode === 'system' ? systemPrefers() : mode));

  useEffect(() => {
    const r = mode === 'system' ? systemPrefers() : mode;
    setResolved(r);
    applyTheme(mode);
    try { localStorage.setItem(THEME_KEY, mode); } catch { /* 忽略 */ }
  }, [mode]);

  // 跟随系统变化（仅 system 模式）
  useEffect(() => {
    if (mode !== 'system') return;
    const mq = window.matchMedia('(prefers-color-scheme: light)');
    const onChange = (): void => { const r = systemPrefers(); setResolved(r); applyTheme('system'); };
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, [mode]);

  return { mode, setMode: setModeState, resolved };
}

// ─────────────────────────────── 防抖 ───────────────────────────────

export function useDebounced<T>(value: T, ms = 300): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

/** 轻量 toast */
export interface Toast { id: number; kind: 'ok' | 'warn' | 'error'; text: string }

export function useToasts(): {
  toasts: Toast[];
  push: (kind: Toast['kind'], text: string) => void;
  dismiss: (id: number) => void;
} {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const push = useCallback((kind: Toast['kind'], text: string) => {
    const id = Date.now() + Math.random();
    setToasts((t) => [...t.slice(-2), { id, kind, text }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 4200);
  }, []);
  const dismiss = useCallback((id: number) => setToasts((t) => t.filter((x) => x.id !== id)), []);
  return { toasts, push, dismiss };
}
