import { it, expect } from 'vitest';
import { writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { createFixture, loginFixtureOwner } from '../support/fixture.js';
import { readyRead } from '../support/read.js';
import { agentConfig, agentHeaders } from '../support/agent.js';
it('restores large historical bytes through a background job and preserves one revision on retries', async () => {
  const f = await createFixture({ agent: agentConfig });
  try {
    const file = join(f.knowledgeRoot, '00-Inbox/history-large.md'),
      old = '# Historical\n' + 'x'.repeat(2 * 1024 * 1024);
    await writeFile(file, old);
    const headers = agentHeaders(),
      n = (await f.app.inject({ url: '/api/agent/v1/notes', headers })).json().data.items[0],
      page = (await readyRead(f, n.id)).json().data.data;
    const patch = (
      await f.app.inject({
        method: 'POST',
        url: `/api/agent/v1/notes/${n.id}/patch`,
        headers,
        payload: {
          snapshotId: page.snapshotId,
          expectedModifiedAt: page.modifiedAt,
          expectedContentHash: page.sourceHash,
          requestId: 'history-source',
          edits: [{ type: 'replace_text', before: '# Historical', after: '# Current' }],
        },
      })
    ).json().data;
    let saved: any;
    for (let i = 0; i < 100; i++) {
      saved = (
        await f.app.inject({
          url: `/api/agent/v1/operations/${patch.operation.operationId}`,
          headers,
        })
      ).json().data;
      if (saved.status === 'succeeded') break;
      await new Promise((r) => setTimeout(r, 20));
    }
    expect(saved.status).toBe('succeeded');
    const h = await loginFixtureOwner(f),
      revision = (await f.app.inject({ url: `/api/notes/${n.id}/revisions`, headers: h })).json()
        .items[0];
    const payload = { expectedModifiedAt: saved.result.modifiedAt, requestId: 'restore-original' },
      url = `/api/notes/${n.id}/revisions/${revision.id}/restore`;
    const start = await f.app.inject({ method: 'POST', url, headers: h, payload });
    expect(start.statusCode).toBe(200);
    expect(start.json().kind).toBe('accepted');
    const id = start.json().operation.operationId;
    let op: any;
    for (let i = 0; i < 100; i++) {
      op = (await f.app.inject({ url: `/api/operations/${id}`, headers: h })).json();
      if (['succeeded', 'failed'].includes(op.status)) break;
      await new Promise((r) => setTimeout(r, 20));
    }
    expect(op.status).toBe('succeeded');
    expect(op.result).not.toHaveProperty('content');
    expect(
      createHash('sha256')
        .update(await readFile(file))
        .digest('hex'),
    ).toBe(createHash('sha256').update(old).digest('hex'));
    expect(
      (await f.app.inject({ method: 'POST', url, headers: h, payload })).json().operation
        .operationId,
    ).toBe(id);
    expect(
      (await f.app.inject({ url: `/api/notes/${n.id}/revisions`, headers: h })).json().items,
    ).toHaveLength(2);
  } finally {
    await f.close();
  }
});
