import { expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase } from '../packages/core/db';
import { workspaceExclusive } from '../packages/core/workspace/gate';

it('blocks Git and backup checkpoints while a committed To Doo transaction still needs files', async () => {
  const root = await mkdtemp(join(tmpdir(), 'to-doo-gate-'));
  const db = openDatabase(root);
  try {
    db.exec(
      "CREATE TABLE todo_pending_files(kind TEXT NOT NULL,id TEXT NOT NULL,PRIMARY KEY(kind,id)); INSERT INTO todo_pending_files VALUES('task','pending-task')",
    );
    await expect(
      workspaceExclusive(db, { kind: 'backup' }, async () => 'unsafe'),
    ).rejects.toMatchObject({ code: 'RECOVERY_REQUIRED' });
    db.prepare('DELETE FROM todo_pending_files').run();
    expect(await workspaceExclusive(db, { kind: 'backup' }, async () => 'complete')).toBe(
      'complete',
    );
  } finally {
    db.close();
    await rm(root, { recursive: true, force: true });
  }
});
