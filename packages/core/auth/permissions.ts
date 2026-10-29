import { randomUUID } from 'node:crypto';
import type {
  DomainGrant,
  PermissionPolicy,
  ResourceRef,
  ResourceSet,
} from '../../../shared/permissions.js';
import { permissionDomains } from '../../../shared/permissions.js';
import type { Principal } from '../../../shared/knowledge-contracts.js';
import type { AppDatabase } from '../db.js';
import { readKnowledgeDataFile } from '../knowledge-data.js';
import { validName } from '../files.js';
import { fail } from '../knowledge/errors.js';
export { permissionDomains } from '../../../shared/permissions.js';
export type ResourceContains = (
  domain: string,
  grant: DomainGrant,
  ancestor: ResourceRef,
  descendant: ResourceRef,
) => boolean;
const object = (v: unknown): v is Record<string, any> =>
  !!v && typeof v === 'object' && !Array.isArray(v);
const identifier = (v: unknown): v is string =>
  typeof v === 'string' && v.length > 0 && v.length <= 512;
const equal = (a: ResourceRef, b: ResourceRef) => a.kind === b.kind && a.id === b.id;
export function normalizePermissionPolicy(input: unknown): PermissionPolicy {
  if (!object(input) || input.version !== 2 || !object(input.domains))
    fail(400, 'INVALID_PERMISSION_POLICY');
  const domains: Record<string, DomainGrant> = {};
  for (const [id, value] of Object.entries(input.domains)) {
    const definition = permissionDomains.find((d) => d.id === id && d.implemented);
    if (
      !definition ||
      !object(value) ||
      typeof value.enabled !== 'boolean' ||
      !identifier(value.ownerId) ||
      !identifier(value.instanceId) ||
      !Array.isArray(value.actions) ||
      value.actions.some(
        (a: unknown) =>
          typeof a !== 'string' || !definition.actions.some((x) => x.id === a && x.implemented),
      ) ||
      !object(value.resources)
    )
      fail(400, 'INVALID_PERMISSION_POLICY');
    let resources: ResourceSet;
    if (value.resources.mode === 'all') resources = { mode: 'all' };
    else if (
      value.resources.mode === 'selected' &&
      Array.isArray(value.resources.resources) &&
      value.resources.resources.length <= 256
    ) {
      const selected: ResourceRef[] = [];
      for (const ref of value.resources.resources) {
        if (!object(ref) || !definition.resourceKinds.includes(ref.kind) || !identifier(ref.id))
          fail(400, 'INVALID_PERMISSION_POLICY');
        if (!selected.some((x) => equal(x, { kind: ref.kind, id: ref.id })))
          selected.push({ kind: ref.kind, id: ref.id });
      }
      resources = { mode: 'selected', resources: selected };
    } else return fail(400, 'INVALID_PERMISSION_POLICY');
    domains[id] = {
      enabled: value.enabled,
      ownerId: value.ownerId,
      instanceId: value.instanceId,
      actions: [...new Set<string>(value.actions)],
      resources,
    };
  }
  return { version: 2, domains };
}
export function policyScopes(policy: PermissionPolicy): string[] {
  return Object.entries(policy.domains).flatMap(([id, grant]) =>
    grant.enabled ? grant.actions.map((action) => `${id}:${action}`) : [],
  );
}
export function intersectPermissionPolicies(
  a: PermissionPolicy,
  b: PermissionPolicy,
  contains?: ResourceContains,
): PermissionPolicy {
  a = normalizePermissionPolicy(a);
  b = normalizePermissionPolicy(b);
  const domains: Record<string, DomainGrant> = {};
  for (const [id, left] of Object.entries(a.domains)) {
    const right = b.domains[id];
    if (!right || left.ownerId !== right.ownerId || left.instanceId !== right.instanceId) continue;
    let resources: ResourceSet;
    if (left.resources.mode === 'all') resources = right.resources;
    else if (right.resources.mode === 'all') resources = left.resources;
    else {
      const selected: ResourceRef[] = [];
      for (const x of left.resources.resources)
        for (const y of right.resources.resources) {
          const match =
            equal(x, y) || contains?.(id, left, x, y)
              ? y
              : contains?.(id, left, y, x)
                ? x
                : undefined;
          if (match && !selected.some((z) => equal(z, match))) selected.push(match);
        }
      resources = { mode: 'selected', resources: selected };
    }
    domains[id] = {
      ...left,
      enabled: left.enabled && right.enabled,
      actions: left.actions.filter((x) => right.actions.includes(x)),
      resources,
    };
  }
  return { version: 2, domains };
}
export function effectivePermissionPolicy(...policies: PermissionPolicy[]): PermissionPolicy {
  return policies.length
    ? policies
        .slice(1)
        .reduce((a, b) => intersectPermissionPolicies(a, b), normalizePermissionPolicy(policies[0]))
    : { version: 2, domains: {} };
}
export function hasTable(db: AppDatabase, name: string) {
  return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name);
}
/** Table names are host-owned; missing identity metadata always fails closed for v2. */
export function currentLibraryIdentity(
  db: AppDatabase,
): { libraryId: string; bindingVersion?: number; structureRevision?: string } | undefined {
  if (!hasTable(db, 'organization_library')) return;
  const row = db.prepare('SELECT * FROM organization_library LIMIT 1').get() as any;
  if (!row) return;
  return {
    libraryId: row.library_id ?? row.libraryId,
    bindingVersion: row.binding_version ?? row.bindingVersion,
    structureRevision: String(row.structure_revision ?? row.structureRevision ?? ''),
  };
}
export function currentBlogInstanceId(db: AppDatabase): string {
  const row = db.prepare("SELECT value FROM index_meta WHERE key='blog_instance_id'").get() as any;
  if (row?.value) return row.value;
  const id = randomUUID();
  db.prepare("INSERT OR IGNORE INTO index_meta(key,value) VALUES('blog_instance_id',?)").run(id);
  return (db.prepare("SELECT value FROM index_meta WHERE key='blog_instance_id'").get() as any)
    .value;
}
/** Host identity for the portable task service, independent of knowledge permissions. */
export function currentToDooInstanceId(db: AppDatabase): string {
  // Read identity metadata only; a corrupt optional task store must not initialize here.
  if (hasTable(db, 'todo_instance_state')) {
    const root = (db.prepare('SELECT root FROM todo_instance_state WHERE id=1').get() as any)?.root;
    if (root)
      try {
        const bytes = readKnowledgeDataFile(root, 'apps/to-doo/manifest.json');
        const manifest = bytes && JSON.parse(bytes.toString('utf8'));
        if (manifest?.format === 1 && manifest.appId === 'to-doo' && identifier(manifest.datasetId))
          return manifest.datasetId;
      } catch {
        /* Task endpoints report unreadable optional data independently. */
      }
  }
  const row = db
    .prepare("SELECT value FROM index_meta WHERE key='to_doo_instance_id'")
    .get() as any;
  if (row?.value) return row.value;
  db.prepare("INSERT OR IGNORE INTO index_meta(key,value) VALUES('to_doo_instance_id',?)").run(
    randomUUID(),
  );
  return (db.prepare("SELECT value FROM index_meta WHERE key='to_doo_instance_id'").get() as any)
    .value;
}
function resourcePath(db: AppDatabase, ref: ResourceRef, libraryId?: string): string | undefined {
  if (ref.kind === 'directory' && hasTable(db, 'organization_directories')) {
    const row = db
      .prepare('SELECT path FROM organization_directories WHERE id=? AND active=1 AND library_id=?')
      .get(ref.id, libraryId || currentLibraryIdentity(db)?.libraryId || '') as any;
    return row?.path;
  }
  if (ref.kind === 'note' && hasTable(db, 'notes')) {
    const row = db.prepare('SELECT path FROM notes WHERE id=? AND active=1').get(ref.id) as any;
    return row?.path;
  }
}
export function resourceContains(db: AppDatabase): ResourceContains {
  return (domain, grant, a, b) => {
    if (equal(a, b)) return true;
    if (domain === 'knowledge') {
      if (currentLibraryIdentity(db)?.libraryId !== grant.instanceId || a.kind !== 'directory')
        return false;
      const x = resourcePath(db, a, grant.instanceId),
        y = resourcePath(db, b, grant.instanceId);
      return x !== undefined && y !== undefined && underPrefix(y, x);
    }
    return domain === 'blog' && a.kind === 'site' && a.id === grant.instanceId;
  };
}
export const underPrefix = (path: string, prefix: string) =>
  path === prefix || path.startsWith(prefix + '/');
