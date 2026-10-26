import { expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { pluginRuntimeFixture } from './support/plugin-runtime.js';
import { pluginHost } from '../apps/server/plugins/host.js';
import { pluginServices } from '../apps/server/plugins/services.js';
import { oauthGrantStore } from '../apps/server/platform/oauth-grants.js';
import { createOperations } from '../plugins/mcp/server/operations.js';
import { hostClient } from '../plugins/mcp/server/service.js';
import { budgets, resultSize } from '../plugins/mcp/server/budgets.js';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

async function fixture() {
  const f = await pluginRuntimeFixture(); pluginHost(f.config, f.db);
  const capabilities = ['knowledge:read', 'knowledge:write', 'blog:publish'];
  f.db.prepare("INSERT INTO platform_plugins(id,installed_version,installed,manifest_json,files_json,state,config_json) VALUES('mcp','1.1.0',1,'{}','{}','enabled',?)").run(JSON.stringify({ readOnly: false, allowPublish: true, allowedPrefixes: ['00-Inbox'] }));
  const created = await f.services.knowledge.create({ directory: '00-Inbox', fileName: 'public.md', content: '# Public snapshot', requestId: randomUUID() });
  const grant = oauthGrantStore(f.db).approve(f.principal.id, 'blog-integration', capabilities, ['00-Inbox']);
  const principal = { ...f.principal, scopes: capabilities, clientId: grant.clientId, grantId: grant.id, grantVersion: grant.version, tokenIssuedAt: grant.notBefore, tokenExpiresAt: Math.floor(Date.now() / 1000) + 60, pluginId: 'mcp' };
  const services = pluginServices(f.platform, f.db, 'mcp', capabilities, { ownerId: principal.id, principal, channel: 'mcp' });
  const registry = createOperations({ objectIdSecret: 'fixture-mcp-blog-reference-secret-at-least-32-characters' }, hostClient(() => services, () => ({})));
  const input = { noteId: created.id, expectedModifiedAt: created.modifiedAt, expectedContentHash: created.contentHash, expectedPublicationVersion: 0, requestId: randomUUID(), metadata: { slug: 'mcp-public-snapshot' } };
  return { ...f, principal, services, registry, created, input };
}

it('publishes a private snapshot only explicitly, replays fixed receipts, recovers operation status and withdraws by publication version', async () => {
  const f = await fixture();
  try {
    expect(await f.registry.execute('get_blog_status', f.principal, { noteId: f.created.id })).toMatchObject({ data: { siteEnabled: false, post: null, publicationVersion: 0 } });
    const published: any = await f.registry.execute('publish_blog_post', f.principal, f.input);
    expect(published).toMatchObject({ data: { state: 'published', version: 1, url: null, sourceHash: f.created.contentHash } });
    expect(await f.registry.execute('operation_status', f.principal, { requestId: f.input.requestId })).toMatchObject({ data: { kind: 'blog.publish', status: 'succeeded', result: published.data } });
    await f.services.knowledge.update({ noteId: f.created.id, content: '# Private new version', expectedModifiedAt: f.created.modifiedAt, requestId: randomUUID() });
    expect(await f.registry.execute('publish_blog_post', f.principal, f.input)).toEqual(published);
    expect(await f.registry.execute('get_blog_status', f.principal, { noteId: f.created.id })).toMatchObject({ data: { post: { hasUnpublishedChanges: true } } });
    await expect(f.registry.execute('publish_blog_post', f.principal, { ...f.input, expectedPublicationVersion: 1, requestId: randomUUID() })).rejects.toMatchObject({ code: 'VERSION_CONFLICT' });
    const withdrawn: any = await f.registry.execute('unpublish_blog_post', f.principal, { noteId: f.created.id, expectedPublicationVersion: 1, requestId: 'withdraw-fixture-1' });
    expect(withdrawn).toMatchObject({ data: { state: 'withdrawn', version: 2 } });
    expect(await f.registry.execute('unpublish_blog_post', f.principal, { noteId: f.created.id, expectedPublicationVersion: 1, requestId: 'withdraw-fixture-1' })).toEqual(withdrawn);
    f.db.prepare("UPDATE platform_plugins SET config_json=? WHERE id='mcp'").run(JSON.stringify({ readOnly: false, allowPublish: true, allowedPrefixes: ['10-Projects'] }));
    await expect(f.registry.execute('operation_status', f.principal, { requestId: f.input.requestId })).rejects.toMatchObject({ code: 'FORBIDDEN' });
  } finally { await f.close(); }
});

it.each(['revocation', 'prefix', 'readOnly', 'allowPublish', 'expiry', 'deadline'])('rechecks %s immediately before committing public disclosure', async (change) => {
  const f = await fixture();
  try {
    const blog = f.platform.get().blog, publish = blog.publishNote;
    blog.publishNote = (principal, input, revalidate) => {
      if (change === 'revocation') oauthGrantStore(f.db).revoke(f.principal.id, f.principal.clientId);
      else if (change === 'expiry') f.principal.tokenExpiresAt = Math.floor(Date.now() / 1000) - 1;
      else if (change === 'deadline') vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 30000);
      else f.db.prepare("UPDATE platform_plugins SET config_json=? WHERE id='mcp'").run(JSON.stringify({ readOnly: change === 'readOnly', allowPublish: change !== 'allowPublish', allowedPrefixes: change === 'prefix' ? ['10-Projects'] : ['00-Inbox'] }));
      return publish(principal, input, revalidate);
    };
    await expect(f.registry.execute('publish_blog_post', f.principal, f.input)).rejects.toMatchObject({ code: change === 'expiry' ? 'UNAUTHORIZED' : change === 'deadline' ? 'CALL_CANCELLED' : 'FORBIDDEN' });
    expect((f.db.prepare('SELECT count(*) AS count FROM blog_posts').get() as any).count).toBe(0);
    expect((f.db.prepare('SELECT count(*) AS count FROM blog_versions').get() as any).count).toBe(0);
  } finally { vi.restoreAllMocks(); await f.close(); }
});

