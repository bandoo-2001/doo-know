import { it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createFixture } from '../support/fixture.js';
import { openDatabase } from '../../packages/core/db.js';
import { mutationCore, webPrincipal } from '../../packages/core/knowledge/core.js';

for (const kind of ['create', 'update'] as const)
  it(`records ${kind} without a WAL snapshot upgrade failure after source publication`, async () => {
    const fixture = await createFixture({ fileTasks: { embedded: false } });
    await fixture.app.close();
    const db = openDatabase(fixture.dataRoot);
    const writer = new Database(join(fixture.dataRoot, 'app.sqlite'), { timeout: 0 });
    const prepare = db.prepare.bind(db);
    try {
      const core = mutationCore(fixture.config as any, db);
      const original = core.create(
        webPrincipal,
        '00-Inbox',
        'existing.md',
        '# Original fixture',
        'initial-create',
      );
      let readBoundaryHits = 0;
      let competingWriterBlocked = false;
      const writeElsewhere = () =>
        writer
          .prepare('INSERT OR REPLACE INTO index_meta(key,value) VALUES(?,?)')
          .run('record-concurrency-fixture', 'concurrent index update');
      db.prepare = ((sql: string) => {
        const statement = prepare(sql);
        if (sql === 'SELECT status FROM write_intents WHERE id=?') {
          const get = statement.get.bind(statement);
          statement.get = ((...parameters: any[]) => {
            const result = get(...parameters);
            if (!readBoundaryHits++) {
              // Emulate a separate index worker committing in the gap between
              // record() reading its intent and writing the durable receipt.
              try {
                writeElsewhere();
              } catch (error) {
                if ((error as { code?: string }).code !== 'SQLITE_BUSY') throw error;
                competingWriterBlocked = true;
              }
            }
            return result;
          }) as any;
        }
        return statement;
      }) as any;
      const content = '# Published fixture';
      let receipt: ReturnType<typeof core.update> | undefined;
      let failure: unknown;
      try {
        receipt =
          kind === 'create'
            ? core.create(webPrincipal, '00-Inbox', 'created.md', content, 'concurrent-create')
            : core.update(
                webPrincipal,
                original.id,
                content,
                original.modifiedAt,
                'concurrent-update',
              );
      } catch (error) {
        failure = error;
      }
      expect(failure).toBeUndefined();
      expect(readBoundaryHits).toBe(1);
      expect(competingWriterBlocked).toBe(true);
      // The other writer can commit once receipt publication releases its lock.
      writeElsewhere();
      expect(await readFile(join(fixture.knowledgeRoot, receipt!.relativePath), 'utf8')).toBe(
        content,
      );
      expect(
        prepare('SELECT status,error FROM operations WHERE request_id=?').get('concurrent-' + kind),
      ).toEqual({ status: 'succeeded', error: null });
      expect(
        prepare('SELECT status FROM write_intents WHERE id=?').get(
          (
            prepare('SELECT id FROM operations WHERE request_id=?').get('concurrent-' + kind) as {
              id: string;
            }
          ).id,
        ),
      ).toEqual({ status: 'recorded' });
      const replay =
        kind === 'create'
          ? core.create(webPrincipal, '00-Inbox', 'created.md', content, 'concurrent-create')
          : core.update(
              webPrincipal,
              original.id,
              content,
              original.modifiedAt,
              'concurrent-update',
            );
      expect(replay).toEqual(receipt);
      expect(
        prepare('SELECT count(*) AS n FROM revisions WHERE note_id=?').get(receipt!.id),
      ).toEqual({ n: kind === 'update' ? 1 : 0 });
    } finally {
      db.prepare = prepare;
      writer.close();
      db.close();
      await fixture.close();
    }
  });
