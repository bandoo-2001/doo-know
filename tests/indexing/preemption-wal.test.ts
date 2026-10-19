import { expect, it } from 'vitest';
import { createFixture } from '../support/fixture.js';
import { openDatabase } from '../../packages/core/db.js';
import { observeSource } from '../../packages/core/indexing/state.js';
import { indexJobService } from '../../packages/core/indexing/jobs.js';

it('yields a large text job to a small note despite a competing WAL writer without losing its checkpoint or charging a retry', async () => {
  const f = await createFixture({ fileTasks: { embedded: false } });
  const db = openDatabase(f.dataRoot),
    other = openDatabase(f.dataRoot),
    jobs = indexJobService(db);
  other.pragma('busy_timeout=0');
  const prepare = db.prepare.bind(db);
  let attempted = false,
    outcome: 'committed' | 'blocked' | undefined;
  try {
    for (const [id, size] of [
      ['large', 2097152],
      ['small', 20],
    ] as const) {
      db.prepare('INSERT INTO notes(id,path) VALUES(?,?)').run(id, `00-Inbox/${id}.md`);
      const version = observeSource(db, id, id[0].repeat(64), '1', size);
      if (id === 'large') jobs.enqueue(version, 'text');
    }
    const large = jobs.claim('worker')!;
    expect(large.noteId).toBe('large');
    jobs.checkpoint(large, 32);
    jobs.enqueue({ noteId: 'small', sourceRevision: 1, contentHash: 's'.repeat(64) }, 'text');
    db.prepare = ((sql: string) => {
      const statement = prepare(sql);
      if (sql === 'SELECT size_bytes FROM document_state WHERE note_id=?') {
        const get = statement.get.bind(statement);
        statement.get = ((...values: any[]) => {
          const row = get(...values);
          if (!attempted && db.inTransaction) {
            attempted = true;
            try {
              other
                .prepare(
                  "INSERT INTO index_meta(key,value) VALUES('preemption_competing_write','committed') ON CONFLICT(key) DO UPDATE SET value=excluded.value",
                )
                .run();
              outcome = 'committed';
            } catch (error) {
              if ((error as any).code !== 'SQLITE_BUSY') throw error;
              outcome = 'blocked';
            }
          }
          return row;
        }) as any;
      }
      return statement;
    }) as any;
    expect(jobs.preempt(large)).toBe(true);
    expect({ attempted, outcome }).toEqual({ attempted: true, outcome: 'blocked' });
    expect(jobs.valid(large)).toBe(false);
    const small = jobs.claim('worker')!;
    expect(small.noteId).toBe('small');
    jobs.complete(small);
    const resumed = jobs.claim('worker')!;
    expect(resumed.noteId).toBe('large');
    expect(resumed.checkpoint).toBe(32);
    expect(resumed.attempts).toBe(1);
    expect(resumed.leaseEpoch).toBeGreaterThan(large.leaseEpoch);
  } finally {
    db.prepare = prepare;
    other.close();
    db.close();
    await f.close();
  }
});
