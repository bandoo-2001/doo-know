import { expect, it } from 'vitest';
import { stat, utimes } from 'node:fs/promises';
import { join } from 'node:path';
import { createFixture, loginFixtureOwner } from './support/fixture.js';
import { agentConfig, agentHeaders } from './support/agent.js';
import type { TreeEntry } from '../shared/contracts.js';

const flatten = (items: TreeEntry[]): TreeEntry[] =>
  items.flatMap((item) => [item, ...flatten(item.children || [])]);

it('persists favorites by note identity through renames and hides archived notes', async () => {
  const f = await createFixture();
  try {
    const headers = await loginFixtureOwner(f);
    const n = (
      await f.app.inject({
        method: 'POST',
        url: '/api/notes',
        headers,
        payload: { folderPath: '00-Inbox', fileName: 'favorite.md', content: '# Favorite' },
      })
    ).json();
    const url = `/api/notes/${n.id}/favorite`;
    expect(
      (await f.app.inject({ method: 'PUT', url, payload: { favorite: true } })).statusCode,
    ).toBe(401);
    expect(
      (await f.app.inject({ method: 'PUT', url, headers, payload: { favorite: 'true' } }))
        .statusCode,
    ).toBe(400);
    const originalTime = (await stat(join(f.knowledgeRoot, n.relativePath))).mtimeMs;
    for (let i = 0; i < 2; i++) {
      const reply = await f.app.inject({
        method: 'PUT',
        url,
        headers,
        payload: { favorite: true },
      });
      expect(reply.statusCode, reply.body).toBe(200);
      expect(reply.json()).toEqual({ favorite: true });
    }
    expect((await stat(join(f.knowledgeRoot, n.relativePath))).mtimeMs).toBe(originalTime);
    const entries = async () => flatten((await f.app.inject({ url: '/api/tree', headers })).json());
    expect((await entries()).find((e) => e.id === n.id)).toMatchObject({ favorite: true });
    const moved = await f.app.inject({
      method: 'POST',
      url: `/api/notes/${n.id}/move`,
      headers,
      payload: {
        folderPath: '00-Inbox',
        fileName: 'renamed.md',
        expectedModifiedAt: n.modifiedAt,
        requestId: 'favorite-move',
      },
    });
    expect(moved.statusCode, moved.body).toBe(200);
    expect((await entries()).find((e) => e.id === n.id)).toMatchObject({
      path: '00-Inbox/renamed.md',
      favorite: true,
    });
    await f.app.inject({ method: 'PUT', url, headers, payload: { favorite: false } });
    expect((await entries()).find((e) => e.id === n.id)).toMatchObject({ favorite: false });
    await f.app.inject({ method: 'PUT', url, headers, payload: { favorite: true } });
    const current = (await f.app.inject({ url: `/api/notes/${n.id}`, headers })).json();
    const deleted = await f.app.inject({
      method: 'DELETE',
      url: `/api/notes/${n.id}`,
      headers,
      payload: { expectedModifiedAt: current.modifiedAt, requestId: 'favorite-delete' },
    });
    expect(deleted.statusCode, deleted.body).toBe(200);
    expect((await entries()).some((e) => e.id === n.id)).toBe(false);
    expect(
      (await f.app.inject({ method: 'PUT', url, headers, payload: { favorite: true } })).statusCode,
    ).toBe(404);
  } finally {
    await f.close();
  }
});

it('exposes current edit times for MCP creates and updates without requiring a browser save', async () => {
  const f = await createFixture({ agent: agentConfig });
  try {
    const headers = await loginFixtureOwner(f);
    const created = await f.app.inject({
      method: 'POST',
      url: '/api/agent/v1/notes',
      headers: agentHeaders(),
      payload: {
        directory: '00-Inbox',
        fileName: 'mcp.md',
        content: '# MCP',
        requestId: 'recent-mcp-create',
      },
    });
    expect(created.statusCode, created.body).toBe(201);
    const n = created.json().data;
    const entries = async () => flatten((await f.app.inject({ url: '/api/tree', headers })).json());
    expect((await entries()).find((e) => e.id === n.id)?.updatedAt).toBeDefined();
    const oldTime = new Date('2020-01-01T00:00:00Z');
    await utimes(join(f.knowledgeRoot, n.relativePath), oldTime, oldTime);
    const current = (
      await f.app.inject({ url: `/api/agent/v1/notes/${n.id}`, headers: agentHeaders() })
    ).json().data;
    const update = await f.app.inject({
      method: 'PUT',
      url: `/api/agent/v1/notes/${n.id}`,
      headers: agentHeaders(),
      payload: {
        content: '# Updated by MCP',
        expectedModifiedAt: current.modifiedAt,
        requestId: 'recent-mcp-update',
      },
    });
    expect(update.statusCode, update.body).toBe(200);
    const updatedAt = (await entries()).find((e) => e.id === n.id)?.updatedAt;
    expect(Date.parse(updatedAt!)).toBeGreaterThan(oldTime.getTime());
    expect(updatedAt).toBe((await stat(join(f.knowledgeRoot, n.relativePath))).mtime.toISOString());
  } finally {
    await f.close();
  }
});
