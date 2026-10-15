import { it, expect } from 'vitest';
import { createFixture } from './support/fixture.js';
import { acquireInstance, readInstance } from '../apps/server/platform/instance.js';
it('refuses a second live owner for one database and releases only its own instance token', async () => {
  const f = await createFixture();
  let release: (() => void) | undefined;
  try {
    release = acquireInstance(f.config, 'fixture-version');
    expect(readInstance(f.dataRoot)?.version).toBe('fixture-version');
    expect(() => acquireInstance(f.config, 'other-version')).toThrowError(/已有/);
    release();
    release = undefined;
    expect(readInstance(f.dataRoot)).toBeUndefined();
  } finally {
    release?.();
    await f.close();
  }
});
it('checks process ownership without migrating an older database', async () => {
  const { mkdtemp, rm } = await import('node:fs/promises'),
    { tmpdir } = await import('node:os'),
    { join } = await import('node:path'),
    { default: Database } = await import('better-sqlite3'),
    { activeDatabaseProcesses } = await import('../apps/server/platform/instance.js');
  const root = await mkdtemp(join(tmpdir(), 'ownership-readonly-'));
  try {
    let db = new Database(join(root, 'app.sqlite'));
    db.exec('CREATE TABLE preserved_legacy_table(value TEXT)');
    db.close();
    expect(activeDatabaseProcesses(root)).toEqual([]);
    db = new Database(join(root, 'app.sqlite'));
    try {
      expect(db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all()).toEqual([
        { name: 'preserved_legacy_table' },
      ]);
    } finally {
      db.close();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
