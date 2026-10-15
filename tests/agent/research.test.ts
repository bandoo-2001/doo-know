import { it, expect } from 'vitest';
import { writeFile, utimes } from 'node:fs/promises';
import { join } from 'node:path';
import { createFixture } from '../support/fixture.js';
import { agentConfig, agentHeaders } from '../support/agent.js';
import { openDatabase } from '../../packages/core/db.js';
import { observeSource } from '../../packages/core/indexing/state.js';
import { sha256 } from '../../packages/core/knowledge/operations.js';

it('fetches complete bounded research objects, rejects stale versions and never truncates large objects', async () => {
  const f = await createFixture({ agent: agentConfig, indexing: { enabled: true, watch: false } });
  try {
    const content = '# 可引用的知识\n\n原文保持完整，包括引号 " 和反斜杠 \\。';
    await writeFile(join(f.knowledgeRoot, '00-Inbox/research.md'), content);
    const search = await f.app.inject({
      method: 'POST',
      url: '/api/agent/v1/search',
      headers: agentHeaders(),
      payload: { query: '原文', mode: 'text', freshness: 'strict' },
    });
    expect(search.statusCode).toBe(200);
    const match = search.json().data.results[0].matches[0];
    expect(match.sourceRevision).toBeGreaterThan(0);
    const suffix = `?sourceHash=${match.sourceHash}&sourceRevision=${match.sourceRevision}`;
    const base = `/api/agent/v1/notes/${match.noteId}`;
    const whole = await f.app.inject({ url: base + '/research' + suffix, headers: agentHeaders() });
    expect(whole.statusCode).toBe(200);
    expect(whole.json().data.text).toBe(content);
    expect(whole.json().data.metadata).toMatchObject({
      noteId: match.noteId,
      objectType: 'note',
      sourceHash: match.sourceHash,
      sourceRevision: match.sourceRevision,
    });
    const chunk = await f.app.inject({
      url: base + `/chunks/${match.chunkId}` + suffix,
      headers: agentHeaders(),
    });
    expect(chunk.statusCode).toBe(200);
    expect(chunk.json().data.text).toBe(content);
    expect(chunk.json().data.metadata).toMatchObject({
      objectType: 'chunk',
      chunkId: match.chunkId,
      startByte: 0,
      endByte: Buffer.byteLength(content),
    });
    const denied = await f.app.inject({
      url: base + '/research' + suffix,
      headers: agentHeaders({ allowedPrefixes: ['00-Inbox/other'] }),
    });
    expect(denied.statusCode).toBe(403);
    const db = openDatabase(f.dataRoot);
    try {
      const state = db
        .prepare('SELECT * FROM document_state WHERE note_id=?')
        .get(match.noteId) as any;
      observeSource(db, match.noteId, sha256('intermediate'), state.mtime_ns, state.size_bytes);
      observeSource(db, match.noteId, match.sourceHash, state.mtime_ns, state.size_bytes);
    } finally {
      db.close();
    }
    const stale = await f.app.inject({ url: base + '/research' + suffix, headers: agentHeaders() });
    expect(stale.statusCode).toBe(409);
    expect(stale.json().error.code).toBe('RESULT_STALE');
    const large = await f.app.inject({
      method: 'POST',
      url: '/api/agent/v1/notes',
      headers: agentHeaders(),
      payload: {
        directory: '00-Inbox',
        fileName: 'too-large.md',
        content: 'x'.repeat(17000),
        requestId: 'research-large',
      },
    });
    const id = large.json().data.id;
    const info = (
      await f.app.inject({ url: `/api/agent/v1/notes/${id}`, headers: agentHeaders() })
    ).json().data;
    const rejected = await f.app.inject({
      url: `/api/agent/v1/notes/${id}/research?sourceHash=${info.contentHash}&sourceRevision=${info.sourceRevision}`,
      headers: agentHeaders(),
    });
    expect(rejected.statusCode).toBe(413);
    expect(rejected.json().error.code).toBe('RESEARCH_OBJECT_TOO_LARGE');
  } finally {
    await f.close();
  }
});

it('rechecks same-stat changes and enforces full JSON envelope budgets', async () => {
  const f = await createFixture({ agent: agentConfig });
  try {
    const create = async (fileName: string, content: string) =>
      (
        await f.app.inject({
          method: 'POST',
          url: '/api/agent/v1/notes',
          headers: agentHeaders(),
          payload: { directory: '00-Inbox', fileName, content, requestId: fileName },
        })
      ).json().data;
    const n = await create('version.md', 'original');
    const get = async (id: string) =>
      (await f.app.inject({ url: `/api/agent/v1/notes/${id}`, headers: agentHeaders() })).json()
        .data;
    const info = await get(n.id);
    const file = join(f.knowledgeRoot, '00-Inbox/version.md');
    await writeFile(file, 'external');
    const seconds = Number(BigInt(info.modifiedAt) / 1000n) / 1e6;
    await utimes(file, seconds, seconds);
    const r = await f.app.inject({
      url: `/api/agent/v1/notes/${n.id}/research?sourceHash=${info.contentHash}&sourceRevision=${info.sourceRevision}`,
      headers: agentHeaders(),
    });
    expect(r.statusCode).toBe(409);
    expect(r.json().error.code).toBe('RESULT_STALE');
    const escaped = await create('escaped.md', '\u0001'.repeat(12000));
    const e = await get(escaped.id);
    const budget = await f.app.inject({
      url: `/api/agent/v1/notes/${e.id}/research?sourceHash=${e.contentHash}&sourceRevision=${e.sourceRevision}`,
      headers: agentHeaders(),
    });
    expect(budget.statusCode).toBe(413);
    expect(budget.json().error.code).toBe('RESEARCH_OBJECT_TOO_LARGE');
  } finally {
    await f.close();
  }
});