/** Business syntax only. Filesystem evidence is additionally checked by every read/mutation. */
export function canAccessPath(p: Principal, path: string): boolean {
  if (typeof path !== 'string' || path === '_data' || path.startsWith('_data/')) return false;
  if (path === '') return p.knowledgeAll === true;
  if (
    path.startsWith('/') ||
    path.includes('\\') ||
    path.split('/').some((part) => !validName(part))
  )
    return false;
  if (p.knowledgeAll === true) return true;
  if (p.knowledgeResourcePaths)
    return p.knowledgeResourcePaths.some((ref) =>
      ref.kind === 'note' ? path === ref.path : underPrefix(path, ref.path),
    );
  return p.allowedPrefixes.some((prefix) => !!prefix && underPrefix(path, prefix));
}
export function projectPermissionPrincipal(
  db: AppDatabase,
  p: Principal,
  policy: PermissionPolicy,
): Principal {
  policy = normalizePermissionPolicy(policy);
  for (const [domain, grant] of Object.entries(policy.domains))
    grant.actions = grant.actions.filter((action) => p.scopes.includes(`${domain}:${action}`));
  const blog = policy.domains.blog;
  if (
    blog &&
    (blog.instanceId !== currentBlogInstanceId(db) || blog.ownerId !== (p.ownerId || p.id))
  )
    delete policy.domains.blog;
  const tasks = policy.domains['to-doo'];
  if (
    tasks &&
    (tasks.instanceId !== currentToDooInstanceId(db) || tasks.ownerId !== (p.ownerId || p.id))
  )
    delete policy.domains['to-doo'];
  const grant = policy.domains.knowledge;
  const library = currentLibraryIdentity(db);
  const available =
    !!grant?.enabled &&
    grant.ownerId === (p.ownerId || p.id) &&
    library?.libraryId === grant.instanceId;
  if (grant && (grant.ownerId !== (p.ownerId || p.id) || library?.libraryId !== grant.instanceId))
    delete policy.domains.knowledge;
  const refs =
    available && grant.resources.mode === 'selected'
      ? grant.resources.resources.flatMap((ref) => {
          const path = resourcePath(db, ref, grant.instanceId);
          return path === undefined ? [] : [{ ...ref, path }];
        })
      : [];
  const prefixes = refs.map((ref) => ref.path);
  return {
    ...p,
    permissionPolicy: policy,
    permissionCeiling: undefined,
    policyVersion: 2,
    scopes: policyScopes(policy),
    knowledgeResourcePaths: refs,
    knowledgeAll: available && grant.resources.mode === 'all',
    allowedPrefixes: [...new Set(prefixes)],
  };
}
export function authorizeDomainResource(
  p: Principal,
  domain: string,
  action: string,
  resourceId?: string,
): void {
  const policy = p.policyVersion === 2 ? p.permissionPolicy : p.permissionCeiling;
  if (!policy && p.policyVersion !== 2) return;
  const grant = policy?.domains[domain];
  if (!grant?.enabled || grant.ownerId !== (p.ownerId || p.id) || !grant.actions.includes(action))
    fail(403, 'FORBIDDEN');
  if (
    grant.resources.mode === 'selected' &&
    (!resourceId ||
      !grant.resources.resources.some(
        (ref) =>
          (ref.kind === 'post' && ref.id === resourceId) ||
          (domain === 'blog' && ref.kind === 'site' && ref.id === grant.instanceId),
      ))
  )
    fail(403, 'FORBIDDEN');
}

