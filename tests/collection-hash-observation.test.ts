import { expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { createFixture, loginFixtureOwner } from './support/fixture.js';
import { createApp } from '../apps/server/app.js';
import { openDatabase } from '../packages/core/db.js';
import { observeSource } from '../packages/core/indexing/state.js';
import { observeCollectionSource } from '../packages/core/collections/source.js';

it('preserves pagination and warm summaries while indexing first discovers unchanged source hashes', async () => {
  const f = await createFixture();
  const db = openDatabase(f.dataRoot);
  let restarted: Awaited<ReturnType<typeof createApp>> | undefined;
  try {
    const headers = await loginFixtureOwner(f);
    const contents = new Map<string, string>();
    for (let index = 0; index < 4; index++) {
      const path = `00-Inbox/hash-${index}.md`,
        content = `# Card ${index}\n\nBody ${index}`;
      contents.set(path, content);
      await fs.writeFile(join(f.knowledgeRoot, path), content);
    }
    await vi.waitFor(
      async () => {
        expect(
          (await f.app.inject({ url: '/api/collections/status?kind=recent', headers })).json()
            .total,
        ).toBe(4);
      },
      { timeout: 5000, interval: 40 },
    );
    const warm = await f.app.inject({ url: '/api/collections?kind=recent', headers });
    expect(warm.statusCode, warm.body).toBe(200);
    const first = (
      await f.app.inject({ url: '/api/collections?kind=recent&limit=2', headers })
    ).json();
    expect(first.nextCursor).toBeTypeOf('string');
    const rows = db
      .prepare(
        'SELECT n.id,n.path,c.modified_ns,c.size_bytes,c.identity,c.source_hash,c.source_version FROM notes n JOIN collection_catalog c ON c.note_id=n.id WHERE n.active=1',
      )
      .all() as {
      id: string;
      path: string;
      modified_ns: string;
      size_bytes: number;
      identity: string;
      source_hash: string | null;
      source_version: string;
    }[];
    expect(rows.every((row) => row.source_hash === null)).toBe(true);
    const spy = vi.spyOn(fs, 'open').mockImplementation(async () => {
      throw new Error('cached source content must not be reopened');
    });
    try {
      for (const row of rows) {
        const hash = createHash('sha256').update(contents.get(row.path)!).digest('hex');
        observeSource(db, row.id, hash, BigInt(row.modified_ns).toString(), row.size_bytes);
      }
      const discovered = (
        await f.app.inject({ url: '/api/collections/status?kind=recent', headers })
      ).json();
      expect(discovered.version).toBe(first.version);
      for (const row of rows) {
        const enriched = db
          .prepare('SELECT source_hash,source_version FROM collection_catalog WHERE note_id=?')
          .get(row.id) as { source_hash: string; source_version: string };
        expect(enriched.source_hash).toBe(
          createHash('sha256').update(contents.get(row.path)!).digest('hex'),
        );
        expect(enriched.source_version).toBe(row.source_version);
        observeCollectionSource(
          db,
          row.id,
          BigInt(row.modified_ns).toString(),
          row.size_bytes,
          undefined,
          row.identity,
        );
        observeSource(
          db,
          row.id,
          enriched.source_hash,
          BigInt(row.modified_ns).toString(),
          row.size_bytes,
        );
      }
      const continued = await f.app.inject({
        url: `/api/collections?kind=recent&limit=2&cursor=${encodeURIComponent(first.nextCursor)}`,
        headers,
      });
      expect(continued.statusCode, continued.body).toBe(200);
      expect(
        new Set([...first.items, ...continued.json().items].map((item: any) => item.id)).size,
      ).toBe(4);
      const again = await f.app.inject({ url: '/api/collections?kind=recent', headers });
      expect(again.statusCode, again.body).toBe(200);
      expect(again.json().version).toBe(first.version);
      expect(again.json().items.every((item: any) => item.summaryState === 'ready')).toBe(true);
      await f.app.close();
      restarted = await createApp(f.config);
      const afterRestart = await restarted.inject({ url: '/api/collections?kind=recent', headers });
      expect(afterRestart.statusCode, afterRestart.body).toBe(200);
      expect(afterRestart.json().version).toBe(first.version);
      expect(afterRestart.json().items.every((item: any) => item.summaryState === 'ready')).toBe(
        true,
      );
      expect(spy).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  } finally {
    db.close();
    await restarted?.close();
    await f.close();
  }
});
