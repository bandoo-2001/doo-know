import { expect, it } from 'vitest';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { openDatabase } from '../packages/core/db.js';
import { guardedProcess } from '../packages/core/processes/guarded.js';
import { workspaceExclusive, workspacePermit } from '../packages/core/workspace/gate.js';

it('does not execute a workload when its signal is already aborted', async () => {
  const root = await mkdtemp(join(tmpdir(), 'guarded-preaborted-'));
  const db = openDatabase(join(root, 'data')), marker = join(root, 'executed');
  const controller = new AbortController(); controller.abort();
  try {
    const outcome = await workspaceExclusive(db, { kind: 'fixture-already-aborted' }, async () =>
      guardedProcess(db, { kind: 'workspace', token: workspacePermit(db) }, process.execPath,
        ['-e', `require('node:fs').writeFileSync(${JSON.stringify(marker)},'workload executed')`],
        root, { signal: controller.signal, timeoutMs: 2000 }).wait);
    expect(existsSync(marker)).toBe(false);
    expect(outcome.code).not.toBe(0);
    expect(db.prepare('SELECT * FROM workspace_guards').all()).toEqual([]);
    expect(db.prepare('SELECT * FROM workspace_gate').all()).toEqual([]);
  } finally { db.close(); await rm(root, { recursive: true, force: true }); }
});
