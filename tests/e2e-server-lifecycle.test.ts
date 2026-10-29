import { expect, it } from 'vitest';
import { execFile, spawn } from 'node:child_process';
import { closeSync, constants, existsSync, openSync } from 'node:fs';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import projectConfig from '../playwright.config.js';

const execute = promisify(execFile);
const require = createRequire(import.meta.url);
const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";

function startActualFixture(cwd: string, temporary: string) {
  const token = randomUUID();
  const child = spawn(
    process.execPath,
    ['--import', require.resolve('tsx'), resolve('tests/support/e2e-server.ts')],
    {
      cwd,
      env: {
        ...process.env,
        TMPDIR: temporary,
        TSX_DISABLE_CACHE: '1',
        DOOKNOW_E2E_PRODUCTION: '0',
        DOOKNOW_E2E_SEARCH_RUNTIME: '0',
        DOOKNOW_E2E_GIT_ONBOARDING: '0',
        DOOKNOW_E2E_PORT: '0',
        DOOKNOW_E2E_READY_TOKEN: token,
      },
      stdio: ['pipe', 'ignore', 'pipe', 'ipc'],
    },
  );
  let stderr = '';
  child.stderr.on('data', (bytes) => {
    stderr = (stderr + bytes).slice(-16384);
  });
  const exit = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
    (resolve, reject) => {
      child.once('error', reject);
      child.once('exit', (code, signal) => resolve({ code, signal }));
    },
  );
  let ready: { port: number } | undefined;
  child.on('message', (message: any) => {
    if (
      message?.type === 'dooknow-e2e-ready' &&
      message.token === token &&
      message.pid === child.pid &&
      Number.isInteger(message.port) &&
      message.port > 0 &&
      message.port <= 65535
    )
      ready = { port: message.port };
  });
  return { child, exit, stderr: () => stderr, ready: () => ready };
}

async function waitForFixture(
  fixture: ReturnType<typeof startActualFixture>,
  condition: () => Promise<boolean>,
) {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    if (fixture.child.exitCode !== null || fixture.child.signalCode !== null)
      throw Error('Actual fixture exited before the checkpoint: ' + fixture.stderr());
    if (await condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw Error('Actual fixture did not reach the startup checkpoint: ' + fixture.stderr());
}

async function waitForFixtureExit(fixture: ReturnType<typeof startActualFixture>) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      fixture.exit,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(Error('Actual fixture did not exit within 5 seconds: ' + fixture.stderr())),
          5000,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function stopOwnedFixture(fixture: ReturnType<typeof startActualFixture>) {
  if (fixture.child.exitCode === null && fixture.child.signalCode === null)
    fixture.child.kill('SIGKILL');
  await waitForFixtureExit(fixture);
  fixture.child.stdin.destroy();
}

it.skipIf(process.platform !== 'linux')(
  'cleans the actual fixture when SIGTERM arrives during initialization',
  async () => {
    const root = await mkdtemp(join(tmpdir(), 'dooknow-startup-signal-'));
    const temporary = join(root, 'temporary');
    const fifo = join(root, '.local/e2e-config.json');
    let fixture: ReturnType<typeof startActualFixture> | undefined;
    let reader: number | undefined;
    try {
      await mkdir(temporary);
      await writeFile(join(temporary, 'keep.txt'), 'keep sibling\n');
      await mkdir(join(root, '.local'));
      await execute('mkfifo', ['-m', '600', fifo]);
      fixture = startActualFixture(root, temporary);
      await waitForFixture(fixture, async () => {
        const roots = (await readdir(temporary)).filter((name) =>
          name.startsWith('dooknow-browser-'),
        );
        if (roots.length !== 1 || !existsSync(join(temporary, roots[0], 'remote.git/HEAD')))
          return false;
        const threads = await readdir('/proc/' + fixture!.child.pid + '/task');
        const states = await Promise.all(
          threads.map((tid) =>
            readFile('/proc/' + fixture!.child.pid + '/task/' + tid + '/wchan', 'utf8').catch(
              () => '',
            ),
          ),
        );
        return states.some((state) => state.trim() === 'wait_for_partner');
      });
      fixture.child.kill('SIGTERM');
      // Release only this test's blocked filesystem operation so initialization can settle.
      reader = openSync(fifo, constants.O_RDONLY | constants.O_NONBLOCK);
      const result = await waitForFixtureExit(fixture);
      expect(
        await readdir(temporary),
        'initialization cancellation must not leave owned data',
      ).toEqual(['keep.txt']);
      expect(result).toEqual({ code: 0, signal: null });
      expect(await readFile(join(temporary, 'keep.txt'), 'utf8')).toBe('keep sibling\n');
    } finally {
      if (fixture) await stopOwnedFixture(fixture);
      if (reader !== undefined) closeSync(reader);
      await rm(root, { recursive: true, force: true });
    }
  },
  30000,
);

it.skipIf(process.platform === 'win32')(
  'cleans the actual Vite fixture after a graceful shutdown',
  async () => {
    const root = await mkdtemp(join(tmpdir(), 'dooknow-actual-vite-'));
    const temporary = join(root, 'temporary');
    let fixture: ReturnType<typeof startActualFixture> | undefined;
    const unrelated = createServer((_request, response) => {
      response.setHeader('content-type', 'application/json');
      response.end('null');
    });
    try {
      await new Promise<void>((resolve) => unrelated.listen(0, '127.0.0.1', resolve));
      const unrelatedPort = (unrelated.address() as { port: number }).port;
      const unrelatedResponse = await fetch(`http://127.0.0.1:${unrelatedPort}/api/auth/get-session`);
      expect(unrelatedResponse.ok).toBe(true);
      expect(await unrelatedResponse.json()).toBe(null);
      await mkdir(temporary);
      await writeFile(join(temporary, 'keep.txt'), 'keep sibling\n');
      await writeFile(
        join(root, 'vite.config.ts'),
        'export { default } from ' + JSON.stringify(resolve('vite.config.ts')) + ';\n',
      );
      fixture = startActualFixture(root, temporary);
      // An unrelated 200/null responder cannot establish readiness of this child.
      await waitForFixture(fixture, async () => fixture!.ready() !== undefined);
      const { port } = fixture.ready()!;
      expect(port).not.toBe(unrelatedPort);
      const response = await fetch(`http://127.0.0.1:${port}/api/auth/get-session`, {
        signal: AbortSignal.timeout(1000),
      });
      expect(response.ok).toBe(true);
      expect(await response.json()).toBe(null);
      expect(
        (await readdir(temporary)).some((name) => name.startsWith('dooknow-browser-')),
        'the owned child must initialize browser data before shutdown',
      ).toBe(true);
      fixture.child.kill('SIGTERM');
      const result = await waitForFixtureExit(fixture);
      expect(
        await readdir(temporary),
        'Vite must not exit before application data cleanup completes',
      ).toEqual(['keep.txt']);
      expect(result).toEqual({ code: 0, signal: null });
      expect(await readFile(join(temporary, 'keep.txt'), 'utf8')).toBe('keep sibling\n');
      await expect(
        fetch(`http://127.0.0.1:${port}/api/auth/get-session`, {
          signal: AbortSignal.timeout(1000),
        }),
      ).rejects.toThrow();
      expect((await fetch(`http://127.0.0.1:${unrelatedPort}/api/auth/get-session`)).ok).toBe(true);
    } finally {
      if (fixture) await stopOwnedFixture(fixture);
      unrelated.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        unrelated.close((error) => (error ? reject(error) : resolve())),
      );
      await rm(root, { recursive: true, force: true });
    }
  },
  30000,
);

