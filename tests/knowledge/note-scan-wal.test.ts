import { expect, it } from 'vitest';
import { writeFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { createFixture } from '../support/fixture.js';
import { openDatabase, type AppDatabase } from '../../packages/core/db.js';
import { noteService } from '../../packages/core/notes.js';
import { reconcileService } from '../../packages/core/indexing/reconcile.js';

function contendAfterRows(db: AppDatabase, other: AppDatabase, sql: string) {
  const prepare = db.prepare.bind(db);
  let attempted = false,
    outcome: 'committed' | 'blocked' | undefined;
  db.prepare = ((statement: string) => {
    const query = prepare(statement);
    if (statement === sql) {
      const all = query.all.bind(query);
      query.all = ((...values: any[]) => {
        const rows = all(...values);
        if (!attempted && db.inTransaction) {
          attempted = true;
          try {
            other
              .prepare(
                "INSERT INTO index_meta(key,value) VALUES('note_scan_competing_write','committed') ON CONFLICT(key) DO UPDATE SET value=excluded.value",
              )
              .run();
            outcome = 'committed';
          } catch (error) {
            if ((error as any).code !== 'SQLITE_BUSY') throw error;
            outcome = 'blocked';
          }
        }
        return rows;
      }) as any;
    }
    return query;
  }) as any;
  return {
    restore: () => {
      db.prepare = prepare;
    },
    result: () => ({ attempted, outcome }),
  };
}

async function isolatedScan() {
  const f = await createFixture({
    fileTasks: { embedded: false },
    indexing: { enabled: false, watch: false },
  });
  const db = openDatabase(f.dataRoot),
    other = openDatabase(f.dataRoot),
    notes = noteService(f.config, db);
  other.pragma('busy_timeout=0');
  await writeFile(join(f.knowledgeRoot, '00-Inbox/keep.md'), '# Keep\n');
  await writeFile(join(f.knowledgeRoot, '00-Inbox/external.md'), '# External\n');
  notes.scan();
  return {
    f,
    db,
    other,
    notes,
    close: async () => {
      other.close();
      db.close();
      await f.close();
    },
  };
}

for (const change of ['added', 'removed'] as const)
  it(`loads the tree and registers an externally ${change} file despite a competing WAL writer`, async () => {
    const f = await isolatedScan();
    let contention: ReturnType<typeof contendAfterRows> | undefined;
    try {
      if (change === 'added')
        await writeFile(join(f.f.knowledgeRoot, '00-Inbox/new.md'), '# New\n');
      else await unlink(join(f.f.knowledgeRoot, '00-Inbox/external.md'));
      contention = contendAfterRows(f.db, f.other, 'SELECT * FROM notes WHERE active=1');
      let tree: ReturnType<typeof f.notes.tree> | undefined;
      expect(() => {
        tree = f.notes.tree();
      }).not.toThrow();
      expect(contention.result()).toEqual({ attempted: true, outcome: 'blocked' });
      expect(JSON.stringify(tree)).toContain('keep.md');
      if (change === 'added') {
        expect(JSON.stringify(tree)).toContain('new.md');
        expect(f.db.prepare("SELECT active FROM notes WHERE path='00-Inbox/new.md'").get()).toEqual(
          {
            active: 1,
          },
        );
      } else {
        expect(JSON.stringify(tree)).not.toContain('external.md');
        expect(
          f.db.prepare("SELECT active FROM notes WHERE path='00-Inbox/external.md'").get(),
        ).toEqual({
          active: 0,
        });
      }
    } finally {
      contention?.restore();
      await f.close();
    }
  });

it('reconciles an externally removed note despite a competing WAL writer during cleanup', async () => {
  const f = await isolatedScan();
  let contention: ReturnType<typeof contendAfterRows> | undefined;
  try {
    const reconciliation = reconcileService(f.f.config, f.db);
    await reconciliation.reconcile();
    const removed = f.db
      .prepare("SELECT id FROM notes WHERE path='00-Inbox/external.md'")
      .get() as {
      id: string;
    };
    await unlink(join(f.f.knowledgeRoot, '00-Inbox/external.md'));
    contention = contendAfterRows(f.db, f.other, 'SELECT id,path FROM notes WHERE active=1');
    await expect(reconciliation.reconcile()).resolves.toMatchObject({ removed: 1, complete: true });
    expect(contention.result()).toEqual({ attempted: true, outcome: 'blocked' });
    expect(f.db.prepare('SELECT active FROM notes WHERE id=?').get(removed.id)).toEqual({
      active: 0,
    });
    expect(
      f.db.prepare('SELECT active FROM document_state WHERE note_id=?').get(removed.id),
    ).toEqual({
      active: 0,
    });
    expect(
      f.db
        .prepare("SELECT count(*) n FROM index_jobs WHERE note_id=? AND status<>'superseded'")
        .get(removed.id),
    ).toEqual({ n: 0 });
  } finally {
    contention?.restore();
    await f.close();
  }
});
