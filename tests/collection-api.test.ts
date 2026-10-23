import { expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import { join } from 'node:path';
import { createFixture, loginFixtureOwner } from './support/fixture.js';
import { createApp } from '../apps/server/app.js';
import type { CollectionPage } from '../shared/collection-contracts.js';
import { openDatabase } from '../packages/core/db.js';
import { observeSource } from '../packages/core/indexing/state.js';

async function waitFor(check: () => Promise<boolean>) {
  await vi.waitFor(async () => expect(await check()).toBe(true), { timeout: 5000, interval: 40 });
}

it('pages tied modification times once, filters favorites before paging, and validates cursors', async () => {
  const f = await createFixture();
  try {
    const headers = await loginFixtureOwner(f);
    expect((await f.app.inject('/api/collections?kind=recent')).statusCode).toBe(401);
    for (let i = 0; i < 9; i++) {
      const path = join(f.knowledgeRoot, '00-Inbox', `page-${i}.md`);
      await fs.writeFile(
        path,
        `# Heading ${i}\n\n**Readable** [body](https://example.com) ![image](x.png)`,
      );
      await fs.utimes(path, new Date('2020-01-01'), new Date('2020-01-01'));
    }
    await waitFor(
      async () =>
        (await f.app.inject({ url: '/api/collections/status?kind=recent', headers })).json()
          .total === 9,
    );
    const seen: string[] = [];
    let cursor: string | null = null;
    let firstCursor = '';
    do {
      const reply = await f.app.inject({
        url: `/api/collections?kind=recent&limit=3${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`,
        headers,
      });
      expect(reply.statusCode, reply.body).toBe(200);
      const page: CollectionPage = reply.json();
      expect(page.total).toBe(9);
      expect(page.items).toHaveLength(3);
      for (const item of page.items) {
        expect(item.summary).toContain('Readable body');
        expect(item.summary).not.toContain('https://');
        expect(item.summaryState).toBe('ready');
      }
      seen.push(...page.items.map((n: any) => n.id));
      cursor = page.nextCursor;
      firstCursor ||= cursor || '';
    } while (cursor);
    expect(new Set(seen).size).toBe(9);
    expect(seen).toEqual([...seen].sort());
    for (const id of [seen[2], seen[7]])
      await f.app.inject({
        method: 'PUT',
        url: `/api/notes/${id}/favorite`,
        headers,
        payload: { favorite: true },
      });
    const db = openDatabase(f.dataRoot);
    try {
      db.prepare('INSERT INTO note_favorites(owner_id,note_id) VALUES(?,?)').run(
        'other-owner',
        seen[3],
      );
    } finally {
      db.close();
    }
    const favorites = (
      await f.app.inject({ url: '/api/collections?kind=favorites&limit=1', headers })
    ).json();
    expect(favorites.total).toBe(2);
    expect(favorites.items.map((n: any) => n.id)).toEqual([seen[2]]);
    expect(favorites.items[0].favorite).toBe(true);
    const stale = await f.app.inject({
      url: `/api/collections?kind=recent&cursor=${encodeURIComponent(firstCursor)}`,
      headers,
    });
    expect(stale.statusCode).toBe(409);
    expect(stale.json().code).toBe('COLLECTION_CHANGED');
    for (const query of [
      'kind=nope',
      'kind=recent&limit=0',
      'kind=recent&limit=49',
      'kind=recent&limit=1.5',
      'kind=recent&cursor=bad',
    ])
      expect(
        (await f.app.inject({ url: `/api/collections?${query}`, headers })).statusCode,
        query,
      ).toBe(400);
    expect(
      (
        await f.app.inject({
          url: `/api/collections?kind=favorites&cursor=${encodeURIComponent(firstCursor)}`,
          headers,
        })
      ).statusCode,
    ).toBe(400);
  } finally {
    await f.close();
  }
});

it('tracks external edits and deletions with indexing disabled and isolates invalid source files', async () => {
  const f = await createFixture();
  try {
    const headers = await loginFixtureOwner(f);
    const path = join(f.knowledgeRoot, '00-Inbox/external.md');
    await fs.writeFile(path, '# Original\n\nfirst summary');
    await fs.writeFile(join(f.knowledgeRoot, '00-Inbox/invalid.md'), Buffer.from([255, 254, 253]));
    await waitFor(
      async () =>
        (await f.app.inject({ url: '/api/collections/status?kind=recent', headers })).json()
          .total === 2,
    );
    const load = async () =>
      (await f.app.inject({ url: '/api/collections?kind=recent', headers })).json();
    const initial = await load();
    expect(initial.items.find((n: any) => n.path.endsWith('invalid.md')).summaryState).toBe(
      'unavailable',
    );
    expect(initial.items.find((n: any) => n.path.endsWith('external.md')).summary).toContain(
      'first summary',
    );
    await fs.writeFile(path, '# Changed\n\nsecond summary');
    await waitFor(
      async () =>
        (await f.app.inject({ url: '/api/collections/status?kind=recent', headers })).json()
          .version !== initial.version,
    );
    expect((await load()).items.find((n: any) => n.path.endsWith('external.md')).summary).toContain(
      'second summary',
    );
    await fs.unlink(path);
    await waitFor(
      async () =>
        (await f.app.inject({ url: '/api/collections/status?kind=recent', headers })).json()
          .total === 1,
    );
  } finally {
    await f.close();
  }
});

it('bounds cold reads, deduplicates overlapping pages, and reuses the persistent cache after restart', async () => {
  const f = await createFixture();
  let restarted: Awaited<ReturnType<typeof createApp>> | undefined;
  try {
    const headers = await loginFixtureOwner(f);
    for (let i = 0; i < 6; i++)
      await fs.writeFile(
        join(f.knowledgeRoot, `00-Inbox/budget-${i}.md`),
        `# Budget ${i}\n\n${'readable text '.repeat(2000)}AFTER_BYTE_LIMIT`,
      );
    await waitFor(
      async () =>
        (await f.app.inject({ url: '/api/collections/status?kind=recent', headers })).json()
          .total === 6,
    );
    let active = 0,
      maxActive = 0,
      totalBytes = 0,
      reads = 0;
    const originalOpen = fs.open.bind(fs);
    const spy = vi
      .spyOn(fs, 'open')
      .mockImplementation(async (...args: Parameters<typeof fs.open>) => {
        const handle = await originalOpen(...args);
        if (String(args[0]).endsWith('.md')) {
          const originalRead = handle.read.bind(handle);
          handle.read = (async (...input: any[]) => {
            active++;
            maxActive = Math.max(maxActive, active);
            reads++;
            try {
              await new Promise((resolve) => setTimeout(resolve, 15));
              const result = await (originalRead as any)(...input);
              totalBytes += result.bytesRead;
              return result;
            } finally {
              active--;
            }
          }) as typeof handle.read;
        }
        return handle;
      });
    try {
      const pages = await Promise.all(
        Array.from({ length: 4 }, () =>
          f.app.inject({ url: '/api/collections?kind=recent', headers }),
        ),
      );
      for (const reply of pages) {
        expect(reply.statusCode, reply.body).toBe(200);
        expect(
          reply
            .json()
            .items.every(
              (item: any) =>
                item.summaryState === 'ready' && !item.summary.includes('AFTER_BYTE_LIMIT'),
            ),
        ).toBe(true);
      }
      expect(reads).toBe(6);
      expect(maxActive).toBeLessThanOrEqual(2);
      expect(totalBytes).toBeLessThanOrEqual(6 * 8192);
      await f.app.inject({ url: '/api/collections?kind=recent', headers });
      await f.app.inject({ url: '/api/collections/status?kind=recent', headers });
      expect(reads).toBe(6);
      const fileModule = await import('../packages/core/files.js');
      const scanSpy = vi.spyOn(fileModule, 'scanFiles').mockImplementation(() => {
        throw new Error('browser requests must never scan the source tree');
      });
      try {
        for (let i = 0; i < 3; i++) {
          expect(
            (await f.app.inject({ url: '/api/collections?kind=recent', headers })).statusCode,
          ).toBe(200);
          expect(
            (await f.app.inject({ url: '/api/collections/status?kind=recent', headers }))
              .statusCode,
          ).toBe(200);
        }
      } finally {
        scanSpy.mockRestore();
      }
      await f.app.close();
      restarted = await createApp(f.config);
      const warm = await restarted.inject({ url: '/api/collections?kind=recent', headers });
      expect(warm.statusCode, warm.body).toBe(200);
      expect(reads).toBe(6);
    } finally {
      spy.mockRestore();
    }
  } finally {
    await restarted?.close();
    await f.close();
  }
});

it('serves saved summaries immediately and excludes symbolic links and shared hard links', async () => {
  const f = await createFixture();
  try {
    const headers = await loginFixtureOwner(f);
    const create = await f.app.inject({
      method: 'POST',
      url: '/api/notes',
      headers,
      payload: {
        folderPath: '00-Inbox',
        fileName: 'saved.md',
        content: '# Saved title\n\n**Existing** body',
      },
    });
    const note = create.json();
    const originalOpen = fs.open.bind(fs);
    const spy = vi
      .spyOn(fs, 'open')
      .mockImplementation(async (...args: Parameters<typeof fs.open>) => {
        if (String(args[0]).endsWith('.md'))
          throw new Error('original content must already be cached');
        return originalOpen(...args);
      });
    try {
      const initial = (await f.app.inject({ url: '/api/collections?kind=recent', headers })).json();
      expect(initial.items[0]).toMatchObject({
        id: note.id,
        title: 'Saved title',
        summaryState: 'ready',
        summary: 'Existing body',
      });
      const save = await f.app.inject({
        method: 'PUT',
        url: `/api/notes/${note.id}`,
        headers,
        payload: { content: '# New title\n\nChanged body', expectedModifiedAt: note.modifiedAt },
      });
      expect(save.statusCode, save.body).toBe(200);
      expect(
        (await f.app.inject({ url: '/api/collections?kind=recent', headers })).json().items[0],
      ).toMatchObject({
        title: 'New title',
        summary: 'Changed body',
        summaryState: 'ready',
      });
    } finally {
      spy.mockRestore();
    }
    await fs.symlink(
      join(f.knowledgeRoot, note.relativePath),
      join(f.knowledgeRoot, '00-Inbox/link.md'),
    );
    await fs.link(
      join(f.knowledgeRoot, note.relativePath),
      join(f.knowledgeRoot, '00-Inbox/hard.md'),
    );
    await waitFor(
      async () =>
        (await f.app.inject({ url: '/api/collections/status?kind=recent', headers })).json()
          .total === 0,
    );
  } finally {
    await f.close();
  }
});

it('never lets an obsolete in-flight read poison a same-size same-mtime replacement', async () => {
  const f = await createFixture();
  try {
    const headers = await loginFixtureOwner(f);
    const path = join(f.knowledgeRoot, '00-Inbox/race.md');
    const fixed = new Date('2020-01-01T00:00:00Z');
    await fs.writeFile(path, '# Before\nold body');
    await fs.utimes(path, fixed, fixed);
    const status = async () =>
      (await f.app.inject({ url: '/api/collections/status?kind=recent', headers })).json();
    await waitFor(async () => (await status()).total === 1);
    const initial = await status();
    let entered!: () => void, release!: () => void;
    const reading = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const originalOpen = fs.open.bind(fs);
    const spy = vi
      .spyOn(fs, 'open')
      .mockImplementation(async (...args: Parameters<typeof fs.open>) => {
        const handle = await originalOpen(...args);
        if (String(args[0]) === path) {
          const read = handle.read.bind(handle);
          handle.read = (async (...input: any[]) => {
            const result = await (read as any)(...input);
            entered();
            await gate;
            return result;
          }) as typeof handle.read;
        }
        return handle;
      });
    try {
      // inject starts execution when its thenable is consumed.
      const first = f.app
        .inject({ url: '/api/collections?kind=recent', headers })
        .then((reply) => reply);
      await reading;
      await fs.writeFile(path, '# After \nnew body');
      await fs.utimes(path, fixed, fixed);
      await waitFor(async () => (await status()).version !== initial.version);
      release();
      expect((await first).statusCode).toBe(409);
    } finally {
      release();
      spy.mockRestore();
    }
    const next = await f.app.inject({ url: '/api/collections?kind=recent', headers });
    expect(next.statusCode, next.body).toBe(200);
    expect(next.json().items[0]).toMatchObject({
      title: 'After',
      summary: 'new body',
      summaryState: 'ready',
    });
  } finally {
    await f.close();
  }
});

it('invalidates cached text when an index observer sees a new content hash with unchanged source metadata', async () => {
  const f = await createFixture();
  const db = openDatabase(f.dataRoot);
  try {
    const headers = await loginFixtureOwner(f);
    const content = '# Original\nfirst body';
    const created = (
      await f.app.inject({
        method: 'POST',
        url: '/api/notes',
        headers,
        payload: { folderPath: '00-Inbox', fileName: 'observed.md', content },
      })
    ).json();
    const initial = (
      await f.app.inject({ url: '/api/collections/status?kind=recent', headers })
    ).json();
    observeSource(
      db,
      created.id,
      'independently-observed-new-hash',
      created.modifiedAt,
      Buffer.byteLength(content),
    );
    const changed = (
      await f.app.inject({ url: '/api/collections/status?kind=recent', headers })
    ).json();
    expect(changed.version).not.toBe(initial.version);
    let reads = 0;
    const originalOpen = fs.open.bind(fs);
    const spy = vi
      .spyOn(fs, 'open')
      .mockImplementation(async (...args: Parameters<typeof fs.open>) => {
        if (String(args[0]).endsWith('observed.md')) reads++;
        return originalOpen(...args);
      });
    try {
      const page = (await f.app.inject({ url: '/api/collections?kind=recent', headers })).json();
      expect(page.items[0].summaryState).toBe('ready');
      expect(reads).toBe(1);
    } finally {
      spy.mockRestore();
    }
  } finally {
    db.close();
    await f.close();
  }
});

it('loads 24 cards by default and bounds an explicitly larger page to 48 cards', async () => {
  const f = await createFixture();
  try {
    const headers = await loginFixtureOwner(f);
    await Promise.all(
      Array.from({ length: 55 }, (_, index) =>
        fs.writeFile(
          join(f.knowledgeRoot, `00-Inbox/large-${index}.md`),
          `# Card ${index}\n\nDescription`,
        ),
      ),
    );
    await waitFor(
      async () =>
        (await f.app.inject({ url: '/api/collections/status?kind=recent', headers })).json()
          .total === 55,
    );
    const first: CollectionPage = (
      await f.app.inject({ url: '/api/collections?kind=recent', headers })
    ).json();
    expect(first.items).toHaveLength(24);
    const second: CollectionPage = (
      await f.app.inject({
        url: `/api/collections?kind=recent&cursor=${encodeURIComponent(first.nextCursor!)}`,
        headers,
      })
    ).json();
    expect(second.items).toHaveLength(24);
    const third: CollectionPage = (
      await f.app.inject({
        url: `/api/collections?kind=recent&cursor=${encodeURIComponent(second.nextCursor!)}`,
        headers,
      })
    ).json();
    expect(third.items).toHaveLength(7);
    expect(third.nextCursor).toBe(null);
    expect(
      new Set([...first.items, ...second.items, ...third.items].map((item) => item.id)).size,
    ).toBe(55);
    const maximum = (
      await f.app.inject({ url: '/api/collections?kind=recent&limit=48', headers })
    ).json();
    expect(maximum.items).toHaveLength(48);
  } finally {
    await f.close();
  }
});
