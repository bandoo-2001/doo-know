import { test as base, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import Database from 'better-sqlite3';

// Cases share a temporary app, but each starts with its own authentication request budget.
// Keep production rate limits unchanged; authentication throttling has separate server tests.
export const test = base.extend<{ _authBudget: void }>({
  _authBudget: [
    async ({}, use) => {
      const config = JSON.parse(await readFile('.local/e2e-config.json', 'utf8'));
      const root = dirname(resolve(config.dataRoot));
      if (
        dirname(root) !== resolve(tmpdir()) ||
        !basename(root).startsWith('dooknow-browser-') ||
        dirname(resolve(config.knowledgeRoot)) !== root
      ) {
        throw Error('Browser fixture must use its own temporary data directory');
      }
      const db = new Database(join(root, 'data/app.sqlite'), { fileMustExist: true });
      try {
        db.prepare('DELETE FROM "rateLimit"').run();
      } finally {
        db.close();
      }
      await use();
    },
    { auto: true },
  ],
});
export { expect };
