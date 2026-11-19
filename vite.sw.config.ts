import { resolve } from 'node:path';
import { defineConfig } from 'vite';

/**
 * Service Worker 独立构建配置。
 *
 * 为什么必须单独构建？
 * - MV3 的 Service Worker 是单文件入口，manifest 里写死一个路径，不能依赖代码分块（chunk）。
 * - 因此这里用 lib 模式 + inlineDynamicImports，把所有依赖（含 QuickJS 的 wasm 胶水代码）
 *   全部打进一个 background.js。
 * - format 用 'es'，配合 manifest 里的 `"type": "module"`。
 */
export default defineConfig({
  resolve: {
    alias: {
      '@': resolve(__dirname, 'src'),
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: false, // 关键：不能清空 dist，否则会删掉 UI 产物
    target: 'es2022',
    lib: {
      entry: resolve(__dirname, 'src/background/service-worker.ts'),
      formats: ['es'],
      fileName: () => 'background.js',
    },
    rollupOptions: {
      output: {
        inlineDynamicImports: true,
        entryFileNames: 'background.js',
      },
    },
  },
});
