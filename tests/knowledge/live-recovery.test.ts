import { it, expect } from 'vitest';
import { createFixture } from '../support/fixture.js';
import { openDatabase } from '../../server/db.js';
import { mutationCore, webPrincipal } from '../../server/knowledge/core.js';
import { beginOperation, sha256 } from '../../server/knowledge/operations.js';
it('does not reconcile another live committing worker and settles an expired unapplied intent once', async () => {
  const f = await createFixture(),
    db = openDatabase(f.dataRoot);
  try {
    const core = mutationCore(f.config, db),
      n = core.create(webPrincipal, '00-Inbox', 'live.md', 'ORIGINAL', 'live-create'),
      op = beginOperation(db, webPrincipal, 'patch', 'live-patch', { id: n.id }).operation;
    db.prepare(
      "INSERT INTO write_intents(id,note_id,path,kind,original_hash,target_hash,status) VALUES(?,?,?,'patch',?,?,'prepared')",
    ).run(op.id, n.id, '00-Inbox/live.md', sha256('ORIGINAL'), sha256('CHANGED'));
    db.prepare(
      "INSERT INTO file_operations(id,note_id,kind,status,payload,created_at,deadline,lease_until,worker_id) VALUES(?,?,'patch','committing','{}',?,?,?,'another-worker')",
    ).run(op.id, n.id, Date.now(), Date.now() + 300000, Date.now() + 60000);
    db.prepare("UPDATE operations SET status='committing' WHERE id=?").run(op.id);
    expect(await core.recover()).toEqual({ recovered: 0, unapplied: 0, conflicted: 0 });
    expect(
      (db.prepare('SELECT status FROM write_intents WHERE id=?').get(op.id) as any).status,
    ).toBe('prepared');
    db.prepare('UPDATE file_operations SET lease_until=0 WHERE id=?').run(op.id);
    expect((await core.recover()).unapplied).toBe(1);
    expect(
      (db.prepare('SELECT status FROM file_operations WHERE id=?').get(op.id) as any).status,
    ).toBe('failed');
    expect((await core.recover()).unapplied).toBe(0);
  } finally {
    db.close();
    await f.close();
  }
});
