import { afterAll, beforeAll, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { request as httpRequest } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
// @ts-expect-error build tool is plain ESM
import { buildPlugins } from '../scripts/build-plugins.mjs';
import { createFixture, loginFixtureOwner } from './support/fixture.js';
import { createAuth } from '../apps/server/auth.js';
import { openDatabase } from '../packages/core/db.js';
import { oauthGrantStore } from '../apps/server/platform/oauth-grants.js';

let artifacts: string, catalog: any[];
beforeAll(async () => {
  artifacts = await mkdtemp(join(tmpdir(), 'mcp-build-'));
  catalog = await buildPlugins({ output: artifacts, ids: ['mcp'], baseURL: pathToFileURL(artifacts + '/').href });
}, 60000);
afterAll(async () => { if (artifacts) await rm(artifacts, { recursive: true, force: true }); });

async function connectedFixture() {
  const f = await createFixture({ pluginCatalog: catalog });
  let db: ReturnType<typeof openDatabase> | undefined;
  try {
    const headers = await loginFixtureOwner(f);
    const post = (url: string, payload: Record<string, unknown> = {}) => f.app.inject({ method: 'POST', url, headers, payload });
    const installed = await post('/api/platform/plugins/mcp/install');
    expect(installed.statusCode, installed.body).toBe(200);
    expect(installed.json().config).toMatchObject({ oauthEnabled: true, apiKeyEnabled: true });
    expect(installed.json().manifest.configSchema.properties).not.toHaveProperty('tunnelToken');
    let configVersion = installed.json().configVersion;
    const configure = async (values: Record<string, unknown>) => {
      const response = await f.app.inject({ method: 'PUT', url: '/api/platform/plugins/mcp/config', headers, payload: { configVersion, values } });
      expect(response.statusCode, response.body).toBe(200);
      configVersion = response.json().configVersion;
    };
    const inventory = await f.app.inject({ url: '/api/platform/mcp/permissions', headers });
    expect(inventory.statusCode, inventory.body).toBe(200);
    const permissionPolicy = inventory.json().policy;
    await configure({ permissionPolicy });
    expect((await post('/api/platform/plugins/mcp/enable')).statusCode).toBe(200);
    const created = await post('/api/platform/mcp/api-clients', { name: 'HTTP fixture', permissionPolicy, expiresAt: null });
    expect(created.statusCode, created.body).toBe(200);
    const apiKey = created.json().key as string;
    db = openDatabase(f.dataRoot);
    const owner = (db.prepare('SELECT id FROM user').get() as { id: string }).id;
    const auth = await createAuth(f.config, db);
    const grant = oauthGrantStore(db).approveV2(owner, 'transport-oauth-fixture', permissionPolicy);
    const now = Math.floor(Date.now() / 1000);
    const { token: oauthToken } = await auth.api.signJWT({ body: { payload: { sub: owner, client_id: grant.clientId,
      iat: now, exp: now + 300, scope: 'knowledge:read', dk_grant_id: grant.id, dk_grant_version: grant.version,
      iss: f.config.origin + '/api/auth', aud: f.config.origin + '/mcp' } } });
    const address = await f.app.listen({ host: '127.0.0.1', port: 0 });
    // Keep the configured Host while connecting to an ephemeral real HTTP listener.
    const httpFetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const request = new Request(input, init);
      const body = request.method === 'GET' || request.method === 'HEAD' ? undefined : Buffer.from(await request.arrayBuffer());
      return new Promise((resolve, reject) => {
        const target = new URL(request.url);
        const network = httpRequest(address + target.pathname + target.search, { method: request.method,
          headers: { ...Object.fromEntries(request.headers), host: new URL(f.config.origin).host }, signal: request.signal }, response => {
          const chunks: Buffer[] = [];
          response.on('data', chunk => chunks.push(Buffer.from(chunk)));
          response.on('error', reject);
          response.on('end', () => {
            const responseHeaders = new Headers();
            for (const [name, value] of Object.entries(response.headers)) {
              if (Array.isArray(value)) for (const item of value) responseHeaders.append(name, item);
              else if (value !== undefined) responseHeaders.set(name, value);
            }
            const status = response.statusCode || 500;
            resolve(new Response([204, 205, 304].includes(status) ? null : Buffer.concat(chunks), { status, headers: responseHeaders }));
          });
        });
        network.setTimeout(10000, () => network.destroy(new Error('Fixture MCP request timed out')));
        network.on('error', reject);
        network.end(body);
      });
    };
    const rpc = (path: string, token: string, body: unknown = { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }, extra: Record<string, string> = {}) =>
      httpFetch(f.config.origin + path, { method: 'POST', headers: { authorization: 'Bearer ' + token,
        'content-type': 'application/json', accept: 'application/json, text/event-stream', ...extra }, body: JSON.stringify(body) });
    return { f, headers, post, configure, apiKey, apiClient: created.json().client, permissionPolicy, oauthToken, httpFetch, rpc, address,
      close: async () => { db?.close(); await f.close(); } };
  } catch (error) { db?.close(); await f.close(); throw error; }
}