it('accepts bounded Unicode titles and returns source display titles measured in codepoints', async () => {
  const f = await fixture();
  try {
    const title = '🌈'.repeat(200), sourceTitle = '📝'.repeat(300);
    await f.services.knowledge.update({ noteId: f.created.id, content: '# ' + sourceTitle, expectedModifiedAt: f.created.modifiedAt, requestId: randomUUID() });
    expect(await f.registry.execute('get_note_info', f.principal, { noteId: f.created.id })).toMatchObject({ data: { title: '📝'.repeat(256) } });
    const status: any = await f.registry.execute('get_blog_status', f.principal, { noteId: f.created.id });
    expect(status.data.source.title).toBe('📝'.repeat(256));
    const published: any = await f.registry.execute('publish_blog_post', f.principal, { ...f.input, expectedModifiedAt: status.data.source.modifiedAt, expectedContentHash: status.data.source.contentHash, metadata: { slug: 'emoji-title', title } });
    expect(published.data.title).toBe(title); expect(published.data.sourceTitle).toBe('📝'.repeat(256));
  } finally { await f.close(); }
});

it.each([
  { externalWebOrigin: '', baseUrl: 'https://blog.example', expectedUrl: 'https://blog.example/blog/mcp-public-snapshot' },
  { externalWebOrigin: 'https://notes.example', baseUrl: 'https://blog.example', expectedUrl: 'https://blog.example/blog/mcp-public-snapshot' },
  { externalWebOrigin: '', baseUrl: '', expectedUrl: '/blog/mcp-public-snapshot' },
])('preserves enabled-blog URL $expectedUrl with externalWebOrigin=$externalWebOrigin', async ({ externalWebOrigin, baseUrl, expectedUrl }) => {
  const f = await fixture();
  try {
    const blog = f.platform.get().blog;
    blog.updateSettings(f.principal, { settings: { ...blog.settings(f.principal), enabled: true, baseUrl }, requestId: randomUUID() });
    const registry = createOperations({ objectIdSecret: 'fixture-mcp-blog-reference-secret-at-least-32-characters' }, hostClient(() => f.services, () => ({ externalWebOrigin })));
    const published: any = await registry.execute('publish_blog_post', f.principal, f.input);
    expect(published.data.url).toBe(expectedUrl);
    expect(await registry.execute('get_blog_status', f.principal, { noteId: f.created.id })).toMatchObject({ data: { siteEnabled: true, post: { url: published.data.url } } });
    expect(await registry.execute('operation_status', f.principal, { requestId: f.input.requestId })).toMatchObject({ data: { result: { url: published.data.url } } });
  } finally { await f.close(); }
});

