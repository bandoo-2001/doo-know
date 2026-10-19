import { it, expect } from 'vitest';
import { createFixture } from '../support/fixture.js';
import { openDatabase, type AppDatabase } from '../../packages/core/db.js';
import { noteService } from '../../packages/core/notes.js';
import { mutationCore, webPrincipal } from '../../packages/core/knowledge/core.js';
import { snapshotService } from '../../packages/core/knowledge/snapshots.js';
import { readFile } from 'node:fs/promises';

// A second real WAL connection commits after a transaction's first SELECT.
// Deferred transactions cannot then upgrade their stale snapshot to a writer.
// Immediate transactions reserve the writer first, so that competing write
// instead gets SQLITE_BUSY without changing the database snapshot underneath.
function contendAfterRead(db: AppDatabase, other: AppDatabase, sql: string) {
  const prepare = db.prepare.bind(db);
  let attempted = false,
    outcome: 'committed' | 'blocked' | undefined;
  db.prepare = ((statement: string) => {
    const stmt = prepare(statement);
    if (statement === sql) {
      const get = stmt.get.bind(stmt);
      stmt.get = ((...values: any[]) => {
        const result = get(...values);
        if (!attempted && db.inTransaction) {
          attempted = true;
          try {
            other
              .prepare(
                "INSERT INTO index_meta(key,value) VALUES('snapshot_competing_write','committed') ON CONFLICT(key) DO UPDATE SET value=excluded.value",
              )
              .run();
            outcome = 'committed';
          } catch (error) {
            if ((error as any).code !== 'SQLITE_BUSY') throw error;
            outcome = 'blocked';
          }
        }
        return result;
      }) as any;
    }
    return stmt;
  }) as any;
  return {
    restore: () => {
      db.prepare = prepare;
    },
    result: () => ({ attempted, outcome }),
  };
}

async function isolatedSnapshots() {
  const f = await createFixture({
    fileTasks: { embedded: false },
    indexing: { enabled: false, watch: false },
  });
  const db = openDatabase(f.dataRoot),
    other = openDatabase(f.dataRoot);
  other.pragma('busy_timeout=0');
  const config = { ...f.config, fileTasks: { embedded: true } } as any,
    notes = noteService(config, db),
    snapshots = snapshotService(config, db, notes),
    content = '# Stable snapshot source\n' + 'another ordinary line\n'.repeat(20),
    note = mutationCore(config, db).create(
      webPrincipal,
      '00-Inbox',
      'snapshot-transaction.md',
      content,
      'snapshot-transaction-create',
    );
  return {
    f,
    db,
    other,
    snapshots,
    note,
    content,
    close: async () => {
      await snapshots.close();
      other.close();
      db.close();
      await f.close();
    },
  };
}

for (const route of ['fresh page', 'cached cursor page'] as const)
  it(`commits a ${route} read budget despite a competing WAL writer`, async () => {
    const f = await isolatedSnapshots();
    let contention: ReturnType<typeof contendAfterRead> | undefined;
    try {
      const operation = await f.snapshots.prepare(webPrincipal, f.note.id, 'snapshot-prepare');
      await f.snapshots.drain();
      const built = f.snapshots.operation(operation.operationId);
      expect(built.status).toBe('succeeded');
      let input: { snapshotId?: string; cursor?: string; maxBytes?: number } = {
          snapshotId: built.snapshotId,
          maxBytes: 64,
        },
        expectedContent: string | undefined;
      if (route === 'cached cursor page') {
        const first = await f.snapshots.read(webPrincipal, f.note.id, input, 'web');
        if (first.kind !== 'ready' || !first.data.nextCursor)
          throw Error('missing first page cursor');
        input = { cursor: first.data.nextCursor };
        const second = await f.snapshots.read(webPrincipal, f.note.id, input, 'web');
        if (second.kind !== 'ready') throw Error('missing cached second page');
        expectedContent = second.data.content;
      } else expectedContent = f.content.slice(0, 64);
      contention = contendAfterRead(
        f.db,
        f.other,
        'SELECT bytes FROM read_rates WHERE principal=? AND client_id=? AND channel=? AND window=?',
      );
      await expect(f.snapshots.read(webPrincipal, f.note.id, input, 'web')).resolves.toMatchObject({
        kind: 'ready',
        data: { snapshotId: built.snapshotId, content: expectedContent },
      });
      expect(contention.result().attempted).toBe(true);
      expect(contention.result().outcome).toBe('blocked');
    } finally {
      contention?.restore();
      await f.close();
    }
  });

