import { it, expect } from 'vitest';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createFixture } from '../support/fixture.js';
import { agentConfig, agentHeaders } from '../support/agent.js';
import { readyRead } from '../support/read.js';
import { messageSize } from '../../server/knowledge/limits.js';
it('shrinks metadata and outline pages using the complete compatibility response budget', async () => {
  const f = await createFixture({ agent: agentConfig });
  try {
    for (let i = 0; i < 40; i++)
      await f.app.inject({
        method: 'POST',
        url: '/api/agent/v1/notes',
        headers: agentHeaders(),
        payload: {
          directory: '00-Inbox',
          fileName: `meta-${i}.md`,
          content: '# ' + '长标题'.repeat(100),
          requestId: 'meta-' + i,
        },
      });
    let cursor: string | undefined;
    const ids = new Set<string>();
    do {
      const r: import('light-my-request').Response = await f.app.inject({
        url:
          '/api/agent/v1/notes?limit=50' + (cursor ? '&cursor=' + encodeURIComponent(cursor) : ''),
        headers: agentHeaders(),
      });
      expect(r.statusCode).toBe(200);
      const page: any = r.json().data;
      expect(messageSize(page)).toBeLessThanOrEqual(65536);
      for (const n of page.items) {
        expect(ids.has(n.id)).toBe(false);
        ids.add(n.id);
      }
      cursor = page.nextCursor;
    } while (cursor);
    expect(ids.size).toBe(40);
    await writeFile(
      join(f.knowledgeRoot, '00-Inbox/000-outline.md'),
      Array.from({ length: 60 }, (_, i) => '# ' + i + ' ' + '章节'.repeat(130)).join('\n'),
    );
    const notes = (
      await f.app.inject({
        url: '/api/agent/v1/notes?directory=00-Inbox&limit=50',
        headers: agentHeaders(),
      })
    ).json().data.items;
    let n = notes.find((n: any) => n.relativePath.endsWith('/000-outline.md'));
    if (!n) {
      const next = (
        await f.app.inject({
          url:
            '/api/agent/v1/notes?directory=00-Inbox&limit=50&cursor=' +
            encodeURIComponent(
              (
                await f.app.inject({
                  url: '/api/agent/v1/notes?directory=00-Inbox&limit=50',
                  headers: agentHeaders(),
                })
              ).json().data.nextCursor,
            ),
          headers: agentHeaders(),
        })
      ).json().data.items;
      n = next.find((n: any) => n.relativePath.endsWith('/000-outline.md'));
    }
    await readyRead(f, n.id);
    let count = 0;
    cursor = undefined;
    do {
      const r: import('light-my-request').Response = await f.app.inject({
        url:
          `/api/agent/v1/notes/${n.id}/outline` +
          (cursor ? '?cursor=' + encodeURIComponent(cursor) : ''),
        headers: agentHeaders(),
      });
      expect(r.statusCode).toBe(200);
      const page: any = r.json().data;
      expect(messageSize(page)).toBeLessThanOrEqual(65536);
      count += page.data.items.length;
      cursor = page.data.nextCursor;
    } while (cursor);
    expect(count).toBe(60);
  } finally {
    await f.close();
  }
});