it('serves both packaged MCP endpoints through the SDK with independent authentication and live tool permissions', async () => {
  const fixture = await connectedFixture();
  const { f, apiKey, oauthToken, rpc } = fixture;
  try {
    for (const [path, token] of [['/mcp', oauthToken], ['/mcp/api-key', apiKey]]) {
      const client = new Client({ name: 'transport-sdk-fixture', version: '1' });
      try {
        await client.connect(new StreamableHTTPClientTransport(new URL(f.config.origin + path), {
          fetch: fixture.httpFetch, requestInit: { headers: { authorization: 'Bearer ' + token } },
        }));
        expect(client.getServerVersion()).toMatchObject({ name: 'doo-know', version: '2.0.0' });
        const names: string[] = [];
        let cursor: string | undefined;
        do {
          const page = await client.listTools(cursor ? { cursor } : {});
          expect(Buffer.byteLength(JSON.stringify({ jsonrpc: '2.0', id: 1, result: page }))).toBeLessThanOrEqual(65536);
          names.push(...page.tools.map(tool => tool.name)); cursor = page.nextCursor;
        } while (cursor);
        expect(names).toEqual(expect.arrayContaining(['list_notes', 'get_mcp_context', 'create_note', 'publish_blog_post', 'query_to_doos']));
        expect(new Set(names).size).toBe(names.length);
        expect(await client.callTool({ name: 'list_notes', arguments: {} })).toMatchObject({ structuredContent: { data: { items: [] } } });
        expect(await client.callTool({ name: 'create_note', arguments: { directory: '00-Inbox', fileName: 'denied.md', content: 'private-body', requestId: 'denied-request' } }))
          .toMatchObject({ isError: true, structuredContent: { error: { code: 'INSUFFICIENT_SCOPE', requiredScope: 'knowledge:write' } } });
      } finally { await client.close(); }
    }
    const apiOnOAuth = await rpc('/mcp', apiKey);
    expect(apiOnOAuth.status).toBe(401);
    expect(apiOnOAuth.headers.get('www-authenticate')).toContain('/.well-known/oauth-protected-resource/mcp');
    const oauthOnApi = await rpc('/mcp/api-key', oauthToken);
    expect(oauthOnApi.status).toBe(401);
    expect(oauthOnApi.headers.get('www-authenticate')).toBe('Bearer realm="DooKnow MCP API Key"');
    expect(oauthOnApi.headers.get('cache-control')).toBe('no-store');
    const logs = await fixture.post('/api/plugins/mcp/call', { kind: 'provider', id: 'mcp.calls', input: {} });
    expect(logs.json().items.some((row: any) => row.tool === 'list_notes')).toBe(true);
    expect(JSON.stringify(logs.json())).not.toContain(apiKey);
    expect(JSON.stringify(logs.json())).not.toContain('private-body');
    const status = await fixture.post('/api/plugins/mcp/call', { kind: 'provider', id: 'mcp.status', input: {} });
    expect(status.json().connection).toMatchObject({ oauth: { ready: false }, apiKey: { ready: true, address: f.config.origin + '/mcp/api-key' } });
    expect(status.json().connection).not.toHaveProperty('tunnel');
    expect(status.json().clients).toHaveLength(1);
  } finally { await fixture.close(); }
}, 60000);

it('preserves protocol method, origin, host, preflight and request validation without REST adapters', async () => {
  const fixture = await connectedFixture();
  try {
    for (const [path, token] of [['/mcp', fixture.oauthToken], ['/mcp/api-key', fixture.apiKey]]) {
      for (const method of ['GET', 'DELETE']) {
        const response = await fixture.httpFetch(fixture.f.config.origin + path, { method, headers: { authorization: 'Bearer ' + token } });
        expect(response.status).toBe(405); expect(response.headers.get('allow')).toBe('POST');
      }
      expect((await fixture.rpc(path, token, { jsonrpc: '2.0', method: 'notifications/initialized' })).status).toBe(202);
      expect((await fixture.rpc(path, token, undefined, { origin: 'https://untrusted.example' })).status).toBe(403);
      const invalidHost = await fixture.f.app.inject({ method: 'POST', url: path, headers: { host: 'untrusted.example', authorization: 'Bearer ' + token }, payload: { jsonrpc: '2.0', id: 1, method: 'tools/list' } });
      expect(invalidHost.statusCode).toBe(403);
      const preflight = await fixture.httpFetch(fixture.f.config.origin + path, { method: 'OPTIONS', headers: { origin: fixture.f.config.origin,
        'access-control-request-method': 'POST', 'access-control-request-headers': 'authorization,content-type,mcp-protocol-version' } });
      expect(preflight.status).toBe(204); expect(preflight.headers.get('access-control-allow-origin')).toBe(fixture.f.config.origin);
      const deniedPreflight = await fixture.httpFetch(fixture.f.config.origin + path, { method: 'OPTIONS', headers: { origin: fixture.f.config.origin,
        'access-control-request-method': 'DELETE' } });
      expect(deniedPreflight.status).toBe(403);
      expect((await fixture.rpc(path + '?access_token=do-not-accept-query-tokens', token)).status).toBe(401);
      expect((await fixture.rpc(path, token, undefined, { 'content-encoding': 'gzip' })).status).toBe(415);
      expect((await fixture.rpc(path, token, undefined, { accept: 'application/json' })).status).toBe(406);
      expect((await fixture.rpc(path, token, undefined, { 'mcp-protocol-version': 'unsupported' })).status).toBe(400);
    }
    const loopback = await fetch(fixture.address + '/mcp/api-key', { method: 'POST', headers: {
      authorization: 'Bearer ' + fixture.apiKey, accept: 'application/json, text/event-stream', 'content-type': 'application/json',
    }, body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }) });
    expect(loopback.status).toBe(200);
    for (const path of ['/openapi.json', '/api/v1/tools/list_notes']) {
      const response = await fixture.f.app.inject({ method: path.startsWith('/api/') ? 'POST' : 'GET', url: path,
        headers: { ...fixture.headers, host: 'localhost:3010', authorization: 'Bearer ' + fixture.apiKey } });
      expect(response.statusCode).toBe(404);
    }
  } finally { await fixture.close(); }
}, 60000);