it('publishes a completed snapshot instead of marking it failed when another WAL writer races final registration', async () => {
  const f = await isolatedSnapshots();
  const contention = contendAfterRead(
    f.db,
    f.other,
    'SELECT status,lease_epoch FROM file_operations WHERE id=?',
  );
  try {
    const operation = await f.snapshots.prepare(
      webPrincipal,
      f.note.id,
      'snapshot-final-registration',
    );
    await f.snapshots.drain();
    expect(contention.result().attempted).toBe(true);
    expect(f.snapshots.operation(operation.operationId)).toMatchObject({ status: 'succeeded' });
    expect(contention.result().outcome).toBe('blocked');
    const page = await f.snapshots.read(webPrincipal, f.note.id, {}, 'web');
    expect(page).toMatchObject({ kind: 'ready', data: { content: f.content } });
  } finally {
    contention.restore();
    await f.close();
  }
});

it('adopts an indexer snapshot for a browser read despite a competing WAL writer', async () => {
  const f = await isolatedSnapshots();
  let contention: ReturnType<typeof contendAfterRead> | undefined;
  try {
    const indexer = { ...webPrincipal, id: 'system:index-worker', clientId: 'indexer' };
    const operation = await f.snapshots.prepare(indexer, f.note.id, 'indexer-snapshot-adoption');
    await f.snapshots.drain();
    const built = f.snapshots.operation(operation.operationId);
    expect(built.status).toBe('succeeded');
    contention = contendAfterRead(
      f.db,
      f.other,
      'SELECT coalesce(sum(size_bytes),0) n FROM read_snapshots WHERE principal=?',
    );
    await expect(f.snapshots.read(webPrincipal, f.note.id, {}, 'web')).resolves.toMatchObject({
      kind: 'ready',
      data: { snapshotId: built.snapshotId, content: f.content },
    });
    expect(contention.result()).toEqual({ attempted: true, outcome: 'blocked' });
    expect(
      f.db.prepare('SELECT principal FROM read_snapshots WHERE id=?').get(built.snapshotId),
    ).toMatchObject({ principal: webPrincipal.id });
  } finally {
    contention?.restore();
    await f.close();
  }
});

it('does not return a snapshot deleted by an index worker between candidate selection and browser adoption', async () => {
  const f = await isolatedSnapshots();
  const otherSnapshots = snapshotService(
    f.f.config,
    f.other,
    noteService(f.f.config, f.other),
  );
  const prepare = f.db.prepare.bind(f.db);
  let raced = false,
    release: Promise<void> | undefined;
  try {
    const indexer = { ...webPrincipal, id: 'system:index-worker', clientId: 'indexer' };
    const operation = await f.snapshots.prepare(indexer, f.note.id, 'candidate-release-race');
    await f.snapshots.drain();
    const built = f.snapshots.operation(operation.operationId);
    expect(built.status).toBe('succeeded');
    f.db.prepare = ((sql: string) => {
      const statement = prepare(sql);
      if (sql.startsWith('SELECT * FROM read_snapshots WHERE note_id=? AND source_key=?')) {
        const get = statement.get.bind(statement);
        statement.get = ((...values: any[]) => {
          const row = get(...values) as any;
          if (!raced && row?.id === built.snapshotId) {
            raced = true;
            release = otherSnapshots.releaseInternal(row.id).catch((error) => {
              if (error.code !== 'SQLITE_BUSY') throw error;
            });
          }
          return row;
        }) as any;
      }
      return statement;
    }) as any;
    await expect(f.snapshots.read(webPrincipal, f.note.id, {}, 'web')).resolves.toMatchObject({
      kind: 'ready',
      data: { content: f.content },
    });
    expect(raced).toBe(true);
    await release;
  } finally {
    f.db.prepare = prepare;
    await release;
    await otherSnapshots.close();
    await f.close();
  }
});

