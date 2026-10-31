import { defineConfig, devices } from '@playwright/test';
export default defineConfig({
  testDir: 'tests/fixtures/png-preview-privacy',
  testMatch: 'png-preview-privacy.spec.ts',
  workers: 1,
  timeout: 60000,
  use: { baseURL: 'http://127.0.0.1:4198', trace: 'retain-on-failure' },
  projects: [{ name: 'desktop', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command:
      'npx vite --config tests/support/png-preview-vite.config.ts --host 127.0.0.1 --port 4198 --strictPort',
    url: 'http://127.0.0.1:4198',
    reuseExistingServer: false,
  },
});
