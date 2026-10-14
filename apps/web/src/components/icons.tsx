/**
 * 图标集 —— 手写 SVG，零依赖（沿用 docs/03 §5 的取舍：不引图标库）。
 *
 * 统一规格（docs/04 §5.2）：
 *   - 24×24 viewBox，`stroke: currentColor`，线宽 1.75，圆头圆角
 *   - `width/height: 1em` 由外边距类或父级 CSS 控制，因此可直接继承字号与颜色
 *   - 一律 `aria-hidden`（纯装饰）；带语义的图标按钮必须自己写 `aria-label`
 *   - 文本符号不再混用作图标（字形基线在不同字体下会漂移）
 *
 * 这些都刻意保持极简：本仪表盘的视觉主角是数字（tabn 等宽），图标只做导航锚点。
 */

import type { SVGProps } from 'react';

type IconProps = SVGProps<SVGSVGElement>;

/** 公共属性：所有图标共用，避免每处重复 */
const base = (props: IconProps): IconProps => ({
  viewBox: '0 0 24 24',
  width: '1em',
  height: '1em',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.75,
  strokeLinecap: 'round',
  strokeLinejoin: 'round',
  'aria-hidden': true,
  focusable: false,
  ...props,
});

// ─────────────────────────────── 导航 ───────────────────────────────

/** 概览：四宫格（呼应 Bento 布局） */
export const IconOverview = (p: IconProps) => (
  <svg {...base(p)}>
    <rect x="3" y="3" width="7.5" height="7.5" rx="2" />
    <rect x="13.5" y="3" width="7.5" height="4.5" rx="2" />
    <rect x="3" y="13.5" width="7.5" height="7.5" rx="2" />
    <rect x="13.5" y="10.5" width="7.5" height="10.5" rx="2" />
  </svg>
);

/** 请求明细：列表 */
export const IconRequests = (p: IconProps) => (
  <svg {...base(p)}>
    <path d="M8 6h13M8 12h13M8 18h13" />
    <path d="M3.5 6h.01M3.5 12h.01M3.5 18h.01" />
  </svg>
);

/** 会话：对话气泡 + 时间 */
export const IconSessions = (p: IconProps) => (
  <svg {...base(p)}>
    <path d="M20 14.5a2.5 2.5 0 0 1-2.5 2.5H12l-4.5 3.5V17H6a2.5 2.5 0 0 1-2.5-2.5v-7A2.5 2.5 0 0 1 6 5h11.5A2.5 2.5 0 0 1 20 7.5Z" />
    <path d="M8 9.5h7M8 12.5h4" />
  </svg>
);

/** 设置：滑块 */
export const IconSettings = (p: IconProps) => (
  <svg {...base(p)}>
    <path d="M5 8h9M18.5 8H21M5 16h3M12.5 16H21" />
    <circle cx="16" cy="8" r="2.5" />
    <circle cx="10" cy="16" r="2.5" />
  </svg>
);

// ─────────────────────────────── 动作 ───────────────────────────────

export const IconRefresh = (p: IconProps) => (
  <svg {...base(p)}>
    <path d="M20.5 12a8.5 8.5 0 1 1-2.6-6.1" />
    <path d="M20.5 4v4.5H16" />
  </svg>
);

export const IconClose = (p: IconProps) => (
  <svg {...base(p)}>
    <path d="M6 6l12 12M18 6L6 18" />
  </svg>
);

export const IconArrowRight = (p: IconProps) => (
  <svg {...base(p)}>
    <path d="M5 12h13M13 6.5l5.5 5.5L13 17.5" />
  </svg>
);

// ─────────────────────────────── 状态 / 语义 ───────────────────────────────

/** 空状态：面积图轮廓 */
export const IconChart = (p: IconProps) => (
  <svg {...base(p)}>
    <path d="M3.5 20.5V4M3.5 20.5H21" />
    <path d="M7 16.5l3.8-4.6 3 2.4 5-6.4" />
  </svg>
);

/** 空状态：数据库 */
export const IconDatabase = (p: IconProps) => (
  <svg {...base(p)}>
    <ellipse cx="12" cy="6" rx="7.5" ry="3" />
    <path d="M4.5 6v12c0 1.66 3.36 3 7.5 3s7.5-1.34 7.5-3V6" />
    <path d="M4.5 12c0 1.66 3.36 3 7.5 3s7.5-1.34 7.5-3" />
  </svg>
);

/** 空状态：收件箱 */
export const IconInbox = (p: IconProps) => (
  <svg {...base(p)}>
    <path d="M3.5 12.5 6 5.5A1.5 1.5 0 0 1 7.4 4.5h9.2A1.5 1.5 0 0 1 18 5.5l2.5 7v5a1.5 1.5 0 0 1-1.5 1.5H5a1.5 1.5 0 0 1-1.5-1.5Z" />
    <path d="M3.5 12.5H9a3 3 0 0 0 6 0h5.5" />
  </svg>
);

export const IconWarning = (p: IconProps) => (
  <svg {...base(p)}>
    <path d="M10.3 4.3 2.9 17.2A1.9 1.9 0 0 0 4.6 20h14.8a1.9 1.9 0 0 0 1.7-2.8L13.7 4.3a1.9 1.9 0 0 0-3.4 0Z" />
    <path d="M12 9.5v4.5M12 17.2h.01" />
  </svg>
);

export const IconCheckCircle = (p: IconProps) => (
  <svg {...base(p)}>
    <circle cx="12" cy="12" r="8.5" />
    <path d="M8.5 12.3l2.4 2.4 4.6-5" />
  </svg>
);

export const IconInfo = (p: IconProps) => (
  <svg {...base(p)}>
    <circle cx="12" cy="12" r="8.5" />
    <path d="M12 11v5.5M12 7.8h.01" />
  </svg>
);

export const IconFile = (p: IconProps) => (
  <svg {...base(p)}>
    <path d="M14 3.5H7.5A1.5 1.5 0 0 0 6 5v14a1.5 1.5 0 0 0 1.5 1.5h9A1.5 1.5 0 0 0 18 19V7.5Z" />
    <path d="M14 3.5V7.5H18" />
  </svg>
);
