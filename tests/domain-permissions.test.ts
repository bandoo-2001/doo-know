import { describe, expect, it } from 'vitest';
import { pluginHost } from '../apps/server/plugins/host.js';
import { oauthGrantStore } from '../apps/server/platform/oauth-grants.js';
import { platformPolicy } from '../packages/core/auth/grants.js';
import { tunnelPrincipal } from '../apps/server/platform/tunnel-identity.js';
import { requireScope } from '../packages/core/agent/auth.js';
import * as policies from '../packages/core/auth/permissions.js';
import type { PermissionPolicy } from '../shared/permissions.js';
import { recallFilter, validateFilters } from '../packages/core/search/filters.js';

const policy = (
  actions = ['read', 'write', 'organize'],
  resources: any = { mode: 'all' },
  instanceId = 'library',
) => ({
  version: 2 as const,
  domains: { knowledge: { enabled: true, ownerId: 'owner', instanceId, actions, resources } },
});
describe('domain permission boundaries', () => {
  it('does not infer blog or todo from knowledge organize', () => {
    const p = policies.normalizePermissionPolicy(policy());
    expect(Object.keys(p.domains)).toEqual(['knowledge']);
    expect(p.domains.knowledge.actions).toEqual(['read', 'write', 'organize']);
    expect(policies.policyScopes(p)).toEqual([
      'knowledge:read',
      'knowledge:write',
      'knowledge:organize',
    ]);
  });
  it('intersects all with selected without widening', () => {
    const selected = policy(['read'], {
      mode: 'selected',
      resources: [{ kind: 'directory', id: 'child' }],
    });
    expect(policies.intersectPermissionPolicies(policy(), selected)).toEqual(selected);
    expect(policies.intersectPermissionPolicies(selected, policy())).toEqual(selected);
    expect(
      policies.intersectPermissionPolicies(policy(), policy(['read'], { mode: 'all' }, 'other'))
        .domains,
    ).toEqual({});
  });
  it('intersects ancestor and descendant selections by identity', () => {
    const a = policy(['read'], {
      mode: 'selected',
      resources: [{ kind: 'directory', id: 'parent' }],
    });
    const b = policy(['read'], { mode: 'selected', resources: [{ kind: 'note', id: 'child' }] });
    const contains = (_domain: string, _grant: any, x: any, y: any) =>
      x.id === 'parent' && y.id === 'child';
    expect(policies.intersectPermissionPolicies(a, b, contains)).toEqual(b);
    expect(policies.intersectPermissionPolicies(a, b).domains.knowledge.resources).toEqual({
      mode: 'selected',
      resources: [],
    });
  });
  it('rejects unimplemented todo and unknown actions', () => {
    expect(() =>
      policies.normalizePermissionPolicy({
        version: 2,
        domains: { todo: { ...policy().domains.knowledge, actions: ['read'] } },
      }),
    ).toThrow();
    expect(() => policies.normalizePermissionPolicy(policy(['superuser']))).toThrow();
  });
  it('removes an all grant when its library instance is unavailable', () => {
    const db = new Database(':memory:');
    db.exec(
      "CREATE TABLE index_meta(key TEXT PRIMARY KEY,value TEXT); CREATE TABLE organization_library(library_id TEXT); INSERT INTO organization_library VALUES('new-library')",
    );
    const p = policies.projectPermissionPrincipal(
      db as any,
      { id: 'owner', clientId: 'client', scopes: ['knowledge:read'], allowedPrefixes: [] },
      policy(['read']),
    );
    expect(p.knowledgeAll).toBe(false);
    expect(p.scopes).toEqual([]);
    expect(p.permissionPolicy?.domains).toEqual({});
    db.close();
  });
  it('accepts a dynamic top-level category filter while rejecting hidden names', () => {
    expect(() => validateFilters({ category: 'Research-Lab' })).not.toThrow();
    expect(() => validateFilters({ category: '.hidden' })).toThrow();
    expect(() => validateFilters({ category: '../escape' })).toThrow();
  });
  it('all SQL ACL still honors the caller directory filter', () => {
    const p = {
      id: 'owner',
      clientId: 'client',
      scopes: ['knowledge:read'],
      allowedPrefixes: [],
      knowledgeAll: true,
    };
    const filter = recallFilter(p, { directory: '00-Inbox' }, 'path');
    const db = new Database(':memory:');
    db.exec(
      "CREATE TABLE paths(path TEXT); INSERT INTO paths VALUES('00-Inbox/a.md'),('10-Projects/b.md')",
    );
    expect(db.prepare(`SELECT path FROM paths WHERE ${filter.sql}`).all(...filter.values)).toEqual([
      { path: '00-Inbox/a.md' },
    ]);
    db.close();
  });
});
import Database from 'better-sqlite3';

