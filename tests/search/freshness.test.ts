import { it, expect } from 'vitest';
import { writeFile, utimes } from 'node:fs/promises';
import { join } from 'node:path';
import { createFixture } from '../support/fixture.js';
import { agentConfig, agentHeaders } from '../support/agent.js';
it('strict freshness detects equal-stat edits while normal indexed reads do not scan all Markdown', async () => {
  const f = await createFixture({ agent: agentConfig, indexing: { enabled: true, watch: false } });
  try {
    const file = join(f.knowledgeRoot, '00-Inbox/fresh.md');
    await writeFile(file, '# Alpha\nunique_old');
    await utimes(file, 1700000000, 1700000000);
    const search = (query: string, freshness = 'indexed') =>
      f.app.inject({
        method: 'POST',
        url: '/api/agent/v1/search',
        headers: agentHeaders(),
        payload: { query, mode: 'text', freshness },
      });
    expect((await search('unique_old', 'strict')).json().data.results).toHaveLength(1);
    await writeFile(file, '# Bravo\nunique_new');
    await utimes(file, 1700000000, 1700000000);
    const indexed = await search('unique_old');
    expect(indexed.statusCode).toBe(200);
    expect(indexed.json().data.index.checkedAt).toBeTruthy();
    expect((await search('unique_new', 'strict')).json().data.results).toHaveLength(1);
    expect((await search('unique_old')).json().data.results).toHaveLength(0);
  } finally {
    await f.close();
  }
});
it('strict timeout returns INDEX_NOT_READY instead of old data and shutdown cancels unstarted work', async () => {
  const f = await createFixture({
    agent: agentConfig,
    indexing: { enabled: true, watch: false },
    fileTasks: { embedded: false },
  });
  try {
    await writeFile(join(f.knowledgeRoot, '00-Inbox/blocked.md'), '# No snapshot yet');
    const r = await f.app.inject({
      method: 'POST',
      url: '/api/agent/v1/search',
      headers: agentHeaders(),
      payload: { query: 'snapshot', mode: 'text', freshness: 'strict' },
    });
    expect(r.statusCode).toBe(503);
    expect(r.json().error.code).toBe('INDEX_NOT_READY');
    expect(r.json()).not.toHaveProperty('data');
  } finally {
    await f.close();
  }
});
