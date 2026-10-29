import { expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { pluginRuntimeFixture } from './support/plugin-runtime.js';
import { pluginHost } from '../apps/server/plugins/host.js';
import { pluginServices } from '../apps/server/plugins/services.js';
import { oauthGrantStore } from '../apps/server/platform/oauth-grants.js';
import { currentBlogInstanceId, policyScopes } from '../packages/core/auth/permissions.js';
import { createOperations } from '../plugins/mcp/server/operations.js';
import { hostClient } from '../plugins/mcp/server/service.js';
import type { PermissionPolicy } from '../shared/permissions.js';

async function fixture(actions: string[]) {
  const f = await pluginRuntimeFixture(); pluginHost(f.config, f.db);
  const library = f.platform.get().knowledge.organization.context(f.principal);
  const policy: PermissionPolicy = { version: 2, domains: {
    knowledge: { enabled: true, ownerId: f.principal.id, instanceId: library.libraryId, actions: ['read'], resources: { mode: 'all' } },
    blog: { enabled: true, ownerId: f.principal.id, instanceId: currentBlogInstanceId(f.db), actions: ['read', ...actions], resources: { mode: 'all' } },
  } };
  const ceiling: PermissionPolicy = { ...policy, domains: { ...policy.domains, blog: { ...policy.domains.blog, actions: ['read','write','manage','publish'] } } };
  const manifest = JSON.parse(await readFile(new URL('../plugins/mcp/manifest.json', import.meta.url), 'utf8'));
  f.db.prepare("INSERT INTO platform_plugins(id,installed_version,manifest_json,files_json,config_json,state) VALUES('mcp',?,?,'[]',?,'enabled')").run(manifest.version, JSON.stringify(manifest), JSON.stringify({ mode: 'oauth', permissionPolicy: ceiling }));
  const grant = oauthGrantStore(f.db).approveV2(f.principal.id, 'blog-full-grants', policy);
  const principal = { ...f.principal, ownerId: f.principal.id, clientId: grant.clientId, grantId: grant.id, grantVersion: grant.version, tokenIssuedAt: grant.notBefore, tokenExpiresAt: Math.floor(Date.now() / 1000) + 120, pluginId: 'mcp', scopes: policyScopes(policy), allowedPrefixes: [], permissionPolicy: policy, policyVersion: 2 as const };
  const services = () => pluginServices(f.platform, f.db, 'mcp', manifest.capabilities, { ownerId: principal.id, principal, channel: 'mcp' });
  const registry = createOperations({ objectIdSecret: 'blog-grants-integration-object-secret-thirty-two' }, hostClient(services, () => ({})));
  return { ...f, principal, policy, ceiling, registry, setCeiling: (value: PermissionPolicy) => f.db.prepare("UPDATE platform_plugins SET config_json=? WHERE id='mcp'").run(JSON.stringify({ mode: 'oauth', permissionPolicy: value })) };
}
it('executes explicit draft grants through the persisted OAuth policy, without note-write, manage or publish rights', async () => {
  const f = await fixture(['write']);
  try {
    const note = f.platform.get().notes.createNote('00-Inbox', 'grant-draft.md', '# Grant draft'), requestId = randomUUID();
    const created: any = await f.registry.execute('create_blog_draft', f.principal, { sourceNoteId: note.id, requestId });
    expect(created).toMatchObject({ data: { state: 'draft', sourceNoteId: note.id } });
    expect(await f.registry.execute('operation_status', f.principal, { requestId })).toMatchObject({ data: { status: 'succeeded', kind: 'blog.create', result: { id: created.data.id } } });
    for (const [tool, args] of [
      ['delete_blog_post', { postId: created.data.id, expectedVersion: created.data.version, requestId: randomUUID() }],
      ['update_blog_settings', { expectedVersion: 0, settings: { enabled: true }, requestId: randomUUID() }],
      ['publish_blog_post', { noteId: note.id, expectedModifiedAt: note.modifiedAt, expectedContentHash: created.data.sourceHash, expectedPublicationVersion: created.data.version, requestId: randomUUID() }],
    ] as const) await expect(f.registry.execute(tool, f.principal, args)).rejects.toMatchObject({ code: 'INSUFFICIENT_SCOPE' });
    f.setCeiling({ ...f.ceiling, domains: { ...f.ceiling.domains, blog: { ...f.ceiling.domains.blog, actions: ['read'] } } });
    await expect(f.registry.execute('update_blog_draft', f.principal, { postId: created.data.id, metadata: { title: 'Revoked edit' }, expectedVersion: created.data.version, requestId: randomUUID() })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(f.platform.get().notes.getNote(note.id).content).toBe('# Grant draft');
  } finally { await f.close(); }
});
it('does not expand a persisted read/publish grant when the plugin ceiling gains draft or management actions', async () => {
  const f = await fixture(['publish']);
  try {
    const note = f.platform.get().notes.createNote('00-Inbox', 'old-grant.md', '# Old grant');
    expect(oauthGrantStore(f.db).list(f.principal.id).find(grant => grant.clientId === f.principal.clientId)?.scopes).toEqual(['knowledge:read','blog:read','blog:publish']);
    await expect(f.registry.execute('create_blog_draft', f.principal, { sourceNoteId: note.id, requestId: randomUUID() })).rejects.toMatchObject({ code: 'INSUFFICIENT_SCOPE' });
    await expect(f.registry.execute('update_blog_settings', f.principal, { expectedVersion: 0, settings: {}, requestId: randomUUID() })).rejects.toMatchObject({ code: 'INSUFFICIENT_SCOPE' });
    const status: any = await f.registry.execute('get_blog_status', f.principal, { noteId: note.id });
    expect(await f.registry.execute('publish_blog_post', f.principal, { noteId: note.id, expectedModifiedAt: note.modifiedAt, expectedContentHash: status.data.source.contentHash, expectedPublicationVersion: 0, requestId: randomUUID() })).toMatchObject({ data: { state: 'published' } });
  } finally { await f.close(); }
});

it('exposes bounded generic upload/download progress and completed receipts while enforcing current management rights', async () => {
  const f = await fixture(['manage']);
  try {
    const text = '站点关于文本。'.repeat(1500), bytes = Buffer.from(text), settings = f.platform.get().blog.settings();
    const sha256 = (await import('../packages/core/blog/resources.js')).blogHash(bytes);
    const upload: any = await f.registry.execute('begin_blog_upload', f.principal, { kind: 'about', expectedVersion: settings.version, byteLength: bytes.length, sha256, mime: 'text/plain', requestId: randomUUID() });
    for (let offset = 0; offset < bytes.length; offset += 12000) {
      const response: any = await f.registry.execute('append_mcp_upload', f.principal, { transferId: upload.data.transferId, offset, base64: bytes.subarray(offset, offset + 12000).toString('base64') });
      expect(response.data.receivedBytes).toBe(Math.min(offset + 12000, bytes.length));
    }
    const requestId = randomUUID();
    const updated: any = await f.registry.execute('update_blog_settings', f.principal, { expectedVersion: settings.version, settings: {}, aboutTransferId: upload.data.transferId, requestId });
    expect(updated.data.aboutBytes).toBe(bytes.length);
    expect(await f.registry.execute('operation_status', f.principal, { requestId })).toMatchObject({ data: { kind: 'blog.settings', status: 'succeeded', result: { version: updated.data.version, aboutBytes: bytes.length, aboutHash: sha256 } } });
    expect(await f.registry.execute('get_mcp_transfer', f.principal, { transferId: upload.data.transferId })).toMatchObject({ data: { state: 'completed', result: { version: updated.data.version, aboutBytes: bytes.length } } });
    const download: any = await f.registry.execute('download_blog_content', f.principal, { kind: 'about' });
    let offset = 0, complete = '';
    // Decode only after joining bytes: transport pages may end inside a UTF-8 character.
    const chunks: Buffer[] = [];
    do { const page: any = await f.registry.execute('read_mcp_transfer', f.principal, { transferId: download.data.transferId, offset }); chunks.push(Buffer.from(page.data.base64, 'base64')); offset = page.data.done ? 0 : page.data.nextOffset; } while (offset);
    complete = Buffer.concat(chunks).toString('utf8'); expect(complete).toBe(text);
    f.setCeiling({ ...f.ceiling, domains: { ...f.ceiling.domains, blog: { ...f.ceiling.domains.blog, actions: ['read'] } } });
    await expect(f.registry.execute('get_mcp_transfer', f.principal, { transferId: upload.data.transferId })).rejects.toMatchObject({ code: 'FORBIDDEN' });
  } finally { await f.close(); }
});
