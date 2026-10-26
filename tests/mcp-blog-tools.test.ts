import { expect, it } from 'vitest';
import { createOperations } from '../plugins/mcp/server/operations.js';
import { hostClient } from '../plugins/mcp/server/service.js';
import { buildOpenApi } from '../plugins/mcp/server/openapi.js';
import type { BlogPost } from '../shared/blog-contracts.js';

const p = { id: 'fixture-owner', clientId: 'fixture-client', scopes: ['knowledge:read', 'knowledge:write', 'blog:publish'], allowedPrefixes: ['00-Inbox'] };
const post: BlogPost = { id: 'post-1', sourceNoteId: 'note-1', sourceTitle: 'Private title', sourceModifiedAt: '123', sourceHash: 'a'.repeat(64), version: 1, state: 'published', publishedVersionId: 'version-1', publishedAt: '2026-10-26T00:00:00.000Z', updatedAt: '2026-10-26T00:00:00.000Z', hasUnpublishedChanges: false, url: 'https://blog.example/blog/post', slug: 'post', title: 'Public title', summary: '', category: '', tags: [], pinned: false, cover: null };
function registry() {
  const services: any = { knowledge: {}, blog: {
    status: async () => ({ siteEnabled: true, post, publicationVersion: 1, source: { noteId: 'note-1', title: 'Private title', relativePath: '00-Inbox/note.md', modifiedAt: '123', contentHash: 'a'.repeat(64) } }),
    publish: async () => post,
    unpublish: async () => ({ ...post, state: 'withdrawn', version: 2, url: null }),
  } };
  return createOperations({ objectIdSecret: 'fixture-blog-secret-at-least-32-characters' }, hostClient(() => services, () => ({})));
}
it('exposes bounded blog status, publish and unpublish through tools and matching OpenAPI', async () => {
  const r = registry();
  expect(await r.execute('get_blog_status', p, { noteId: 'note-1' })).toMatchObject({ data: { publicationVersion: 1, source: { relativePath: '00-Inbox/note.md' } } });
  const published: any = await r.execute('publish_blog_post', p, { noteId: 'note-1', expectedModifiedAt: '123', expectedContentHash: 'a'.repeat(64), expectedPublicationVersion: 0, requestId: 'publish-1' });
  expect(published).toMatchObject({ data: { id: 'post-1', state: 'published', version: 1, sourceHash: 'a'.repeat(64), title: 'Public title', slug: 'post', url: 'https://blog.example/blog/post', omittedMetadata: ['summary', 'category', 'tags', 'pinned', 'cover'] } });
  for (const key of ['summary', 'category', 'tags', 'pinned', 'cover']) expect(published.data).not.toHaveProperty(key);
  expect(await r.execute('unpublish_blog_post', p, { noteId: 'note-1', expectedPublicationVersion: 1, requestId: 'withdraw-1' })).toMatchObject({ data: { state: 'withdrawn', version: 2 } });
  const api: any = buildOpenApi(r.operations);
  expect(api.paths['/api/v1/tools/publish_blog_post'].post['x-required-scope']).toBe('blog:publish');
  expect(JSON.stringify(api.paths['/api/v1/tools/publish_blog_post'].post.responses['200'])).not.toContain('sourceContent');
  const receipt = api.paths['/api/v1/tools/publish_blog_post'].post.responses['200'].content['application/json'].schema.properties.data;
  expect(receipt.additionalProperties).toBe(false);
  expect(receipt.properties.omittedMetadata).toBeDefined();
  for (const key of ['summary', 'category', 'tags', 'pinned', 'cover']) expect(receipt.properties[key]).toBeUndefined();
});
it.each(['knowledge:read', 'knowledge:write', 'blog:publish'])('requires %s independently for publication', async (scope) => {
  await expect(registry().execute('publish_blog_post', { ...p, scopes: p.scopes.filter((value) => value !== scope) }, { noteId: 'note-1', expectedModifiedAt: '123', expectedContentHash: 'a'.repeat(64), expectedPublicationVersion: 0, requestId: 'publish-denied' })).rejects.toMatchObject({ code: 'INSUFFICIENT_SCOPE' });
});
it('rejects unexpected publication body fields and source paths outside the actor prefixes', async () => {
  await expect(registry().execute('publish_blog_post', p, { noteId: 'note-1', expectedModifiedAt: '123', expectedContentHash: 'a'.repeat(64), expectedPublicationVersion: 0, requestId: 'publish-invalid', content: 'unsaved private text' })).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  await expect(registry().execute('get_blog_status', { ...p, allowedPrefixes: ['10-Projects'] }, { noteId: 'note-1' })).rejects.toMatchObject({ code: 'FORBIDDEN' });
});
