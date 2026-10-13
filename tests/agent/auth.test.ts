import { it, expect } from 'vitest';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createFixture, loginFixtureOwner } from '../support/fixture.js';
import { agentConfig, agentHeaders } from '../support/agent.js';
it('requires both service identity and signed, short lived, audience-bound claims', async () => {
  const f = await createFixture({ agent: agentConfig });
  try {
    await writeFile(join(f.knowledgeRoot, '00-Inbox/a.md'), '# 私人\n正文');
    const url = '/api/agent/v1/notes';
    for (const headers of [
      { 'x-principal': 'owner' },
      { ...agentHeaders(), authorization: 'Bearer fake' },
      agentHeaders({ exp: 1 }),
      agentHeaders({ aud: 'other' }),
      agentHeaders({ iat: 1, exp: Math.floor(Date.now() / 1000) + 3600 }),
    ])
      expect((await f.app.inject({ url, headers })).statusCode).toBe(401);
    const r = await f.app.inject({ url, headers: agentHeaders() });
    expect(r.statusCode).toBe(200);
    expect(r.json().data.items).toHaveLength(1);
    expect(r.json().data.items[0]).not.toHaveProperty('content');
    const info = await f.app.inject({
      url: `${url}/${r.json().data.items[0].id}`,
      headers: agentHeaders(),
    });
    expect(info.json().data.modifiedAt).toMatch(/^\d+$/);
    expect(info.json().data).not.toHaveProperty('content');
    expect((await f.app.inject({ url: '/api/tree', headers: agentHeaders() })).statusCode).toBe(
      401,
    );
    const browser = await loginFixtureOwner(f);
    expect((await f.app.inject({ url, headers: browser })).statusCode).toBe(401);
  } finally {
    await f.close();
  }
});
it('intersects directory and scope grants without prefix lookalike escapes', async () => {
  const config = {
    ...agentConfig,
    policies: [
      { ...agentConfig.policies[0], allowedPrefixes: ['00-Inbox/a'], scopes: ['knowledge:read'] },
    ],
  };
  const f = await createFixture({ agent: config });
  try {
    for (const dir of ['a', 'ab']) {
      await mkdir(join(f.knowledgeRoot, '00-Inbox', dir));
      await writeFile(join(f.knowledgeRoot, '00-Inbox', dir, 'x.md'), 'private');
    }
    const r = await f.app.inject({ url: '/api/agent/v1/notes', headers: agentHeaders() });
    expect(r.statusCode).toBe(200);
    expect(r.json().data.items.map((x: any) => x.relativePath)).toEqual(['00-Inbox/a/x.md']);
    expect(
      (
        await f.app.inject({
          method: 'POST',
          url: '/api/agent/v1/notes',
          headers: agentHeaders(),
          payload: {
            directory: '00-Inbox/ab',
            fileName: 'x.md',
            content: 'oops',
            requestId: 'read-only-write',
          },
        })
      ).statusCode,
    ).toBe(403);
  } finally {
    await f.close();
  }
});
