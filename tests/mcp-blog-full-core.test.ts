import { afterEach, beforeEach, expect, it } from 'vitest';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { openDatabase } from '../packages/core/db.js';
import { noteService } from '../packages/core/notes.js';
import { blogService } from '../packages/core/blog/service.js';
import { currentBlogInstanceId } from '../packages/core/auth/permissions.js';
import { blogHash } from '../packages/core/blog/resources.js';
import type { Principal } from '../shared/knowledge-contracts.js';

let root: string, db: ReturnType<typeof openDatabase>, notes: ReturnType<typeof noteService>, blog: ReturnType<typeof blogService>;
const owner: Principal = { id: 'owner', clientId: 'web', scopes: ['knowledge:read', 'knowledge:write', 'blog:publish'], allowedPrefixes: ['00-Inbox'] };
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'blog-full-'));
  const config: any = { knowledgeRoot: join(root, 'knowledge'), dataRoot: join(root, 'data'), origin: 'http://localhost:3010', secret: 'test-secret' };
  await mkdir(join(config.knowledgeRoot, '00-Inbox'), { recursive: true });
  db = openDatabase(config.dataRoot); notes = noteService(config, db); blog = blogService(config, db, notes);
});
afterEach(async () => { db.close(); await rm(root, { recursive: true, force: true }); });
function principal(actions: string[], posts?: string[]): Principal {
  return { ...owner, clientId: 'mcp', pluginId: 'mcp', policyVersion: 2, scopes: ['knowledge:read', ...actions.map(a => 'blog:' + a)], permissionPolicy: { version: 2, domains: { knowledge: { enabled: true, ownerId: owner.id, instanceId: 'test-library', actions: ['read'], resources: { mode: 'all' } }, blog: { enabled: true, ownerId: owner.id, instanceId: currentBlogInstanceId(db), actions, resources: posts ? { mode: 'selected', resources: posts.map(id => ({ kind: 'post', id })) } : { mode: 'all' } } } } };
}
it('grants draft edits independently, preserves public snapshots and returns durable action receipts', () => {
  const n = notes.createNote('00-Inbox', 'draft.md', '# Private');
  const editor = principal(['read', 'write']);
  const requestId = randomUUID();
  const draft = blog.createPost(editor, { sourceNoteId: n.id, requestId });
  expect(blog.createPost(editor, { sourceNoteId: n.id, requestId })).toEqual(draft);
  expect(blog.operationStatus(editor, { requestId })).toMatchObject({ kind: 'blog.create', status: 'succeeded', result: { id: draft.id } });
  expect(() => blog.createPost(editor, { sourceNoteId: n.id, metadata: { title: 'Changed retry' }, requestId })).toThrowError(expect.objectContaining({ code: 'IDEMPOTENCY_CONFLICT' }));
  expect(() => blog.publishNote(editor, { noteId: n.id, expectedModifiedAt: n.modifiedAt, expectedContentHash: blogHash(n.content), expectedPublicationVersion: draft.version, requestId: randomUUID() })).toThrow();
  const published = blog.publishNote(owner, { noteId: n.id, expectedModifiedAt: n.modifiedAt, expectedContentHash: blogHash(n.content), expectedPublicationVersion: draft.version, requestId: randomUUID() });
  blog.updateSettings(owner, { settings: { ...blog.settings(), enabled: true }, requestId: randomUUID() });
  const updated = blog.updatePost(principal(['read', 'write'], [draft.id]), draft.id, { metadata: { slug: draft.slug, title: 'Edited privately', summary: draft.summary, category: draft.category, tags: draft.tags, pinned: draft.pinned, cover: draft.cover }, expectedVersion: published.version, requestId: randomUUID() });
  expect(updated.hasUnpublishedChanges).toBe(true);
  expect(blog.publicPost(draft.slug).title).toBe('Private');
  expect(() => blog.updatePost(editor, draft.id, { metadata: { summary: 'Stale write' }, expectedVersion: published.version, requestId: randomUUID() })).toThrowError(expect.objectContaining({ code: 'VERSION_CONFLICT' }));
  expect(blog.postMetadata(editor, draft.id).summary).toBe(draft.summary);
});
it('isolates old grants, selected posts, site management and source access', () => {
  const n = notes.createNote('00-Inbox', 'draft.md', '# Private');
  const draft = blog.createPost(owner, { sourceNoteId: n.id, requestId: randomUUID() });
  for (const actions of [['read'], ['read', 'publish']]) expect(() => blog.createPost(principal(actions), { sourceNoteId: n.id, requestId: randomUUID() })).toThrow();
  expect(() => blog.createPost(principal(['read', 'write'], [draft.id]), { sourceNoteId: n.id, requestId: randomUUID() })).toThrow();
  expect(() => blog.updateSettings(principal(['read', 'manage'], [draft.id]), { settings: blog.settings(), requestId: randomUUID() })).toThrow();
  expect(() => blog.deletePost(principal(['read', 'write']), draft.id, { expectedVersion: draft.version, requestId: randomUUID() })).toThrow();
  expect(() => blog.updateSettings(principal(['read', 'manage']), { settings: { ...blog.settings(), enabled: true }, requestId: randomUUID() })).toThrow();
  expect(() => blog.postMetadata({ ...principal(['read']), allowedPrefixes: ['10-Projects'] }, draft.id)).toThrow();
  expect(() => blog.createPost({ ...owner, pluginId: 'mcp', scopes: [...owner.scopes, 'blog:read'] }, { sourceNoteId: n.id, requestId: randomUUID() })).toThrow();
});
it('filters bounded queries and version/resource metadata without returning source or HTML', () => {
  const a = notes.createNote('00-Inbox', 'a.md', '# A');
  const b = notes.createNote('00-Inbox', 'b.md', '# B');
  const first = blog.createPost(owner, { sourceNoteId: a.id, metadata: { tags: ['one'], category: 'news' }, requestId: randomUUID() });
  blog.createPost(owner, { sourceNoteId: b.id, requestId: randomUUID() });
  const p = principal(['read'], [first.id]);
  expect(blog.listPosts(p, { category: 'news', limit: 1 })).toMatchObject({ total: 1, posts: [{ id: first.id }], nextCursor: null });
  const metadata = blog.postMetadata(p, first.id);
  expect(metadata).not.toHaveProperty('sourceContent'); expect(metadata).not.toHaveProperty('previewHtml');
  expect(blog.listVersions(p, first.id, { limit: 5 }).versions).toEqual([]);
  expect(blog.listTaxonomy(p, { kind: 'tags', limit: 10, offset: 0 })).toMatchObject({ entries: [{ name: 'one', count: 1 }], total: 1 });
});
it('binds version reads to their article and preserves deletion receipts after the article disappears', () => {
  const a = notes.createNote('00-Inbox', 'a.md', '# A'), b = notes.createNote('00-Inbox', 'b.md', '# B');
  const publish = (n: typeof a) => blog.publishNote(owner, { noteId: n.id, expectedModifiedAt: n.modifiedAt, expectedContentHash: blogHash(n.content), expectedPublicationVersion: 0, requestId: randomUUID() });
  const first = publish(a), second = publish(b), reader = principal(['read']);
  expect(blog.listVersions(reader, first.id).versions).toMatchObject([{ id: first.publishedVersionId, current: true }]);
  expect(blog.managedVersion(reader, first.id, first.publishedVersionId!).coverResource).toBeNull();
  expect(() => blog.managedVersion(reader, first.id, second.publishedVersionId!)).toThrowError(expect.objectContaining({ code: 'NOT_FOUND' }));
  const manager = principal(['read', 'manage'], [first.id]), requestId = randomUUID(), input = { expectedVersion: first.version, requestId };
  expect(blog.deletePost(manager, first.id, input)).toEqual({ deleted: true });
  expect(blog.deletePost(manager, first.id, input)).toEqual({ deleted: true });
  expect(blog.operationStatus(manager, { requestId })).toMatchObject({ kind: 'blog.delete:' + first.id, status: 'succeeded', result: { deleted: true } });
  expect(notes.getNote(a.id).content).toBe('# A');
});
