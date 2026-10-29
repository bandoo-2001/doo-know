import { expect, it } from 'vitest';
import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { pluginRuntimeFixture } from './support/plugin-runtime.js';
import { pluginHost } from '../apps/server/plugins/host.js';
import { pluginServices } from '../apps/server/plugins/services.js';
import { oauthGrantStore } from '../apps/server/platform/oauth-grants.js';
import { createOperations, registerOperations } from '../plugins/mcp/server/operations.js';
import { hostClient } from '../plugins/mcp/server/service.js';
import { webPrincipal } from '../packages/core/knowledge/core.js';

const toolNames = [
  'search', 'fetch', 'search_notes', 'get_note_info', 'get_note_outline', 'read_note',
  'list_notes', 'create_note', 'update_note', 'patch_note', 'archive_note',
  'refresh_index', 'index_status', 'operation_status', 'cancel_operation',
  'get_blog_status', 'publish_blog_post', 'unpublish_blog_post',
  'get_mcp_context','list_directories','organize_library','list_organization_history','undo_organization',
];
const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');

async function workflowFixture() {
  const f = await pluginRuntimeFixture();
  try {
    pluginHost(f.config, f.db);
    const manifest = JSON.parse(await readFile(new URL('../plugins/mcp/manifest.json', import.meta.url), 'utf8'));
    const capabilities = ['knowledge:read', 'knowledge:write', 'knowledge:index', 'knowledge:archive', 'blog:read', 'blog:publish'];
    // Only fixture configuration and grants use SQL. Business outcomes below
    // must be produced by the real core through the registered MCP tools.
    f.db.prepare(`INSERT INTO platform_plugins
      (id,installed_version,installed,manifest_json,files_json,state,config_json)
      VALUES('mcp',?,1,'{}','{}','enabled',?)`).run(manifest.version,
      JSON.stringify({ readOnly: false, allowIndex: true, allowPublish: true, allowedPrefixes: ['00-Inbox'] }));
    const grant = oauthGrantStore(f.db).approve(f.principal.id, 'agent-workflow', capabilities.filter(scope=>!['knowledge:archive','blog:read'].includes(scope)), ['00-Inbox']);
    const principal = { ...f.principal, scopes: [...capabilities], clientId: grant.clientId,
      grantId: grant.id, grantVersion: grant.version, tokenIssuedAt: grant.notBefore,
      tokenExpiresAt: Math.floor(Date.now() / 1000) + 300, pluginId: 'mcp' };
    const services = pluginServices(f.platform, f.db, 'mcp', capabilities,
      { ownerId: principal.id, principal, channel: 'mcp' });
    const registry = createOperations({ objectIdSecret: 'agent-workflow-fixture-object-secret-at-least-32-characters' },
      hostClient(() => services, () => ({ externalWebOrigin: 'https://notes.example' })));
    const server = new McpServer({ name: 'agent-workflow-fixture', version: manifest.version });
    registerOperations(server, registry, principal, {});
    const client = new Client({ name: 'agent-workflow-client', version: '1.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    let lastResponse: unknown;
    const send = serverTransport.send.bind(serverTransport);
    serverTransport.send = async (message, options) => {
      expect(Buffer.byteLength(JSON.stringify(message))).toBeLessThanOrEqual(65536);
      if ('result' in message) lastResponse = message.result;
      return send(message, options);
    };
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    const listed = await client.listTools();
    let discoveryCursor = listed.nextCursor;
    while (discoveryCursor) {
      const page = await client.listTools({ cursor: discoveryCursor });
      listed.tools.push(...page.tools);
      discoveryCursor = page.nextCursor;
    }
    expect(listed.tools.map(tool => tool.name)).toEqual(expect.arrayContaining([...toolNames, 'query_to_doos', 'create_to_doo_task']));
    const called = new Set<string>();
    const call = async (name: string, args: Record<string, unknown>) => {
      called.add(name);
      const reply: any = await client.callTool({ name, arguments: args }).catch(error => {
        throw new Error(`${name}: SDK rejected ${JSON.stringify(lastResponse)}`, { cause: error });
      });
      expect(reply.structuredContent, `${name}: missing structured result`).toBeDefined();
      expect(reply.content).toEqual([{ type: 'text', text: JSON.stringify(reply.structuredContent) }]);
      return reply;
    };
    const ok = async (name: string, args: Record<string, unknown>) => {
      const reply = await call(name, args);
      expect(reply.isError, `${name}: ${JSON.stringify(reply.structuredContent)}`).not.toBe(true);
      return reply.structuredContent;
    };
    const error = async (name: string, args: Record<string, unknown>, code: string) => {
      const reply = await call(name, args);
      expect(reply.isError).toBe(true);
      expect(reply.structuredContent).toMatchObject({ error: { code } });
      return reply.structuredContent.error;
    };
    const readyRead = async (noteId: string, args: Record<string, unknown> = {}) => {
      let reply = (await ok('read_note', { noteId, ...args })).data;
      if (reply.kind === 'accepted') {
        await f.platform.get().knowledge.snapshots.drain();
        expect((await ok('operation_status', { operationId: reply.operation.operationId })).data)
          .toMatchObject({ kind: 'prepare_snapshot', status: 'succeeded' });
        reply = (await ok('read_note', { noteId, ...args })).data;
      }
      expect(reply.kind).toBe('ready');
      return reply.data;
    };
    return { ...f, principal, services, called, ok, error, readyRead,
      close: async () => { await client.close(); await server.close(); await f.close(); } };
  } catch (error) { await f.close(); throw error; }
}

it('uses SDK discovery, honest index status, research objects and explicit note/outline pagination against real temporary notes', async () => {
  const f = await workflowFixture();
  try {
    // Valid Markdown may begin at H2. Indexing must not emit null ancestor
    // placeholders that make the strict MCP search result schema unusable.
    const content = Array.from({ length: 61 }, (_, index) => `## Section ${index + 1}\nagentworkflow retrieval evidence ${index + 1}\n`).join('');
    const created = (await f.ok('create_note', { directory: '00-Inbox', fileName: 'guide.md', content, requestId: randomUUID() })).data;
    const second = (await f.ok('create_note', { directory: '00-Inbox', fileName: 'second.md', content: '# Companion\nagentworkflow companion evidence\n', requestId: randomUUID() })).data;
    const firstList = (await f.ok('list_notes', { directory: '00-Inbox', limit: 1 })).data;
    expect(firstList.items).toHaveLength(1);
    expect(firstList.nextCursor).toEqual(expect.any(String));
    const secondList = (await f.ok('list_notes', { directory: '00-Inbox', limit: 1, cursor: firstList.nextCursor })).data;
    expect(secondList.nextCursor).toBeUndefined();
    expect(new Set([...firstList.items, ...secondList.items].map((item: any) => item.id)))
      .toEqual(new Set([created.id, second.id]));
    const info = (await f.ok('get_note_info', { noteId: created.id })).data;
    expect(info).toMatchObject({ id: created.id, relativePath: '00-Inbox/guide.md', sizeBytes: Buffer.byteLength(content), editorMode: 'full' });
    expect(info).not.toHaveProperty('content');

    const refreshed = (await f.ok('refresh_index', { scope: '00-Inbox', requestId: 'workflow-refresh' })).data;
    expect(refreshed).toMatchObject({ complete: true, indexState: 'pending', conflicted: 0 });
    expect(refreshed.jobId).toEqual(expect.any(String));
    // Reconciliation/worker execution is explicit fixture control; refresh's
    // receipt alone must never be interpreted as completed vector indexing.
    await f.platform.get().knowledge.indexing.reconcile(undefined, true);
    await f.platform.get().knowledge.worker.drain();
    const status = (await f.ok('index_status', { scope: '00-Inbox', jobId: refreshed.jobId })).data;
    expect(status.activeSpaceId).toBeNull();
    expect(status.failed).toBe(0);
    expect(status.documents).toHaveLength(2);
    for (const document of status.documents) {
      expect(document.sourceHash).toMatch(/^[a-f0-9]{64}$/);
      expect(document.textIndexedHash).toBe(document.sourceHash);
      expect(document.vectorIndexedHash).toBeNull();
    }
    const searched = (await f.ok('search_notes', { query: 'agentworkflow', mode: 'hybrid', filters: { directory: '00-Inbox' } })).data;
    expect(searched.degraded).toBe(true);
    expect(searched.reasons).toContain('VECTOR_NOT_CONFIGURED');
    expect(new Set(searched.results.map((note: any) => note.noteId))).toEqual(new Set([created.id, second.id]));
    const research = await f.ok('search', { query: 'agentworkflow' });
    expect(research.results).toHaveLength(2);
    expect(research.degraded).toBe(true);
    expect(research.reasons).toContain('VECTOR_NOT_CONFIGURED');
    const object = await f.ok('fetch', { id: research.results[0].id });
    expect(object.id).toBe(research.results[0].id);
    expect(object.metadata.objectType).toBe('note');
    expect(object.text).toBe(object.metadata.noteId === created.id ? content : '# Companion\nagentworkflow companion evidence\n');

    const page1 = await f.readyRead(created.id, { maxBytes: 128 });
    expect(page1.hasMore).toBe(true);
    expect(page1.bytesReturned).toBeLessThanOrEqual(128);
    const page2 = await f.readyRead(created.id, { cursor: page1.nextCursor });
    expect(page2.snapshotId).toBe(page1.snapshotId);
    expect(page2.startByte).toBe(page1.endByte);
    expect(page1.content + page2.content).toBe(content.slice(0, page2.endByte));
    expect(await f.readyRead(created.id, { cursor: page1.nextCursor })).toEqual(page2);
    const outline1 = (await f.ok('get_note_outline', { noteId: created.id })).data;
    expect(outline1.kind).toBe('ready');
    expect(outline1.data.items).toHaveLength(50);
    const outline2 = (await f.ok('get_note_outline', { noteId: created.id, cursor: outline1.data.nextCursor })).data;
    expect(outline2.kind).toBe('ready');
    expect(outline2.data.nextCursor).toBeUndefined();
    expect([...outline1.data.items, ...outline2.data.items].map((item: any) => item.title))
      .toEqual(Array.from({ length: 61 }, (_, index) => `Section ${index + 1}`));
    expect([...f.called]).toEqual(expect.arrayContaining(['search', 'fetch', 'search_notes', 'get_note_info', 'get_note_outline', 'read_note', 'list_notes', 'create_note', 'refresh_index', 'index_status']));
  } finally { await f.close(); }
});

it('keeps immutable write receipts, rejects stale/forbidden writes, commits a patch, cancels a queued patch and archives recoverably over SDK calls', async () => {
  const f = await workflowFixture();
  try {
    const create = { directory: '00-Inbox', fileName: 'draft.md', content: '# Draft\nOriginal text\n', requestId: 'workflow-create' };
    const created = (await f.ok('create_note', create)).data;
    expect((await f.ok('create_note', create)).data).toEqual(created);
    const update = { noteId: created.id, content: '# Draft\nRevised text\n', expectedModifiedAt: created.modifiedAt, requestId: 'workflow-update' };
    const updated = (await f.ok('update_note', update)).data;
    expect((await f.ok('update_note', update)).data).toEqual(updated);
    await f.error('update_note', { ...update, content: '# Stale replacement', requestId: 'workflow-stale-update' }, 'VERSION_CONFLICT');
    await f.error('create_note', { ...create, directory: '99-System', requestId: 'workflow-forbidden-directory' }, 'FORBIDDEN');
    f.principal.allowedPrefixes = ['00-Inbox/narrow'];
    await f.error('get_note_info', { noteId: created.id }, 'FORBIDDEN');
    f.principal.allowedPrefixes = ['00-Inbox'];
    f.principal.scopes = ['knowledge:read'];
    await f.error('update_note', { ...update, requestId: 'workflow-missing-scope' }, 'INSUFFICIENT_SCOPE');
    f.principal.scopes = ['knowledge:read', 'knowledge:write', 'knowledge:index', 'knowledge:archive', 'blog:read', 'blog:publish'];

    const beforePatch = await f.readyRead(created.id);
    expect(beforePatch.content).toBe(update.content);
    // Pause scheduling through the supported fixture configuration, then run
    // recovery/drain explicitly. No sleeps or assumed worker timing.
    f.config.fileTasks!.embedded = false;
    const patch = { noteId: created.id, snapshotId: beforePatch.snapshotId,
      expectedContentHash: beforePatch.sourceHash, expectedModifiedAt: beforePatch.modifiedAt,
      requestId: 'workflow-patch', edits: [{ type: 'replace_text', before: 'Revised text', after: 'Patched text' }] };
    const accepted = (await f.ok('patch_note', patch)).data;
    expect(accepted).toMatchObject({ kind: 'accepted', operation: { kind: 'patch', status: 'queued', requestId: patch.requestId } });
    expect((await f.ok('operation_status', { requestId: patch.requestId })).data)
      .toMatchObject({ operationId: accepted.operation.operationId, status: 'queued' });
    f.config.fileTasks!.embedded = true;
    await f.platform.get().knowledge.files.recover();
    await f.platform.get().knowledge.files.drain();
    const completed = (await f.ok('operation_status', { operationId: accepted.operation.operationId })).data;
    expect(completed).toMatchObject({ kind: 'patch', status: 'succeeded', result: { editCount: 1, contentHash: sha256('# Draft\nPatched text\n') } });
    expect((await f.ok('patch_note', patch)).data.operation).toEqual(completed);
    const patched = await f.readyRead(created.id);
    expect(patched.content).toBe('# Draft\nPatched text\n');
    expect((await f.ok('update_note', update)).data).toEqual(updated);

    f.config.fileTasks!.embedded = false;
    const cancelledInput = { ...patch, snapshotId: patched.snapshotId, expectedContentHash: patched.sourceHash,
      expectedModifiedAt: patched.modifiedAt, requestId: 'workflow-cancel-patch',
      edits: [{ type: 'replace_range', startByte: 0, endByte: Buffer.byteLength(patched.content), expectedRangeHash: patched.rangeHash, insert: '# Never committed\n' }] };
    const waiting = (await f.ok('patch_note', cancelledInput)).data;
    expect(waiting.operation.status).toBe('queued');
    const cancelled = (await f.ok('cancel_operation', { operationId: waiting.operation.operationId })).data;
    expect(cancelled).toMatchObject({ operationId: waiting.operation.operationId, status: 'cancelled', requestId: cancelledInput.requestId });
    f.config.fileTasks!.embedded = true;
    await f.platform.get().knowledge.files.recover();
    await f.platform.get().knowledge.files.drain();
    expect((await f.ok('operation_status', { requestId: cancelledInput.requestId })).data.status).toBe('cancelled');
    expect((await f.readyRead(created.id)).content).toBe(patched.content);
    const archive = { noteId: created.id, expectedModifiedAt: patched.modifiedAt, requestId: 'workflow-archive' };
    const archived = (await f.ok('archive_note', archive)).data;
    expect(archived).toMatchObject({ id: created.id, archived: true });
    expect((await f.ok('archive_note', archive)).data).toEqual(archived);
    expect((await f.ok('list_notes', { directory: '00-Inbox' })).data.items).toEqual([]);
    expect(await readFile(join(f.config.knowledgeRoot, '90-Archive', '.trash', created.id, create.fileName), 'utf8')).toBe(patched.content);
    expect([...f.called]).toEqual(expect.arrayContaining(['update_note', 'patch_note', 'archive_note', 'operation_status', 'cancel_operation']));
  } finally { await f.close(); }
});

it('requires explicit blog publish/update/withdrawal, preserves private changes and replays publication receipts through the SDK', async () => {
  const f = await workflowFixture();
  try {
    const content = '# Public version one\n';
    const created = (await f.ok('create_note', { directory: '00-Inbox', fileName: 'public.md', content, requestId: randomUUID() })).data;
    expect((await f.ok('get_blog_status', { noteId: created.id })).data).toMatchObject({ siteEnabled: false, publicationVersion: 0, post: null });
    const input = { noteId: created.id, expectedModifiedAt: created.modifiedAt, expectedContentHash: created.contentHash,
      expectedPublicationVersion: 0, requestId: 'workflow-publish', metadata: { slug: 'workflow-public' } };
    f.principal.scopes = ['knowledge:read', 'knowledge:write'];
    await f.error('publish_blog_post', input, 'INSUFFICIENT_SCOPE');
    f.principal.scopes = ['knowledge:read', 'knowledge:write', 'knowledge:index', 'knowledge:archive', 'blog:read', 'blog:publish'];
    const published = (await f.ok('publish_blog_post', input)).data;
    expect(published).toMatchObject({ state: 'published', version: 1, sourceHash: sha256(content), url: null });
    expect((await f.ok('operation_status', { requestId: input.requestId })).data)
      .toMatchObject({ kind: 'blog.publish', status: 'succeeded', result: published });
    // Enable only this temporary site's public projection to check that private
    // edits do not replace the immutable publication until an explicit publish.
    const blog = f.platform.get().blog;
    blog.updateSettings({ ...webPrincipal, id: f.principal.id }, { settings: { ...blog.settings(f.principal), enabled: true, baseUrl: 'https://blog.example' }, requestId: 'workflow-site-enable' });
    expect(blog.publicPost('workflow-public').html).toContain('Public version one');
    const privateContent = '# Private version two\n';
    const updated = (await f.ok('update_note', { noteId: created.id, expectedModifiedAt: created.modifiedAt, content: privateContent, requestId: 'workflow-private-edit' })).data;
    const unchanged = (await f.ok('get_blog_status', { noteId: created.id })).data;
    expect(unchanged).toMatchObject({ source: { contentHash: sha256(privateContent) }, publicationVersion: 1,
      post: { version: 1, sourceHash: sha256(privateContent), publishedVersionId: published.publishedVersionId, hasUnpublishedChanges: true } });
    expect(blog.publicPost('workflow-public').html).toContain('Public version one');
    expect(blog.publicPost('workflow-public').html).not.toContain('Private version two');
    expect((await f.ok('publish_blog_post', input)).data).toEqual(published);
    await f.error('publish_blog_post', { ...input, expectedPublicationVersion: 1, requestId: 'workflow-publish-stale' }, 'VERSION_CONFLICT');
    const republished = (await f.ok('publish_blog_post', { ...input, expectedModifiedAt: updated.modifiedAt,
      expectedContentHash: updated.contentHash, expectedPublicationVersion: 1, requestId: 'workflow-publish-new-version' })).data;
    expect(republished).toMatchObject({ state: 'published', version: 2, sourceHash: sha256(privateContent), hasUnpublishedChanges: false });
    expect(blog.publicPost('workflow-public').html).toContain('Private version two');
    const withdraw = { noteId: created.id, expectedPublicationVersion: 2, requestId: 'workflow-withdraw' };
    const withdrawn = (await f.ok('unpublish_blog_post', withdraw)).data;
    expect(withdrawn).toMatchObject({ state: 'withdrawn', version: 3 });
    expect((await f.ok('unpublish_blog_post', withdraw)).data).toEqual(withdrawn);
    expect((await f.ok('get_blog_status', { noteId: created.id })).data).toMatchObject({ publicationVersion: 3, post: { state: 'withdrawn', version: 3 } });
    expect(() => blog.publicPost('workflow-public')).toThrowError(expect.objectContaining({ statusCode: 404 }));
    expect((await f.readyRead(created.id)).content).toBe(privateContent);
    expect([...f.called]).toEqual(expect.arrayContaining(['get_blog_status', 'publish_blog_post', 'unpublish_blog_post']));
  } finally { await f.close(); }
});

it('reads legacy indexed heading holes through SDK search and chunk fetch without reindexing while rejecting invalid heading types', async () => {
  const f = await workflowFixture();
  try {
    const content = '#### Legacy root\n' + 'legacyheading evidence\n'.repeat(900);
    const created = (await f.ok('create_note', { directory: '00-Inbox', fileName: 'legacy.md', content, requestId: 'legacy-heading-create' })).data;
    await f.platform.get().knowledge.indexing.reconcile(undefined, true);
    await f.platform.get().knowledge.worker.drain();
    const indexed = f.db.prepare('SELECT chunk_id,heading_path FROM chunks WHERE note_id=? AND active=1')
      .all(created.id) as { chunk_id: string; heading_path: string }[];
    expect(indexed.length).toBeGreaterThan(0);
    // Represent only the metadata emitted by the previous chunker. Note bytes,
    // hashes, FTS, actual chunk text and indexed revisions remain real.
    const legacyPath = JSON.stringify([null, null, null, 'Legacy root']);
    const updatePath = f.db.prepare('UPDATE chunks SET heading_path=? WHERE chunk_id=?');
    for (const chunk of indexed) {
      expect(JSON.parse(chunk.heading_path)).toEqual(['Legacy root']);
      updatePath.run(legacyPath, chunk.chunk_id);
    }
    const searched = (await f.ok('search_notes', { query: 'legacyheading', mode: 'hybrid' })).data;
    expect(searched.results).toHaveLength(1);
    expect(searched.results[0].noteId).toBe(created.id);
    for (const match of searched.results[0].matches) expect(match.headingPath).toEqual(['Legacy root']);
    const research = await f.ok('search', { query: 'legacyheading' });
    expect(research.results).toHaveLength(1);
    const fetched = await f.ok('fetch', { id: research.results[0].id });
    expect(fetched.metadata).toMatchObject({ noteId: created.id, objectType: 'chunk', headingPath: ['Legacy root'] });
    expect(Buffer.from(fetched.text)).toEqual(Buffer.from(content).subarray(fetched.metadata.startByte, fetched.metadata.endByte));
    expect(f.db.prepare('SELECT heading_path FROM chunks WHERE chunk_id=?').get(indexed[0].chunk_id))
      .toEqual({ heading_path: legacyPath });

    // Compatibility removes only absent ancestors; corrupt non-string values
    // must still fail the strict MCP output contract rather than disappear.
    for (const chunk of indexed) updatePath.run(JSON.stringify([null, 7, 'Legacy root']), chunk.chunk_id);
    await f.error('search_notes', { query: 'legacyheading', mode: 'hybrid' }, 'INVALID_BACKEND_RESPONSE');
    await f.error('search', { query: 'legacyheading' }, 'INVALID_BACKEND_RESPONSE');
    await f.error('fetch', { id: research.results[0].id }, 'INVALID_BACKEND_RESPONSE');
  } finally { await f.close(); }
});
