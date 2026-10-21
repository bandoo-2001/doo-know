import { expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import projectConfig from '../playwright.config.js';

const execute = promisify(execFile);
const require = createRequire(import.meta.url);
const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";

// Playwright cannot deliver graceful shutdown signals on Windows.
it.skipIf(process.platform === 'win32')(
  'lets the managed web server remove its owned data directory during teardown',
  async () => {
    const root = await mkdtemp(join(tmpdir(), 'dooknow-webserver-lifecycle-'));
    const files = join(root, "fixture server's files"), data = join(root, 'data');
    const serverFile = join(files, 'server.mjs'), configFile = join(files, 'playwright.config.cjs');
    const playwright = JSON.stringify(require.resolve('@playwright/test'));
    const webServer = Array.isArray(projectConfig.webServer)
      ? projectConfig.webServer[0]
      : projectConfig.webServer;
    try {
      await mkdir(files);
      await writeFile(serverFile, `
        import { createServer } from 'node:http';
        import { mkdir, rm } from 'node:fs/promises';
        const data = ${JSON.stringify(data)};
        await mkdir(data);
        const server = createServer((_request, response) => response.end('ready'));
        for (const signal of ['SIGINT', 'SIGTERM']) {
          process.on(signal, async () => {
            server.closeAllConnections();
            await new Promise(resolve => server.close(resolve));
            await rm(data, { recursive: true, force: true });
            process.exit(0);
          });
        }
        server.listen(0, '127.0.0.1', () => {
          console.log('Fixture listening on ' + server.address().port);
        });
      `);
      await writeFile(join(files, 'ready.spec.cjs'), `
        const { test, expect } = require(${playwright});
        const { existsSync } = require('node:fs');
        test('owned fixture is ready', async ({ request }) => {
          expect(existsSync(${JSON.stringify(data)})).toBe(true);
          const response = await request.get('http://127.0.0.1:' + process.env.FIXTURE_PORT);
          expect(response.ok()).toBe(true);
        });
      `);
      await writeFile(configFile, `
        const { defineConfig } = require(${playwright});
        module.exports = defineConfig({
          testDir: ${JSON.stringify(files)},
          outputDir: ${JSON.stringify(join(root, 'results'))},
          workers: 1,
          timeout: 5000,
          globalTimeout: 15000,
          reporter: 'line',
          webServer: {
            command: ${JSON.stringify('exec ' + quote(process.execPath) + ' ' + quote(serverFile))},
            wait: { stdout: /Fixture listening on (?<fixture_port>\\d+)/ },
            timeout: 5000,
            gracefulShutdown: ${JSON.stringify(webServer?.gracefulShutdown)},
          },
        });
      `);
      await execute(process.execPath, [require.resolve('@playwright/test/cli'), 'test', '--config', configFile], {
        cwd: root,
        timeout: 20000,
      });
      expect(existsSync(data), 'managed teardown must let the fixture remove its data').toBe(false);
    } finally {
      // Only this test's newly allocated directory is eligible for fallback cleanup.
      await rm(root, { recursive: true, force: true });
    }
  },
  25000,
);
