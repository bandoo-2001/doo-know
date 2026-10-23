import { it, expect } from 'vitest';
import { pluginRuntimeFixture } from '../support/plugin-runtime.js';
import { createOperations } from '../../plugins/mcp/server/operations.js';
import { hostClient } from '../../plugins/mcp/server/service.js';

it('keeps the precise match line through the MCP search output contract', async () => {
  const f = await pluginRuntimeFixture();
  try {
    await f.services.knowledge.create({
      directory: '00-Inbox',
      fileName: 'observations.md',
      content: '# 观测记录\n\n水文观测记录。',
      requestId: 'create-observations',
    });
    const registry = createOperations(
      { objectIdSecret: 'fixture-reference-secret-at-least-thirty-two-characters' },
      hostClient(
        () => f.services,
        () => ({ externalWebOrigin: 'https://notes.example' }),
      ),
    );
    const result: any = await registry.execute('search_notes', f.principal, {
      query: '水文',
      mode: 'text',
      freshness: 'strict',
    });
    expect(result.data.results[0].matches[0]).toMatchObject({ startLine: 1, matchLine: 3 });
    expect(result.data.results[0].matches[0].url).toMatch(/#L3$/);
  } finally {
    await f.close();
  }
});
