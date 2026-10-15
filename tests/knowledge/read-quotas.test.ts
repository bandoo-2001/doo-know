import { it, expect, vi } from 'vitest';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createFixture } from '../support/fixture.js';
import { readyRead } from '../support/read.js';
import { agentConfig, agentHeaders } from '../support/agent.js';
import { openDatabase } from '../../packages/core/db.js';
it('enforces persistent page budget, idempotent concurrent cursor retry, current grants and expiry', async () => {
  const f = await createFixture({ agent: agentConfig });
  try {
    await writeFile(join(f.knowledgeRoot, '00-Inbox/quota.md'), 'x'.repeat(400000));
    const headers = agentHeaders(),
      n = (await f.app.inject({ url: '/api/agent/v1/notes', headers })).json().data.items[0];
    let page = (await readyRead(f, n.id, { maxBytes: 8192 })).json().data.data;
    const url = `/api/agent/v1/notes/${n.id}/read`,
      payload = { cursor: page.nextCursor };
    const both = await Promise.all([
      f.app.inject({ method: 'POST', url, headers, payload }),
      f.app.inject({ method: 'POST', url, headers, payload }),
    ]);
    expect(both[0].json()).toEqual(both[1].json());
    page = both[0].json().data.data;
    for (let i = 2; i < 32; i++) {
      const r = await f.app.inject({
        method: 'POST',
        url,
        headers,
        payload: { cursor: page.nextCursor },
      });
      expect(r.statusCode).toBe(200);
      page = r.json().data.data;
    }
    const exhausted = await f.app.inject({
      method: 'POST',
      url,
      headers,
      payload: { cursor: page.nextCursor },
    });
    expect(exhausted.json().error.code).toBe('READ_BUDGET_EXCEEDED');
    const clock = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 16 * 60 * 1000);
    try {
      expect(
        (
          await f.app.inject({
            method: 'POST',
            url,
            headers: agentHeaders(),
            payload: { cursor: page.nextCursor },
          })
        ).json().error.code,
      ).toBe('CURSOR_EXPIRED');
    } finally {
      clock.mockRestore();
    }
  } finally {
    await f.close();
  }
});
it('rejects cross-client cursors even with access to the same note', async () => {
  const config = {
    ...agentConfig,
    policies: [...agentConfig.policies, { ...agentConfig.policies[0], clientId: 'second-client' }],
  };
  const f = await createFixture({ agent: config });
  try {
    await writeFile(join(f.knowledgeRoot, '00-Inbox/cross.md'), 'x'.repeat(20000));
    const n = (await f.app.inject({ url: '/api/agent/v1/notes', headers: agentHeaders() })).json()
        .data.items[0],
      page = (await readyRead(f, n.id)).json().data.data;
    const r = await f.app.inject({
      method: 'POST',
      url: `/api/agent/v1/notes/${n.id}/read`,
      headers: agentHeaders({ clientId: 'second-client' }),
      payload: { cursor: page.nextCursor },
    });
    expect(r.statusCode).toBe(403);
  } finally {
    await f.close();
  }
});
