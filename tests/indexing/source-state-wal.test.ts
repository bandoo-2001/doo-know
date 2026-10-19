import { expect, it } from 'vitest';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createFixture } from '../support/fixture.js';
import { openDatabase } from '../../packages/core/db.js';
import { mutationCore, webPrincipal } from '../../packages/core/knowledge/core.js';
import { reconcileService } from '../../packages/core/indexing/reconcile.js';
import { sha256 } from '../../packages/core/knowledge/operations.js';

it('reconciles an externally edited note despite a WAL writer racing source-version registration', async () => {
  const f = await createFixture({ fileTasks: { embedded: false } });
  const db = openDatabase(f.dataRoot),
    other = openDatabase(f.dataRoot),
    prepare = db.prepare.bind(db);
  other.pragma('busy_timeout=0');
  let attempted = false,
    outcome: 'committed' | 'blocked' | undefined;
  try {
    const note = mutationCore(f.config, db).create(
      webPrincipal,
      '00-Inbox',
      'source-registration.md',
      '# Original source\n',
      'source-registration-create',
    );
    const previous = db
      .prepare('SELECT source_revision FROM document_state WHERE note_id=?')
      .get(note.id) as { source_revision: number };
    const content = '# Externally edited source\nKnowledge remains readable.\n';
    await writeFile(join(f.knowledgeRoot, '00-Inbox/source-registration.md'), content);
    db.prepare = ((sql: string) => {
      const statement = prepare(sql);
      if (
        sql ===
        'SELECT content_hash,source_revision,active,conflict FROM document_state WHERE note_id=?'
      ) {
        const get = statement.get.bind(statement);
        statement.get = ((...values: any[]) => {
          const result = get(...values);
          if (!attempted && db.inTransaction) {
            attempted = true;
            try {
              other
                .prepare(
                  "INSERT INTO index_meta(key,value) VALUES('source_state_competing_write','committed') ON CONFLICT(key) DO UPDATE SET value=excluded.value",
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
      return statement;
    }) as any;
    await expect(reconcileService(f.config, db).reconcile()).resolves.toMatchObject({
      complete: true,
      changed: 1,
    });
    expect({ attempted, outcome }).toEqual({ attempted: true, outcome: 'blocked' });
    expect(
      db
        .prepare('SELECT content_hash,source_revision,active FROM document_state WHERE note_id=?')
        .get(note.id),
    ).toEqual({
      content_hash: sha256(content),
      source_revision: previous.source_revision + 1,
      active: 1,
    });
    expect(
      db
        .prepare(
          "SELECT count(*) n FROM index_jobs WHERE note_id=? AND source_hash=? AND status='pending'",
        )
        .get(note.id, sha256(content)),
    ).toEqual({ n: 1 });
  } finally {
    db.prepare = prepare;
    other.close();
    db.close();
    await f.close();
  }
});
