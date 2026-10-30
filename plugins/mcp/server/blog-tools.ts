import { z } from 'zod';
import { blogToolDefinitions } from '../../../shared/mcp-blog-tools.js';
import type { Operation } from './operations.js';
import type { KnowledgeClient } from './service.js';

export function createBlogToolOperations(client: KnowledgeClient): Operation[] {
  return blogToolDefinitions.map(definition => ({
    name: definition.name,
    description: definition.description,
    scope: definition.scope,
    additionalScopes: definition.scope === 'blog:read' ? ['knowledge:read'] : ['knowledge:read', 'blog:read'],
    readOnly: definition.readOnly,
    ...('destructive' in definition ? { destructive: definition.destructive } : {}),
    input: definition.input,
    output: z.object({ data: definition.output }).strict(),
    run: (principal, input, options) => client.domainTool(principal, 'blog', definition.name, input, !definition.readOnly, options),
  }));
}
