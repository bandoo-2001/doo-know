import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: 'tests/setup-feedback',
  testMatch: 'setup-feedback.spec.ts',
  workers: 1,
  timeout: 60000,
  use: { baseURL: 'http://127.0.0.1:4591', trace: 'retain-on-failure' },
  projects: [
    { name: 'desktop', use: { viewport: { width: 1440, height: 1000 } } },
    {
      name: 'phone320',
      use: { viewport: { width: 320, height: 844 }, isMobile: true, hasTouch: true },
    },
    {
      name: 'phone390',
      use: { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true },
    },
  ],
  webServer: {
    command: 'npx tsx tests/support/setup-feedback-fixture.ts',
    url: 'http://127.0.0.1:4591',
    reuseExistingServer: false,
    timeout: 120000,
    gracefulShutdown: { signal: 'SIGTERM', timeout: 15000 },
  },
});
