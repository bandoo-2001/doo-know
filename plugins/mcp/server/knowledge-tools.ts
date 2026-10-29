import { z } from 'zod';
import { knowledgeToolDefinitions } from '../../../shared/mcp-knowledge-tools.js';
import type { Operation } from './operations.js';
import type { KnowledgeClient } from './service.js';

export function createKnowledgeToolOperations(client: KnowledgeClient): Operation[] {
  return knowledgeToolDefinitions.map((definition) => ({
    name: definition.name,
    description: definition.description,
    scope: definition.scopes[0],
    additionalScopes: definition.scopes.slice(1),
    readOnly: definition.readOnly,
    destructive: definition.destructive,
    input: definition.input,
    output: z.object({ data: definition.output }).strict(),
    run: (p, args, options) =>
      client.domainTool(p, 'knowledge', definition.name, args, !definition.readOnly, options),
  }));
}