it('applies independent mode switches, plugin lifecycle and bounded authentication failure throttling', async () => {
  const fixture = await connectedFixture();
  try {
    await fixture.configure({ oauthEnabled: false });
    expect((await fixture.rpc('/mcp', fixture.oauthToken)).status).toBe(404);
    expect((await fixture.rpc('/mcp/api-key', fixture.apiKey)).status).toBe(200);
    await fixture.configure({ oauthEnabled: true, apiKeyEnabled: false });
    expect((await fixture.rpc('/mcp', fixture.oauthToken)).status).toBe(200);
    expect((await fixture.rpc('/mcp/api-key', fixture.apiKey)).status).toBe(404);
    await fixture.configure({ apiKeyEnabled: true });
    for (let attempt = 0; attempt < 20; attempt++) expect((await fixture.rpc('/mcp/api-key', 'invalid-key')).status).toBe(401);
    const throttled = await fixture.rpc('/mcp/api-key', 'invalid-key');
    expect(throttled.status).toBe(429); expect(Number(throttled.headers.get('retry-after'))).toBeGreaterThan(0);
    expect((await fixture.rpc('/mcp', fixture.oauthToken)).status).toBe(200);
    expect((await fixture.post('/api/platform/plugins/mcp/disable')).statusCode).toBe(200);
    expect((await fixture.rpc('/mcp', fixture.oauthToken)).status).toBe(404);
    expect((await fixture.rpc('/mcp/api-key', fixture.apiKey)).status).toBe(404);
  } finally { await fixture.close(); }
}, 60000);

it.each(['oauth', 'api-key'] as const)('limits authenticated %s requests by stable client without affecting another client', async mode => {
  const fixture = await connectedFixture();
  try {
    const path = mode === 'oauth' ? '/mcp' : '/mcp/api-key';
    const token = mode === 'oauth' ? fixture.oauthToken : fixture.apiKey;
    const get = (endpoint: string, credential: string) => fixture.httpFetch(fixture.f.config.origin + endpoint, {
      method: 'GET', headers: { authorization: 'Bearer ' + credential },
    });
    for (let attempt = 0; attempt < 120; attempt++) expect((await get(path, token)).status).toBe(405);
    const throttled = await get(path, token);
    expect(throttled.status).toBe(429);
    expect(Number(throttled.headers.get('retry-after'))).toBeGreaterThan(0);
    expect(Number(throttled.headers.get('retry-after'))).toBeLessThanOrEqual(60);
    expect(await throttled.json()).toMatchObject({ error: { data: { code: 'MCP_CLIENT_RATE_LIMIT', retryable: true } } });
    const other = await fixture.post('/api/platform/mcp/api-clients', {
      name: 'Independent client', permissionPolicy: fixture.permissionPolicy, expiresAt: null,
    });
    expect(other.statusCode).toBe(200);
    expect((await get('/mcp/api-key', other.json().key)).status).toBe(405);
    if (mode === 'api-key') {
      const rotated = await fixture.post('/api/platform/mcp/api-clients/' + encodeURIComponent(fixture.apiClient.clientId) + '/rotate-key', {
        expiresAt: null, expectedVersion: fixture.apiClient.version,
      });
      expect(rotated.statusCode).toBe(200);
      expect(rotated.json().client.clientId).toBe(fixture.apiClient.clientId);
      expect((await get(path, rotated.json().key)).status).toBe(429);
      expect((await get(path, token)).status).toBe(401);
    }
  } finally { await fixture.close(); }
}, 60000);