it('legacy write retains archive but never organize only for persisted grants', async () => {
  const { pluginRuntimeFixture } = await import('./support/plugin-runtime.js');
  const f = await pluginRuntimeFixture();
  try {
    const grants = oauthGrantStore(f.db);
    const g = grants.approve(
      f.principal.id,
      'legacy',
      ['knowledge:read', 'knowledge:write'],
      ['00-Inbox'],
    );
    const p = platformPolicy(f.db, {
      ...f.principal,
      clientId: 'legacy',
      grantId: g.id,
      grantVersion: g.version,
      tokenIssuedAt: g.notBefore,
    });
    expect(() => requireScope(p!, 'knowledge:archive')).not.toThrow();
    expect(() => requireScope(p!, 'knowledge:organize')).toThrow();
    expect(() => requireScope(f.principal, 'knowledge:archive')).toThrow();
  } finally {
    await f.close();
  }
});
it('tunnel policy expansion preserves old grant', async () => {
  const { pluginRuntimeFixture } = await import('./support/plugin-runtime.js');
  const f = await pluginRuntimeFixture();
  pluginHost(f.config, f.db);
  try {
    const set = (readOnly: boolean) =>
      f.db
        .prepare("UPDATE platform_plugins SET config_json=? WHERE id='mcp'")
        .run(JSON.stringify({ readOnly, allowedPrefixes: ['00-Inbox'] }));
    f.db
      .prepare(
        "INSERT INTO platform_plugins(id,installed_version,installed,manifest_json,files_json,state,config_json) VALUES('mcp','1.1.0',1,'{}','{}','enabled','{}')",
      )
      .run();
    set(true);
    const info = { reference: 'test-only', createdAt: Date.now(), authGeneration: 0 };
    const first = tunnelPrincipal(f.db, f.principal.id, info);
    set(false);
    const second = tunnelPrincipal(f.db, f.principal.id, info);
    expect(second.grantVersion).toBe(first.grantVersion);
    expect(second.scopes).toEqual(['knowledge:read']);
  } finally {
    await f.close();
  }
});
it('explicit v2 grants revoke old token versions and do not infer archive', async () => {
  const { pluginRuntimeFixture } = await import('./support/plugin-runtime.js');
  const f = await pluginRuntimeFixture();
  try {
    const grants = oauthGrantStore(f.db),
      owner = f.principal.id;
    const old = grants.approve(
      owner,
      'upgrade',
      ['knowledge:read', 'knowledge:write'],
      ['00-Inbox'],
    );
    const p = policy(['read', 'write']);
    p.domains.knowledge.ownerId = owner;
    const next = grants.approveV2(owner, 'upgrade', p);
    expect(() =>
      grants.requireExact(old.reference, owner, 'upgrade', ['knowledge:read']),
    ).toThrow();
    expect(next.policyVersion).toBe(2);
    expect(next.scopes).not.toContain('knowledge:archive');
  } finally {
    await f.close();
  }
});
it('v2 blog publishing does not require source write', async () => {
  const { pluginRuntimeFixture } = await import('./support/plugin-runtime.js');
  const f = await pluginRuntimeFixture();
  try {
    const k = f.platform.get().knowledge;
    const note = k.core.create(
      f.principal,
      '00-Inbox',
      'publish.md',
      '# Publishable\n',
      'v2-publish-create',
    );
    const owner = f.principal.id;
    const p: any = {
      ...f.principal,
      scopes: ['knowledge:read', 'blog:publish'],
      policyVersion: 2,
      permissionPolicy: {
        version: 2,
        domains: {
          knowledge: {
            enabled: true,
            ownerId: owner,
            instanceId: 'library',
            actions: ['read'],
            resources: { mode: 'all' },
          },
          blog: {
            enabled: true,
            ownerId: owner,
            instanceId: 'site',
            actions: ['publish'],
            resources: { mode: 'all' },
          },
        },
      } satisfies PermissionPolicy,
    };
    const status = f.platform.get().blog.noteStatus(f.principal, note.id);
    const reply = await f.platform.get().blog.publishNote(p, {
      noteId: note.id,
      expectedModifiedAt: status.source.modifiedAt,
      expectedContentHash: status.source.contentHash,
      expectedPublicationVersion: 0,
      confirmPublic: true,
      requestId: 'source-readonly-publish',
    } as any);
    expect(reply.state).toBe('published');
    expect(() =>
      k.core.update(p, note.id, '# changed', status.source.modifiedAt, 'forbidden-source-change'),
    ).toThrow();
  } finally {
    await f.close();
  }
});

