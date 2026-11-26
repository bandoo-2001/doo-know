import { expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createApp } from '../apps/server/app.js';
import { openDatabase } from '../packages/core/db.js';
import { writeKnowledgeDataFile } from '../packages/core/knowledge-data.js';
import { createFixture, loginFixtureOwner } from './support/fixture.js';

it('starts existing Git and MCP settings with their original credentials and no installed code', async () => {
  const fixture = await createFixture();
  let upgraded: typeof fixture.app | undefined;
  try {
    const headers = await loginFixtureOwner(fixture);
    const enable = (app: typeof fixture.app, feature: string, enabled: boolean) =>
      app.inject({ method: 'PUT', url: `/api/platform/${feature}/enabled`, headers, payload: { enabled } });
    expect((await enable(fixture.app, 'mcp', true)).statusCode).toBe(200);
    const permission = await fixture.app.inject({ url: '/api/platform/mcp/permissions', headers });
    expect(permission.statusCode).toBe(200);
    const key = await fixture.app.inject({
      method: 'POST',
      url: '/api/platform/mcp/api-clients',
      headers,
      payload: { name: 'Existing client', permissionPolicy: permission.json().policy },
    });
    expect(key.statusCode, key.body).toBe(200);
    const secretPath = join(fixture.dataRoot, 'secrets/plugins/mcp/runtime/objects.key');
    const existingObjectSecret = await readFile(secretPath);
    await fixture.app.close();

    // These rows represent an installation whose previous code packages are
    // missing and whose Git author settings travel with the knowledge library.
    const db = openDatabase(fixture.dataRoot);
    try {
      db.prepare(`UPDATE platform_plugins SET installed=1,installed_version='2.0.5',
        manifest_json='{"apiVersion":"^1.5.0"}',desired_enabled=1,config_version=5,
        config_json='{"allowedPrefixes":["00-Inbox"],"externalWebOrigin":"https://notes.example","retiredSecret":"old-sensitive-value"}'
        WHERE id='mcp'`).run();
      db.prepare(`UPDATE platform_plugins SET installed=1,installed_version='1.1.4',desired_enabled=1,
        config_json='{"authorName":"Machine-local name","authorEmail":"old@example.invalid"}'
        WHERE id='git'`).run();
    } finally {
      db.close();
    }
    writeKnowledgeDataFile(fixture.knowledgeRoot, 'plugins/git/state.json', JSON.stringify({
      format: 1, revision: 'prior-release',
      data: {
        schemaVersion: 1,
        plugin: { id: 'git', version: '1.1.4', apiVersion: '^1.0.0' },
        config: { authorName: 'Repository author', authorEmail: 'git@example.invalid' },
        userData: {},
      },
    }));

    const app = upgraded = await createApp(fixture.config);
    const response = await app.inject({ url: '/api/platform/features', headers });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      mcp: { state: 'enabled', configVersion: 5, config: { externalWebOrigin: 'https://notes.example' } },
      git: { state: 'enabled', config: { authorName: 'Repository author', authorEmail: 'git@example.invalid' } },
    });
    expect(response.body).not.toContain('old-sensitive-value');
    expect(await readFile(secretPath)).toEqual(existingObjectSecret);

    const invoke = () => app.inject({
      method: 'POST',
      url: '/mcp/api-key',
      headers: {
        host: new URL(fixture.config.origin).host,
        authorization: 'Bearer ' + key.json().key,
        accept: 'application/json, text/event-stream',
      },
      payload: { jsonrpc: '2.0', id: 1, method: 'tools/list' },
    });
    const first = await invoke();
    expect(first.statusCode).toBe(200);
    expect(first.json().result.tools.length).toBeGreaterThan(0);
    expect((await enable(app, 'mcp', false)).json().state).toBe('disabled');
    const blocked = await invoke();
    expect(blocked.statusCode).toBe(404);
    expect(blocked.json().error.data.code).toBe('MCP_DISABLED');
    expect((await enable(app, 'mcp', true)).statusCode).toBe(200);
    expect((await invoke()).statusCode).toBe(200);
  } finally {
    await upgraded?.close();
    await fixture.close();
  }
});

it('keeps both features off for a plain directory and updates them independently', async () => {
  const fixture = await createFixture();
  try {
    const headers = await loginFixtureOwner(fixture);
    const { app } = fixture;
    const fresh = await app.inject({ url: '/api/platform/features', headers });
    expect(fresh.json()).toMatchObject({
      git: { state: 'disabled', desiredEnabled: false },
      mcp: { state: 'disabled', desiredEnabled: false },
    });
    const denied = await app.inject({
      method: 'POST',
      url: '/api/platform/git/actions',
      headers,
      payload: { kind: 'command', id: 'git.initialize', input: { requestId: 'disabled' } },
    });
    expect(denied.statusCode).toBe(409);
    const enabled = await app.inject({
      method: 'PUT', url: '/api/platform/git/enabled', headers, payload: { enabled: true },
    });
    expect(enabled.json().state).toBe('enabled');
    const status = await app.inject({ url: '/api/platform/features', headers });
    expect(status.json().mcp.state).toBe('disabled');
    await expect(readFile(join(fixture.knowledgeRoot, '.git/HEAD'))).rejects.toMatchObject({ code: 'ENOENT' });
    expect((await app.inject({ url: '/api/platform/plugins', headers })).statusCode).toBe(404);
  } finally { await fixture.close(); }
});
