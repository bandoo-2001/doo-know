import { implementedResourceScopes } from './permissions.js';
/** Public disclosure and structural changes always require explicit grants. */
export const resourceScopes = implementedResourceScopes;
export const oauthScopes = ['offline_access', ...resourceScopes];
export const isResourceScope = (scope: string) => resourceScopes.includes(scope);
/** Scope set accepted by the original assertion/configuration and v1 grant format. */
export const isLegacyResourceScope = (scope: string) =>
  ['knowledge:read', 'knowledge:write', 'knowledge:index', 'blog:publish', 'to-doo:read', 'to-doo:write'].includes(scope);
