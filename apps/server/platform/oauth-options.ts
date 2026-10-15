import { jwt } from 'better-auth/plugins';
import { oauthProvider, getOAuthProviderState, type OAuthProviderExtension } from '@better-auth/oauth-provider';
import { APIError } from 'better-call';
import type { HostConfig } from '../../../shared/platform-contracts.js';
import type { AppDatabase } from '../../../packages/core/db.js';
import { oauthGrantStore } from './oauth-grants.js';
export const oauthScopes = ['offline_access', 'knowledge:read', 'knowledge:write', 'knowledge:index'];
export function oauthPlugins(config: HostConfig, db: AppDatabase) {
  const grants = oauthGrantStore(db), resource = config.origin + '/mcp', issuer = config.origin + '/api/auth';
  type AccessClaims = NonNullable<NonNullable<OAuthProviderExtension['claims']>['accessToken']>;
  const accessToken: AccessClaims = async ({ user, client, scopes, resources, referenceId }) => {
    try {
      if (!user || !referenceId || !resources?.includes(resource)) throw new Error();
      const grant = grants.requireExact(referenceId, user.id, client.clientId, scopes.filter(s => s.startsWith('knowledge:')));
      return { dk_grant_id: grant.id, dk_grant_version: grant.version };
    } catch { throw new APIError('BAD_REQUEST', { error: 'invalid_grant', error_description: 'Knowledge authorization was revoked or changed' }); }
  };
  return [jwt({ jwt: { issuer } }), oauthProvider({
    loginPage: '/login', consentPage: '/oauth/consent', scopes: oauthScopes,
    grantTypes: ['authorization_code', 'refresh_token'], allowDynamicClientRegistration: true,
    allowUnauthenticatedClientRegistration: true,
    clientRegistrationDefaultScopes: ['knowledge:read', 'offline_access'],
    clientRegistrationAllowedScopes: oauthScopes, enforcePerClientResources: true,
    resources: [{ identifier: resource, allowedScopes: oauthScopes, accessTokenTtl: 300 }],
    clientRegistrationDefaultResources: [resource], accessTokenExpiresIn: 300,
    refreshTokenReuseInterval: 0, extensions: [{ claims: { accessToken } }],
    postLogin: { page: '/oauth/consent', shouldRedirect: () => false,
      consentReferenceId: async ({ user }) => {
        const state = await getOAuthProviderState();
        const client = new URLSearchParams(state?.query || '').get('client_id');
        return client ? grants.activeReference(user.id, client) : undefined;
      } },
  })] as const;
}