it('owner narrowing cannot widen resources and invalidates the old grant version', async () => {
  const { pluginRuntimeFixture } = await import('./support/plugin-runtime.js');
  const f = await pluginRuntimeFixture();
  pluginHost(f.config, f.db);
  try {
    const { narrowMcpClientGrant } =
      await import('../apps/server/platform/mcp-client-permissions.js');
    const { syncDirectoryCatalog, directoryByPath } =
      await import('../packages/core/organization/catalog.js');
    const owner = f.principal.id,
      { libraryId } = syncDirectoryCatalog(f.config, f.db);
    const ceiling = policy(['read', 'write']);
    ceiling.domains.knowledge.ownerId = owner;
    ceiling.domains.knowledge.instanceId = libraryId;
    f.db
      .prepare(
        "INSERT INTO platform_plugins(id,installed_version,installed,manifest_json,files_json,state,config_json) VALUES('mcp','1.2.0',1,'{}','{}','enabled',?)",
      )
      .run(JSON.stringify({ permissionPolicy: ceiling }));
    const store = oauthGrantStore(f.db),
      first = store.approveV2(owner, 'narrow-me', ceiling);
    const selected = policy(
      ['read'],
      {
        mode: 'selected',
        resources: [{ kind: 'directory', id: directoryByPath(f.db, '00-Inbox')!.id }],
      },
      libraryId,
    );
    selected.domains.knowledge.ownerId = owner;
    const next = narrowMcpClientGrant(f.db, owner, {
      clientId: 'narrow-me',
      permissionPolicy: selected,
      expectedGrantVersion: first.version,
    });
    expect(next.version).toBe(first.version + 1);
    expect(() => store.requireExact(first.reference, owner, 'narrow-me', [])).toThrow();
    expect(() =>
      narrowMcpClientGrant(f.db, owner, { clientId: 'narrow-me', permissionPolicy: ceiling }),
    ).toThrow();
    expect(() =>
      narrowMcpClientGrant(f.db, owner, {
        clientId: 'narrow-me',
        permissionPolicy: selected,
        expectedGrantVersion: first.version,
      }),
    ).toThrow();
  } finally {
    await f.close();
  }
});
it('Tunnel expansion requires an explicit owner authorization action', async () => {
  const { pluginRuntimeFixture } = await import('./support/plugin-runtime.js');
  const f = await pluginRuntimeFixture();
  pluginHost(f.config, f.db);
  try {
    const { authorizeMcpTunnel } =
      await import('../apps/server/platform/mcp-client-permissions.js');
    const { syncDirectoryCatalog } = await import('../packages/core/organization/catalog.js');
    const owner = f.principal.id,
      { libraryId } = syncDirectoryCatalog(f.config, f.db);
    const ceiling = policy(['read']);
    ceiling.domains.knowledge.ownerId = owner;
    ceiling.domains.knowledge.instanceId = libraryId;
    f.db
      .prepare(
        "INSERT INTO platform_plugins(id,installed_version,installed,manifest_json,files_json,state,config_json) VALUES('mcp','1.2.0',1,'{}','{}','enabled',?)",
      )
      .run(JSON.stringify({ permissionPolicy: ceiling }));
    const credential = {
      reference: 'explicit-owner',
      createdAt: Date.now() - 120000,
      authGeneration: 0,
    };
    const old = tunnelPrincipal(f.db, owner, credential);
    ceiling.domains.knowledge.actions.push('write', 'organize');
    f.db
      .prepare("UPDATE platform_plugins SET config_json=? WHERE id='mcp'")
      .run(JSON.stringify({ permissionPolicy: ceiling }));
    expect(tunnelPrincipal(f.db, owner, credential).scopes).toEqual(['knowledge:read']);
    const authorized = authorizeMcpTunnel(f.db, owner, { expectedGrantVersion: old.grantVersion });
    expect(authorized.version).toBe(old.grantVersion! + 1);
    expect(tunnelPrincipal(f.db, owner, credential).scopes).toEqual([
      'knowledge:read',
      'knowledge:write',
      'knowledge:organize',
    ]);
    expect(() => authorizeMcpTunnel(f.db, 'other-owner', {})).toThrow();
  } finally {
    await f.close();
  }
});
it('a v2 plugin ceiling can remove legacy archive and blog-read aliases', async () => {
  const { pluginRuntimeFixture } = await import('./support/plugin-runtime.js');
  const f = await pluginRuntimeFixture();
  pluginHost(f.config, f.db);
  try {
    const { syncDirectoryCatalog } = await import('../packages/core/organization/catalog.js');
    const { libraryId } = syncDirectoryCatalog(f.config, f.db),
      owner = f.principal.id;
    const ceiling = policy(['read', 'write'], { mode: 'all' }, libraryId);
    ceiling.domains.knowledge.ownerId = owner;
    f.db
      .prepare(
        "INSERT INTO platform_plugins(id,installed_version,installed,manifest_json,files_json,state,config_json) VALUES('mcp','1.2.0',1,'{}','{}','enabled',?)",
      )
      .run(JSON.stringify({ permissionPolicy: ceiling }));
    const g = oauthGrantStore(f.db).approve(
      owner,
      'legacy-ceiling',
      ['knowledge:read', 'knowledge:write'],
      ['00-Inbox'],
    );
    const effective = platformPolicy(f.db, {
      id: owner,
      clientId: g.clientId,
      scopes: g.scopes,
      allowedPrefixes: g.allowedPrefixes,
      grantId: g.id,
      grantVersion: g.version,
      tokenIssuedAt: g.notBefore,
      pluginId: 'mcp',
    })!;
    expect(effective.scopes).toContain('knowledge:write');
    expect(effective.scopes).not.toContain('knowledge:archive');
  } finally {
    await f.close();
  }
});
it('a selected blog reader sees only its article and taxonomy', async () => {
  const { pluginRuntimeFixture } = await import('./support/plugin-runtime.js');
  const f = await pluginRuntimeFixture();
  try {
    const k = f.platform.get().knowledge,
      blog = f.platform.get().blog,
      publisher = { ...f.principal, scopes: [...f.principal.scopes, 'blog:publish'] };
    const posts = ['Visible', 'Private'].map((title, i) => {
      const n = k.core.create(
        f.principal,
        '00-Inbox',
        `blog-select-${i}.md`,
        `# ${title}`,
        'blog-select-' + i,
      );
      const s = blog.noteStatus(publisher, n.id);
      return blog.publishNote(publisher, {
        noteId: n.id,
        expectedModifiedAt: s.source.modifiedAt,
        expectedContentHash: s.source.contentHash,
        expectedPublicationVersion: 0,
        requestId: 'blog-selected-publish-' + i,
        metadata: { title, tags: [title] },
      });
    });
    const p: any = {
      ...f.principal,
      policyVersion: 2,
      scopes: ['knowledge:read', 'blog:read'],
      permissionPolicy: {
        version: 2,
        domains: {
          knowledge: {
            enabled: true,
            ownerId: f.principal.id,
            instanceId: 'library',
            actions: ['read'],
            resources: { mode: 'all' },
          },
          blog: {
            enabled: true,
            ownerId: f.principal.id,
            instanceId: 'site',
            actions: ['read'],
            resources: { mode: 'selected', resources: [{ kind: 'post', id: posts[0].id }] },
          },
        },
      },
    };
    const view = blog.dashboard(p);
    expect(view.posts.map((x) => x.title)).toEqual(['Visible']);
    expect(view.total).toBe(1);
    expect(view.taxonomy.tags).toEqual([{ name: 'Visible', count: 1 }]);
    expect(() => blog.postDetail(p, posts[1].id)).toThrow();
  } finally {
    await f.close();
  }
});