it.each([
  { conflict: '.local', errorCode: 'EEXIST' },
  { conflict: '.local/e2e-config.json', errorCode: 'EISDIR' },
])(
  'removes its owned browser data when setup fails at $conflict',
  async ({ conflict, errorCode }) => {
    const root = await mkdtemp(join(tmpdir(), 'dooknow-startup-cleanup-'));
    const temporary = join(root, 'temporary');
    const sentinel = join(temporary, 'keep.txt');
    let fixture: ReturnType<typeof startActualFixture> | undefined;
    try {
      await mkdir(temporary);
      await writeFile(sentinel, 'unrelated sibling must survive\n');
      if (conflict === '.local')
        await writeFile(join(root, '.local'), 'preserve conflicting file\n');
      else await mkdir(join(root, conflict), { recursive: true });
      fixture = startActualFixture(root, temporary);
      const result = await waitForFixtureExit(fixture);
      expect(result).toEqual({ code: 1, signal: null });
      expect(fixture.stderr()).toContain(errorCode);
      expect(
        await readdir(temporary),
        'failed startup must retire its newly allocated browser directory',
      ).toEqual(['keep.txt']);
      expect(await readFile(sentinel, 'utf8')).toBe('unrelated sibling must survive\n');
      if (conflict === '.local')
        expect(await readFile(join(root, '.local'), 'utf8')).toBe('preserve conflicting file\n');
    } finally {
      if (fixture) await stopOwnedFixture(fixture);
      // This parent was allocated by this test, never read from an old fixture config.
      await rm(root, { recursive: true, force: true });
    }
  },
  20000,
);

// Playwright cannot deliver graceful shutdown signals on Windows.
it.skipIf(process.platform === 'win32')(
  'lets the managed web server remove its owned data directory during teardown',
  async () => {
    const root = await mkdtemp(join(tmpdir(), 'dooknow-webserver-lifecycle-'));
    const files = join(root, "fixture server's files"),
      data = join(root, 'data');
    const serverFile = join(files, 'server.mjs'),
      configFile = join(files, 'playwright.config.cjs');
    const playwright = JSON.stringify(require.resolve('@playwright/test'));
    const webServer = Array.isArray(projectConfig.webServer)
      ? projectConfig.webServer[0]
      : projectConfig.webServer;
    try {
      await mkdir(files);
      await writeFile(
        serverFile,
        `
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
      `,
      );
      await writeFile(
        join(files, 'ready.spec.cjs'),
        `
        const { test, expect } = require(${playwright});
        const { existsSync } = require('node:fs');
        test('owned fixture is ready', async ({ request }) => {
          expect(existsSync(${JSON.stringify(data)})).toBe(true);
          const response = await request.get('http://127.0.0.1:' + process.env.FIXTURE_PORT);
          expect(response.ok()).toBe(true);
        });
      `,
      );
      await writeFile(
        configFile,
        `
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
      `,
      );
      await execute(
        process.execPath,
        [require.resolve('@playwright/test/cli'), 'test', '--config', configFile],
        {
          cwd: root,
          timeout: 20000,
        },
      );
      expect(existsSync(data), 'managed teardown must let the fixture remove its data').toBe(false);
    } finally {
      // Only this test's newly allocated directory is eligible for fallback cleanup.
      await rm(root, { recursive: true, force: true });
    }
  },
  25000,
);
