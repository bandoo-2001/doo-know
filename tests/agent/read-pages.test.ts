import { it, expect } from 'vitest';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createFixture } from '../support/fixture.js';
import { agentConfig, agentHeaders } from '../support/agent.js';
import { readyRead } from '../support/read.js';
it.each(['中文😀\r\n'.repeat(1000), '中文😀'.repeat(5000), '\\\"\t'.repeat(15000)])(
  'reads exact UTF-8 bytes across bounded long-line pages and replays cursors without double debit',
  async (content) => {
    const f = await createFixture({ agent: agentConfig });
    try {
      await writeFile(join(f.knowledgeRoot, '00-Inbox/read.md'), content);
      const n = (await f.app.inject({ url: '/api/agent/v1/notes', headers: agentHeaders() })).json()
        .data.items[0];
      expect(n?.id).toBeTruthy();
      let r = await readyRead(f, n.id, { maxBytes: 16384 });
      expect(r.statusCode).toBe(200);
      const buffers: Buffer[] = [];
      let offset = 0,
        pages = 0;
      while (true) {
        const page = r.json().data.data;
        expect(page.startByte).toBe(offset);
        expect(page.bytesReturned).toBe(Buffer.byteLength(page.content));
        expect(page.bytesReturned).toBeLessThanOrEqual(16384);
        expect(page.content).not.toContain('\ufffd');
        const result = { data: r.json().data };
        const wire = {
          jsonrpc: '2.0',
          id: 'request',
          result: {
            structuredContent: result,
            content: [{ type: 'text', text: JSON.stringify(result) }],
          },
        };
        expect(Buffer.byteLength(JSON.stringify(wire))).toBeLessThanOrEqual(65536);
        buffers.push(Buffer.from(page.content));
        offset = page.endByte;
        if (!page.hasMore) break;
        expect(++pages).toBeLessThan(32);
        const payload = { cursor: page.nextCursor };
        const next = await f.app.inject({
          method: 'POST',
          url: `/api/agent/v1/notes/${n.id}/read`,
          headers: agentHeaders(),
          payload,
        });
        const retry = await f.app.inject({
          method: 'POST',
          url: `/api/agent/v1/notes/${n.id}/read`,
          headers: agentHeaders(),
          payload,
        });
        expect(retry.json()).toEqual(next.json());
        r = next;
      }
      expect(Buffer.concat(buffers)).toEqual(Buffer.from(content));
    } finally {
      await f.close();
    }
  },
);
it('rejects stale, crossed-identity and range-plus-cursor reads and cannot select Web limits', async () => {
  const f = await createFixture({ agent: agentConfig });
  try {
    await writeFile(join(f.knowledgeRoot, '00-Inbox/stale.md'), 'line\n'.repeat(10000));
    const n = (await f.app.inject({ url: '/api/agent/v1/notes', headers: agentHeaders() })).json()
      .data.items[0];
    const r = await readyRead(f, n.id);
    expect(r.statusCode).toBe(200);
    const page = r.json().data.data;
    const url = `/api/agent/v1/notes/${n.id}/read`;
    expect(
      (
        await f.app.inject({
          method: 'POST',
          url,
          headers: agentHeaders(),
          payload: { cursor: page.nextCursor, range: { startLine: 1, endLine: 2 } },
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (
        await f.app.inject({
          method: 'POST',
          url,
          headers: agentHeaders(),
          payload: { maxBytes: 128 * 1024, channel: 'web' },
        })
      ).statusCode,
    ).toBe(400);
    await writeFile(join(f.knowledgeRoot, '00-Inbox/stale.md'), 'changed');
    const stale = await f.app.inject({
      method: 'POST',
      url,
      headers: agentHeaders(),
      payload: { cursor: page.nextCursor },
    });
    expect(stale.json().error.code).toBe('STALE_CURSOR');
  } finally {
    await f.close();
  }
});
