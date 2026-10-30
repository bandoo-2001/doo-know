import type { Principal } from '../../../shared/knowledge-contracts.js';
import type { AppDatabase } from '../db.js';
import { authorizePath, requireScope } from '../agent/auth.js';
import { currentLibraryIdentity, canAccessPath } from '../auth/permissions.js';
import { validateRelative } from '../files.js';
import { fail } from './errors.js';

/** Identity grants may authorize recovery of their own inactive object only.
 * Keep this principal local to the recovery operation; ordinary reads must still
 * resolve active identities, so a new file at the old path gains no permission. */
export function lifecyclePrincipal(
  db: AppDatabase,
  p: Principal,
  kind: 'note' | 'directory',
  id: string,
  path: string,
): Principal {
  try {
    if (kind === 'directory') authorizeFolderPath(p, path);
    else authorizePath(p, path);
    return p;
  } catch {
    /* An inactive selected identity has no ordinary path projection. */
  }
  const grant = (p.permissionPolicy || p.permissionCeiling)?.domains.knowledge;
  if (
    !grant?.enabled ||
    grant.instanceId !== currentLibraryIdentity(db)?.libraryId ||
    grant.resources.mode !== 'selected' ||
    !grant.resources.resources.some((r) => r.kind === kind && r.id === id)
  )
    fail(403, 'FORBIDDEN');
  return {
    ...p,
    allowedPrefixes: [...p.allowedPrefixes, path],
    knowledgeResourcePaths: [...(p.knowledgeResourcePaths || []), { kind, id, path }],
  };
}
export function authorizeFolderPath(p: Principal, path: string, scope = 'knowledge:read') {
  requireScope(p, scope);
  validateRelative(path, 'folder');
  if (!canAccessPath(p, path)) fail(403, 'FORBIDDEN');
}
