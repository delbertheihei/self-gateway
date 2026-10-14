import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwind from '@tailwindcss/vite';
import path from 'node:path';

/**
 * 前端构建配置。
 *
 * 两个刻意的选择：
 *   1. **不引入 TanStack Query / Recharts 等重依赖**（v1 权衡）。
 *      仪表盘的核心是"数字准确 + 能下钻"，用原生 fetch + 一段手写轮询/SSE 就够，
 *      图表用 SVG 手绘（面积图/柱状/环形各约 60 行）。
 *      好处：依赖极少、包体小、没有 React 19 兼容性风险；代价：图表功能朴素。
 *      若将来需要密集时序（>5 万点），再按 docs/03 §5.2 引入 uPlot。
 *   2. `base: './'` + 输出到网关可托管的位置，保证**单端口**（网关自己托管 SPA）。
 */
export default defineConfig({
  plugins: [react(), tailwind()],
  // ★ 必须用绝对路径 `'/'`，不能用 `'./'`。
  //   原因：本应用用 hash 路由（`#/requests`）。若资源是相对路径，
  //   在 `http://127.0.0.1:8787/#/requests` 下浏览器会把 `./assets/x.js`
  //   解析成 `http://127.0.0.1:8787/assets/x.js`（看起来对），
  //   但一旦路径形式变化（例如带尾斜杠的子路径）就会解析到错误目录。
  //   网关始终从根路径托管，因此绝对路径最稳。
  base: '/',
  resolve: {
    alias: {
      '@sgw/shared': path.resolve(__dirname, '../../packages/shared/src/index.ts'),
    },
  },
  server: {
    port: 5173,
    // 开发时把 API 与代理路径转发到网关，保留 HMR
    proxy: {
      '/_sgw': { target: 'http://127.0.0.1:8787', changeOrigin: false },
      '/v1': { target: 'http://127.0.0.1:8787', changeOrigin: false },
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    sourcemap: false,
    target: 'es2022',
    rollupOptions: {
      output: {
        entryFileNames: 'assets/[name]-[hash].js',
        chunkFileNames: 'assets/[name]-[hash].js',
        assetFileNames: 'assets/[name]-[hash][extname]',
      },
    },
  },
});
