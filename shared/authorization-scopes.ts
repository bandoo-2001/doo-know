/** Public disclosure is an explicit grant, independent of private-note writes. */
export const resourceScopes = ['knowledge:read', 'knowledge:write', 'knowledge:index', 'blog:publish'] as const;
export const oauthScopes = ['offline_access', ...resourceScopes];
export const isResourceScope = (scope: string) => (resourceScopes as readonly string[]).includes(scope);
