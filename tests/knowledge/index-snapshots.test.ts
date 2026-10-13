import { it, expect } from 'vitest';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createFixture } from '../support/fixture.js';
import { openDatabase } from '../../server/db.js';
import { noteService } from '../../server/notes.js';
import { snapshotService } from '../../server/knowledge/snapshots.js';
import { webPrincipal } from '../../server/knowledge/core.js';
it('releases internal indexing snapshots and adopts those actually opened by an authorized reader', async () => {
  const f = await createFixture(),
    db = openDatabase(f.dataRoot),
    notes = noteService(f.config, db),
    snapshots = snapshotService(f.config, db, notes),
    internal = { ...webPrincipal, id: 'system:index-worker', clientId: 'indexer' };
  try {
    await writeFile(join(f.knowledgeRoot, '00-Inbox/internal.md'), '# 内部快照');
    notes.scan();
    const n = db.prepare('SELECT id FROM notes WHERE active=1').get() as any;
    let prepared = await snapshots.available(internal, n.id, {});
    await snapshots.drain();
    prepared = await snapshots.available(internal, n.id, {});
    expect(prepared).not.toHaveProperty('operation');
    const first = (prepared as any).id;
    await snapshots.releaseInternal(first);
    expect(db.prepare('SELECT id FROM read_snapshots WHERE id=?').get(first)).toBeUndefined();
    await snapshots.available(internal, n.id, {});
    await snapshots.drain();
    const second = await snapshots.available(webPrincipal, n.id, {});
    expect(second).not.toHaveProperty('operation');
    await snapshots.releaseInternal((second as any).id);
    expect(
      (db.prepare('SELECT principal FROM read_snapshots WHERE id=?').get((second as any).id) as any)
        .principal,
    ).toBe('web-owner');
  } finally {
    await snapshots.close();
    db.close();
    await f.close();
  }
});
