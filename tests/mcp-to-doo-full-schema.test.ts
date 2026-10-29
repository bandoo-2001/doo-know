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
