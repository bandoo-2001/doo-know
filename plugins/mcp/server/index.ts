import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { PluginContext, PluginServices, ProtocolCall } from '../../../packages/plugin-sdk/index.js';
import { createOperations, registerOperations } from './operations.js';
import { hostClient } from './service.js';
import { budgets, assertRequest } from './budgets.js';
import { BridgeError, errorBody } from './errors.js';
import { buildOpenApi } from './openapi.js';
export function activate(ctx: PluginContext) {
  const calls = new AsyncLocalStorage<PluginServices>();
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
        client: principal.clientId, tool: /^[a-z_]{1,64}$/.test(tool) ? tool : 'unknown', elapsedMs: Date.now()-started, code });
      ctx.storage.set('calls', rows.slice(0,500));
    }
  };
  const validate = (config: Record<string, any>) => {
    for (const p of config.allowedPrefixes) if (typeof p !== 'string' || p.startsWith('/') || /[\\\x00-\x1f]/.test(p) || p.split('/').some(x => x === '.' || x === '..' || !x || x.startsWith('.'))) throw new BridgeError('INVALID_CONFIGURATION');
    for (const value of [config.externalWebOrigin,config.tunnelOrigin].filter(Boolean)) { const u = new URL(value); if (u.protocol !== 'https:' || u.origin !== value) throw new BridgeError('INVALID_CONFIGURATION'); }
  };
  validate(ctx.config()); ctx.onConfigure(validate);
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
    const path = new URL(request.url!, 'http://local.invalid').pathname;
    if (path === '/openapi.json') { response.setHeader('content-type','application/json'); response.end(JSON.stringify(buildOpenApi(registry.operations, (ctx.config().tunnelOrigin || 'http://127.0.0.1:' + ctx.config().compatPort) + '/mcp'))); return; }
    const principal = call.principal!;
    assertRequest(body);
    const controller = new AbortController(), deadline = Date.now()+budgets.call;
    const timer = setTimeout(() => controller.abort(),budgets.call); timer.unref();
    const abort = () => controller.abort(); request.once('aborted',abort); response.once('close',abort);
    try {
      if (path.startsWith('/api/v1/tools/')) {
        const tool = path.slice('/api/v1/tools/'.length), result = await registry.execute(tool, principal, body, { signal: controller.signal, deadline });
        response.setHeader('content-type','application/json'); response.end(JSON.stringify(registry.operations.find(o => o.name === tool)?.research ? { data: result } : result)); return;
      }
      const b = body as any;
      if (!b || typeof b !== 'object' || Array.isArray(b) || (b.id != null && !(typeof b.id === 'number' && Number.isFinite(b.id)) && !(typeof b.id === 'string' && Buffer.byteLength(b.id)<=128))) throw new BridgeError('INVALID_INPUT');
      const server = new McpServer({ name: 'doo-know', version: '1.1.0' });
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
    } finally { clearTimeout(timer); request.off('aborted',abort); response.off('close',abort); }
  });
  ctx.registerProtocol('mcp.oauth',protocol); ctx.registerProtocol('mcp.compat',protocol);
}
