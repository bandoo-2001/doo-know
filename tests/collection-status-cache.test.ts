import { expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { createFixture, loginFixtureOwner } from './support/fixture.js';

it('reuses unchanged collection totals and refreshes them after source and favorite mutations', async () => {
  const f = await createFixture({ fileTasks: { embedded: false } });
  try {
    const headers = await loginFixtureOwner(f);
    let counts = 0;
    const realPrepare = Database.prototype.prepare;
    const spy = vi.spyOn(Database.prototype, 'prepare').mockImplementation(function (
      this: Database.Database,
      sql: string,
    ) {
        const statement = realPrepare.call(this, sql) as Database.Statement<unknown[], unknown>;
      if (/\bcount\s*\(/i.test(sql) && sql.includes('collection_catalog')) {
        const get = statement.get;
        statement.get = function (...parameters: unknown[]) {
          counts++;
          return get.apply(this, parameters);
        };
      }
      return statement;
    });
    const status = async (kind: 'recent' | 'favorites') => {
      const reply = await f.app.inject({ url: `/api/collections/status?kind=${kind}`, headers });
      expect(reply.statusCode, reply.body).toBe(200);
      return reply.json();
    };
    try {
      expect((await status('favorites')).total).toBe(0);
      for (let index = 0; index < 5; index++) {
        expect((await status('favorites')).total).toBe(0);
        expect(
          (await f.app.inject({ url: '/api/collections?kind=favorites', headers })).json().total,
        ).toBe(0);
      }
      expect(counts).toBe(1);
      const created = (
        await f.app.inject({
          method: 'POST',
          url: '/api/notes',
          headers,
          payload: { folderPath: '00-Inbox', fileName: 'totals.md', content: '# Totals\n\nBody' },
        })
      ).json();
      expect((await status('recent')).total).toBe(1);
      expect((await status('recent')).total).toBe(1);
      expect(counts).toBe(2);
      const favorite = await f.app.inject({
        method: 'PUT',
        url: `/api/notes/${created.id}/favorite`,
        headers,
        payload: { favorite: true },
      });
      expect(favorite.statusCode, favorite.body).toBe(200);
      expect((await status('favorites')).total).toBe(1);
      expect((await status('favorites')).total).toBe(1);
      expect(counts).toBe(3);
      const archived = await f.app.inject({
        method: 'DELETE',
        url: `/api/notes/${created.id}`,
        headers,
        payload: { expectedModifiedAt: created.modifiedAt, requestId: 'cached-total-archive' },
      });
      expect(archived.statusCode, archived.body).toBe(200);
      expect((await status('favorites')).total).toBe(0);
      expect((await status('favorites')).total).toBe(0);
      expect(counts).toBe(4);
    } finally {
      spy.mockRestore();
    }
  } finally {
    await f.close();
  }
});