it('does not unlink a snapshot after a concurrent browser adoption wins the index-worker release', async () => {
  const f = await isolatedSnapshots();
  const prepare = f.db.prepare.bind(f.db);
  let raced = false;
  try {
    const indexer = { ...webPrincipal, id: 'system:index-worker', clientId: 'indexer' };
    const operation = await f.snapshots.prepare(indexer, f.note.id, 'release-adoption-race');
    await f.snapshots.drain();
    const built = f.snapshots.operation(operation.operationId);
    expect(built.status).toBe('succeeded');
    f.db.prepare = ((sql: string) => {
      const statement = prepare(sql);
      if (sql.includes("FROM read_snapshots WHERE id=? AND principal='system:index-worker'")) {
        const get = statement.get.bind(statement);
        statement.get = ((...values: any[]) => {
          const row = get(...values) as any;
          if (!raced && row?.id === built.snapshotId) {
            raced = true;
            try {
              f.other
                .prepare('UPDATE read_snapshots SET principal=? WHERE id=? AND principal=?')
                .run(webPrincipal.id, row.id, indexer.id);
            } catch (error) {
              if ((error as any).code !== 'SQLITE_BUSY') throw error;
            }
          }
          return row;
        }) as any;
      }
      return statement;
    }) as any;
    await f.snapshots.releaseInternal(built.snapshotId!);
    expect(raced).toBe(true);
    let page = await f.snapshots.read(webPrincipal, f.note.id, {}, 'web');
    if (page.kind === 'accepted') {
      await f.snapshots.drain();
      page = await f.snapshots.read(webPrincipal, f.note.id, {}, 'web');
    }
    expect(page).toMatchObject({ kind: 'ready', data: { content: f.content } });
  } finally {
    f.db.prepare = prepare;
    await f.close();
  }
});

it('does not prune a snapshot used by a read session registered after the cleaner inspected it', async () => {
  const f = await isolatedSnapshots();
  const prepare = f.db.prepare.bind(f.db);
  let raced = false,
    sessionRegistered = false;
  try {
    const operation = await f.snapshots.prepare(webPrincipal, f.note.id, 'prune-session-race');
    await f.snapshots.drain();
    const built = f.snapshots.operation(operation.operationId);
    const row = f.db.prepare('SELECT path FROM read_snapshots WHERE id=?').get(built.snapshotId) as {
      path: string;
    };
    f.db.prepare('UPDATE read_snapshots SET expires_at=? WHERE id=?').run(
      Date.now() - 1,
      built.snapshotId,
    );
    f.db.prepare = ((sql: string) => {
      const statement = prepare(sql);
      if (sql === 'SELECT 1 FROM read_sessions WHERE snapshot_id=? AND expires_at>?') {
        const get = statement.get.bind(statement);
        statement.get = ((...values: any[]) => {
          const result = get(...values);
          if (!raced && values[0] === built.snapshotId) {
            raced = true;
            try {
              f.other
                .prepare(
                  'INSERT INTO read_sessions(id,snapshot_id,principal,client_id,channel,expires_at) VALUES(?,?,?,?,?,?)',
                )
                .run(
                  'concurrent-live-session',
                  built.snapshotId,
                  webPrincipal.id,
                  webPrincipal.clientId,
                  'web',
                  Date.now() + 60000,
                );
              sessionRegistered = true;
            } catch (error) {
              if ((error as any).code !== 'SQLITE_BUSY') throw error;
            }
          }
          return result;
        }) as any;
      }
      return statement;
    }) as any;
    await f.snapshots.clean();
    expect(raced).toBe(true);
    if (sessionRegistered) {
      expect(
        f.db.prepare('SELECT id FROM read_sessions WHERE id=?').get('concurrent-live-session'),
      ).toBeDefined();
      expect(await readFile(row.path, 'utf8')).toBe(f.content);
    }
    let page = await f.snapshots.read(webPrincipal, f.note.id, {}, 'web');
    if (page.kind === 'accepted') {
      await f.snapshots.drain();
      page = await f.snapshots.read(webPrincipal, f.note.id, {}, 'web');
    }
    expect(page).toMatchObject({ kind: 'ready', data: { content: f.content } });
  } finally {
    f.db.prepare = prepare;
    await f.close();
  }
});
