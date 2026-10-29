import { expect, it } from 'vitest';
import { z } from 'zod';
import { annotateError, BridgeError, errorBody, invalidInput } from '../plugins/mcp/server/errors.js';
import { hostClient } from '../plugins/mcp/server/service.js';
import type { PluginServices } from '../packages/plugin-sdk/index.js';
import type { Principal } from '../shared/knowledge-contracts.js';
const p: Principal = { id: 'owner', clientId: 'client', scopes: ['to-doo:read', 'to-doo:write'], allowedPrefixes: [] };

it('keeps public task field paths while removing unknown user-controlled keys and messages', () => {
  const body = errorBody(invalidInput('execute_to_doo_command', [
    { code: 'invalid_type', path: ['payload', 'occurrenceId'], message: 'private body' },
    { code: 'invalid_type', path: ['payload', 'expectedRevision'], message: 'private body' },
    { code: 'custom', path: ['payload', 'private-secret-field'], message: 'private body' },
  ]));
  expect(body.error.issues?.map(i => i.path)).toEqual([['payload', 'occurrenceId'], ['payload', 'expectedRevision'], []]);
  expect(JSON.stringify(body)).not.toContain('private body');
  expect(JSON.stringify(body)).not.toContain('private-secret-field');
});
it('recovers new task writes by the original caller-bound task receipt instead of knowledge operations', () => {
  expect(errorBody(annotateError(new BridgeError('OPERATION_OUTCOME_UNKNOWN', 504, true), 'save_to_doo_entity', { requestId: 'same-request' }))).toMatchObject({ error: { requestId: 'same-request', recovery: { tool: 'get_to_doo_operation', requestIdPolicy: 'preserve' } } });
  expect(errorBody(annotateError(new BridgeError('OPERATION_OUTCOME_UNKNOWN', 504, true), 'create_to_doo_outcome_note', { requestId: 'same-request' }))).toMatchObject({ error: { recovery: { tool: 'get_to_doo_outcome_operation', requestIdPolicy: 'preserve' } } });
});
it('directs task version conflicts back to task data while keeping old note recovery unchanged', () => {
  expect(errorBody(annotateError(new BridgeError('TO_DOO_CONFLICT', 409), 'update_to_doo_task', {}))).toMatchObject({ error: { recovery: { tool: 'query_to_doos', requestIdPolicy: 'new_after_review' } } });
  expect(errorBody(annotateError(new BridgeError('VERSION_CONFLICT', 409), 'update_note', {}))).toMatchObject({ error: { recovery: { tool: 'read_note' } } });
});
it('recovers lifecycle writes using their dedicated authorized receipt path', () => {
  expect(errorBody(annotateError(new BridgeError('OPERATION_OUTCOME_UNKNOWN', 504, true), 'complete_note_asset_upload', { requestId: 'same-request' }))).toMatchObject({ error: { recovery: { tool: 'get_knowledge_operation', requestIdPolicy: 'preserve' } } });
});
it('reports host input validation as invalid input before a write, not an unknown committed outcome', async () => {
  const schema = z.object({ expectedVersion: z.number().int() }).strict();
  const services = { knowledge: {}, blogTools: { call: async (_name: string, input: unknown) => schema.parse(input) } } as unknown as PluginServices;
  const client = hostClient(() => services, () => ({}));
  let failure: unknown;
  try { await client.domainTool(p, 'blog', 'update_blog_draft', { requestId: 'original', expectedVersion: 'private invalid value' }, true); } catch (e) { failure = e; }
  const body = errorBody(failure);
  expect(body).toMatchObject({ error: { code: 'INVALID_INPUT', retryable: false } });
  expect(JSON.stringify(body)).not.toContain('private invalid value');
});
