import { expect, it } from 'vitest';
import { z } from 'zod';
import {
  toDooFullToolSchemas,
  toDooSchemaDocument,
  toDooEntityFields,
} from '../shared/mcp-to-doo-tools';
import { resultSize } from '../plugins/mcp/server/budgets';
import { toDooCommandSchema, toDooEntitySchemas } from '../shared/to-doo-contracts';

it('publishes every command and entity schema with precise create and optional patch fields', () => {
  for (const command of toDooCommandSchema.options) {
    const action = command.shape.action.value;
    const schema = toDooSchemaDocument('command', action);
    expect(schema).toHaveProperty('properties.payload');
    expect(resultSize({ data: { category: 'command', name: action, schema } })).toBeLessThan(65536);
  }
  for (const kind of Object.keys(toDooEntitySchemas)) {
    const schema = toDooSchemaDocument('entity', kind);
    expect(schema).toHaveProperty('properties');
    expect(resultSize({ data: { category: 'entity', name: kind, schema } })).toBeLessThan(65536);
    expect(toDooSchemaDocument('patch', kind)).toHaveProperty('properties');
  }
  expect(toDooEntityFields('list', true).parse({ description: 'later' })).toEqual({
    description: 'later',
  });
  expect(toDooEntityFields('habit', true).parse({ name: 'later' })).toEqual({ name: 'later' });
  expect(toDooEntityFields('anniversary', true).parse({ description: 'later' })).toEqual({
    description: 'later',
  });
  for (const schema of Object.values(toDooFullToolSchemas)) {
    expect(Buffer.byteLength(JSON.stringify(z.toJSONSchema(schema)))).toBeLessThan(30000);
  }
});

it('accepts restore-unread with the same strict revision and request identity requirements as other reminder actions', () => {
  const schema = toDooFullToolSchemas.act_on_to_doo_reminder;
  const action = {
    id: 'rem-1',
    requestId: 'restore-1',
    expectedRevision: 'revision-1',
    action: 'unread',
  };
  expect(schema.parse(action)).toMatchObject(action);
  expect(schema.safeParse({ ...action, expectedRevision: undefined }).success).toBe(false);
  expect(schema.safeParse({ ...action, action: 'complete' }).success).toBe(false);
});
