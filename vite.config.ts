import { resolve } from 'node:path';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

/**
 * UI 构建配置（Dashboard 主工作区 + Popup 启动器）。
 *
 * 初学者注意：
 * - Chrome 扩展不认 Vite 的 dev server，必须先 `npm run build` 产出 dist/ 再手动加载。
 * - `rollupOptions.input` 决定产出几个 HTML 入口；每个入口对应 manifest 里的一个页面。
 * - `outDir: 'dist'` 且 `emptyOutDir: true` 会在每次构建时清空 dist/，
 *   但 Service Worker 是另一个配置构建的，所以 UI 构建必须放到 sw 构建之后执行（见 package.json 的 build 脚本）。
 */
export default defineConfig({
  plugins: [react()],
  // root 指向 src，这样入口 HTML 的产物路径就是 dist/dashboard/index.html，
  // 而不是 dist/src/dashboard/index.html（后者与 manifest 里的路径对不上）。
  root: resolve(__dirname, 'src'),
  // public 目录（manifest.json、icons）原样拷贝到 dist 根目录
  publicDir: resolve(__dirname, 'public'),
  resolve: {
    alias: {
      '@': resolve(__dirname, 'src'),
    },
  },
  build: {
    outDir: resolve(__dirname, 'dist'),
    emptyOutDir: true,
    target: 'es2022',
    chunkSizeWarningLimit: 4096,
    rollupOptions: {
      input: {
        dashboard: resolve(__dirname, 'src/dashboard/index.html'),
        popup: resolve(__dirname, 'src/popup/index.html'),
      },
      output: {
        entryFileNames: 'assets/[name].js',
        chunkFileNames: 'assets/[name]-[hash].js',
        assetFileNames: 'assets/[name]-[hash][extname]',
      },
    },
  },
});