/** Safe caller-only display for old connections; it does not change enforcement. */
export function permissionPolicyForPrincipal(db: AppDatabase, p: Principal): PermissionPolicy {
  if (p.permissionPolicy && p.policyVersion === 2)
    return normalizePermissionPolicy(p.permissionPolicy);
  const ownerId = p.ownerId || p.id,
    library = currentLibraryIdentity(db),
    domains: Record<string, DomainGrant> = {};
  const actions = p.scopes
    .filter((scope) => scope.startsWith('knowledge:'))
    .map((scope) => scope.slice('knowledge:'.length))
    .filter((action) => ['read', 'write', 'archive', 'index'].includes(action));
  const resources: ResourceRef[] = [];
  if (library)
    for (const path of p.allowedPrefixes) {
      const dir = db
        .prepare(
          'SELECT id FROM organization_directories WHERE library_id=? AND path=? AND active=1',
        )
        .get(library.libraryId, path) as any;
      const note =
        !dir && (db.prepare('SELECT id FROM notes WHERE path=? AND active=1').get(path) as any);
      if (dir || note) resources.push({ kind: dir ? 'directory' : 'note', id: dir?.id || note.id });
    }
  if (actions.length)
    domains.knowledge = {
      enabled: true,
      ownerId,
      instanceId: library?.libraryId || 'legacy-unbound',
      actions,
      resources: p.knowledgeAll ? { mode: 'all' } : { mode: 'selected', resources },
    };
  const blogActions = p.scopes
    .filter((scope) => scope.startsWith('blog:'))
    .map((scope) => scope.slice(5))
    .filter((a) => ['read', 'publish'].includes(a));
  if (blogActions.length) {
    const selected: ResourceRef[] = hasTable(db, 'blog_posts')
      ? (
          db
            .prepare('SELECT b.id,n.path FROM blog_posts b JOIN notes n ON n.id=b.source_note_id')
            .all() as any[]
        )
          .filter((row) => canAccessPath(p, row.path))
          .map((row) => ({ kind: 'post', id: row.id }))
      : [];
    domains.blog = {
      enabled: true,
      ownerId,
      instanceId: currentBlogInstanceId(db),
      actions: blogActions,
      resources: p.knowledgeAll ? { mode: 'all' } : { mode: 'selected', resources: selected },
    };
  }
  const taskActions = p.scopes
    .filter((scope) => scope.startsWith('to-doo:'))
    .map((scope) => scope.slice(7))
    .filter((action) => ['read', 'write'].includes(action));
  if (taskActions.length) {
    let listIds: string[] = [];
    if (p.pluginId === 'mcp' && hasTable(db, 'platform_plugins')) {
      const plugin = db
        .prepare("SELECT config_json FROM platform_plugins WHERE id='mcp'")
        .get() as any;
      const config = plugin ? JSON.parse(plugin.config_json) : {};
      if (Array.isArray(config.toDooListIds)) listIds = config.toDooListIds;
    }
    domains['to-doo'] = {
      enabled: true,
      ownerId,
      instanceId: currentToDooInstanceId(db),
      actions: taskActions,
      resources: listIds.length
        ? { mode: 'selected', resources: listIds.map((id) => ({ kind: 'list', id })) }
        : { mode: 'all' },
    };
  }
  const displayed: PermissionPolicy = { version: 2, domains };
  return p.permissionCeiling
    ? intersectPermissionPolicies(displayed, p.permissionCeiling, resourceContains(db))
    : displayed;
}
export const legacyPermissionPolicy = permissionPolicyForPrincipal;
