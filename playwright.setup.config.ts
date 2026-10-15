import { defineConfig, devices } from '@playwright/test';
export default defineConfig({ testDir: 'tests/platform-browser', workers: 1, timeout: 45000,
  use: { baseURL: 'http://127.0.0.1:4178', trace: 'retain-on-failure' },
  projects: [{ name: 'desktop', use: devices['Desktop Chrome'] },
    { name: 'mobile', use: { ...devices['iPhone 13'], defaultBrowserType: 'chromium' } }],
  webServer: { command: 'npx tsx tests/support/setup-e2e-server.ts', url: 'http://127.0.0.1:4178', timeout: 120000, reuseExistingServer: false } });
