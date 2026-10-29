import { expect, it } from 'vitest';
import { createServer } from 'node:http';
import { activate } from '../plugins/mcp/server/index.js';
import { BridgeError } from '../plugins/mcp/server/errors.js';
import type { PluginContext, PluginServices, ProtocolCall } from '../packages/plugin-sdk/index.js';

it('routes HTTP cancellation to the original identity-bound request and releases tracking afterward', async () => {
  const protocols = new Map<string, (call: ProtocolCall) => Promise<void>>(), storage = new Map<string, unknown>();
  const disposers: Array<() => unknown> = [];
  let started!: () => void, release!: () => void, aborted = false, first = true;
  const waiting = new Promise<void>(resolve => { started = resolve; });
  const services = { knowledge: { list: async (_input: unknown, options: { signal: AbortSignal }) => {
    if (!first) return { items: [] };
    first = false; started();
    return new Promise((resolve, reject) => {
      release = () => resolve({ items: [] });
      options.signal.addEventListener('abort', () => { aborted = true; reject(new BridgeError('CALL_CANCELLED', 499)); }, { once: true });
    });
  } } } as unknown as PluginServices;
  activate({ config: () => ({ allowedPrefixes: ['00-Inbox'] }), secrets: { getOrCreate: () => 'isolated-http-cancellation-fixture-secret' },
    storage: { get: (key: string) => storage.get(key), set: (key: string, value: unknown) => { storage.set(key, value); } },
    registerProtocol: (id: string, handler: (call: ProtocolCall) => Promise<void>) => { protocols.set(id, handler); return () => {}; },
    registerProvider: () => () => {}, registerCommand: () => () => {}, onConfigure: () => () => {}, onDispose: (fn: () => unknown) => { disposers.push(fn); },
  } as unknown as PluginContext);
  const server = createServer(async (request, response) => {
    try {
      const parts: Buffer[] = []; for await (const part of request) parts.push(Buffer.from(part));
      const body = JSON.parse(Buffer.concat(parts).toString());
      await protocols.get('mcp.oauth')!({ request, response, body, call: { ownerId: 'owner', input: body, services,
        principal: { id: 'owner', clientId: String(request.headers['x-client'] || 'one'), scopes: ['knowledge:read'], allowedPrefixes: ['00-Inbox'] } } });
    } catch { if (!response.headersSent) response.writeHead(500); response.end(); }
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as { port: number };
  const post = (body: unknown, client = 'one') => fetch(`http://127.0.0.1:${address.port}/mcp`, { method: 'POST', headers: { accept: 'application/json, text/event-stream', 'content-type': 'application/json', 'x-client': client }, body: JSON.stringify(body) });
  try {
    const request = post({ jsonrpc: '2.0', id: 71, method: 'tools/call', params: { name: 'list_notes', arguments: { limit: 1 } } });
    await waiting;
    const other = await post({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 71 } }, 'two');
    expect(other.status).toBe(202); await other.arrayBuffer();
    expect(aborted).toBe(false);
    const cancelled = await post({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 71 } });
    expect(cancelled.status).toBe(202); await cancelled.arrayBuffer();
    const wasAborted = aborted;
    release();
    const result = await (await request).json();
    expect(wasAborted).toBe(true);
    expect(result).toMatchObject({ result: { isError: true, structuredContent: { error: { code: 'CALL_CANCELLED' } } } });
    const retry = await post({ jsonrpc: '2.0', id: 71, method: 'tools/call', params: { name: 'list_notes', arguments: { limit: 1 } } });
    expect((await retry.json()).result).toMatchObject({ structuredContent: { data: { items: [] } } });
    const invalid = await post({ jsonrpc: '2.0', id: 72, method: 'tools/call', params: { name: 'private_observation_token', arguments: {} } });
    expect((await invalid.json()).result).toMatchObject({ isError: true });
    expect(JSON.stringify(storage.get('calls'))).not.toContain('private_observation_token');
  } finally {
    release?.(); for (const dispose of disposers) await dispose();
    server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
  }
});
