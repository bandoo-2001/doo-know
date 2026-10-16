import { it, expect } from 'vitest';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createFixture } from '../support/fixture.js';
import { agentConfig, agentHeaders } from '../support/agent.js';
import { openDatabase } from '../../packages/core/db.js';
it('requires an explicit empty directory to create the authorized root README', async () => {
  const f = await createFixture({
    agent: {
      ...agentConfig,
      policies: [{ ...agentConfig.policies[0], allowedPrefixes: ['README.md'] }],
    },
  });
  try {
    const headers = agentHeaders({ allowedPrefixes: ['README.md'] });
    for (const directory of [undefined, null, false, 0]) {
      const result = await f.app.inject({
        method: 'POST',
        url: '/api/agent/v1/notes',
        headers,
        payload: {
          directory,
          fileName: 'README.md',
          content: '# Root',
          requestId: `invalid-${directory}`,
        },
      });
      expect(result.statusCode, `${directory}: ${result.body}`).toBe(400);
    }
    const result = await f.app.inject({
      method: 'POST',
      url: '/api/agent/v1/notes',
      headers,
      payload: {
        directory: '',
        fileName: 'README.md',
        content: '# Root',
        requestId: 'root-readme',
      },
    });
    expect(result.statusCode, result.body).toBe(201);
    expect(result.json().data.relativePath).toBe('README.md');
    expect(await readFile(join(f.knowledgeRoot, 'README.md'), 'utf8')).toBe('# Root');
  } finally {
    await f.close();
  }
});
it('persists write deduplication and rejects requestId/body and nanosecond version conflicts', async () => {
  const f = await createFixture({ agent: agentConfig });
  try {
    const headers = agentHeaders(),
      base = '/api/agent/v1/notes';
    const payload = {
      directory: '00-Inbox',
      fileName: '幂等.md',
      content: '# 原文',
      requestId: 'create-one',
    };
    const a = await f.app.inject({ method: 'POST', url: base, headers, payload });
    expect(a.statusCode).toBe(201);
    const b = await f.app.inject({ method: 'POST', url: base, headers, payload });
    expect(b.json().data).toEqual(a.json().data);
    expect(b.json().data).not.toHaveProperty('content');
    expect(
      (
        await f.app.inject({
          method: 'POST',
          url: base,
          headers,
          payload: { ...payload, content: 'different' },
        })
      ).statusCode,
    ).toBe(409);
    const id = a.json().data.id,
      modifiedAt = a.json().data.modifiedAt;
    const save = { content: '# 修改', expectedModifiedAt: modifiedAt, requestId: 'update-one' };
    const first = await f.app.inject({
      method: 'PUT',
      url: `${base}/${id}`,
      headers,
      payload: save,
    });
    expect(first.statusCode).toBe(200);
    const db = openDatabase(f.dataRoot),
      count = () => db.prepare('SELECT count(*) AS n FROM revisions').get();
    const before = count();
    const second = await f.app.inject({
      method: 'PUT',
      url: `${base}/${id}`,
      headers,
      payload: save,
    });
    expect(second.json().data).toEqual(first.json().data);
    expect(count()).toEqual(before);
    db.close();
    await writeFile(join(f.knowledgeRoot, '00-Inbox/幂等.md'), '外部正文');
    const conflict = await f.app.inject({
      method: 'PUT',
      url: `${base}/${id}`,
      headers,
      payload: { ...save, requestId: 'update-stale' },
    });
    expect(conflict.statusCode).toBe(409);
    expect(await readFile(join(f.knowledgeRoot, '00-Inbox/幂等.md'), 'utf8')).toBe('外部正文');
    expect(
      (
        await f.app.inject({
          method: 'PUT',
          url: `${base}/${id}`,
          headers: agentHeaders({ scopes: ['knowledge:read'] }),
          payload: save,
        })
      ).statusCode,
    ).toBe(403);
  } finally {
    await f.close();
  }
});
it('archives with version checks, deduplicates retries and keeps the operation query private', async () => {
  const f = await createFixture({ agent: agentConfig });
  try {
    const headers = agentHeaders();
    const n = (
      await f.app.inject({
        method: 'POST',
        url: '/api/agent/v1/notes',
        headers,
        payload: {
          directory: '00-Inbox',
          fileName: 'archive.md',
          content: 'recoverable',
          requestId: 'make-archive',
        },
      })
    ).json().data;
    expect(n?.id).toBeTruthy();
    const url = `/api/agent/v1/notes/${n.id}/archive`,
      payload = { expectedModifiedAt: n.modifiedAt, requestId: 'archive-one' };
    const r = await f.app.inject({ method: 'POST', url, headers, payload });
    expect(r.statusCode).toBe(200);
    expect((await f.app.inject({ method: 'POST', url, headers, payload })).json().data).toEqual(
      r.json().data,
    );
    expect(
      (
        await f.app.inject({ url: '/api/agent/v1/operations?requestId=archive-one', headers })
      ).json().data.status,
    ).toBe('succeeded');
    expect(
      (
        await f.app.inject({
          url: '/api/agent/v1/operations?requestId=archive-one',
          headers: agentHeaders({ clientId: 'other' }),
        })
      ).statusCode,
    ).toBe(401);
  } finally {
    await f.close();
  }
});
