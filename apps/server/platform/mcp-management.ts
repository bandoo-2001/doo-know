import type { FastifyInstance } from 'fastify';
import type { AppDatabase } from '../../../packages/core/db.js';
import type { HostConfig } from '../../../shared/platform-contracts.js';
import type { MCPConnectionState } from '../../../shared/mcp-connection-contracts.js';
import type { pluginHost } from '../plugins/host.js';
import type { mcpTransports } from '../plugins/mcp-transport.js';
import type { createAuth } from '../auth.js';
import { platformPolicy } from '../../../packages/core/auth/grants.js';
import { oauthGrantStore } from './oauth-grants.js';
import { revokeOAuthClient } from './oauth.js';
import { fail } from '../../../packages/core/knowledge/errors.js';

export function registerMcpManagementRoutes(
  app: FastifyInstance,
  config: HostConfig,
  db: AppDatabase,
  host: ReturnType<typeof pluginHost>,
  transports: ReturnType<typeof mcpTransports>,
  auth: Awaited<ReturnType<typeof createAuth>>,
) {
  app.get('/api/platform/mcp/connection', async (request): Promise<MCPConnectionState> => {
    const ownerId = (request as any).ownerId as string;
    const plugin = host.list().find((p) => p.id === 'mcp');
    const stored = db
      .prepare("SELECT value FROM plugin_data WHERE plugin_id='mcp' AND key='calls'")
      .get() as { value: string } | undefined;
    const calls = stored ? JSON.parse(stored.value) : [];
    const identityTable = db
      .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='mcp_tunnel_identity'")
      .get();
    const identity = identityTable
      ? (db
          .prepare('SELECT principal_id,client_id FROM mcp_tunnel_identity WHERE owner_id=?')
          .get(ownerId) as { principal_id: string; client_id: string } | undefined)
      : undefined;
    const last =
      Array.isArray(calls) &&
      calls.find(
        (call: any) =>
          call.code === 'OK' &&
          (call.principal === ownerId ||
            (identity &&
              call.principal === identity.principal_id &&
              call.client === identity.client_id)),
      );
    return {
      origin: config.origin,
      plugin: {
        installed: !!plugin,
        enabled: plugin?.state === 'enabled',
        state: plugin?.state || 'not_installed',
        configVersion: plugin?.configVersion ?? null,
      },
      connection: await transports.connection(),
      // Host checks cannot establish public reachability or identify a ChatGPT session.
      externalVerification: 'unknown',
      latestConnectionAttempt: transports.latestAttempt(),
      latestSuccessfulCall: last ? { at: last.at, tool: last.tool, client: last.client } : null,
      clients: oauthGrantStore(db)
        .list(ownerId)
        .map((grant) => {
          const channel = identity?.client_id === grant.clientId ? 'tunnel' : 'oauth';
          const mode = plugin?.config.mode || 'oauth';
          const channelEnabled = mode === 'both' || mode === channel;
          const effective = channelEnabled
            ? platformPolicy(db, {
                id: ownerId,
                ownerId,
                clientId: grant.clientId,
                scopes: grant.scopes,
                allowedPrefixes: grant.allowedPrefixes,
                grantId: grant.id,
                grantVersion: grant.version,
                tokenIssuedAt: Math.floor(Date.now() / 1000),
                pluginId: 'mcp',
              })
            : undefined;
          return {
            clientId: grant.clientId,
            active: grant.active,
            scopes: grant.scopes,
            allowedPrefixes: grant.allowedPrefixes,
            effectiveScopes: effective?.scopes || [],
            effectivePrefixes: effective?.allowedPrefixes || [],
          };
        }),
    };
  });
  app.post('/api/platform/mcp/clients/revoke', async (request) => {
    const clientId = (request.body as any)?.clientId;
    if (typeof clientId !== 'string' || !clientId || clientId.length > 512)
      fail(400, 'INVALID_INPUT');
    return revokeOAuthClient(auth, db, (request as any).ownerId, clientId);
  });
}
