import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { pluginHost } from './host.js';
import type { createAuth } from '../auth.js';
import type { AppDatabase } from '../../../packages/core/db.js';
import type { HostConfig } from '../../../shared/platform-contracts.js';
import { verifyMcpBearer } from '../platform/oauth.js';
import { authenticateMcpApiKey } from '../platform/mcp-api-keys.js';
import { currentPrincipalPolicy } from '../../../packages/core/agent/config.js';
import { checkTokenCutoff } from '../../../packages/core/agent/auth.js';
import { fail } from '../../../packages/core/knowledge/errors.js';
import type { platformRuntime } from '../platform/runtime.js';
import type { MCPConnectionAttempt } from '../../../shared/mcp-connection-contracts.js';
import { isResourceScope } from '../../../shared/authorization-scopes.js';

type Host = ReturnType<typeof pluginHost>;
type Mode = MCPConnectionAttempt['mode'];
const authFailureLimit = 20, authFailureWindow = 60_000, maxAuthPeers = 1024;
const clientRequestLimit = 120, clientRequestWindow = 60_000, maxClients = 1024;

export function mcpTransports(app: FastifyInstance, host: Host, auth: Awaited<ReturnType<typeof createAuth>>, config: HostConfig, db: AppDatabase, platform: ReturnType<typeof platformRuntime>) {
  let latestAttempt: MCPConnectionAttempt | null = null;
  const authFailures = new Map<string, { count: number; expiresAt: number }>();
  const clientRequests = new Map<string, { count: number; expiresAt: number }>();
  function available(mode: Mode) {
    const item = host.list().find(plugin => plugin.id === 'mcp');
    return item?.state === 'enabled' && item.config[mode === 'oauth' ? 'oauthEnabled' : 'apiKeyEnabled'] !== false;
  }
  function failureBucket(peer: string) {
    const bucket = authFailures.get(peer);
    if (bucket && bucket.expiresAt <= Date.now()) { authFailures.delete(peer); return; }
    return bucket;
  }
  function recordFailure(peer: string) {
    let bucket = failureBucket(peer);
    if (!bucket) {
      // Never retain unbounded attacker-controlled peer addresses or credentials.
      if (authFailures.size >= maxAuthPeers) authFailures.delete(authFailures.keys().next().value!);
      bucket = { count: 0, expiresAt: Date.now() + authFailureWindow };
      authFailures.set(peer, bucket);
    }
    bucket.count++;
  }
  function consumeClientBudget(ownerId: string, clientId: string, reply: FastifyReply) {
    const key = JSON.stringify([ownerId, clientId]), now = Date.now();
    let bucket = clientRequests.get(key);
    if (bucket && bucket.expiresAt <= now) { clientRequests.delete(key); bucket = undefined; }
    if (!bucket) {
      if (clientRequests.size >= maxClients) clientRequests.delete(clientRequests.keys().next().value!);
      bucket = { count: 0, expiresAt: now + clientRequestWindow };
      clientRequests.set(key, bucket);
    }
    if (bucket.count >= clientRequestLimit) {
      reply.header('Retry-After', String(Math.max(1, Math.ceil((bucket.expiresAt - now) / 1000))));
      fail(429, 'MCP_CLIENT_RATE_LIMIT', undefined, true);
    }
    bucket.count++;
  }
  function register(path: string, mode: Mode) {
    app.route({ method: ['POST', 'GET', 'DELETE', 'OPTIONS'], url: path, bodyLimit: 128 * 1024, handler: handle });
    async function handle(req: FastifyRequest, reply: FastifyReply) {
      const url = new URL(req.url, 'http://local.invalid');
      const peer = mode + ':' + req.ip;
      try {
        if ((db.prepare('SELECT active FROM maintenance WHERE id=1').get() as { active: number }).active) fail(503, 'MAINTENANCE_ACTIVE');
        if (!available(mode)) fail(404, 'PLUGIN_PROTOCOL_UNAVAILABLE');
        if (req.headers['content-encoding']) fail(415, 'COMPRESSED_REQUEST_NOT_ALLOWED');
        if (url.searchParams.has('access_token')) fail(401, 'UNAUTHORIZED');
        const allowedHosts = new Set([new URL(config.origin).host]);
        const listener = app.server.address();
        if (listener && typeof listener !== 'string') {
          for (const name of ['localhost', '127.0.0.1', '[::1]']) allowedHosts.add(name + ':' + listener.port);
        }
        if (!req.headers.host || !allowedHosts.has(req.headers.host)) fail(403, 'FORBIDDEN');
        const origin = req.headers.origin;
        if (origin && origin !== config.origin) fail(403, 'FORBIDDEN');
        if (origin) reply.header('Access-Control-Allow-Origin', origin).header('Vary', 'Origin').header('Access-Control-Expose-Headers', 'WWW-Authenticate,MCP-Protocol-Version,Retry-After');
        reply.header('Cache-Control', 'no-store');
        if (req.method === 'OPTIONS') {
          if (req.headers['access-control-request-method'] && req.headers['access-control-request-method'] !== 'POST') fail(403, 'FORBIDDEN');
          const headers = ['authorization', 'content-type', 'mcp-protocol-version', 'mcp-session-id', 'last-event-id'];
          if (String(req.headers['access-control-request-headers'] || '').split(',').map(header => header.trim().toLowerCase()).filter(Boolean).some(header => !headers.includes(header))) fail(403, 'FORBIDDEN');
          return reply.header('Access-Control-Allow-Methods', 'POST').header('Access-Control-Allow-Headers', headers.join(',')).code(204).send();
        }
        const bucket = failureBucket(peer);
        if (bucket && bucket.count >= authFailureLimit) {
          reply.header('Retry-After', String(Math.max(1, Math.ceil((bucket.expiresAt - Date.now()) / 1000))));
          fail(429, 'AUTHENTICATION_RATE_LIMIT');
        }
        const principal = mode === 'oauth'
          ? { ...await verifyMcpBearer(auth, config, db, req.headers.authorization), pluginId: 'mcp' }
          : authenticateMcpApiKey(db, req.headers.authorization);
        checkTokenCutoff(db, principal);
        const policy = currentPrincipalPolicy(platform.get().config, db, principal);
        if (!policy) fail(401, 'UNAUTHORIZED');
        Object.assign(principal, policy);
        consumeClientBudget(principal.ownerId || principal.id, principal.clientId, reply);
        latestAttempt = { at: new Date().toISOString(), mode, outcome: 'authenticated', code: 'AUTHENTICATED' };
        if (req.method !== 'POST') return reply.code(405).header('Allow', 'POST').send({ jsonrpc: '2.0', id: null, error: { code: -32000, message: 'POST required' } });
        for (const [key, value] of Object.entries(reply.getHeaders())) if (value !== undefined) reply.raw.setHeader(key, value);
        reply.hijack();
        await host.protocol('mcp', 'mcp.oauth', { request: req.raw, response: reply.raw, body: req.body,
          call: { ownerId: principal.ownerId || principal.id, principal, channel: 'mcp', input: {}, services: undefined as any } });
        return reply;
      } catch (error) {
        const failure = error as any, status = failure.statusCode || failure.status || 500;
        const code = typeof failure.code === 'string' && /^[A-Z][A-Z0-9_]{0,63}$/.test(failure.code) ? failure.code : 'INTERNAL_ERROR';
        if (status === 401) recordFailure(peer);
        latestAttempt = { at: new Date().toISOString(), mode, outcome: 'rejected', code };
        if (!reply.raw.headersSent) {
          const headers: Record<string, string | string[]> = {};
          for (const [name, value] of Object.entries(reply.getHeaders())) {
            if (value !== undefined) headers[name] = Array.isArray(value) ? value : String(value);
          }
          headers['content-type'] = 'application/json'; headers['cache-control'] = 'no-store';
          if (status === 401) headers['www-authenticate'] = mode === 'oauth'
            ? `Bearer resource_metadata="${config.origin}/.well-known/oauth-protected-resource/mcp"`
            : 'Bearer realm="DooKnow MCP API Key"';
          if (status === 403 && isResourceScope(failure.requiredScope)) headers['www-authenticate'] = `Bearer error="insufficient_scope", scope="${failure.requiredScope}"`;
          const details = { code, message: code, retryable: !!failure.retryable,
            ...(typeof failure.requestId === 'string' && failure.requestId.length <= 128 ? { requestId: failure.requestId } : {}) };
          const body = req.body as any;
          const id = (typeof body?.id === 'number' && Number.isFinite(body.id)) || (typeof body?.id === 'string' && Buffer.byteLength(body.id) <= 128) ? body.id : null;
          reply.raw.writeHead(status, headers).end(JSON.stringify({ jsonrpc: '2.0', id, error: { code: status === 401 ? -32001 : -32600, message: code, data: details } }));
          reply.hijack();
        } else if (!reply.raw.writableEnded) reply.raw.end();
        return reply;
      }
    }
  }
  register('/mcp', 'oauth');
  register('/mcp/api-key', 'api-key');
  return {
    latestAttempt: () => latestAttempt ? { ...latestAttempt } : null,
    start: async () => {},
    close: async () => { authFailures.clear(); clientRequests.clear(); },
    connection: async () => ({
      oauth: {
        ready: available('oauth') && config.origin.startsWith('https:') && platform.status().components.knowledge,
        address: config.origin + '/mcp',
        reason: !available('oauth') ? 'OAuth 连接方式未启用' : !config.origin.startsWith('https:') ? '需要浏览器可达的 HTTPS 授权站点和 MCP 地址' : !platform.status().components.knowledge ? '知识库尚未就绪' : undefined,
      },
      apiKey: {
        ready: available('api-key') && platform.status().components.knowledge,
        address: config.origin + '/mcp/api-key',
        reason: !available('api-key') ? 'API Key 连接方式未启用' : !platform.status().components.knowledge ? '知识库尚未就绪' : undefined,
      },
    }),
  };
}
