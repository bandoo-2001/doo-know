import { defineConfig, devices } from '@playwright/test';
const webPort = Number(process.env.DOOKNOW_E2E_WEB_PORT || 4179);
const baseURL = `http://127.0.0.1:${webPort}`;
export default defineConfig({
  testDir: 'tests/e2e',
  fullyParallel: false,
  workers: 1,
  timeout: 45000,
  use: { baseURL, trace: 'retain-on-failure' },
  projects: [
    { name: 'desktop', use: { ...devices['Desktop Chrome'] } },
    { name: 'mobile', use: { ...devices['iPhone 13'], defaultBrowserType: 'chromium' } },
  ],
  webServer: {
    command: 'npx tsx tests/support/e2e-server.ts',
    url: baseURL,
    reuseExistingServer: false,
    timeout: 120000,
    gracefulShutdown: { signal: 'SIGTERM', timeout: 5000 },
  },
});
