import { expect, it } from 'vitest';
import Ajv from 'ajv';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { PluginServices } from '../packages/plugin-sdk/index.js';
import { KnowledgeError } from '../packages/core/knowledge/errors.js';
import { BlogError } from '../packages/core/blog/errors.js';
import { requireScope } from '../plugins/mcp/server/auth.js';
import { createOperations, registerOperations } from '../plugins/mcp/server/operations.js';
import * as errors from '../plugins/mcp/server/errors.js';
import { hostClient } from '../plugins/mcp/server/service.js';

const principal = { id: 'error-fixture-owner', clientId: 'error-fixture-client', scopes: ['knowledge:read'], allowedPrefixes: ['00-Inbox'] };
const privateMarker = 'PRIVATE_BODY_OR_BACKEND_MESSAGE';

it('returns the specific missing scope instead of making an agent guess the authorization', () => {
  let denied: unknown;
  try { requireScope(principal, 'knowledge:write'); } catch (error) { denied = error; }
  expect(errors.errorBody(denied)).toMatchObject({ error: { code: 'INSUFFICIENT_SCOPE', requiredScope: 'knowledge:write' } });
});

it.each(['direct', 'details'])('keeps a safe backend conflict version from %s without returning its message or other details', async (location) => {
  const conflict = new KnowledgeError(409, 'VERSION_CONFLICT', privateMarker, false, { privateText: privateMarker });
  Object.assign(location === 'direct' ? conflict : conflict.details, { currentModifiedAt: '1234567890123456789' });
  const services = { knowledge: { update: async () => { throw conflict; } } } as unknown as PluginServices;
  const client = hostClient(() => services, () => ({}));
  let failure: unknown;
  try { await client.update(principal, { noteId: 'fixture-note', content: privateMarker, requestId: 'conflict-fixture' }); } catch (error) { failure = error; }
  const body = errors.errorBody(failure);
  expect(body).toMatchObject({ error: { code: 'VERSION_CONFLICT', retryable: false, requestId: 'conflict-fixture', currentModifiedAt: '1234567890123456789' } });
  expect(JSON.stringify(body)).not.toContain(privateMarker);
});

it('keeps a recognized backend scope while discarding its private details', async () => {
  const denied = Object.assign(new KnowledgeError(403, 'INSUFFICIENT_SCOPE', privateMarker, false, { privateText: privateMarker }), { requiredScope: 'knowledge:index' });
  const services = { knowledge: { status: async () => { throw denied; } } } as unknown as PluginServices;
  let failure: unknown;
  try { await hostClient(() => services, () => ({})).status(principal, {}); } catch (error) { failure = error; }
  expect(errors.errorBody(failure)).toMatchObject({ error: { code: 'INSUFFICIENT_SCOPE', requiredScope: 'knowledge:index' } });
  expect(JSON.stringify(errors.errorBody(failure))).not.toContain(privateMarker);
});

it('makes a known conflict require reading the new body and merging before a new request ID', () => {
  const failure = errors.annotateError(new errors.BridgeError('VERSION_CONFLICT', 409), 'update_note', { noteId: 'private-note', requestId: 'old-attempt', content: privateMarker });
  const body = errors.errorBody(failure);
  expect(body).toMatchObject({ error: { requestId: 'old-attempt', recovery: { action: 'read_and_merge', tool: 'read_note', requestIdPolicy: 'new_after_review' } } });
  expect(body.error.recovery?.message).toMatch(/正文/);
  expect(body.error.recovery?.message).toMatch(/合并/);
  expect(JSON.stringify(body)).not.toContain(privateMarker);
  expect(JSON.stringify(body)).not.toContain('private-note');
});

