import { expect, it } from 'vitest';
import { normalizePermissionPolicy, policyScopes, authorizeDomainResource } from '../packages/core/auth/permissions.js';
import { legacyScopes } from '../packages/core/auth/grants.js';
import type { Principal } from '../shared/knowledge-contracts.js';

for (const [domain, action] of [
  ['knowledge', 'share'], ['knowledge', 'manage'], ['blog', 'write'],
  ['blog', 'manage'], ['to-doo', 'share'], ['to-doo', 'integrations'],
] as const) {
  it(`honors an explicit ${domain}:${action} grant without granting public publication`, () => {
    const policy = normalizePermissionPolicy({ version: 2, domains: {
      [domain]: { enabled: true, ownerId: 'owner', instanceId: 'instance', actions: [action], resources: { mode: 'all' } },
    } });
    const p: Principal = { id: 'owner', clientId: 'mcp-client', allowedPrefixes: [], scopes: policyScopes(policy), policyVersion: 2, permissionPolicy: policy };
    expect(() => authorizeDomainResource(p, domain, action)).not.toThrow();
    expect(() => authorizeDomainResource(p, domain, 'publish')).toThrow();
  });
}

it('keeps existing grants unchanged and prevents new administration scopes in legacy grants', () => {
  const policy = normalizePermissionPolicy({ version: 2, domains: {
    blog: { enabled: true, ownerId: 'owner', instanceId: 'blog', actions: ['read', 'publish'], resources: { mode: 'all' } },
    'to-doo': { enabled: true, ownerId: 'owner', instanceId: 'tasks', actions: ['read', 'write'], resources: { mode: 'all' } },
  } });
  expect(policyScopes(policy)).toEqual(['blog:read', 'blog:publish', 'to-doo:read', 'to-doo:write']);
  expect(legacyScopes(['blog:write', 'blog:manage', 'knowledge:share', 'knowledge:manage', 'to-doo:share', 'to-doo:integrations'])).toEqual([]);
});
