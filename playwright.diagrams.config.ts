import { defineConfig, devices } from '@playwright/test';
export default defineConfig({
  testDir: 'tests/e2e',
  testMatch: 'mindmap-adapter.spec.ts',
  workers: 1,
  timeout: 60000,
  use: { baseURL: 'http://127.0.0.1:4196', trace: 'retain-on-failure' },
  projects: [{ name: 'desktop', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command:
      'npx vite --config tests/support/mindmap-vite.config.ts --host 127.0.0.1 --port 4196 --strictPort',
    url: 'http://127.0.0.1:4196',
    reuseExistingServer: false,
  },
});
