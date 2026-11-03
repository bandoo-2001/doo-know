import { defineConfig, devices } from '@playwright/test';
import base from './playwright.config';
import { VISUAL_NOW } from './tests/support/to-doo-visual-fixture';
const server = base.webServer;
if (!server || Array.isArray(server))
  throw Error('Visual acceptance requires the isolated browser server');
export default defineConfig({
  ...base,
  testDir: 'tests/visual',
  outputDir: '.local/to-doo-visual-results',
  timeout: 600000,
  webServer: { ...server, env: { ...server.env, DOOKNOW_E2E_FIXED_TIME: VISUAL_NOW } },
  projects: [
    {
      name: 'desktop',
      use: {
        ...devices['Desktop Chrome'],
        viewport: { width: 1440, height: 1000 },
        deviceScaleFactor: 1,
        timezoneId: 'UTC',
        locale: 'zh-CN',
      },
    },
  ],
});
