import { z } from 'zod';
import { transferToolDefinitions } from '../../../shared/mcp-transfer-tools.js';
import type { KnowledgeClient } from './service.js';
import type { Operation } from './operations.js';
export function createTransferToolOperations(client: KnowledgeClient): Operation[] {
  return transferToolDefinitions.map(definition => ({ name: definition.name, description: definition.description, readOnly: definition.readOnly, input: definition.input, output: z.object({ data: definition.output }).strict(), run: (p, input, options) => client.domainTool(p, 'transfers', definition.name, input, !definition.readOnly, options) }));
}
