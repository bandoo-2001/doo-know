import { expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createOperations, registerOperations } from '../plugins/mcp/server/operations.js';
import { hostClient } from '../plugins/mcp/server/service.js';
import { resultSize, budgets } from '../plugins/mcp/server/budgets.js';
import { pluginRuntimeFixture } from './support/plugin-runtime.js';
import { createMcpTransferStore } from '../apps/server/plugins/mcp-transfers.js';
import { createBlogToolPort } from '../apps/server/blog/mcp-tools.js';
import { requireScope } from '../packages/core/agent/auth.js';
import { blogHash } from '../packages/core/blog/resources.js';
import { defaultBlogDesign } from '../shared/blog-design.js';
import { currentBlogInstanceId } from '../packages/core/auth/permissions.js';
import type { Principal } from '../shared/knowledge-contracts.js';

async function fixture() {
  const f = await pluginRuntimeFixture();
  let principal: Principal = { ...f.principal, pluginId: 'mcp', scopes: ['knowledge:read', 'blog:read', 'blog:write', 'blog:manage', 'blog:publish'] };
  const transfers = createMcpTransferStore(f.config, f.db);
  const port = createBlogToolPort({ config: f.config, db: f.db, runtime: f.platform.get(), transfers,
    authorize(scopes) { for (const s of scopes) requireScope(principal, s); return principal; }, toDooAccess: () => ({ listIds: [], domains: [] }) });
  return { ...f, principal, port, transfers, change(p: Principal) { principal = p; } };
}
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a7i8AAAAASUVORK5CYII=', 'base64');
async function upload(f: Awaited<ReturnType<typeof fixture>>, kind: 'design' | 'media', bytes: Buffer, expectedVersion: number) {
  const transfer: any = await f.port.call('begin_blog_design_upload', { kind, expectedVersion, byteLength: bytes.length, sha256: blogHash(bytes), mime: kind === 'design' ? 'application/json' : 'image/png', name: kind === 'design' ? 'design.json' : 'image.png', requestId: randomUUID() });
  for (let offset = 0; offset < bytes.length; offset += 16000) {
    const p = f.port.authorizeTransfer(transfer.binding, true);
    f.transfers.append(p, { transferId: transfer.transferId, offset, base64: bytes.subarray(offset, offset + 16000).toString('base64') });
  }
  return transfer;
}
it('pages full UTF-8 design JSON, saves drafts, publishes, restores and replays bounded receipts', async () => {
  const f = await fixture();
  try {
    const initial: any = await f.port.call('get_blog_design', {});
    expect(initial).toMatchObject({ version: 1, kind: 'draft', publishedRevision: 0, nextByte: null });
    const design = { ...defaultBlogDesign(), profile: { ...defaultBlogDesign().profile, bio: '中文😀'.repeat(5000) } };
    const transfer = await upload(f, 'design', Buffer.from(JSON.stringify(design)), initial.version);
    const input = { expectedVersion: initial.version, designTransferId: transfer.transferId, requestId: randomUUID() };
    const saved: any = await f.port.call('update_blog_design', input);
    expect(saved).toMatchObject({ version: 2, hasUnpublishedChanges: true, draftHash: blogHash(JSON.stringify(design)) });
    expect(saved).not.toHaveProperty('draft');
    expect(await f.port.call('update_blog_design', input)).toEqual(saved);
    await expect(f.port.call('update_blog_design', { ...input, requestId: randomUUID() })).rejects.toBeDefined();
    const publish = { expectedVersion: saved.version, requestId: randomUUID() };
    const published: any = await f.port.call('publish_blog_design', publish);
    expect(published).toMatchObject({ version: 3, publishedRevision: 1, hasUnpublishedChanges: false });
    expect(await f.port.call('publish_blog_design', publish)).toEqual(published);
    let offset = 0, json = '';
    do {
      const page: any = await f.port.call('get_blog_design', { kind: 'published', offset, maxBytes: 8192 });
      expect(Buffer.byteLength(JSON.stringify({ result: { content: [{ type: 'text', text: JSON.stringify({ data: page }) }], structuredContent: { data: page } } }))).toBeLessThan(65536);
      expect(page.sha256).toBe(blogHash(JSON.stringify(design))); json += page.json; offset = page.nextByte ?? 0;
    } while (offset);
    expect(JSON.parse(json)).toEqual(design);
    const restored: any = await f.port.call('restore_blog_design', { expectedVersion: published.version, revision: 1, requestId: randomUUID() });
    expect(restored).toMatchObject({ version: 4, publishedRevision: 1 });
    expect(await f.port.call('update_blog_design', input)).toEqual(saved);
    await expect(f.port.call('update_blog_design', { ...input, expectedVersion: 4 })).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
    expect((f.db.prepare("SELECT count(*) AS n FROM operations WHERE kind='blog.design.save'").get() as any).n).toBe(1);
  } finally { await f.close(); }
});
it('uploads media without inline base64 tools and binds every transfer operation to site authority and current design', async () => {
  const f = await fixture();
  try {
    const uploadInfo = await upload(f, 'media', png, 1);
    const input = { transferId: uploadInfo.transferId, expectedVersion: 1, requestId: randomUUID() };
    const media: any = await f.port.call('commit_blog_design_media', input);
    expect(media).toMatchObject({ hash: blogHash(png), size: png.length, url: '/blog/media/' + blogHash(png) });
    expect(await f.port.call('commit_blog_design_media', input)).toEqual(media);
    await expect(f.port.call('commit_blog_design_media', { ...input, requestId: randomUUID() })).rejects.toBeDefined();
    const stale = await upload(f, 'media', png, 1);
    const design = defaultBlogDesign(); design.profile.avatar = media.url;
    await f.port.call('update_blog_design', { designJson: JSON.stringify(design), expectedVersion: 1, requestId: randomUUID() });
    expect(() => f.port.authorizeTransfer(stale.binding, true)).toThrowError(expect.objectContaining({ code: 'VERSION_CONFLICT' }));
    await expect(f.port.call('commit_blog_design_media', { transferId: stale.transferId, expectedVersion: 1, requestId: randomUUID() })).rejects.toMatchObject({ code: 'VERSION_CONFLICT' });
    expect(await f.port.call('commit_blog_design_media', input)).toEqual(media);
    f.change({ ...f.principal, scopes: ['knowledge:read', 'blog:read'] });
    await expect(f.port.call('commit_blog_design_media', input)).rejects.toBeDefined();
    f.change({ ...f.principal, permissionCeiling: { version: 2, domains: { blog: { enabled: true, ownerId: f.principal.id, instanceId: currentBlogInstanceId(f.db), actions: ['read','manage','publish'], resources: { mode: 'selected', resources: [{ kind: 'post', id: 'selected' }] } } } } });
    await expect(f.port.call('get_blog_design', {})).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(() => f.port.authorizeTransfer(uploadInfo.binding, true, undefined, 'completed')).toThrowError(expect.objectContaining({ code: 'FORBIDDEN' }));
  } finally { await f.close(); }
});
it('rejects cancelled/expired uploads, malformed images, invalid UTF-8, and oversized inline JSON', async () => {
  const f = await fixture();
  try {
    const badImage = await upload(f, 'media', Buffer.from('not a png'), 1);
    await expect(f.port.call('commit_blog_design_media', { transferId: badImage.transferId, expectedVersion: 1, requestId: randomUUID() })).rejects.toBeDefined();
    const invalid = await upload(f, 'design', Buffer.from([0xff, 0xfe]), 1);
    await expect(f.port.call('update_blog_design', { designTransferId: invalid.transferId, expectedVersion: 1, requestId: randomUUID() })).rejects.toBeDefined();
    const cancelled = await upload(f, 'media', png, 1); f.transfers.cancel(f.principal, cancelled.transferId);
    await expect(f.port.call('commit_blog_design_media', { transferId: cancelled.transferId, expectedVersion: 1, requestId: randomUUID() })).rejects.toBeDefined();
    const expired = await upload(f, 'media', png, 1); f.db.prepare('UPDATE mcp_transfers SET expires_at=0 WHERE id=?').run(expired.transferId);
    await expect(f.port.call('commit_blog_design_media', { transferId: expired.transferId, expectedVersion: 1, requestId: randomUUID() })).rejects.toBeDefined();
    const design = defaultBlogDesign(); design.profile.bio = '中'.repeat(9000);
    await expect(f.port.call('update_blog_design', { designJson: JSON.stringify(design), expectedVersion: 1, requestId: randomUUID() })).rejects.toBeDefined();
    await expect(f.port.call('begin_blog_design_upload', { kind: 'media', expectedVersion: 1, byteLength: 5 * 1024 ** 2 + 1, sha256: blogHash(png), mime: 'image/png', name: 'a.png', requestId: randomUUID() })).rejects.toBeDefined();
  } finally { await f.close(); }
});
it('returns paged publication diagnostics and comparison hashes without full HTML', async () => {
  const f = await fixture();
  try {
    const runtime = f.platform.get();
    const note = runtime.notes.createNote('00-Inbox', 'review.md', '# Review\n' + Array.from({ length: 28 }, (_, i) => `[Missing ${i}](missing-${i}.md)`).join('\n'));
    const post = runtime.blog.createPost(f.principal, { sourceNoteId: note.id, requestId: randomUUID() });
    const result: any = await f.port.call('get_blog_publication_review', { postId: post.id, limit: 7 });
    expect(result).toMatchObject({ warningTotal: 28, nextWarningOffset: 7, comparison: { published: null, draft: { sha256: expect.stringMatching(/^[a-f0-9]{64}$/), byteLength: expect.any(Number) } } });
    expect(result.warnings).toHaveLength(7); expect(result).not.toHaveProperty('draftHtml'); expect(result).not.toHaveProperty('publishedHtml');
    expect(await f.port.call('get_blog_publication_review', { postId: post.id, limit: 7, warningOffset: 21 })).toMatchObject({ warningTotal: 28, nextWarningOffset: null });
    f.change({ ...f.principal, allowedPrefixes: ['10-Projects'] });
    await expect(f.port.call('get_blog_publication_review', { postId: post.id })).rejects.toMatchObject({ code: 'FORBIDDEN' });
  } finally { await f.close(); }
});
it('keeps disconnected studio operation receipts bounded and existing reserved article URLs editable', async () => {
  const f = await fixture();
  try {
    const design = defaultBlogDesign(); design.profile.bio = '巨型装修'.repeat(9000);
    const info = await upload(f, 'design', Buffer.from(JSON.stringify(design)), 1);
    const requestId = randomUUID();
    await f.port.call('update_blog_design', { expectedVersion: 1, designTransferId: info.transferId, requestId });
    const operation = f.platform.get().blog.operationStatus(f.principal, { requestId });
    expect(Object.hasOwn(operation.result ?? {}, 'draft')).toBe(false);
    expect(operation.result).toMatchObject({ version: 2, draftBytes: Buffer.byteLength(JSON.stringify(design)) });
    expect(Buffer.byteLength(JSON.stringify(operation))).toBeLessThan(8000);
    const runtime = f.platform.get(), note = runtime.notes.createNote('00-Inbox', 'legacy.md', '# Legacy');
    const post = runtime.blog.createPost(f.principal, { sourceNoteId: note.id, requestId: randomUUID() });
    const metadata = { ...post, slug: 'articles' };
    const stored = JSON.parse((f.db.prepare('SELECT metadata_json FROM blog_posts WHERE id=?').get(post.id) as any).metadata_json);
    f.db.prepare('UPDATE blog_posts SET slug=?,metadata_json=? WHERE id=?').run(metadata.slug, JSON.stringify({ ...stored, slug: metadata.slug }), post.id);
    const updated = runtime.blog.updatePost(f.principal, post.id, { metadata: { title: 'Legacy updated' }, expectedVersion: post.version, requestId: randomUUID() });
    expect(updated.slug).toBe('articles');
    const published = runtime.blog.publishNote(f.principal, { noteId: note.id, expectedModifiedAt: note.modifiedAt, expectedContentHash: blogHash(note.content), expectedPublicationVersion: updated.version, requestId: randomUUID() });
    expect(published.slug).toBe('articles');
    const fresh = runtime.notes.createNote('00-Inbox', 'fresh.md', '# Fresh');
    expect(() => runtime.blog.createPost(f.principal, { sourceNoteId: fresh.id, metadata: { slug: 'collections' }, requestId: randomUUID() })).toThrow();
  } finally { await f.close(); }
});
it('discovers and executes studio tools through real MCP SDK within duplicated escaped frame budgets', async () => {
  const f = await fixture();
  const registry = createOperations({ objectIdSecret: 'studio-sdk-object-secret-more-than-thirty-two' }, hostClient(() => ({ ...f.services, knowledge: {} as any, blogTools: f.port }), () => ({})));
  const server = new McpServer({ name: 'studio', version: '1' }); registerOperations(server, registry, f.principal);
  const client = new Client({ name: 'studio-test', version: '1' });
  const [left, right] = InMemoryTransport.createLinkedPair();
  const frames: number[] = [], send = right.send.bind(right);
  right.send = (message, options) => { frames.push(Buffer.byteLength(JSON.stringify(message))); return send(message, options); };
  try {
    await server.connect(right); await client.connect(left);
    const names = new Set<string>(); let cursor: string | undefined;
    do { const page = await client.listTools(cursor ? { cursor } : {}); for (const tool of page.tools) names.add(tool.name); cursor = page.nextCursor; } while (cursor);
    for (const name of ['get_blog_design','update_blog_design','publish_blog_design','restore_blog_design','begin_blog_design_upload','commit_blog_design_media','get_blog_publication_review']) expect(names.has(name)).toBe(true);
    const design = defaultBlogDesign(); design.profile.bio = '\\"\n'.repeat(15000);
    const transfer = await upload(f, 'design', Buffer.from(JSON.stringify(design)), 1);
    const input = { expectedVersion: 1, designTransferId: transfer.transferId, requestId: randomUUID() };
    const saved: any = await client.callTool({ name: 'update_blog_design', arguments: input });
    expect(saved.isError).toBeUndefined(); expect(saved.structuredContent.data).toMatchObject({ version: 2, hasUnpublishedChanges: true });
    expect(await client.callTool({ name: 'update_blog_design', arguments: input })).toEqual(saved);
    for (const offset of [0,8192,16384]) {
      const result: any = await client.callTool({ name: 'get_blog_design', arguments: { offset, maxBytes: 8192 } });
      expect(result.isError).toBeUndefined(); expect(resultSize(result.structuredContent, '\\'.repeat(128))).toBeLessThan(budgets.response);
    }
    f.db.prepare('UPDATE mcp_transfers SET expires_at=0 WHERE id=?').run(transfer.transferId);
    expect(await client.callTool({ name: 'update_blog_design', arguments: input })).toEqual(saved);
    f.change({ ...f.principal, scopes: ['knowledge:read','blog:read','blog:manage'] });
    const denied: any = await client.callTool({ name: 'publish_blog_design', arguments: { expectedVersion: 2, requestId: randomUUID() } });
    expect(denied).toMatchObject({ isError: true, structuredContent: { error: { code: 'FORBIDDEN' } } });
    expect(f.platform.get().blog.designState(f.principal).publishedRevision).toBe(0);
    expect(frames.every(size => size <= budgets.response)).toBe(true);
  } finally { await client.close(); await server.close(); await f.close(); }
});
it('routes decoration version conflicts to design state while preserving settings/article recovery', async () => {
  const { annotateError, BridgeError, errorBody } = await import('../plugins/mcp/server/errors.js');
  for (const name of ['update_blog_design','publish_blog_design','restore_blog_design','begin_blog_design_upload','commit_blog_design_media']) {
    expect(errorBody(annotateError(new BridgeError('VERSION_CONFLICT', 409), name, {}))).toMatchObject({ error: { recovery: { tool: 'get_blog_design', requestIdPolicy: 'new_after_review' } } });
  }
  expect(errorBody(annotateError(new BridgeError('VERSION_CONFLICT', 409), 'update_blog_settings', {}))).toMatchObject({ error: { recovery: { tool: 'get_blog_settings' } } });
  expect(errorBody(annotateError(new BridgeError('VERSION_CONFLICT', 409), 'update_blog_draft', {}))).toMatchObject({ error: { recovery: { tool: 'get_blog_post' } } });
});
