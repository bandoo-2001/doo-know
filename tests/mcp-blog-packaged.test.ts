import { expect, it } from 'vitest';
import Ajv from 'ajv';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request as httpRequest } from 'node:http';
import { pathToFileURL } from 'node:url';
// @ts-expect-error build tool is plain ESM
import { buildPlugins } from '../scripts/build-plugins.mjs';
import { createFixture, loginFixtureOwner, type Fixture } from './support/fixture.js';
import { createAuth } from '../apps/server/auth.js';
import { openDatabase } from '../packages/core/db.js';
import { oauthGrantStore } from '../apps/server/platform/oauth-grants.js';

it('runs the packaged MCP 1.2.0 agent and blog contracts over HTTP with explicit grants, fixed receipts and disposal', async () => {
  const artifacts = await mkdtemp(join(tmpdir(), 'dooknow-mcp-blog-package-'));
  let f: Fixture | undefined;
  let db: ReturnType<typeof openDatabase> | undefined;
  try {
    const catalog = await buildPlugins({ output: artifacts, ids: ['mcp'], baseURL: pathToFileURL(artifacts + '/').href });
    expect(catalog[0]).toMatchObject({ version: '1.2.0', apiVersion: '^1.2.0' });
    expect(catalog[0].artifact.url).toMatch(/dooknow-plugin-mcp-1\.2\.0\.tar\.gz$/);
    const fixture = f = await createFixture({ pluginCatalog: catalog });
    const ownerHeaders = await loginFixtureOwner(fixture);
    const admin = (url: string, payload: Record<string, unknown> = {}) => fixture.app.inject({ method: 'POST', url, headers: ownerHeaders, payload });
    const installed = await admin('/api/platform/plugins/mcp/install');
    expect(installed.statusCode, installed.body).toBe(200);
    expect(installed.json()).toMatchObject({ installedVersion: '1.2.0', config: { readOnly: true, allowPublish: false } });
    const enabled = await admin('/api/platform/plugins/mcp/enable');
    expect(enabled.statusCode, enabled.body).toBe(200);
    expect(enabled.json()).toMatchObject({ state: 'enabled', activeVersion: '1.2.0' });
    const address = await fixture.app.listen({ host: '127.0.0.1', port: 0 });
    db = openDatabase(fixture.dataRoot);
    const database = db;
    const owner = (database.prepare('SELECT id FROM user').get() as { id: string }).id;
    const auth = await createAuth(fixture.config, database);
    const token = async (clientId: string, scopes: string[]) => {
      const grant = oauthGrantStore(database).approve(owner, clientId, scopes, ['00-Inbox']);
      const now = Math.floor(Date.now() / 1000);
      return (await auth.api.signJWT({ body: { payload: { sub: owner, client_id: clientId, scope: scopes.join(' '), iat: now, exp: now + 300,
        dk_grant_id: grant.id, dk_grant_version: grant.version, iss: fixture.config.origin + '/api/auth', aud: fixture.config.origin + '/mcp' } } })).token;
    };
    const fullToken = await token('packaged-blog', ['knowledge:read', 'knowledge:write', 'blog:publish']);
    const notesOnlyToken = await token('packaged-notes-only', ['knowledge:read', 'knowledge:write']);
    let sequence = 0;
    const rpc = async (method: string, params: Record<string, unknown>, accessToken = fullToken) => {
      // node:http preserves the fixture's virtual Host while the listener uses
      // an ephemeral loopback port; fetch treats Host as a forbidden header.
      const response = await new Promise<{ status: number; text: string; body: any }>((resolve, reject) => {
        const request = httpRequest(address + '/mcp', { method: 'POST',
          headers: { host: new URL(fixture.config.origin).host, authorization: 'Bearer ' + accessToken, 'content-type': 'application/json', accept: 'application/json, text/event-stream' } }, (reply) => {
          const chunks: Buffer[] = [];
          reply.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
          reply.on('error', reject);
          reply.on('end', () => {
            const text = Buffer.concat(chunks).toString('utf8');
            try { resolve({ status: reply.statusCode || 500, text, body: JSON.parse(text) }); } catch (error) { reject(error); }
          });
        });
        request.setTimeout(10000, () => request.destroy(new Error('Fixture MCP request timed out')));
        request.on('error', reject);
        request.end(JSON.stringify({ jsonrpc: '2.0', id: method === 'tools/call' ? '\\'.repeat(128) : ++sequence, method, params }));
      });
      expect(Buffer.byteLength(response.text, 'utf8')).toBeLessThanOrEqual(65536);
      return response;
    };
    const initialized = await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'packaged-agent-fixture', version: '1.0.0' } });
    expect(initialized.status, initialized.text).toBe(200);
    expect(initialized.body.result.serverInfo.version).toBe('1.2.0');
    expect(initialized.body.result.instructions).toContain('requestId');
    const listed = await rpc('tools/list', {});
    expect(listed.status, listed.text).toBe(200);
    const tools: any[] = listed.body.result.tools;
    const byName = new Map(tools.map((tool) => [tool.name, tool]));
    for (const name of ['get_blog_status', 'publish_blog_post', 'unpublish_blog_post', 'operation_status']) expect(byName.has(name)).toBe(true);
    const publishSchema = byName.get('publish_blog_post');
    expect(publishSchema.inputSchema.additionalProperties).toBe(false);
    expect(publishSchema.inputSchema.required).toEqual(expect.arrayContaining(['noteId', 'expectedModifiedAt', 'expectedContentHash', 'expectedPublicationVersion', 'requestId']));
    const publishSuccess = publishSchema.outputSchema.anyOf.find((schema: any) => schema.properties?.data);
    expect(publishSuccess.properties.data.additionalProperties).toBe(false);
    expect(publishSuccess.properties.data.required).toContain('omittedMetadata');
    for (const field of ['summary', 'category', 'tags', 'pinned', 'cover']) expect(publishSuccess.properties.data.properties[field]).toBeUndefined();
    const ajv = new Ajv({ strict: false, validateFormats: false });
    const validators = new Map(['get_blog_status', 'publish_blog_post', 'unpublish_blog_post', 'operation_status'].map((name) => [name, ajv.compile(byName.get(name).outputSchema)]));
    const call = (name: string, args: Record<string, unknown>, accessToken = fullToken) => rpc('tools/call', { name, arguments: args }, accessToken);
    const invalid = await call('get_note_info', {});
    expect(invalid.status, invalid.text).toBe(200);
    expect(invalid.body.result).toMatchObject({ isError: true, structuredContent: { error: { code: 'INVALID_INPUT', recovery: { action: 'fix_input' } } } });
    expect(invalid.body.result.structuredContent.error.issues).toEqual(expect.arrayContaining([expect.objectContaining({ path: ['noteId'] })]));
    expect(ajv.compile(byName.get('get_note_info').outputSchema)(invalid.body.result.structuredContent)).toBe(true);
    const ok = async (name: string, args: Record<string, unknown>) => {
      const response = await call(name, args);
      expect(response.status, response.text).toBe(200);
      expect(response.body.error, response.text).toBeUndefined();
      expect(response.body.result.isError, response.text).not.toBe(true);
      const result = response.body.result.structuredContent;
      const validate = validators.get(name)!;
      expect(validate(result), JSON.stringify(validate.errors)).toBe(true);
      expect(response.body.result.content).toEqual([{ type: 'text', text: JSON.stringify(result) }]);
      return result.data;
    };
    const original = '# Packaged blog\n\nPUBLIC_VERSION_ONE\n';
    const created = await fixture.app.inject({ method: 'POST', url: '/api/notes', headers: ownerHeaders,
      payload: { folderPath: '00-Inbox', fileName: 'packaged.md', content: original, requestId: randomUUID() } });
    expect(created.statusCode, created.body).toBe(201);
    const note = created.json();
    await writeFile(join(fixture.knowledgeRoot, '00-Inbox/figure.svg'), '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect width="10" height="10" fill="red"/></svg>');
    const publish = { noteId: note.id, expectedModifiedAt: note.modifiedAt, expectedContentHash: createHash('sha256').update(original).digest('hex'), expectedPublicationVersion: 0, requestId: randomUUID(),
      metadata: { slug: 'packaged-blog', title: 'Packaged blog', summary: '中'.repeat(2000), tags: Array.from({ length: 30 }, (_, index) => String(index) + '中'.repeat(78)), cover: 'figure.svg?' + '中'.repeat(8000) } };
    const denied = async (accessToken = fullToken) => {
      const response = await call('publish_blog_post', publish, accessToken);
      expect(response.status, response.text).toBe(200);
      expect(response.body.result).toMatchObject({ isError: true, structuredContent: { error: { code: 'INSUFFICIENT_SCOPE' } } });
      expect((database.prepare('SELECT count(*) AS count FROM blog_posts').get() as { count: number }).count).toBe(0);
    };
    await denied(); // The installed defaults do not permit public disclosure.
    let configVersion = installed.json().configVersion as number;
    const configure = async (values: Record<string, unknown>) => {
      const changed = await fixture.app.inject({ method: 'PUT', url: '/api/platform/plugins/mcp/config', headers: ownerHeaders, payload: { configVersion, values } });
      expect(changed.statusCode, changed.body).toBe(200); configVersion = changed.json().configVersion;
    };
    await configure({ readOnly: false, allowPublish: false, allowedPrefixes: ['00-Inbox'] });
    await denied();
    await configure({ readOnly: true, allowPublish: true });
    await denied();
    await configure({ readOnly: false, allowPublish: true });
    await denied(notesOnlyToken);
    const settings = await fixture.app.inject({ url: '/api/blog/settings', headers: ownerHeaders });
    const enabledSite = await fixture.app.inject({ method: 'PATCH', url: '/api/blog/settings', headers: ownerHeaders,
      payload: { settings: { ...settings.json(), enabled: true }, requestId: randomUUID() } });
    expect(enabledSite.statusCode, enabledSite.body).toBe(200);
    expect(await ok('get_blog_status', { noteId: note.id })).toMatchObject({ siteEnabled: true, post: null, publicationVersion: 0 });
    const first = await ok('publish_blog_post', publish);
    expect(first).toMatchObject({ state: 'published', version: 1, sourceHash: publish.expectedContentHash, sourceModifiedAt: note.modifiedAt, url: '/blog/packaged-blog', omittedMetadata: ['summary', 'category', 'tags', 'pinned', 'cover'] });
    const publicPage = async () => {
      const response = await fetch(address + '/blog/packaged-blog', { signal: AbortSignal.timeout(10000) });
      return { status: response.status, text: await response.text() };
    };
    const visible = await publicPage();
    expect(visible.status).toBe(200); expect(visible.text).toContain('PUBLIC_VERSION_ONE');
    const draft = '# Packaged blog\n\nPRIVATE_VERSION_TWO\n';
    const saved = await fixture.app.inject({ method: 'PUT', url: '/api/notes/' + encodeURIComponent(note.id), headers: ownerHeaders,
      payload: { content: draft, expectedModifiedAt: note.modifiedAt, requestId: randomUUID() } });
    expect(saved.statusCode, saved.body).toBe(200);
    const changed = await ok('get_blog_status', { noteId: note.id });
    expect(changed).toMatchObject({ publicationVersion: 1, post: { version: 1, hasUnpublishedChanges: true }, source: { contentHash: createHash('sha256').update(draft).digest('hex') } });
    const stillPublished = await publicPage();
    expect(stillPublished.text).toContain('PUBLIC_VERSION_ONE'); expect(stillPublished.text).not.toContain('PRIVATE_VERSION_TWO');
    expect(await ok('publish_blog_post', publish)).toEqual(first);
    expect(await ok('operation_status', { requestId: publish.requestId })).toMatchObject({ status: 'succeeded', kind: 'blog.publish', result: first });
    const republish = { ...publish, expectedModifiedAt: changed.source.modifiedAt, expectedContentHash: changed.source.contentHash, expectedPublicationVersion: 1, requestId: randomUUID() };
    const second = await ok('publish_blog_post', republish);
    expect(second).toMatchObject({ state: 'published', version: 2, sourceHash: changed.source.contentHash });
    expect(await ok('publish_blog_post', republish)).toEqual(second);
    const updatedPage = await publicPage();
    expect(updatedPage.text).toContain('PRIVATE_VERSION_TWO'); expect(updatedPage.text).not.toContain('PUBLIC_VERSION_ONE');
    const withdrawal = { noteId: note.id, expectedPublicationVersion: 2, requestId: randomUUID() };
    const withdrawn = await ok('unpublish_blog_post', withdrawal);
    expect(withdrawn).toMatchObject({ state: 'withdrawn', version: 3, url: null });
    expect(await ok('unpublish_blog_post', withdrawal)).toEqual(withdrawn);
    expect(await ok('operation_status', { requestId: withdrawal.requestId })).toMatchObject({ status: 'succeeded', kind: 'blog.unpublish', result: withdrawn });
    expect((await publicPage()).status).toBe(404);
    expect(await ok('get_blog_status', { noteId: note.id })).toMatchObject({ publicationVersion: 3, post: { state: 'withdrawn', version: 3 } });
    const disabled = await admin('/api/platform/plugins/mcp/disable');
    expect(disabled.statusCode, disabled.body).toBe(200); expect(disabled.json().state).toBe('disabled');
    const unavailable = await rpc('tools/list', {});
    expect(unavailable.status).toBe(404); expect(unavailable.body.error.data.code).toBe('PLUGIN_PROTOCOL_UNAVAILABLE');
    const provider = await admin('/api/plugins/mcp/call', { kind: 'provider', id: 'mcp.status', input: {} });
    expect(provider.statusCode).toBe(409); expect(provider.json().code).toBe('PLUGIN_DISABLED');
  } finally {
    db?.close();
    try { await f?.close(); } finally { await rm(artifacts, { recursive: true, force: true }); }
  }
}, 60000);
