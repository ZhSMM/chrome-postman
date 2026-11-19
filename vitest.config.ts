import { resolve } from 'node:path';
import { defineConfig } from 'vitest/config';

/**
 * 单元测试配置。
 * - environment: 'node'，因为核心逻辑（变量引擎/沙箱/执行器）不依赖 DOM。
 * - sandbox.ts 依赖 quickjs-emscripten，它在 Node 下同样可用（用 WASM 运行）。
 */
export default defineConfig({
  resolve: {
    alias: {
      '@': resolve(__dirname, 'src'),
    },
  },
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    testTimeout: 30000,
    hookTimeout: 30000,
  },
});
