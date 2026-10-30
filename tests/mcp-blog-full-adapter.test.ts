import { expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { pluginRuntimeFixture } from './support/plugin-runtime.js';
import { createMcpTransferStore } from '../apps/server/plugins/mcp-transfers.js';
import { createBlogToolPort } from '../apps/server/blog/mcp-tools.js';
import { createOperations, registerOperations } from '../plugins/mcp/server/operations.js';
import { hostClient } from '../plugins/mcp/server/service.js';
import { blogToolDefinitions, blogToolVersionMetadata } from '../shared/mcp-blog-tools.js';
import { requireScope } from '../packages/core/agent/auth.js';
import { resultSize, budgets } from '../plugins/mcp/server/budgets.js';
import { currentBlogInstanceId } from '../packages/core/auth/permissions.js';
import type { Principal } from '../shared/knowledge-contracts.js';

async function fixture(actions = ['read', 'write']) {
  const f = await pluginRuntimeFixture();
  let principal: Principal = { ...f.principal, pluginId: 'mcp', scopes: ['knowledge:read', ...actions.map(action => 'blog:' + action)] };
  const transfers = createMcpTransferStore(f.config, f.db);
  const port = createBlogToolPort({ config: f.config, db: f.db, runtime: f.platform.get(),
    authorize(scopes) { for (const scope of scopes) requireScope(principal, scope); return principal; },
    toDooAccess: () => ({ listIds: [], domains: [] }), transfers });
  const registry = createOperations({ objectIdSecret: 'blog-full-sdk-test-object-secret-thirty-two' }, hostClient(() => ({ ...f.services, knowledge: {} as any, blogTools: port }), () => ({})));
  const server = new McpServer({ name: 'blog-full', version: '1.3.0' }); registerOperations(server, registry, principal);
  const client = new Client({ name: 'blog-full-test', version: '1' });
  const [left, right] = InMemoryTransport.createLinkedPair();
  const frames: number[] = [], send = right.send.bind(right);
  right.send = (message, options) => { frames.push(Buffer.byteLength(JSON.stringify(message))); return send(message, options); };
  await server.connect(right); await client.connect(left);
  return { ...f, client, port, transfers, registry, frames, principal, change: (value: Principal) => { principal = value; },
    close: async () => { await client.close(); await server.close(); await f.close(); } };
}
it('discovers strict blog schemas over real SDK and edits drafts without publication, site management or note writes', async () => {
  const f = await fixture();
  try {
    const names = new Set<string>(); let cursor: string | undefined;
    do { const page = await f.client.listTools(cursor ? { cursor } : {}); for (const tool of page.tools) { names.add(tool.name); if (tool.name === 'update_blog_draft') expect(tool.inputSchema).toMatchObject({ additionalProperties: false, required: expect.arrayContaining(['postId','metadata','expectedVersion','requestId']) }); } cursor = page.nextCursor; } while (cursor);
    for (const definition of blogToolDefinitions) expect(names.has(definition.name)).toBe(true);
    const note = f.platform.get().notes.createNote('00-Inbox', 'draft.md', '# Private draft');
    const input = { sourceNoteId: note.id, requestId: randomUUID(), metadata: { category: 'private', tags: ['draft'] } };
    const created: any = await f.client.callTool({ name: 'create_blog_draft', arguments: input });
    expect(created).toMatchObject({ structuredContent: { data: { sourceNoteId: note.id, state: 'draft', title: 'Private draft' } } });
    const post = created.structuredContent.data;
    expect(await f.client.callTool({ name: 'create_blog_draft', arguments: input })).toEqual(created);
    const update: any = await f.client.callTool({ name: 'update_blog_draft', arguments: { postId: post.id, expectedVersion: post.version, metadata: { title: 'New title' }, requestId: randomUUID() } });
    expect(update).toMatchObject({ structuredContent: { data: { title: 'New title', category: 'private', tags: ['draft'], state: 'draft' } } });
    expect(await f.client.callTool({ name: 'update_blog_draft', arguments: { postId: post.id, expectedVersion: post.version, metadata: { title: 'Stale' }, requestId: randomUUID() } })).toMatchObject({ isError: true, structuredContent: { error: { code: 'VERSION_CONFLICT' } } });
    expect(await f.client.callTool({ name: 'update_blog_settings', arguments: { expectedVersion: 0, settings: { enabled: true }, requestId: randomUUID() } })).toMatchObject({ isError: true, structuredContent: { error: { code: 'INSUFFICIENT_SCOPE' } } });
    expect(await f.client.callTool({ name: 'delete_blog_post', arguments: { postId: post.id, expectedVersion: update.structuredContent.data.version, requestId: randomUUID() } })).toMatchObject({ isError: true, structuredContent: { error: { code: 'INSUFFICIENT_SCOPE' } } });
    expect((f.db.prepare('SELECT count(*) AS n FROM blog_versions').get() as any).n).toBe(0);
    expect(f.platform.get().notes.getNote(note.id).content).toBe('# Private draft');
    expect(f.frames.every(size => size <= budgets.response)).toBe(true);
  } finally { await f.close(); }
});
it('filters selected articles and rejects a selected article used as site authority or a revoked source grant', async () => {
  const f = await fixture(['read','write','manage']);
  try {
    const runtime = f.platform.get(), note = runtime.notes.createNote('00-Inbox', 'selected.md', '# Selected'), other = runtime.notes.createNote('00-Inbox', 'other.md', '# Other');
    const selected = runtime.blog.createPost(f.principal, { sourceNoteId: note.id, requestId: randomUUID() });
    runtime.blog.createPost(f.principal, { sourceNoteId: other.id, requestId: randomUUID() });
    const p: Principal = { ...f.principal, permissionCeiling: { version: 2, domains: { knowledge: { enabled: true, ownerId: f.principal.id, instanceId: 'test-library', actions: ['read'], resources: { mode: 'all' } }, blog: { enabled: true, ownerId: f.principal.id, instanceId: currentBlogInstanceId(f.db), actions: ['read','write','manage'], resources: { mode: 'selected', resources: [{ kind: 'post', id: selected.id }] } } } } };
    f.change(p);
    expect(await f.port.call('list_blog_posts', {})).toMatchObject({ total: 1, posts: [{ id: selected.id }] });
    await expect(f.port.call('get_blog_settings', {})).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(f.port.call('update_blog_settings', { expectedVersion: 0, settings: {}, requestId: randomUUID() })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    f.change({ ...p, allowedPrefixes: ['10-Projects'] });
    await expect(f.port.call('get_blog_post', { postId: selected.id })).rejects.toMatchObject({ code: 'FORBIDDEN' });
  } finally { await f.close(); }
});
it('bounds large Unicode metadata and paginates summaries within complete wire-frame budgets', async () => {
  const f = await fixture();
  try {
    const runtime = f.platform.get();
    for (let i = 0; i < 6; i++) {
      const note = runtime.notes.createNote('00-Inbox', `metadata-${i}.md`, '# ' + '😀'.repeat(200));
      runtime.blog.createPost(f.principal, { sourceNoteId: note.id, metadata: { summary: '中'.repeat(2000), tags: Array.from({ length: 30 }, (_, tag) => String(tag) + '中'.repeat(78)), cover: 'figure.svg?' + '中'.repeat(8000) }, requestId: randomUUID() });
    }
    const visited = new Set<string>(); let cursor: string | undefined;
    do {
      const response: any = await f.registry.execute('list_blog_posts', f.principal, { limit: 20, ...(cursor ? { cursor } : {}) });
      expect(resultSize(response)).toBeLessThan(budgets.response);
      for (const post of response.data.posts) visited.add(post.id);
      cursor = response.data.nextCursor || undefined;
    } while (cursor);
    expect(visited.size).toBe(6);
    const detail: any = await f.registry.execute('get_blog_post', f.principal, { postId: [...visited][0] });
    expect(detail.data.truncatedMetadata).toEqual(expect.arrayContaining(['summary','tags','cover']));
    expect(resultSize(detail)).toBeLessThan(budgets.response);
    expect(JSON.stringify(detail)).not.toContain('sourceContent'); expect(JSON.stringify(detail)).not.toContain('previewHtml');
  } finally { await f.close(); }
});

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a7i8AAAAASUVORK5CYII=', 'base64');
it('uses opaque resource transfers, checks exact post association and revokes source access during reads', async () => {
  const f = await fixture(['read','write','publish']);
  try {
    const runtime = f.platform.get();
    let note = runtime.notes.createNote('00-Inbox', 'resource.md', '# Resource');
    const asset = runtime.assets.upload(note.id, 'image.png', 'image/png', png);
    note = runtime.notes.saveNote(note.id, '# Resource\n\n![Image](' + asset.markdownPath + ')', note.modifiedAt) as typeof note;
    const post = runtime.blog.createPost(f.principal, { sourceNoteId: note.id, requestId: randomUUID() });
    const resources: any = await f.port.call('list_blog_resources', { postId: post.id });
    expect(resources).toMatchObject({ total: 1, resources: [{ sizeBytes: png.length, mime: 'image/png' }] });
    const download: any = await f.port.call('download_blog_resource', { postId: post.id, hash: resources.resources[0].hash });
    expect(JSON.stringify(download)).not.toContain(f.root); expect(download).not.toHaveProperty('path');
    const principal = f.port.authorizeTransfer(download.binding, false);
    expect(Buffer.from(f.transfers.read(principal, { transferId: download.transferId, offset: 0 }).base64, 'base64')).toEqual(png);
    const other = runtime.notes.createNote('00-Inbox', 'unrelated.md', '# Other');
    const otherPost = runtime.blog.createPost(f.principal, { sourceNoteId: other.id, requestId: randomUUID() });
    await expect(f.port.call('download_blog_resource', { postId: otherPost.id, hash: resources.resources[0].hash })).rejects.toMatchObject({ code: 'NOT_FOUND' });
    f.change({ ...f.principal, allowedPrefixes: [note.relativePath] });
    expect(() => f.port.authorizeTransfer(download.binding, false)).toThrowError(expect.objectContaining({ code: 'FORBIDDEN' }));
  } finally { await f.close(); }
});
it('uploads source-bound diagram PNGs and publishes once while replaying the original receipt after revision changes', async () => {
  const f = await fixture(['read','write','publish']);
  try {
    const runtime = f.platform.get();
    const note = runtime.notes.createNote('00-Inbox', 'diagram.md', '# Diagram\n\n```mermaid\nflowchart TD\nA-->B\n```\n');
    const post: any = await f.port.call('create_blog_draft', { sourceNoteId: note.id, requestId: randomUUID() });
    const needs: any = await f.port.call('list_blog_diagrams', { postId: post.id });
    expect(needs).toMatchObject({ total: 1, diagrams: [{ kind: 'mermaid' }] }); expect(needs.diagrams[0]).not.toHaveProperty('code');
    const source: any = await f.port.call('download_blog_content', { postId: post.id, kind: 'diagram_source', fenceFrom: needs.diagrams[0].fenceFrom });
    f.port.authorizeTransfer(source.binding, false);
    expect(Buffer.from(f.transfers.read(f.principal, { transferId: source.transferId, offset: 0 }).base64, 'base64').toString()).toContain('A-->B');
    const upload: any = await f.port.call('begin_blog_upload', { kind: 'diagram_png', postId: post.id, expectedVersion: post.version, byteLength: png.length, sha256: (await import('../packages/core/blog/resources.js')).blogHash(png), mime: 'image/png', requestId: randomUUID() });
    f.port.authorizeTransfer(upload.binding, true);
    f.transfers.append(f.principal, { transferId: upload.transferId, offset: 0, base64: png.toString('base64') });
    const input = { postId: post.id, noteId: note.id, expectedModifiedAt: note.modifiedAt, expectedContentHash: post.sourceHash, expectedPublicationVersion: post.version, diagrams: [{ ...needs.diagrams[0], transferId: upload.transferId }], requestId: randomUUID() };
    const published: any = await f.port.call('publish_blog_post_with_diagrams', input);
    expect(published).toMatchObject({ id: post.id, state: 'published' });
    expect(await f.port.call('publish_blog_post_with_diagrams', input)).toEqual(published);
    await expect(f.port.call('publish_blog_post_with_diagrams', { ...input, requestId: randomUUID() })).rejects.toMatchObject({ code: 'MCP_TRANSFER_CONFLICT' });
    await expect(f.port.call('publish_blog_post_with_diagrams', { ...input, diagrams: [], requestId: input.requestId })).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
    expect((f.db.prepare('SELECT count(*) AS n FROM blog_versions').get() as any).n).toBe(1);
    expect(runtime.blog.managedVersion(f.principal, post.id, published.publishedVersionId).html).toContain('/blog/assets/');
    expect(f.transfers.info(f.principal, upload.transferId).state).toBe('completed');
    expect((f.db.prepare("SELECT count(*) AS n FROM operations WHERE kind='blog.publish'").get() as any).n).toBe(1);
    expect(() => f.port.authorizeTransfer(source.binding, false)).toThrowError(expect.objectContaining({ code: 'VERSION_CONFLICT' }));
    f.db.prepare('UPDATE mcp_transfers SET expires_at=0 WHERE id=?').run(upload.transferId);
    expect(await f.port.call('publish_blog_post_with_diagrams', input)).toEqual(published);
  } finally { await f.close(); }
});
it('uploads and pages complete about text with manage alone, preserves CAS and stable retries without republishing', async () => {
  const f = await fixture(['read','manage']);
  try {
    const text = '关于本站。'.repeat(6000), bytes = Buffer.from(text), settings = f.platform.get().blog.settings();
    const upload: any = await f.port.call('begin_blog_upload', { kind: 'about', expectedVersion: settings.version, byteLength: bytes.length, sha256: (await import('../packages/core/blog/resources.js')).blogHash(bytes), mime: 'text/plain', requestId: randomUUID() });
    for (let offset = 0; offset < bytes.length; offset += 12000) {
      f.port.authorizeTransfer(upload.binding, true);
      f.transfers.append(f.principal, { transferId: upload.transferId, offset, base64: bytes.subarray(offset, offset + 12000).toString('base64') });
    }
    const input = { expectedVersion: settings.version, settings: {}, aboutTransferId: upload.transferId, requestId: randomUUID() };
    const updated: any = await f.port.call('update_blog_settings', input);
    expect(updated.aboutBytes).toBe(bytes.length); expect(updated.aboutRange.nextByte).toBeGreaterThan(0);
    expect(await f.port.call('update_blog_settings', input)).toEqual(updated);
    await expect(f.port.call('update_blog_settings', { ...input, requestId: randomUUID() })).rejects.toMatchObject({ code: 'MCP_TRANSFER_CONFLICT' });
    expect(f.platform.get().blog.settings().version).toBe(updated.version);
    expect((f.db.prepare("SELECT count(*) AS n FROM operations WHERE kind='blog.settings'").get() as any).n).toBe(1);
    let offset = 0, complete = '';
    do { const page: any = await f.port.call('get_blog_settings', { aboutOffset: offset, maxBytes: 8192 }); complete += page.about; offset = page.aboutRange.nextByte || 0; } while (offset);
    expect(complete).toBe(text);
    const later: any = await f.port.call('update_blog_settings', { expectedVersion: updated.version, settings: { title: 'Later edit' }, requestId: randomUUID() });
    expect(await f.port.call('update_blog_settings', input)).toEqual(updated);
    expect(f.platform.get().blog.settings().title).toBe('Later edit');
    await expect(f.port.call('update_blog_settings', { expectedVersion: updated.version, settings: { title: 'Stale' }, requestId: randomUUID() })).rejects.toMatchObject({ code: 'VERSION_CONFLICT' });
    await expect(f.port.call('update_blog_settings', { expectedVersion: later.version, settings: { enabled: true }, requestId: randomUUID() })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(f.platform.get().blog.settings().enabled).toBe(false);
    expect((f.db.prepare('SELECT count(*) AS n FROM blog_versions').get() as any).n).toBe(0);
    f.db.prepare('UPDATE mcp_transfers SET expires_at=0 WHERE id=?').run(upload.transferId);
    expect(await f.port.call('update_blog_settings', input)).toEqual(updated);
  } finally { await f.close(); }
});

it.each(['about', 'diagram_png'] as const)('reserves %s uploads to their first finalization identity before a domain conflict', async (kind) => {
  const f = await fixture(['read','write','manage','publish']);
  try {
    const runtime = f.platform.get(), { blogHash } = await import('../packages/core/blog/resources.js');
    const bytes = kind === 'about' ? Buffer.from('Reserved about text') : png;
    const note = kind === 'diagram_png' ? runtime.notes.createNote('00-Inbox', 'reserved-diagram.md', '```mermaid\nflowchart TD\nA-->B\n```\n') : undefined;
    const post: any = note ? await f.port.call('create_blog_draft', { sourceNoteId: note.id, requestId: randomUUID() }) : undefined;
    const settings = runtime.blog.settings();
    const upload: any = await f.port.call('begin_blog_upload', { kind, ...(post ? { postId: post.id } : {}), expectedVersion: post?.version ?? settings.version, byteLength: bytes.length, sha256: blogHash(bytes), mime: kind === 'about' ? 'text/plain' : 'image/png', requestId: randomUUID() });
    f.transfers.append(f.principal, { transferId: upload.transferId, offset: 0, base64: bytes.toString('base64') });
    const firstRequest = randomUUID(), secondRequest = randomUUID();
    if (kind === 'about') {
      const input = { expectedVersion: settings.version - 1, settings: {}, aboutTransferId: upload.transferId, requestId: firstRequest };
      await expect(f.port.call('update_blog_settings', input)).rejects.toMatchObject({ code: 'VERSION_CONFLICT' });
      await expect(f.port.call('update_blog_settings', { ...input, expectedVersion: settings.version, requestId: secondRequest })).rejects.toMatchObject({ code: 'MCP_TRANSFER_CONFLICT' });
      expect(runtime.blog.settings()).toEqual(settings);
      expect((f.db.prepare("SELECT count(*) AS n FROM operations WHERE kind='blog.settings'").get() as any).n).toBe(0);
    } else {
      const needs: any = await f.port.call('list_blog_diagrams', { postId: post.id });
      const input = { postId: post.id, noteId: note!.id, expectedModifiedAt: '0', expectedContentHash: post.sourceHash, expectedPublicationVersion: post.version, diagrams: [{ ...needs.diagrams[0], transferId: upload.transferId }], requestId: firstRequest };
      await expect(f.port.call('publish_blog_post_with_diagrams', input)).rejects.toMatchObject({ code: 'VERSION_CONFLICT' });
      await expect(f.port.call('publish_blog_post_with_diagrams', { ...input, expectedModifiedAt: note!.modifiedAt, requestId: secondRequest })).rejects.toMatchObject({ code: 'MCP_TRANSFER_CONFLICT' });
      expect(runtime.blog.postMetadata(f.principal, post.id)).toMatchObject({ version: post.version, state: 'draft' });
      expect((f.db.prepare('SELECT count(*) AS n FROM blog_versions').get() as any).n).toBe(0);
      expect((f.db.prepare("SELECT count(*) AS n FROM operations WHERE kind='blog.publish'").get() as any).n).toBe(0);
    }
  } finally { await f.close(); }
});

it('paginates every missing diagram above the publication preview limit while rejecting an oversized publication', async () => {
  const f = await fixture(['read','write','publish']);
  try {
    const runtime = f.platform.get();
    const content = Array.from({ length: 85 }, (_, index) => '```mermaid\nflowchart TD\nA' + index + '-->B' + index + '\n```\n').join('\n');
    const note = runtime.notes.createNote('00-Inbox', 'many-diagrams.md', content);
    const post: any = await f.port.call('create_blog_draft', { sourceNoteId: note.id, requestId: randomUUID() });
    expect(runtime.blog.postDetail(f.principal, post.id).diagramNeeds).toHaveLength(85);
    const diagrams: any[] = []; let offset: number | null = 0;
    do {
      const reply: any = await f.client.callTool({ name: 'list_blog_diagrams', arguments: { postId: post.id, limit: 20, offset } });
      expect(reply.isError, JSON.stringify(reply)).not.toBe(true);
      const page = reply.structuredContent.data;
      expect(page.total).toBe(85); expect(page.diagrams.length).toBeLessThanOrEqual(20);
      diagrams.push(...page.diagrams); offset = page.nextOffset;
    } while (offset !== null);
    expect(new Set(diagrams.map(item => item.fenceFrom)).size).toBe(85);
    const source: any = await f.port.call('download_blog_content', { postId: post.id, kind: 'diagram_source', fenceFrom: diagrams[84].fenceFrom });
    f.port.authorizeTransfer(source.binding, false);
    expect(Buffer.from(f.transfers.read(f.principal, { transferId: source.transferId, offset: 0 }).base64, 'base64').toString()).toContain('A84-->B84');
    const excessive = await f.client.callTool({ name: 'publish_blog_post_with_diagrams', arguments: { postId: post.id, noteId: note.id, expectedModifiedAt: note.modifiedAt, expectedContentHash: post.sourceHash, expectedPublicationVersion: post.version, requestId: randomUUID(), diagrams: diagrams.slice(0,65).map(item => ({ ...item, transferId: randomUUID() })) } });
    expect(excessive).toMatchObject({ isError: true, structuredContent: { error: { code: 'INVALID_INPUT' } } });
    expect((f.db.prepare('SELECT count(*) AS n FROM blog_versions').get() as any).n).toBe(0);
    expect(f.frames.every(size => size <= budgets.response)).toBe(true);
  } finally { await f.close(); }
});
it('identifies each immutable version cover among multiple resources after the original asset changes with the site disabled', async () => {
  const f = await fixture(['read','write','publish']);
  try {
    const runtime = f.platform.get(), { blogHash } = await import('../packages/core/blog/resources.js');
    let note = runtime.notes.createNote('00-Inbox', 'version-cover.md', '# Version cover');
    const secondPng = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/lT0AAAAASUVORK5CYII=', 'base64');
    const firstAsset = runtime.assets.upload(note.id, 'first.png', 'image/png', png), coverAsset = runtime.assets.upload(note.id, 'cover.png', 'image/png', secondPng);
    note = runtime.notes.saveNote(note.id, '# Version cover\n\n![Body one](' + firstAsset.markdownPath + ')\n\n![Body two](' + coverAsset.markdownPath + ')', note.modifiedAt) as typeof note;
    const publishInput = { noteId: note.id, expectedModifiedAt: note.modifiedAt, expectedContentHash: blogHash(note.content), expectedPublicationVersion: 0, metadata: { cover: coverAsset.markdownPath }, requestId: randomUUID() };
    const first = runtime.blog.publishNote(f.principal, publishInput);
    const second = runtime.blog.publishNote(f.principal, { ...publishInput, expectedPublicationVersion: first.version, metadata: { cover: firstAsset.markdownPath }, requestId: randomUUID() });
    const { writeFile } = await import('node:fs/promises'), { join } = await import('node:path');
    await writeFile(join(f.config.knowledgeRoot, coverAsset.relativePath), png);
    expect(runtime.blog.settings().enabled).toBe(false);
    const oldVersion: any = await f.port.call('get_blog_version', { postId: first.id, versionId: first.publishedVersionId });
    expect(oldVersion).toMatchObject({ metadata: { cover: coverAsset.markdownPath }, coverResource: { postId: first.id, versionId: first.publishedVersionId, hash: blogHash(secondPng), mime: 'image/png', sizeBytes: secondPng.length } });
    const current: any = await f.port.call('get_blog_version', { postId: second.id, versionId: second.publishedVersionId });
    expect(current.coverResource.hash).toBe(blogHash(png));
    const resources: any = await f.port.call('list_blog_resources', { postId: first.id, versionId: first.publishedVersionId });
    expect(resources.total).toBe(2); expect(resources.resources.map((item: any) => item.hash)).toContain(oldVersion.coverResource.hash);
    const metadata: any = await f.port.call('download_blog_content', { kind: 'version_metadata', postId: first.id, versionId: first.publishedVersionId });
    f.port.authorizeTransfer(metadata.binding, false);
    const full = JSON.parse(Buffer.from(f.transfers.read(f.principal, { transferId: metadata.transferId, offset: 0 }).base64, 'base64').toString());
    expect(blogToolVersionMetadata.safeParse(full).success).toBe(true);
    expect(blogToolVersionMetadata.safeParse({ ...full, coverResource: { ...full.coverResource, localPath: '/tmp/private-cover' } }).success).toBe(false);
    expect(full).toMatchObject({ cover: coverAsset.markdownPath, coverResource: oldVersion.coverResource });
    const download: any = await f.port.call('download_blog_resource', { postId: first.id, versionId: first.publishedVersionId, hash: oldVersion.coverResource.hash });
    f.port.authorizeTransfer(download.binding, false);
    expect(Buffer.from(f.transfers.read(f.principal, { transferId: download.transferId, offset: 0 }).base64, 'base64')).toEqual(secondPng);
    const other = runtime.notes.createNote('00-Inbox', 'other-version.md', '# Other');
    const otherPost = runtime.blog.createPost(f.principal, { sourceNoteId: other.id, requestId: randomUUID() });
    await expect(f.port.call('get_blog_version', { postId: otherPost.id, versionId: first.publishedVersionId })).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(f.port.call('download_blog_resource', { postId: otherPost.id, versionId: first.publishedVersionId, hash: oldVersion.coverResource.hash })).rejects.toMatchObject({ code: 'NOT_FOUND' });
    f.change({ ...f.principal, allowedPrefixes: ['10-Projects'] });
    expect(() => f.port.authorizeTransfer(metadata.binding, false)).toThrowError(expect.objectContaining({ code: 'FORBIDDEN' }));
  } finally { await f.close(); }
});
