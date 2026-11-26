import { z } from 'zod';
import type { Operation } from './operations.js';
import type { KnowledgeClient } from './service.js';
import {
  toDooFullToolSchemas,
  toDooFullToolMetadata,
  toDooFullToolOutputs,
  type ToDooFullToolName,
} from '../../../shared/mcp-to-doo-tools.js';

export function createToDooFullToolOperations(client: KnowledgeClient): Operation[] {
  return (Object.keys(toDooFullToolSchemas) as ToDooFullToolName[]).map((name) => ({
    name,
    ...toDooFullToolMetadata[name],
    input: toDooFullToolSchemas[name],
    output: z.object({ data: toDooFullToolOutputs[name] }).strict(),
    run: (principal, input, options) =>
      client.domainTool(
        principal,
        'to-doo',
        name,
        input,
        !toDooFullToolMetadata[name].readOnly,
        options,
      ),
  }));
}