it.each(['mcp', 'web'])('recovers compact publication receipts for schema-valid oversized metadata created through %s', async (createdThrough) => {
  const f = await fixture();
  try {
    await writeFile(join(f.config.knowledgeRoot, '00-Inbox/figure.svg'), '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect width="10" height="10" fill="red"/></svg>');
    const metadata = {
      ...f.input.metadata,
      title: '😀'.repeat(256), summary: '中'.repeat(2000),
      tags: Array.from({ length: 30 }, (_, index) => String(index) + '中'.repeat(78)),
      cover: 'figure.svg?' + '中'.repeat(8000),
    };
    const input = { ...f.input, metadata }, blog = f.platform.get().blog;
    blog.updateSettings(f.principal, { settings: { ...blog.settings(f.principal), enabled: true, baseUrl: 'https://blog.example' }, requestId: randomUUID() });
    let published: any, firstError: unknown;
    try {
      if (createdThrough === 'mcp') published = await f.registry.execute('publish_blog_post', f.principal, input);
      else {
        await f.services.blog!.publish(input);
        const status: any = await f.registry.execute('get_blog_status', f.principal, { noteId: f.created.id });
        published = { data: status.data.post };
      }
    } catch (error) { firstError = error; }
    expect(f.db.prepare('SELECT state,version FROM blog_posts WHERE source_note_id=?').get(f.created.id)).toEqual({ state: 'published', version: 1 });
    expect(firstError).toBeUndefined();
    expect(published.data).toMatchObject({ state: 'published', version: 1, title: metadata.title, sourceHash: f.created.contentHash, sourceModifiedAt: f.created.modifiedAt, url: 'https://blog.example/blog/mcp-public-snapshot', omittedMetadata: ['summary', 'category', 'tags', 'pinned', 'cover'] });
    for (const key of ['summary', 'category', 'tags', 'pinned', 'cover']) expect(published.data).not.toHaveProperty(key);
    const full = await f.services.blog!.status({ noteId: f.created.id });
    expect(full.post).toMatchObject({ summary: metadata.summary, tags: metadata.tags, cover: metadata.cover });
    expect(resultSize({ data: full.post })).toBeGreaterThan(budgets.response);
    const wireSizes: number[] = [];
    const bounded = (reply: Record<string, unknown>) => {
      const size = resultSize(reply, '\\'.repeat(128)); wireSizes.push(size); expect(size).toBeLessThan(budgets.response); return reply;
    };
    bounded(published);
    const poll: any = bounded(await f.registry.execute('operation_status', f.principal, { requestId: input.requestId }));
    expect(poll.data).toMatchObject({ status: 'succeeded', result: published.data });
    const status: any = bounded(await f.registry.execute('get_blog_status', f.principal, { noteId: f.created.id }));
    expect(status.data.post).toEqual(published.data);
    expect(bounded(await f.registry.execute('publish_blog_post', f.principal, input))).toEqual(published);
    const withdraw = { noteId: f.created.id, expectedPublicationVersion: 1, requestId: randomUUID() };
    const withdrawn: any = bounded(await f.registry.execute('unpublish_blog_post', f.principal, withdraw));
    expect(withdrawn.data).toMatchObject({ state: 'withdrawn', version: 2, omittedMetadata: ['summary', 'category', 'tags', 'pinned', 'cover'] });
    expect(bounded(await f.registry.execute('unpublish_blog_post', f.principal, withdraw))).toEqual(withdrawn);
    const withdrawalPoll: any = bounded(await f.registry.execute('operation_status', f.principal, { requestId: withdraw.requestId }));
    expect(withdrawalPoll.data.result).toEqual(withdrawn.data);
    expect(wireSizes).toHaveLength(7);
  } finally { await f.close(); }
});
