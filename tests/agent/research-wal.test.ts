import { expect, it } from 'vitest';
import { createFixture } from '../support/fixture.js';
import { openDatabase } from '../../packages/core/db.js';
import { noteService } from '../../packages/core/notes.js';
import { mutationCore, webPrincipal } from '../../packages/core/knowledge/core.js';
import { researchService } from '../../packages/core/search/research.js';

it('returns a complete research object and charges its rate budget despite a competing WAL writer', async () => {
  const f = await createFixture({ fileTasks: { embedded: false } });
  const db = openDatabase(f.dataRoot),
    other = openDatabase(f.dataRoot),
    prepare = db.prepare.bind(db),
    content = '# Research citation\nComplete UTF-8 source: 知识。\n';
  other.pragma('busy_timeout=0');
  let attempted = false,
    outcome: 'committed' | 'blocked' | undefined;
  try {
    const note = mutationCore(f.config, db).create(
      webPrincipal,
      '00-Inbox',
      'research-budget.md',
      content,
      'research-budget-create',
    );
    const version = db
      .prepare('SELECT content_hash,source_revision FROM document_state WHERE note_id=?')
      .get(note.id) as { content_hash: string; source_revision: number };
    db.prepare = ((sql: string) => {
      const statement = prepare(sql);
      if (
        sql ===
        'SELECT bytes FROM read_rates WHERE principal=? AND client_id=? AND channel=? AND window=?'
      ) {
        const get = statement.get.bind(statement);
        statement.get = ((...values: any[]) => {
          const result = get(...values);
          if (!attempted && db.inTransaction) {
            attempted = true;
            try {
              other
                .prepare(
                  "INSERT INTO index_meta(key,value) VALUES('research_competing_write','committed') ON CONFLICT(key) DO UPDATE SET value=excluded.value",
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
    await expect(
      researchService(f.config, db, noteService(f.config, db)).fetch(
        webPrincipal,
        note.id,
        undefined,
        { sourceHash: version.content_hash, sourceRevision: String(version.source_revision) },
      ),
    ).resolves.toMatchObject({ id: note.id, text: content });
    expect({ attempted, outcome }).toEqual({ attempted: true, outcome: 'blocked' });
    expect(
      (
        db
          .prepare('SELECT sum(bytes) n FROM read_rates WHERE principal=? AND client_id=? AND channel=?')
          .get(webPrincipal.id, webPrincipal.clientId, 'mcp') as { n: number }
      ).n,
    ).toBe(Buffer.byteLength(content));
    expect((db.prepare('SELECT count(*) n FROM read_leases').get() as any).n).toBe(0);
  } finally {
    db.prepare = prepare;
    other.close();
    db.close();
    await f.close();
  }
});
