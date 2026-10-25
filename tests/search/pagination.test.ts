import { it, expect } from 'vitest';
import { writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { createFixture } from '../support/fixture.js';
import { agentConfig, agentHeaders } from '../support/agent.js';
import { openDatabase } from '../../packages/core/db.js';
import { decodeCursor, signCursor } from '../../packages/core/agent/budgets.js';
it('pages the bounded ranking universe and binds metadata cursors to identity and directory', async () => {
  const f = await createFixture({ agent: agentConfig, indexing: { enabled: true, watch: false } });
  try {
    await mkdir(join(f.knowledgeRoot, '00-Inbox/group'));
    await mkdir(join(f.knowledgeRoot, '00-Inbox/other'));
    for (let i = 0; i < 55; i++)
      await writeFile(
        join(f.knowledgeRoot, `00-Inbox/group/n-${String(i).padStart(2, '0')}.md`),
        '# 检索分页\n一致的搜索测试',
      );
    await writeFile(join(f.knowledgeRoot, '00-Inbox/other/outside.md'), '# 无关');
    const first = await f.app.inject({
      method: 'POST',
      url: '/api/agent/v1/search',
      headers: agentHeaders(),
      payload: { query: '搜索', mode: 'text', freshness: 'strict', limit: 50 },
    });
    expect(first.statusCode).toBe(200);
    expect(first.json().data.results.length).toBeGreaterThan(10);
    expect(first.json().data.results.length).toBeLessThanOrEqual(50);
    expect(first.json().data.nextCursor).toBeTruthy();
    const second = await f.app.inject({
      method: 'POST',
      url: '/api/agent/v1/search',
      headers: agentHeaders(),
      payload: { query: '搜索', mode: 'text', limit: 50, cursor: first.json().data.nextCursor },
    });
    expect(second.statusCode).toBe(200);
    expect(second.json().data.results).toHaveLength(55 - first.json().data.results.length);
    const listed = await f.app.inject({
      url: '/api/agent/v1/notes?directory=00-Inbox/group&limit=10',
      headers: agentHeaders(),
    });
    expect(listed.statusCode).toBe(200);
    expect(listed.json().data.items).toHaveLength(10);
    expect(
      listed.json().data.items.every((n: any) => n.relativePath.startsWith('00-Inbox/group/')),
    ).toBe(true);
    const cursor = encodeURIComponent(listed.json().data.nextCursor);
    const next = await f.app.inject({
      url: '/api/agent/v1/notes?directory=00-Inbox/group&limit=10&cursor=' + cursor,
      headers: agentHeaders(),
    });
    expect(next.statusCode).toBe(200);
    expect(next.json().data.items[0].id).not.toBe(listed.json().data.items[0].id);
    expect(
      (
        await f.app.inject({
          url: '/api/agent/v1/notes?directory=00-Inbox/other&limit=10&cursor=' + cursor,
          headers: agentHeaders(),
        })
      ).statusCode,
    ).toBe(403);
  } finally {
    await f.close();
  }
});

it('expires an old offset when strict refresh changes the result set', async () => {
  const f = await createFixture({ agent: agentConfig, indexing: { enabled: true, watch: false } });
  try {
    for (let i = 0; i < 3; i++)
      await writeFile(join(f.knowledgeRoot, `00-Inbox/strict-${i}.md`), '# 搜索分页\n搜索');
    const payload = { query: '搜索', mode: 'text', freshness: 'strict', limit: 1 };
    const first = await f.app.inject({
      method: 'POST',
      url: '/api/agent/v1/search',
      headers: agentHeaders(),
      payload,
    });
    expect(first.statusCode).toBe(200);
    await writeFile(join(f.knowledgeRoot, first.json().data.results[0].relativePath), '# 不再匹配');
    const next = await f.app.inject({
      method: 'POST',
      url: '/api/agent/v1/search',
      headers: agentHeaders(),
      payload: { ...payload, cursor: first.json().data.nextCursor },
    });
    expect(next.statusCode).toBe(410);
    expect(next.json().error.code).toBe('CURSOR_EXPIRED');
  } finally {
    await f.close();
  }
});

it('expires filename-v2 cursors after note-diverse ranking changes even when sources are unchanged', async () => {
  const f = await createFixture({ agent: agentConfig, indexing: { enabled: true, watch: false } });
  const db = openDatabase(f.dataRoot);
  try {
    for (let i = 0; i < 3; i++)
      await writeFile(join(f.knowledgeRoot, `00-Inbox/cursor-${i}.md`), '# 搜索分页\n搜索');
    const payload = { query: '搜索', mode: 'text', freshness: 'strict', limit: 1 };
    const first = await f.app.inject({
      method: 'POST',
      url: '/api/agent/v1/search',
      headers: agentHeaders(),
      payload,
    });
    expect(first.statusCode, first.body).toBe(200);
    const current = decodeCursor(f.config.secret, first.json().data.nextCursor);
    const legacyEpoch =
      'filename-v2:' +
      String(
        (db.prepare("SELECT value FROM index_meta WHERE key='index_epoch'").get() as any).value,
      ) +
      ':none';
    const cursor = signCursor(f.config.secret, { ...current, epoch: legacyEpoch });
    const next = await f.app.inject({
      method: 'POST',
      url: '/api/agent/v1/search',
      headers: agentHeaders(),
      payload: { ...payload, freshness: 'indexed', cursor },
    });
    expect(next.statusCode).toBe(410);
    expect(next.json().error.code).toBe('CURSOR_EXPIRED');
  } finally {
    db.close();
    await f.close();
  }
});