it.each(['publish_blog_post', 'unpublish_blog_post'] as const)('recovers a %s publication conflict through normal SDK discovery and status lookup', async (tool) => {
  const post = {
    id: 'fixture-post', sourceNoteId: 'fixture-note', sourceTitle: 'Fixture source', sourceModifiedAt: '456', sourceHash: 'b'.repeat(64),
    version: 7, state: 'published', publishedVersionId: 'fixture-publication', publishedAt: '2026-10-26T00:00:00.000Z', updatedAt: '2026-10-26T00:00:00.000Z',
    hasUnpublishedChanges: false, url: 'https://blog.example/blog/fixture', slug: 'fixture', title: 'Fixture post', summary: '', category: '', tags: [], pinned: false, cover: null,
  };
  const refuseStalePublication = async (input: { expectedPublicationVersion: number }) => {
    if (input.expectedPublicationVersion !== 1) throw new Error('Unexpected fixture publication version');
    throw new BlogError(409, privateMarker, { privateText: privateMarker });
  };
  const services = { knowledge: {}, blog: {
    publish: refuseStalePublication, unpublish: refuseStalePublication,
    status: async () => ({ siteEnabled: true, post, publicationVersion: 7, source: { noteId: 'fixture-note', title: 'Fixture source', relativePath: '00-Inbox/fixture.md', modifiedAt: '456', contentHash: 'b'.repeat(64) } }),
  } } as unknown as PluginServices;
  const registry = createOperations({ objectIdSecret: 'error-publication-fixture-secret-at-least-32-characters' }, hostClient(() => services, () => ({})));
  const server = new McpServer({ name: 'error-publication-fixture', version: '1.1.1' });
  registerOperations(server, registry, { ...principal, scopes: ['knowledge:read', 'knowledge:write', 'blog:publish'] }, {});
  const client = new Client({ name: 'error-publication-client', version: '1' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    const discovered = await client.listTools();
    expect(discovered.tools.some(entry => entry.name === tool)).toBe(true);
    const result = await client.callTool({ name: tool, arguments: {
      noteId: 'fixture-note', expectedPublicationVersion: 1, requestId: 'blog-review-attempt',
      ...(tool === 'publish_blog_post' ? { expectedModifiedAt: '456', expectedContentHash: 'b'.repeat(64) } : {}),
    } });
    expect(result).toMatchObject({ isError: true, structuredContent: { error: {
      code: 'VERSION_CONFLICT', retryable: false, requestId: 'blog-review-attempt',
      recovery: { action: 'review_publication', tool: 'get_blog_status', requestIdPolicy: 'new_after_review' },
    } } });
    const body = result.structuredContent as ReturnType<typeof errors.errorBody>;
    expect(body.error.message).toMatch(/博客.*版本/);
    expect(body.error.recovery?.message).toMatch(/发布版本.*原文.*意图/);
    if (tool === 'publish_blog_post') expect(body.error.recovery?.message).toMatch(/正文.*公开/);
    else expect(body.error.recovery?.message).toMatch(/撤下/);
    expect(JSON.stringify(result)).not.toContain(privateMarker);
    const validate = new Ajv({ strict: false }).compile(errors.bridgeErrorSchema);
    expect(validate(body), JSON.stringify(validate.errors)).toBe(true);
    const status = await client.callTool({ name: body.error.recovery!.tool!, arguments: { noteId: 'fixture-note' } });
    expect(status).toMatchObject({ structuredContent: { data: { publicationVersion: 7, source: { modifiedAt: '456', contentHash: 'b'.repeat(64) } } } });
  } finally { await client.close(); await server.close(); }
});

it('keeps the original request ID when the backend cannot confirm whether a write committed', async () => {
  const services = { knowledge: { create: async () => { throw new Error(privateMarker); } } } as unknown as PluginServices;
  const client = hostClient(() => services, () => ({}));
  let failure: unknown;
  try { await client.create(principal, { requestId: 'original-write', content: privateMarker }); } catch (error) { failure = error; }
  const body = errors.errorBody(failure);
  expect(body).toMatchObject({ error: { code: 'OPERATION_OUTCOME_UNKNOWN', retryable: true, requestId: 'original-write', recovery: { action: 'check_operation', tool: 'operation_status', requestIdPolicy: 'preserve' } } });
  expect(JSON.stringify(body)).not.toContain(privateMarker);
});

it('keeps a confirmed write receipt after disconnect instead of replacing success with recovery advice', async () => {
  const controller = new AbortController();
  const receipt = { id: 'fixture-note', relativePath: '00-Inbox/fixture.md', modifiedAt: '123', contentHash: 'a'.repeat(64), sizeBytes: 3, indexState: 'pending' };
  const services = { knowledge: { create: async () => { controller.abort(); return receipt; } } } as unknown as PluginServices;
  const result = await hostClient(() => services, () => ({})).create(principal, { requestId: 'confirmed-write' }, { signal: controller.signal });
  expect(result).toEqual(receipt);
});

it('returns at most eight safe field issues without reflecting unknown keys, messages or codes', () => {
  const failure = errors.invalidInput('patch_note', [
    { code: 'invalid_type', path: ['edits', 0, 'expectedRangeHash'], message: privateMarker },
    { code: privateMarker, path: [privateMarker], message: privateMarker },
    ...Array.from({ length: 12 }, () => ({ code: 'custom', path: ['edits'], message: privateMarker })),
  ]);
  const body = errors.errorBody(failure);
  expect(body.error.code).toBe('INVALID_INPUT');
  expect(body.error.issues).toHaveLength(8);
  expect(body.error.issues?.[0]).toMatchObject({ code: 'invalid_type', path: ['edits', 0, 'expectedRangeHash'] });
  expect(body.error.issues?.[1].path).toEqual([]);
  expect(body.error.recovery).toMatchObject({ action: 'fix_input', tool: 'patch_note' });
  expect(JSON.stringify(body)).not.toContain(privateMarker);
  expect(Buffer.byteLength(JSON.stringify(body))).toBeLessThan(8192);
});

it.each(['', '123x', '1'.repeat(31), privateMarker])('omits malformed backend versions and arbitrary scope metadata (%s)', async (currentModifiedAt) => {
  const backend = Object.assign(new KnowledgeError(409, 'VERSION_CONFLICT', privateMarker, false, { currentModifiedAt, arbitrary: privateMarker }), { requiredScope: privateMarker });
  const services = { knowledge: { update: async () => { throw backend; } } } as unknown as PluginServices;
  let failure: unknown;
  try { await hostClient(() => services, () => ({})).update(principal, { requestId: 'bad-version' }); } catch (error) { failure = error; }
  const body = errors.errorBody(failure);
  expect(body.error).not.toHaveProperty('currentModifiedAt');
  expect(body.error).not.toHaveProperty('requiredScope');
  expect(JSON.stringify(body)).not.toContain(privateMarker);
});

it('does not convert unknown exceptions or invalid correlation IDs into reflected input', () => {
  const body = errors.errorBody(errors.annotateError(new Error(privateMarker), privateMarker, { requestId: 'unsafe\nrequest', content: privateMarker }));
  expect(body).toMatchObject({ error: { code: 'INTERNAL_ERROR', retryable: false } });
  expect(body.error).not.toHaveProperty('requestId');
  expect(body.error).not.toHaveProperty('recovery');
  expect(JSON.stringify(body)).not.toContain(privateMarker);
});

it('restarts expired reads without treating the cursor as new authorization or exposing it', () => {
  const body = errors.errorBody(errors.annotateError(new errors.BridgeError('CURSOR_EXPIRED', 410), 'list_notes', { cursor: privateMarker, directory: privateMarker }));
  expect(body).toMatchObject({ error: { recovery: { action: 'restart_read', tool: 'list_notes', requestIdPolicy: 'not_applicable' } } });
  expect(JSON.stringify(body)).not.toContain(privateMarker);
});

it('publishes an error schema that accepts bounded recovery output and rejects extra fields', () => {
  const validate = new Ajv({ strict: false }).compile(errors.bridgeErrorSchema);
  const body = errors.errorBody(errors.invalidInput('operation_status', [{ code: 'custom', path: [], message: privateMarker }]));
  expect(validate(body), JSON.stringify(validate.errors)).toBe(true);
  expect(validate({ error: { ...body.error, privateBody: privateMarker } })).toBe(false);
});
