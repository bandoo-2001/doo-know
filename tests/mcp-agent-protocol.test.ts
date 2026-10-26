import { afterAll, beforeAll, expect, it } from 'vitest';
import Ajv from 'ajv';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { CallToolResultSchema, type JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';
import { createOperations, registerOperations } from '../plugins/mcp/server/operations.js';
import { buildOpenApi } from '../plugins/mcp/server/openapi.js';
import { hostClient } from '../plugins/mcp/server/service.js';
import type { CallOptions } from '../plugins/mcp/server/service.js';
import type { Principal } from '../plugins/mcp/server/contracts.js';
import { BridgeError, bridgeErrorSchema } from '../plugins/mcp/server/errors.js';
import { makeAgentInstructions } from '../plugins/mcp/server/agent-guidance.js';
import { pluginRuntimeFixture } from './support/plugin-runtime.js';

let fixture: Awaited<ReturnType<typeof pluginRuntimeFixture>>;
beforeAll(async () => { fixture = await pluginRuntimeFixture(); });
afterAll(async () => { await fixture?.close(); });

async function connected(principal: Principal = fixture.principal, options: CallOptions = {}) {
  const registry = createOperations({ objectIdSecret: 'protocol-fixture-reference-secret-at-least-thirty-two-characters' },
    hostClient(() => fixture.services, () => ({})));
  const server = new McpServer({ name: 'doo-know', version: '1.1.1' }, { instructions: makeAgentInstructions({ readOnly: true, allowIndex: false, allowPublish: false }) });
  registerOperations(server, registry, principal, options);
  const client = new Client({ name: 'protocol-test', version: '1' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const frames: JSONRPCMessage[] = [];
  const waiting = new Map<string | number, (frame: JSONRPCMessage) => void>();
  const send = serverTransport.send.bind(serverTransport);
  serverTransport.send = async (message, sendOptions) => {
    frames.push(message);
    if ('id' in message && message.id != null) waiting.get(message.id)?.(message);
    await send(message, sendOptions);
  };
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  await client.listTools();
  const raw = (message: JSONRPCMessage & { id: string | number }) => new Promise<JSONRPCMessage>((resolve, reject) => {
    waiting.set(message.id, (frame) => { waiting.delete(message.id); resolve(frame); });
    void clientTransport.send(message).catch(reject);
  });
  return { registry, server, client, frames, raw, close: async () => { await client.close(); await server.close(); } };
}

it('returns structured field errors for invalid calls through the real SDK transport', async () => {
  const session = await connected();
  try {
    const valid = await session.client.callTool({ name: 'list_notes', arguments: {} });
    expect(valid.isError).not.toBe(true);
    expect(valid.structuredContent).toEqual({ data: { items: [] } });
    const missing = await session.client.callTool({ name: 'get_note_info', arguments: {} });
    expect(missing.isError).toBe(true);
    expect(missing.structuredContent).toMatchObject({ error: { code: 'INVALID_INPUT', issues: [{ path: ['noteId'] }] } });
    expect(missing.content).toEqual([{ type: 'text', text: JSON.stringify(missing.structuredContent) }]);
  } finally { await session.close(); }
});

it.each([
  ['operation_status', { operationId: 'private-operation-value', requestId: 'original-request-id' }],
  ['operation_status', {}],
  ['read_note', { noteId: 'private-note-value', range: { startLine: 10, endLine: 9 } }],
  ['read_note', { noteId: 'private-note-value', maxBytes: 16385 }],
  ['read_note', { noteId: 'private-note-value', cursor: 'private-cursor-value', snapshotId: 'private-snapshot-value' }],
  ['get_note_info', { noteId: 'private-note-value', 'private-unknown-field': 'private-body-value' }],
])('keeps %s validation errors structured and private', async (name, args) => {
  const session = await connected();
  try {
    const result = await session.client.callTool({ name, arguments: args });
    expect(result).toMatchObject({ isError: true, structuredContent: { error: { code: 'INVALID_INPUT', issues: expect.any(Array) } } });
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain('private-');
    expect(Buffer.byteLength(serialized)).toBeLessThan(8192);
  } finally { await session.close(); }
});

it('returns safe scope and conflict recovery through SDK calls', async () => {
  const session = await connected({ ...fixture.principal, scopes: ['knowledge:read'] });
  try {
    const denied = await session.client.callTool({ name: 'create_note', arguments: { content: 'private-denied-body' } });
    expect(denied).toMatchObject({ isError: true, structuredContent: { error: { code: 'INSUFFICIENT_SCOPE', requiredScope: 'knowledge:write' } } });
    expect(JSON.stringify(denied)).not.toContain('private-denied-body');
  } finally { await session.close(); }
  const conflict = await connected();
  try {
    conflict.registry.operations.find((operation) => operation.name === 'update_note')!.run = async () => {
      throw Object.assign(new BridgeError('VERSION_CONFLICT', 409), { currentModifiedAt: '456' });
    };
    const result = await conflict.client.callTool({ name: 'update_note', arguments: { noteId: 'note', content: 'private-conflict-draft', expectedModifiedAt: '123', requestId: 'write-conflict' } });
    expect(result).toMatchObject({ isError: true, structuredContent: { error: { code: 'VERSION_CONFLICT', currentModifiedAt: '456', recovery: { action: 'read_and_merge', tool: 'read_note', requestIdPolicy: 'new_after_review' } } } });
    expect(JSON.stringify(result)).not.toContain('private-conflict-draft');
  } finally { await conflict.close(); }
});

it('enforces output schemas and keeps malformed call envelopes as protocol errors', async () => {
  const session = await connected();
  try {
    session.registry.operations.find((operation) => operation.name === 'list_notes')!.run = async () => ({ items: 'private-invalid-output' });
    const badOutput = await session.client.callTool({ name: 'list_notes', arguments: {} });
    expect(badOutput).toMatchObject({ isError: true, structuredContent: { error: { code: 'INVALID_BACKEND_RESPONSE' } } });
    expect(JSON.stringify(badOutput)).not.toContain('private-invalid-output');
    const malformed = await session.raw({ jsonrpc: '2.0', id: 'invalid-envelope', method: 'tools/call', params: { name: 'list_notes', arguments: [] } } as any);
    expect(malformed).toMatchObject({ jsonrpc: '2.0', id: 'invalid-envelope', error: { code: -32603 } });
    expect(malformed).not.toHaveProperty('result');
  } finally { await session.close(); }
});

it('retains request and response budgets without exposing rejected data', async () => {
  const session = await connected();
  try {
    const oversized = await session.client.callTool({ name: 'search_notes', arguments: { query: 'private-query-'.repeat(11000) } });
    expect(oversized).toMatchObject({ isError: true, structuredContent: { error: { code: 'REQUEST_TOO_LARGE' } } });
    expect(JSON.stringify(oversized)).not.toContain('private-query-');
    session.registry.operations.find((operation) => operation.name === 'list_notes')!.run = async () => ({ items: Array.from({ length: 50 }, (_, index) => ({
      id: String(index), title: 'private-output-'.repeat(100), relativePath: `00-Inbox/${index}.md`, sizeBytes: 1,
      modifiedAt: '123', contentHash: null, editorMode: 'full', longestLineBytes: null, readState: 'unknown',
    })) });
    const response = await session.client.callTool({ name: 'list_notes', arguments: {} });
    expect(response).toMatchObject({ isError: true, structuredContent: { error: { code: 'RESPONSE_TOO_LARGE' } } });
    expect(JSON.stringify(response)).not.toContain('private-output-');
    session.registry.operations.find((operation) => operation.name === 'list_notes')!.run = async () => { throw new Error('private-backend-message'); };
    const unexpected = await session.client.callTool({ name: 'list_notes', arguments: {} });
    expect(unexpected).toMatchObject({ isError: true, structuredContent: { error: { code: 'INTERNAL_ERROR' } } });
    expect(JSON.stringify(unexpected)).not.toContain('private-backend-message');
  } finally { await session.close(); }
});

it('preserves cancellation from SDK notifications and the original deadline', async () => {
  const deadline = Date.now() + 5000;
  const session = await connected(fixture.principal, { deadline });
  const controller = new AbortController();
  let entered!: () => void;
  const started = new Promise<void>((resolve) => { entered = resolve; });
  let cancelled!: (value: number | undefined) => void;
  const observed = new Promise<number | undefined>((resolve) => { cancelled = resolve; });
  session.registry.operations.find((operation) => operation.name === 'list_notes')!.run = (_p, _args, options) => new Promise((_resolve, reject) => {
    options.signal!.addEventListener('abort', () => { cancelled(options.deadline); reject(new BridgeError('CALL_CANCELLED', 499)); }, { once: true });
    entered();
  });
  try {
    const call = session.client.callTool({ name: 'list_notes', arguments: {} }, CallToolResultSchema, { signal: controller.signal });
    const rejected = expect(call).rejects.toBeDefined();
    await started;
    controller.abort();
    await rejected;
    expect(await observed).toBe(deadline);
  } finally { await session.close(); }
});

it('discovers strict schemas and instructions within the complete JSON-RPC frame budget', async () => {
  const session = await connected();
  try {
    expect(session.client.getInstructions()).toEqual(expect.any(String));
    expect(Buffer.byteLength(session.client.getInstructions()!)).toBeLessThanOrEqual(4096);
    const frame = await session.raw({ jsonrpc: '2.0', id: '\0'.repeat(128), method: 'tools/list', params: {} });
    expect(Buffer.byteLength(JSON.stringify(frame))).toBeLessThanOrEqual(65536);
    const tools = (frame as any).result.tools;
    expect(tools).toHaveLength(18);
    const info = tools.find((tool: any) => tool.name === 'get_note_info');
    expect(info.inputSchema.additionalProperties).toBe(false);
    expect(info.inputSchema.properties.noteId.description).toEqual(expect.any(String));
    expect(info.outputSchema.anyOf[0].properties.data.properties.id.description).toBeUndefined();
    const read = tools.find((tool: any) => tool.name === 'read_note');
    expect(read.inputSchema.required).toEqual(['noteId']);
    expect(read.inputSchema.properties.maxBytes.default).toBe(8192);
    const list = tools.find((tool: any) => tool.name === 'list_notes');
    const validate = new Ajv({ strict: false }).compile(list.outputSchema);
    expect(validate({ data: { items: [] } })).toBe(true);
    expect(validate({ data: { items: 'invalid' } })).toBe(false);
    expect(validate({ data: { items: [] }, error: { code: 'INVALID_INPUT', message: 'invalid', retryable: false } })).toBe(false);
    expect(validate({ error: { code: 'INVALID_INPUT', message: 'invalid', retryable: false } })).toBe(true);
  } finally { await session.close(); }
});

it('keeps defaulted OpenAPI input fields optional', () => {
  const registry = createOperations({ objectIdSecret: 'protocol-fixture-reference-secret-at-least-thirty-two-characters' },
    hostClient(() => fixture.services, () => ({})));
  const api = buildOpenApi(registry.operations) as any;
  const input = (name: string) => api.paths['/api/v1/tools/' + name].post.requestBody.content['application/json'].schema;
  expect(input('read_note').required).toEqual(['noteId']);
  expect(input('list_notes').required ?? []).toEqual([]);
  expect(input('search_notes').required).toEqual(['query']);
  expect(input('read_note').properties.maxBytes.default).toBe(8192);
  expect(input('list_notes').properties.limit.default).toBe(10);
  expect(input('search_notes').properties.mode.default).toBe('hybrid');
  expect(input('search_notes').properties.freshness.default).toBe('indexed');
  expect(input('operation_status').description).toMatch(/operationId.*requestId/);
  const error = api.paths['/api/v1/tools/read_note'].post.responses['400'].content['application/json'].schema;
  expect(error).toBe(bridgeErrorSchema);
  expect(error.properties.error.additionalProperties).toBe(false);
  for (const field of ['requiredScope', 'currentModifiedAt', 'issues', 'recovery']) expect(error.properties.error.properties[field]).toBeDefined();
});
