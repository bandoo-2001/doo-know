import { it, expect } from 'vitest';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createFixture } from '../support/fixture.js';
import { agentConfig, agentHeaders } from '../support/agent.js';
it('counts queued snapshot reservations toward the principal 64 MiB quota', async () => {
  const f = await createFixture({ agent: agentConfig, fileTasks: { embedded: false } });
  try {
    const bytes = Buffer.alloc(20 * 1024 * 1024, 120);
    for (let i = 0; i < 4; i++)
      await writeFile(join(f.knowledgeRoot, `00-Inbox/quota-${i}.md`), bytes);
    const headers = agentHeaders(),
      notes = (await f.app.inject({ url: '/api/agent/v1/notes', headers })).json().data.items;
    for (let i = 0; i < 3; i++) {
      const r = await f.app.inject({
        method: 'POST',
        url: `/api/agent/v1/notes/${notes[i].id}/read`,
        headers,
        payload: {},
      });
      expect(r.statusCode).toBe(200);
    }
    for (let i = 0; i < 2; i++) {
      const full = await f.app.inject({
        method: 'POST',
        url: `/api/agent/v1/notes/${notes[3].id}/read`,
        headers,
        payload: {},
      });
      expect(full.statusCode).toBe(429);
      expect(full.json().error.code).toBe('SNAPSHOT_QUOTA_EXCEEDED');
    }
  } finally {
    await f.close();
  }
});
