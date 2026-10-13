import { it, expect } from 'vitest';
import { writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createFixture } from '../support/fixture.js';
import { agentConfig, agentHeaders } from '../support/agent.js';
import { readyRead } from '../support/read.js';
it('accepts a large patch in background and cancellation before committing preserves source bytes', async () => {
  const f = await createFixture({ agent: agentConfig });
  try {
    const content = '# Large\n' + 'A'.repeat(2 * 1024 * 1024),
      file = join(f.knowledgeRoot, '00-Inbox/job.md');
    await writeFile(file, content);
    const headers = agentHeaders();
    const n = (await f.app.inject({ url: '/api/agent/v1/notes', headers })).json().data.items[0],
      page = (await readyRead(f, n.id)).json().data.data;
    const start = await f.app.inject({
      method: 'POST',
      url: `/api/agent/v1/notes/${n.id}/patch`,
      headers,
      payload: {
        snapshotId: page.snapshotId,
        expectedModifiedAt: page.modifiedAt,
        expectedContentHash: page.sourceHash,
        requestId: 'cancel-large',
        edits: [{ type: 'replace_text', before: '# Large', after: '# Cancelled' }],
      },
    });
    expect(start.statusCode).toBe(200);
    expect(start.json().data.kind).toBe('accepted');
    const cancel = await f.app.inject({
      method: 'POST',
      url: `/api/agent/v1/operations/${start.json().data.operation.operationId}/cancel`,
      headers,
      payload: {},
    });
    expect([200, 409]).toContain(cancel.statusCode);
    if (cancel.statusCode === 200 && cancel.json().data.status === 'cancelled')
      expect(await readFile(file, 'utf8')).toBe(content);
  } finally {
    await f.close();
  }
});
