import { defineConfig } from 'vitest/config';
export default defineConfig({
  test: {
    globalSetup: ['scripts/test-process-runner.mjs'],
    include: ['tests/**/*.test.ts'],
    testTimeout: 30000,
    hookTimeout: 30000,
    fileParallelism: false,
  },
});
