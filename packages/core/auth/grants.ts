import type { AppDatabase } from '../db.js';
import type { Principal } from '../../../shared/knowledge-contracts.js';
import type { PermissionPolicy } from '../../../shared/permissions.js';
import { categories } from '../files.js';
import {
  currentLibraryIdentity,
  hasTable,
  intersectPermissionPolicies,
  normalizePermissionPolicy,
  policyScopes,
  projectPermissionPrincipal,
  resourceContains,
  underPrefix,
} from './permissions.js';
export function initializeGrants(db: AppDatabase) {
  db.exec(`CREATE TABLE IF NOT EXISTS platform_grants (
    id TEXT PRIMARY KEY,owner_id TEXT NOT NULL,client_id TEXT NOT NULL,active INTEGER NOT NULL DEFAULT 1,
    version INTEGER NOT NULL DEFAULT 1,scopes_json TEXT NOT NULL,prefixes_json TEXT NOT NULL,
    not_before INTEGER NOT NULL DEFAULT 0,created_at INTEGER NOT NULL,UNIQUE(owner_id,client_id));`);
  const columns = new Set(
    (db.prepare('PRAGMA table_info(platform_grants)').all() as any[]).map((x) => x.name),
  );
  if (!columns.has('policy_version'))
    db.exec('ALTER TABLE platform_grants ADD COLUMN policy_version INTEGER NOT NULL DEFAULT 1');
  if (!columns.has('policy_json'))
    db.exec('ALTER TABLE platform_grants ADD COLUMN policy_json TEXT');
  if (!columns.has('library_id')) db.exec('ALTER TABLE platform_grants ADD COLUMN library_id TEXT');
  db.exec(`CREATE TABLE IF NOT EXISTS platform_permission_selections (
    selection_key TEXT NOT NULL,prefix TEXT NOT NULL,library_id TEXT NOT NULL,resource_kind TEXT,
    resource_id TEXT,PRIMARY KEY(selection_key,prefix));`);
}
/** Bind a legacy path once, including missing paths. Never rebind it to a later replacement. */
export function resolveLegacyPrefixes(
  db: AppDatabase,
  key: string,
  prefixes: string[],
  initialPath: (prefix: string) => string | undefined = (prefix) => prefix,
): string[] {
  const library = currentLibraryIdentity(db);
  if (!library) return prefixes.filter(Boolean);
  const result: string[] = [];
  for (const prefix of prefixes) {
    let row = db
      .prepare('SELECT * FROM platform_permission_selections WHERE selection_key=? AND prefix=?')
      .get(key, prefix) as any;
    if (!row) {
      const lookup = initialPath(prefix);
      const dir =
        lookup !== undefined &&
        hasTable(db, 'organization_directories') &&
        (db
          .prepare(
            'SELECT id FROM organization_directories WHERE path=? AND active=1 AND library_id=?',
          )
          .get(lookup, library.libraryId) as any);
      const note =
        lookup !== undefined &&
        !dir &&
        (db.prepare('SELECT id FROM notes WHERE path=? AND active=1').get(lookup) as any);
      db.prepare(
        'INSERT OR IGNORE INTO platform_permission_selections(selection_key,prefix,library_id,resource_kind,resource_id) VALUES(?,?,?,?,?)',
      ).run(
        key,
        prefix,
        library.libraryId,
        dir ? 'directory' : note ? 'note' : null,
        dir?.id || note?.id || null,
      );
      row = db
        .prepare('SELECT * FROM platform_permission_selections WHERE selection_key=? AND prefix=?')
        .get(key, prefix) as any;
    }
    if (row.library_id !== library.libraryId || !row.resource_id) continue;
    const found =
      row.resource_kind === 'directory'
        ? (db
            .prepare(
              'SELECT path FROM organization_directories WHERE id=? AND library_id=? AND active=1',
            )
            .get(row.resource_id, library.libraryId) as any)
        : (db
            .prepare('SELECT path FROM notes WHERE id=? AND active=1')
            .get(row.resource_id) as any);
    if (found) result.push(found.path);
  }
  return [...new Set(result)];
}
export function legacyScopes(scopes: string[], signedScopes = scopes): string[] {
  const result = scopes.filter(
    (s) =>
      signedScopes.includes(s) &&
      ['knowledge:read', 'knowledge:write', 'knowledge:index', 'blog:publish', 'to-doo:read', 'to-doo:write'].includes(s),
  );
  if (result.includes('knowledge:write')) result.push('knowledge:archive');
  if (result.includes('blog:publish')) result.push('blog:read');
  return result;
}
export function platformPolicy(db: AppDatabase, p: Principal): Principal | undefined {
  if (p.clientId.startsWith('plugin-web:')) {
    const id = p.clientId.slice('plugin-web:'.length);
    if (
      db.prepare('SELECT id FROM user WHERE id=?').get(p.id) &&
      db
        .prepare("SELECT id FROM platform_plugins WHERE id=? AND installed=1 AND state='enabled'")
        .get(id)
    )
      return {
        ...p,
        scopes: [
          'knowledge:read',
          'knowledge:write',
          'knowledge:organize',
          'knowledge:archive',
          'knowledge:index',
          'blog:read',
          'blog:publish',
          'to-doo:read',
          'to-doo:write',
        ],
        knowledgeAll: true,
        allowedPrefixes: ['README.md', ...categories],
      };
    return;
  }
  if (!p.grantId) return;
  initializeGrants(db);
  const grant = db
    .prepare('SELECT * FROM platform_grants WHERE id=? AND owner_id=? AND client_id=? AND active=1')
    .get(p.grantId, p.ownerId || p.id, p.clientId) as any;
  if (!grant || grant.version !== p.grantVersion || (p.tokenIssuedAt ?? 0) < grant.not_before)
    return;
  let config: any;
  if (p.pluginId) {
    const plugin = db
      .prepare(
        "SELECT config_json FROM platform_plugins WHERE id=? AND installed=1 AND state='enabled'",
      )
      .get(p.pluginId) as any;
    if (!plugin) return;
    if (p.pluginId === 'mcp') {
      config = JSON.parse(plugin.config_json);
      config.__selectionKey = 'plugin:mcp:legacy';
      if (
        p.authGeneration != null &&
        (!p.credentialRef || p.credentialRef !== config.tunnelToken?.$secretRef)
      )
        return;
    }
  }
  if (grant.policy_version === 2) {
    let policy = normalizePermissionPolicy(JSON.parse(grant.policy_json));
    for (const [domain, value] of Object.entries(policy.domains))
      value.actions = value.actions.filter((action) => p.scopes.includes(`${domain}:${action}`));
    if (config) {
      if (!config.permissionPolicy)
        return {
          ...p,
          policyVersion: 2,
          permissionPolicy: { version: 2, domains: {} },
          scopes: [],
          allowedPrefixes: [],
          knowledgeAll: false,
        };
      policy = intersectPermissionPolicies(
        policy,
        normalizePermissionPolicy(config.permissionPolicy),
        resourceContains(db),
      );
    }
    return projectPermissionPrincipal(db, p, policy);
  }
  let permissionCeiling: PermissionPolicy | undefined;
  let scopes: string[] = JSON.parse(grant.scopes_json);
  let prefixes = resolveLegacyPrefixes(
    db,
    `grant:${grant.id}:${grant.version}`,
    JSON.parse(grant.prefixes_json),
  );
  if (config) {
    if (config.permissionPolicy) {
      const ceiling = normalizePermissionPolicy(config.permissionPolicy);
      // A v1 client remains a path selection even after plugin policy upgrades.
      const allowed = projectPermissionPrincipal(
        db,
        { ...p, scopes: legacyScopes(scopes, p.scopes) },
        ceiling,
      );
      permissionCeiling = allowed.permissionPolicy;
      scopes = scopes.filter((scope) => allowed.scopes.includes(scope));
      if (!allowed.knowledgeAll)
        prefixes = prefixes.flatMap((a) =>
          allowed.allowedPrefixes.flatMap((b) =>
            underPrefix(a, b) ? [a] : underPrefix(b, a) ? [b] : [],
          ),
        );
    } else {
      scopes = scopes.filter(
        (s) =>
          (s !== 'knowledge:write' || config.readOnly === false) &&
          (s !== 'blog:publish' || (config.allowPublish === true && config.readOnly === false)) &&
          (s !== 'knowledge:index' || config.allowIndex === true) &&
          (s !== 'to-doo:read' || config.allowToDoo === true) &&
          (s !== 'to-doo:write' || (config.allowToDoo === true && config.allowToDooWrite === true && config.readOnly === false)),
      );
      const allowed = resolveLegacyPrefixes(
        db,
        config.__selectionKey,
        config.allowedPrefixes || ['README.md', ...categories],
      );
      prefixes = prefixes.flatMap((a) =>
        allowed.flatMap((b) => (underPrefix(a, b) ? [a] : underPrefix(b, a) ? [b] : [])),
      );
    }
  }
  let effectiveScopes = legacyScopes(scopes, p.scopes);
  if (permissionCeiling)
    effectiveScopes = effectiveScopes.filter((scope) =>
      policyScopes(permissionCeiling).includes(scope),
    );
  const library = currentLibraryIdentity(db);
  const refs = library
    ? [...new Set(prefixes)].flatMap((path) => {
        const dir = db
          .prepare(
            'SELECT id FROM organization_directories WHERE library_id=? AND path=? AND active=1',
          )
          .get(library.libraryId, path) as any;
        const note =
          !dir && (db.prepare('SELECT id FROM notes WHERE path=? AND active=1').get(path) as any);
        return dir || note
          ? [{ kind: dir ? 'directory' : 'note', id: dir?.id || note.id, path }]
          : [];
      })
    : undefined;
  return {
    ...p,
    policyVersion: 1,
    permissionPolicy: undefined,
    permissionCeiling,
    scopes: effectiveScopes,
    knowledgeResourcePaths: refs,
    knowledgeAll: false,
    allowedPrefixes: [...new Set(prefixes)],
  };
}
