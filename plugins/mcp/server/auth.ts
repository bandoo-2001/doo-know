import type { Principal } from './contracts.js';
import { BridgeError } from './errors.js';
export function requireScope(p: Principal, scope: string) {
  if (!p.scopes.includes(scope)) { const error = new BridgeError('INSUFFICIENT_SCOPE', 403); error.requiredScope = scope; throw error; }
}
export function underPrefix(path: string, prefix: string) { return prefix === '' || path === prefix || path.startsWith(prefix + '/'); }
export function authorizePath(p: Principal, path: string) {
  if (!p.allowedPrefixes.some(prefix => underPrefix(path, prefix))) throw new BridgeError('FORBIDDEN', 403);
}
