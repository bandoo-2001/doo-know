import { defineConfig } from '@playwright/test';
import base from './playwright.to-doo-visual.config';
export default defineConfig({
  ...base,
  testMatch: 'to-doo-cohesion-comparison.spec.ts',
  outputDir: '.local/to-doo-cohesion-results',
  timeout: 180000,
  webServer:
    base.webServer && !Array.isArray(base.webServer)
      ? { ...base.webServer, cwd: process.cwd() }
      : base.webServer,
});
