import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: 'tests/public-final',
  workers: 1,
  timeout: 90000,
  use: { baseURL: 'http://127.0.0.1:4779', colorScheme: 'light', trace: 'retain-on-failure' },
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
    command:
      'DOOKNOW_E2E_WEB_PORT=4779 DOOKNOW_E2E_API_PORT=4780 VITE_DOCUMENT_EDITOR_ENABLED=true npx tsx tests/support/e2e-server.ts',
    url: 'http://127.0.0.1:4779',
    reuseExistingServer: false,
    timeout: 120000,
    gracefulShutdown: { signal: 'SIGTERM', timeout: 15000 },
  },
});
