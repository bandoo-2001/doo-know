import { createHmac } from 'node:crypto';
export const agentConfig = {
  serviceToken: 'isolated-service-token-for-tests-only',
  assertionSecret: 'isolated-assertion-secret-for-tests-only',
  issuer: 'doo-know-bridge',
  audience: 'doo-know-web',
  policies: [
    {
      id: 'owner',
      clientId: 'test-client',
      scopes: ['knowledge:read', 'knowledge:write', 'knowledge:index'],
      allowedPrefixes: ['00-Inbox'],
    },
  ],
};
export function agentHeaders(overrides: Record<string, unknown> = {}) {
  const now = Math.floor(Date.now() / 1000);
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const body = Buffer.from(
    JSON.stringify({
      iss: agentConfig.issuer,
      aud: agentConfig.audience,
      sub: 'owner',
      clientId: 'test-client',
      scopes: ['knowledge:read', 'knowledge:write', 'knowledge:index'],
      allowedPrefixes: ['00-Inbox'],
      iat: now,
      exp: now + 45,
      ...overrides,
    }),
  ).toString('base64url');
  const signature = createHmac('sha256', agentConfig.assertionSecret)
    .update(`${header}.${body}`)
    .digest('base64url');
  return {
    authorization: `Bearer ${agentConfig.serviceToken}`,
    'x-agent-assertion': `${header}.${body}.${signature}`,
  };
}
