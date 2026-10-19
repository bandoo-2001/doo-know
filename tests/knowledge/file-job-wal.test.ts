import { it, expect } from 'vitest';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createFixture } from '../support/fixture.js';
import { openDatabase, type AppDatabase } from '../../packages/core/db.js';
import { noteService } from '../../packages/core/notes.js';
import { webPrincipal } from '../../packages/core/knowledge/core.js';
import { snapshotService } from '../../packages/core/knowledge/snapshots.js';
import { fileJobService } from '../../packages/core/knowledge/file-jobs.js';

// Commit through a second real WAL connection after the worker's first SELECT.
// The worker keeps its real workspace gate, snapshot checks, file writes and receipt.
function contendAfterRead(db: AppDatabase, other: AppDatabase, target: string) {
  const prepare = db.prepare.bind(db);
  const proof = {
    attempted: false,
    competitor: undefined as string | undefined,
    workspaceLeaseHeld: false,
    workerError: undefined as { code: string; stack: string } | undefined,
  };
  db.prepare = ((sql: string) => {
    const statement = prepare(sql);
    if (sql === target) {
      const get = statement.get.bind(statement);
      statement.get = ((...values: any[]) => {
        const row = get(...values);
        if (!proof.attempted && db.inTransaction) {
          proof.attempted = true;
          proof.workspaceLeaseHeld = !!prepare(
            "SELECT 1 FROM workspace_gate WHERE kind='file.patch' AND mode='shared'",
          ).get();
          try {
            other
              .prepare(
                "INSERT INTO index_meta(key,value) VALUES('file_job_wal_competitor','committed') ON CONFLICT(key) DO UPDATE SET value=excluded.value",
              )
              .run();
            proof.competitor = 'committed';
          } catch (error) {
            proof.competitor = (error as any).code;
            if (proof.competitor !== 'SQLITE_BUSY') throw error;
          }
        }
        return row;
      }) as any;
    }
    if (
      sql.startsWith('INSERT INTO note_write_leases') ||
      sql.startsWith('INSERT INTO write_intents')
    ) {
      const run = statement.run.bind(statement);
      statement.run = ((...values: any[]) => {
        try {
          return run(...values);
        } catch (error) {
          proof.workerError = { code: (error as any).code, stack: (error as Error).stack! };
          throw error;
        }
      }) as any;
    }
    return statement;
  }) as any;
  return {
    proof,
    restore: () => {
      db.prepare = prepare;
    },
  };
}

for (const window of [
  { name: 'note lease', sql: 'SELECT owner,lease_until FROM note_write_leases WHERE note_id=?' },
  { name: 'commit intent', sql: 'SELECT * FROM file_operations WHERE id=?' },
])
  for (const action of ['patch', 'restore'] as const)
    it(`persists an accepted large-file ${action} despite a WAL writer at the ${window.name}`, async () => {
      const f = await createFixture({ fileTasks: { embedded: false } });
      const db = openDatabase(f.dataRoot, 'file-worker'),
        other = openDatabase(f.dataRoot),
        config = { ...f.config, fileTasks: { embedded: true } } as any,
        notes = noteService(config, db),
        snapshots = snapshotService(config, db, notes),
        files = fileJobService(config, db, notes, snapshots);
      other.pragma('busy_timeout=0');
      let contention: ReturnType<typeof contendAfterRead> | undefined;
      try {
        const source = '# Original\n' + 'ordinary source line\n'.repeat(60000),
          replacement = source.replace('# Original', '# Changed'),
          file = join(f.knowledgeRoot, '00-Inbox/large-wal.md');
        await writeFile(file, source);
        notes.scan();
        const note = db
          .prepare("SELECT id FROM notes WHERE path='00-Inbox/large-wal.md'")
          .get() as { id: string };
        await snapshots.read(webPrincipal, note.id, {}, 'web');
        await snapshots.drain();
        const page = await snapshots.read(webPrincipal, note.id, {}, 'web');
        if (page.kind !== 'ready') throw new Error('snapshot not ready');
        const patchInput = {
          snapshotId: page.data.snapshotId,
          expectedModifiedAt: page.data.modifiedAt,
          expectedContentHash: page.data.sourceHash,
          requestId: 'wal-large-patch',
          edits: [{ type: 'replace_text' as const, before: '# Original', after: '# Changed' }],
        };
        let revision: { id: string } | undefined, modifiedAt: string | undefined;
        if (action === 'restore') {
          const seed = await files.submit(webPrincipal, note.id, patchInput, 'web');
          if (seed.kind !== 'accepted') throw new Error('seed patch not accepted');
          await files.drain();
          const completed = files.operation(webPrincipal, seed.operation.operationId);
          expect(completed.status).toBe('succeeded');
          modifiedAt = (completed.result as any).modifiedAt;
          revision = db.prepare('SELECT id FROM revisions WHERE note_id=?').get(note.id) as {
            id: string;
          };
        }
        contention = contendAfterRead(db, other, window.sql);
        const accepted =
          action === 'patch'
            ? await files.submit(webPrincipal, note.id, patchInput, 'web')
            : await files.restore(
                webPrincipal,
                note.id,
                revision!.id,
                modifiedAt!,
                'wal-large-restore',
              );
        expect(accepted.kind).toBe('accepted');
        if (accepted.kind !== 'accepted') throw new Error('file job not accepted');
        await files.drain();
        const operationId = accepted.operation.operationId,
          operation = files.operation(webPrincipal, operationId);
        expect(operation, JSON.stringify(contention.proof)).toMatchObject({ status: 'succeeded' });
        expect(contention.proof).toMatchObject({
          attempted: true,
          competitor: 'SQLITE_BUSY',
          workspaceLeaseHeld: true,
        });
        expect(contention.proof.workerError).toBeUndefined();
        expect(await readFile(file, 'utf8')).toBe(action === 'patch' ? replacement : source);
        // Another connection must observe the durable receipt, release and exactly one revision per job.
        expect(
          other.prepare('SELECT status,error FROM operations WHERE id=?').get(operationId),
        ).toEqual({ status: 'succeeded', error: null });
        expect(
          other
            .prepare('SELECT status,snapshot_ref_released FROM file_operations WHERE id=?')
            .get(operationId),
        ).toEqual({ status: 'succeeded', snapshot_ref_released: 1 });
        expect(
          other.prepare('SELECT status FROM write_intents WHERE id=?').get(operationId),
        ).toEqual({ status: 'recorded' });
        expect(
          other.prepare('SELECT count(*) n FROM revisions WHERE note_id=?').get(note.id),
        ).toEqual({ n: action === 'patch' ? 1 : 2 });
        expect(
          other.prepare('SELECT * FROM note_write_leases WHERE note_id=?').all(note.id),
        ).toEqual([]);
        expect(other.prepare('SELECT * FROM workspace_gate').all()).toEqual([]);
        expect(
          other
            .prepare(
              'SELECT refs FROM read_snapshots WHERE id=(SELECT snapshot_id FROM file_operations WHERE id=?)',
            )
            .get(operationId),
        ).toEqual({ refs: 0 });
      } finally {
        contention?.restore();
        await files.close();
        await snapshots.close();
        other.close();
        db.close();
        await f.close();
      }
    });
