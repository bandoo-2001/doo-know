import { expect, it } from 'vitest';
import { createFixture } from '../support/fixture.js';
import { openDatabase } from '../../packages/core/db.js';
import { acquireRead } from '../../packages/core/agent/budgets.js';
import { webPrincipal } from '../../packages/core/knowledge/core.js';

for (const channel of ['web', 'mcp'] as const)
  it(`acquires an initialized ${channel} read lease despite a competing WAL writer and preserves its budget`, async () => {
    const f = await createFixture({ fileTasks: { embedded: false } });
    const db = openDatabase(f.dataRoot),
      other = openDatabase(f.dataRoot),
      exec = db.exec.bind(db),
      releases: ReturnType<typeof acquireRead>[] = [];
    other.pragma('busy_timeout=0');
    let attempted = false,
      outcome: 'committed' | 'blocked' | undefined;
    try {
      // The existing-table branch takes a read snapshot even though this DDL
      // changes no schema. A later write must not upgrade that stale snapshot.
      acquireRead(db, webPrincipal, channel)();
      db.exec = ((sql: string) => {
        const result = exec(sql);
        if (!attempted && db.inTransaction && sql.includes('CREATE TABLE IF NOT EXISTS read_leases')) {
          attempted = true;
          try {
            other
              .prepare(
                "INSERT INTO index_meta(key,value) VALUES('lease_competing_write','committed') ON CONFLICT(key) DO UPDATE SET value=excluded.value",
              )
              .run();
            outcome = 'committed';
          } catch (error) {
            if ((error as any).code !== 'SQLITE_BUSY') throw error;
            outcome = 'blocked';
          }
        }
        return result;
      }) as typeof db.exec;

      const first = acquireRead(db, webPrincipal, channel);
      releases.push(first);
      expect({ attempted, outcome }).toEqual({ attempted: true, outcome: 'blocked' });
      const firstId = (db.prepare('SELECT id FROM read_leases').get() as { id: string }).id;
      const second = acquireRead(db, webPrincipal, channel);
      releases.push(second);
      expect(() => acquireRead(db, webPrincipal, channel)).toThrowError(
        expect.objectContaining({ code: 'READ_CONCURRENCY_EXCEEDED', statusCode: 429 }),
      );
      db.prepare('UPDATE read_leases SET expires_at=? WHERE id=?').run(Date.now() - 1, firstId);
      first.renew();
      expect(
        (db.prepare('SELECT expires_at FROM read_leases WHERE id=?').get(firstId) as any).expires_at,
      ).toBeGreaterThan(Date.now());
      expect(() => acquireRead(db, webPrincipal, channel)).toThrowError(
        expect.objectContaining({ code: 'READ_CONCURRENCY_EXCEEDED', statusCode: 429 }),
      );
      first();
      const replacement = acquireRead(db, webPrincipal, channel);
      releases.push(replacement);
      second();
      replacement();
      expect((db.prepare('SELECT count(*) n FROM read_leases').get() as any).n).toBe(0);
    } finally {
      db.exec = exec;
      for (const release of releases) release();
      other.close();
      db.close();
      await f.close();
    }
  });
