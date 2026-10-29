import type { Principal } from './contracts.js';
import { BridgeError } from './errors.js';
export function requireScope(p: Principal, scope: string) {
  if (!p.scopes.includes(scope)) { const error = new BridgeError('INSUFFICIENT_SCOPE', 403); error.requiredScope = scope; throw error; }
}
export function underPrefix(path: string, prefix: string) { return prefix === '' || path === prefix || path.startsWith(prefix + '/'); }
export function authorizePath(p: Principal, path: string) {
  // Resource identities and live plugin ceilings are checked by host services.
  // The signed grant can arrive before the host projects its current path ACL.
  const grant = p.permissionPolicy?.domains.knowledge;
  const owned = grant?.enabled && grant.ownerId === (p.ownerId || p.id);
  const all = owned && grant.resources.mode === 'all';
  // Raw selected-ID grants have no local path projection. Only the host can
  // resolve current ancestry; it checks paths before each read and mutation.
  const hostSelection = owned && grant.resources.mode === 'selected' && p.allowedPrefixes.length === 0;
  if (!p.knowledgeAll && !all && !hostSelection && !p.allowedPrefixes.some(prefix => underPrefix(path, prefix))) throw new BridgeError('FORBIDDEN', 403);
}
