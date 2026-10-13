import { it, expect } from 'vitest';
import { writeFile, mkdir, utimes } from 'node:fs/promises';
import { join } from 'node:path';
import { createFixture } from '../support/fixture.js';
import { agentConfig, agentHeaders } from '../support/agent.js';
it('filters indexed tags and dates during recall and rejects malformed filters', async () => {
  const f = await createFixture({ agent: agentConfig, indexing: { enabled: true, watch: false } });
  try {
    await mkdir(join(f.knowledgeRoot, '00-Inbox/group'));
    for (const [name, tags] of [
      ['old', '[备份]'],
      ['new', '[知识, mcp]'],
      ['plain', '[]'],
    ]) {
      const path = join(f.knowledgeRoot, `00-Inbox/group/${name}.md`);
      await writeFile(path, `---\ntags: ${tags}\n---\n# 同词知识\n统一检索词`);
      if (name === 'old') await utimes(path, 1600000000, 1600000000);
    }
    const request = (filters: any, freshness = 'indexed') =>
      f.app.inject({
        method: 'POST',
        url: '/api/agent/v1/search',
        headers: agentHeaders(),
        payload: { query: '检索', mode: 'text', freshness, filters },
      });
    expect(
      (await request({ directory: '00-Inbox/group' }, 'strict')).json().data.results,
    ).toHaveLength(3);
    const tagged = await request({ tags: ['mcp'] });
    expect(tagged.statusCode).toBe(200);
    expect(tagged.json().data.results.map((n: any) => n.relativePath)).toEqual([
      '00-Inbox/group/new.md',
    ]);
    expect(
      (await request({ updatedAfter: '2021-01-01T00:00:00Z' })).json().data.results,
    ).toHaveLength(2);
    expect((await request({ tags: 'mcp' })).statusCode).toBe(400);
    expect((await request({ updatedAfter: 'bad-date' })).statusCode).toBe(400);
    expect((await request({ directory: '../outside' })).statusCode).toBe(400);
  } finally {
    await f.close();
  }
});