it('selected directory authorization follows its identity across rename and old-path replacement', async () => {
  const { pluginRuntimeFixture } = await import('./support/plugin-runtime.js');
  const { rename, mkdir } = await import('node:fs/promises');
  const { join } = await import('node:path');
  const { syncDirectoryCatalog, directoryByPath } =
    await import('../packages/core/organization/catalog.js');
  const f = await pluginRuntimeFixture();
  try {
    const { libraryId } = syncDirectoryCatalog(f.config, f.db),
      owner = f.principal.id,
      id = directoryByPath(f.db, '00-Inbox')!.id;
    const selected = policy(
      ['read'],
      { mode: 'selected', resources: [{ kind: 'directory', id }] },
      libraryId,
    );
    selected.domains.knowledge.ownerId = owner;
    const g = oauthGrantStore(f.db).approveV2(owner, 'follow-directory', selected);
    const actor = {
      id: owner,
      clientId: g.clientId,
      scopes: g.scopes,
      allowedPrefixes: [],
      grantId: g.id,
      grantVersion: g.version,
      tokenIssuedAt: g.notBefore,
    };
    await rename(join(f.config.knowledgeRoot, '00-Inbox'), join(f.config.knowledgeRoot, 'Renamed'));
    await mkdir(join(f.config.knowledgeRoot, '00-Inbox'));
    syncDirectoryCatalog(f.config, f.db);
    const effective = platformPolicy(f.db, actor)!;
    expect(policies.canAccessPath(effective, 'Renamed/new.md')).toBe(true);
    expect(policies.canAccessPath(effective, '00-Inbox/new.md')).toBe(false);
  } finally {
    await f.close();
  }
});
it('a missing legacy selection never binds a later same-path directory', async () => {
  const { pluginRuntimeFixture } = await import('./support/plugin-runtime.js');
  const { mkdir } = await import('node:fs/promises');
  const { join } = await import('node:path');
  const { syncDirectoryCatalog } = await import('../packages/core/organization/catalog.js');
  const f = await pluginRuntimeFixture();
  try {
    syncDirectoryCatalog(f.config, f.db);
    const g = oauthGrantStore(f.db).approve(
      f.principal.id,
      'missing-prefix',
      ['knowledge:read'],
      ['00-Inbox/Ghost'],
    );
    const actor = {
      id: f.principal.id,
      clientId: g.clientId,
      scopes: g.scopes,
      allowedPrefixes: g.allowedPrefixes,
      grantId: g.id,
      grantVersion: g.version,
      tokenIssuedAt: g.notBefore,
    };
    expect(platformPolicy(f.db, actor)!.allowedPrefixes).toEqual([]);
    await mkdir(join(f.config.knowledgeRoot, '00-Inbox/Ghost'));
    syncDirectoryCatalog(f.config, f.db);
    expect(platformPolicy(f.db, actor)!.allowedPrefixes).toEqual([]);
  } finally {
    await f.close();
  }
});
