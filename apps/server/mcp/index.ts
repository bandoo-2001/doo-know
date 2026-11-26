import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { CancelledNotificationSchema } from '@modelcontextprotocol/sdk/types.js';
import type { FeatureRuntimeContext, IntegrationServices, ProtocolCall } from '../../../packages/core/integration-ports.js';
import { createOperations, registerOperations } from './operations.js';
import { hostClient } from './service.js';
import { budgets, assertRequest } from './budgets.js';
import { BridgeError, errorBody } from './errors.js';
import { makeAgentInstructions, toDooAgentGuidance } from './agent-guidance.js';
import { permissionPolicy } from './contracts.js';
import { permissionDomains } from '../../../shared/permissions.js';
import { fail } from '../../../packages/core/knowledge/errors.js';
export function validateMcpConfig(config: Record<string, any>) {
  function invalid() { fail(400, 'INVALID_CONFIGURATION', 'MCP 配置不符合要求'); }
  if (config.permissionPolicy !== undefined) {
    const parsed = permissionPolicy.safeParse(config.permissionPolicy);
    if (!parsed.success) return invalid();
    for (const [id, grant] of Object.entries(parsed.data.domains)) {
      const domain = permissionDomains.find((candidate) => candidate.id === id && candidate.implemented);
      if (
        !domain ||
        grant.actions.some((action) => !domain.actions.some((known) => known.id === action && known.implemented)) ||
        (grant.resources.mode === 'selected' &&
          grant.resources.resources.some((resource) => !domain.resourceKinds.includes(resource.kind)))
      ) invalid();
    }
  }
  for (const path of config.allowedPrefixes || []) {
    if (
      typeof path !== 'string' || /[\\\x00-\x1f]/.test(path) ||
      path.split('/').some((part: string) => !part || part.startsWith('.'))
    ) invalid();
  }
  if (config.externalWebOrigin) {
    const url = URL.parse(config.externalWebOrigin);
    if (!url || url.protocol !== 'https:' || url.origin !== config.externalWebOrigin) invalid();
  }
}

export function activate(ctx: FeatureRuntimeContext) {
  const activeRequests = new Map<string, AbortController>();
  const requestKey = (p: NonNullable<ProtocolCall['call']['principal']>, id: string | number) => JSON.stringify([p.ownerId || p.id, p.id, p.clientId, id]);
  ctx.onDispose(() => { for (const controller of activeRequests.values()) controller.abort(); activeRequests.clear(); });
  const calls = new AsyncLocalStorage<IntegrationServices>();
  const client = hostClient(() => { const value = calls.getStore(); if (!value) throw new BridgeError('FORBIDDEN',403); return value; }, ctx.config, ctx.track);
  const registry = createOperations({ objectIdSecret: ctx.secrets.getOrCreate('objects') }, client);
  const execute = registry.execute;
  registry.execute = async (tool, principal, args, options) => {
    const started = Date.now(), correlationId = randomUUID(); let code = 'OK';
    try { return await execute(tool, principal, args, options); }
    catch (e) { code = errorBody(e).error.code; throw e; }
    finally {
      const rows = ctx.storage.get<any[]>('calls') || [];
      rows.unshift({ id: correlationId, at: new Date(started).toISOString(), principal: principal.id,
        authentication: principal.credentialKind || 'oauth', keyId: principal.credentialKind === 'api-key' ? principal.credentialRef : undefined,
        client: principal.clientId, tool: registry.operations.some(operation => operation.name === tool) ? tool : 'unknown', elapsedMs: Date.now()-started, code });
      ctx.storage.set('calls', rows.slice(0,500));
    }
  };
  ctx.registerProvider('mcp.status', async ({ services }) => ({ connection: await services.authorization!.connection(),
    tools: registry.operations.map(o => ({ name: o.name, readOnly: o.readOnly, scope: o.scope })), clients: await services.authorization!.list() }));
  ctx.registerProvider('mcp.calls', async ({ input }) => {
    const rows = ctx.storage.get<any[]>('calls') || [];
    const start = input?.cursor ? rows.findIndex(r => r.id === input.cursor) + 1 : 0;
    const page = rows.slice(start, start+50); return { items: page, ...(rows.length > start+50 ? { nextCursor: page.at(-1).id } : {}) };
  });
  ctx.registerCommand('mcp.revoke', async ({ input, services }) => {
    if (typeof input?.clientId !== 'string' || !input.clientId || input.clientId.length > 512) throw new BridgeError('INVALID_INPUT');
    return services.authorization!.revoke(input.clientId);
  });
  const protocol = async ({ request, response, body, call }: ProtocolCall) => calls.run(call.services, async () => {
    const principal = call.principal!;
    assertRequest(body);
    const controller = new AbortController(), deadline = Date.now()+budgets.call;
    let activeKey: string | undefined;
    const timer = setTimeout(() => controller.abort(),budgets.call); timer.unref();
    const abort = () => controller.abort(); request.once('aborted',abort); response.once('close',abort);
    try {
      const b = body as any;
      if (!b || typeof b !== 'object' || Array.isArray(b) || (b.id != null && !(typeof b.id === 'number' && Number.isFinite(b.id)) && !(typeof b.id === 'string' && Buffer.byteLength(b.id)<=128))) throw new BridgeError('INVALID_INPUT');
      if (b.method === 'notifications/cancelled') {
        const cancelled = CancelledNotificationSchema.safeParse(b);
        if (b.jsonrpc !== '2.0' || Object.hasOwn(b, 'id') || !cancelled.success) throw new BridgeError('INVALID_INPUT');
        if (cancelled.data.params.requestId != null) activeRequests.get(requestKey(principal, cancelled.data.params.requestId))?.abort();
        response.statusCode = 202; response.end(); return;
      }
      if (b.method === 'tools/call' && b.id != null) {
        const key = requestKey(principal, b.id);
        if (activeRequests.has(key)) throw new BridgeError('DUPLICATE_REQUEST_ID', 409);
        if (activeRequests.size >= 128) throw new BridgeError('CALL_CONCURRENCY_LIMIT', 429, true);
        activeKey = key; activeRequests.set(key, controller);
      }
      const server = new McpServer({ name: 'doo-know', version: '2.0.5' }, { instructions: makeAgentInstructions(ctx.config()) + '\n' + toDooAgentGuidance });
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true, maxRequestBodySize: budgets.request });
      const send = transport.send.bind(transport);
      transport.send = async (message, options) => {
        if (Buffer.byteLength(JSON.stringify(message)) > budgets.response) {
          const id = 'id' in message ? message.id : null;
          if (id == null) throw new BridgeError('RESPONSE_TOO_LARGE',413);
          return send({ jsonrpc: '2.0', id, error: { code: -32603, message: 'RESPONSE_TOO_LARGE' } }, options);
        }
        return send(message, options);
      };
      registerOperations(server, registry, principal, { signal: controller.signal, deadline });
      await server.connect(transport);
      try { await transport.handleRequest(request,response,body); }
      finally { await server.close(); }
    } finally { if (activeKey && activeRequests.get(activeKey) === controller) activeRequests.delete(activeKey); clearTimeout(timer); request.off('aborted',abort); response.off('close',abort); }
  });
  ctx.registerProtocol('mcp.oauth',protocol);
}
