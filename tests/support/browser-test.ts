import { test as base, expect, type Page, type TestInfo } from '@playwright/test';
import { appendFile, readFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import Database from 'better-sqlite3';
import { trackFileOperationCase } from './file-operations';

// Cases share a temporary app, but each starts with its own authentication request budget.
// Keep production rate limits unchanged; authentication throttling has separate server tests.
export const test = base.extend<{
  _authBudget: void;
  sourceEditorPreference: boolean;
  _failureDiagnostics: void;
  _fileOperationBudget: void;
}>({
  _fileOperationBudget: [
    async ({ browser: _browser }, use, info) => {
      const cleanup = trackFileOperationCase(info);
      try { await use(); }
      finally { cleanup(); }
    },
    { auto: true },
  ],
  sourceEditorPreference: [false, { option: true }],
  _failureDiagnostics: [
    async ({ page }, use, info) => {
      await use();
      await collectFailureProbes(page, info);
    },
    { auto: true },
  ],
  _authBudget: [
    async ({ context, sourceEditorPreference }, use) => {
      const config = JSON.parse(await readFile('.local/e2e-config.json', 'utf8'));
      const root = dirname(resolve(config.dataRoot));
      if (
        dirname(root) !== resolve(tmpdir()) ||
        !basename(root).startsWith('dooknow-browser-') ||
        dirname(resolve(config.knowledgeRoot)) !== root
      ) {
        throw Error('Browser fixture must use its own temporary data directory');
      }
      const db = new Database(join(root, 'data/app.sqlite'), { fileMustExist: true, timeout: 30000 });
      let ownerId: string | undefined;
      try {
        db.prepare('DELETE FROM "rateLimit"').run();
        if (sourceEditorPreference)
          ownerId = (db.prepare('SELECT id FROM user LIMIT 1').get() as { id: string } | undefined)
            ?.id;
      } finally {
        db.close();
      }
      if (sourceEditorPreference) {
        if (!ownerId) throw Error('Source preference requires the isolated fixture owner');
        await context.addInitScript(
          ({ key, origin }) => {
            if (location.origin === origin && localStorage.getItem(key) === null)
              localStorage.setItem(key, JSON.stringify({ editorKind: 'source', mode: 'edit' }));
          },
          {
            key: 'dooknow.preferences.v1:' + encodeURIComponent(ownerId),
            origin: config.origin || 'http://127.0.0.1:4179',
          },
        );
      }
      await use();
    },
    { auto: true },
  ],
});
export { expect };

async function collectFailureProbes(page: Page, info: TestInfo) {
  if (!process.env.DOOKNOW_E2E_DIAGNOSTICS) return;
  if (info.status === info.expectedStatus || info.status === 'skipped') return;
  const config = JSON.parse(await readFile('.local/e2e-config.json', 'utf8'));
  const cookie = (
    JSON.parse(await readFile('.local/e2e-cookies.json', 'utf8')) as {
      name: string;
      value: string;
    }[]
  )
    .map((value) => `${value.name}=${value.value}`)
    .join('; ');
  await appendFile(
    process.env.DOOKNOW_E2E_DIAGNOSTICS!,
    JSON.stringify({
      kind: 'failure-probes-start',
      test: info.title,
      status: info.status,
    }) + '\n',
    { mode: 0o600 },
  );
  async function probe(work: () => Promise<unknown>) {
    const at = performance.now();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const result = await Promise.race([
        work(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error('probe-timeout')), 4000);
        }),
      ]);
      return { result, milliseconds: Math.round(performance.now() - at) };
    } catch (error) {
      return {
        error: error instanceof Error ? error.name : 'error',
        milliseconds: Math.round(performance.now() - at),
      };
    } finally {
      clearTimeout(timer);
    }
  }
  const result = await Promise.all([
    probe(
      async () =>
        (
          await fetch(config.origin + '/api/platform/status', {
            headers: { cookie },
            signal: AbortSignal.timeout(3000),
          })
        ).status,
    ),
    probe(async () => (await page.request.get('/api/platform/status', { timeout: 3000 })).status()),
    probe(() =>
      page.evaluate(async () => {
        const response = await fetch('/api/platform/status', {
          cache: 'no-store',
          signal: AbortSignal.timeout(3000),
        });
        return response.status;
      }),
    ),
  ]);
  await appendFile(
    process.env.DOOKNOW_E2E_DIAGNOSTICS!,
    JSON.stringify({
      kind: 'failure-probes',
      test: info.title,
      status: info.status,
      nodeHttp: result[0],
      contextHttp: result[1],
      rendererFetch: result[2],
    }) + '\n',
    { mode: 0o600 },
  );
}
