import { it, expect } from 'vitest';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pluginRuntimeFixture } from './support/plugin-runtime.js';
import { createOperations } from '../plugins/mcp/server/operations.js';
import { hostClient } from '../plugins/mcp/server/service.js';
it('runs inherited MCP tools through the host SDK and retains fixed write receipts and scope checks', async () => {
  const f = await pluginRuntimeFixture();
  try {
    const registry = createOperations({ objectIdSecret: 'fixture-reference-secret-at-least-thirty-two-characters' },
      hostClient(() => f.services, () => ({ externalWebOrigin: 'https://notes.example' })));
    expect(registry.operations).toHaveLength(27);
    const created: any = await registry.execute('create_note', f.principal, { directory: '00-Inbox', fileName: 'mcp.md', content: '# A', requestId: 'mcp-create' });
    const input = { noteId: created.data.id, content: '# B', expectedModifiedAt: created.data.modifiedAt, requestId: 'mcp-save-B' };
    const first: any = await registry.execute('update_note', f.principal, input);
    await registry.execute('update_note', f.principal, { ...input, content: '# C', expectedModifiedAt: first.data.modifiedAt, requestId: 'mcp-save-C' });
    expect(await registry.execute('update_note', f.principal, input)).toEqual(first);
    await expect(registry.execute('create_note', { ...f.principal, scopes: ['knowledge:read'] }, { directory: '00-Inbox', fileName: 'denied.md', content: '', requestId: 'denied' })).rejects.toMatchObject({ code: 'INSUFFICIENT_SCOPE' });
    const info: any = await registry.execute('get_note_info', f.principal, { noteId: created.data.id });
    expect(info.data.url).toContain('https://notes.example/');
  } finally { await f.close(); }
});
it('skips a genuinely stale search candidate and retains degraded search diagnostics without localhost citations', async () => {
  const f = await pluginRuntimeFixture();
  try {
    for (let i = 0; i < 2; i++) await f.services.knowledge.create({ directory: '00-Inbox', fileName: `search-${i}.md`, content: '# 搜索资料\n知识经验', requestId: `search-create-${i}` });
    await f.platform.get().knowledge.indexing.reconcile(undefined, true);
    await f.platform.get().knowledge.worker.drain();
    const client = hostClient(() => f.services, () => ({ externalWebOrigin: '' }));
    const search = client.search.bind(client);
    client.search = async (...args: Parameters<typeof client.search>) => {
      const found = await search(...args);
      await writeFile(join(f.config.knowledgeRoot, found.results[0].relativePath), '# 外部修改');
      return found;
    };
    const registry = createOperations({ objectIdSecret: 'fixture-reference-secret-at-least-thirty-two-characters' }, client);
    const result: any = await registry.execute('search', f.principal, { query: '知识' });
    expect(result.results).toHaveLength(1);
    expect(result.degraded).toBe(true);
    expect(result.reasons).toContain('RESULT_STALE');
    expect(result.reasons).toContain('VECTOR_NOT_CONFIGURED');
    expect(JSON.stringify(result)).not.toContain('localhost');
    expect(result.results[0].id).toMatch(/^dk1\./);
  } finally { await f.close(); }
});
