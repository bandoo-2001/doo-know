import { it, expect } from 'vitest';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createFixture, loginFixtureOwner } from '../support/fixture.js';
import { openDatabase } from '../../server/db.js';
import { noteService } from '../../server/notes.js';
import { snapshotService } from '../../server/knowledge/snapshots.js';
import { reconcileService } from '../../server/indexing/reconcile.js';
import { indexWorker } from '../../server/indexing/worker.js';
it('rejects invalid original UTF-8 without lossy decoding and lets other index jobs finish', async () => {
  const f = await createFixture(),
    db = openDatabase(f.dataRoot),
    notes = noteService(f.config, db),
    snapshots = snapshotService(f.config, db, notes),
    indexing = reconcileService(f.config, db),
    worker = indexWorker(f.config, db, notes, snapshots);
  try {
    const h = await loginFixtureOwner(f);
    await writeFile(join(f.knowledgeRoot, '00-Inbox/bad.md'), Buffer.from([255, 254, 0, 128]));
    await writeFile(join(f.knowledgeRoot, '00-Inbox/good.md'), '# 正常知识\n合法正文');
    notes.scan();
    const n = db.prepare("SELECT id FROM notes WHERE path='00-Inbox/bad.md'").get() as any;
    const r = await f.app.inject({ url: `/api/notes/${n.id}`, headers: h });
    expect(r.statusCode).toBe(422);
    expect(r.json().error).toContain('UTF-8');
    await indexing.reconcile(undefined, true);
    await worker.drain();
    const bad = db
      .prepare("SELECT status,error FROM index_jobs WHERE note_id=? AND target='text'")
      .get(n.id) as any;
    expect(bad).toEqual({ status: 'retry_wait', error: 'INVALID_UTF8' });
    expect(
      (
        db
          .prepare(
            "SELECT count(*) n FROM index_jobs j JOIN notes n ON n.id=j.note_id WHERE n.path='00-Inbox/good.md' AND j.status='done'",
          )
          .get() as any
      ).n,
    ).toBe(1);
  } finally {
    await worker.close();
    await snapshots.close();
    await indexing.close();
    db.close();
    await f.close();
  }
});
