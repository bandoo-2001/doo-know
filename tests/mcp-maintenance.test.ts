import { expect, it } from 'vitest';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createOperations } from '../plugins/mcp/server/operations.js';
import { hostClient } from '../plugins/mcp/server/service.js';
import { pluginRuntimeFixture } from './support/plugin-runtime.js';

const secret = 'mcp-maintenance-fixture-reference-secret-at-least-32-characters';
it.each(['abort', 'deadline'])('bounds an in-flight HostSDK metadata read on %s', async (reason) => {
  const f = await pluginRuntimeFixture();
  try {
    const created = await f.services.knowledge.create({ directory: '00-Inbox', fileName: 'slow.md', content: '# Slow', requestId: 'slow-create' });
    const info = await f.services.knowledge.info({ noteId: created.id });
    const delayed = { ...f.services, knowledge: { ...f.services.knowledge, info: async () => {
      await new Promise((resolve) => setTimeout(resolve, 80)); return info;
    } } };
    const client = hostClient(() => delayed, () => ({}));
    const controller = new AbortController();
    const timer = reason === 'abort' ? setTimeout(() => controller.abort(), 10) : undefined;
    const pending = client.info(f.principal, { noteId: created.id }, { signal: controller.signal, deadline: Date.now() + (reason === 'deadline' ? 10 : 1000) });
    await expect(pending).rejects.toMatchObject({ code: 'CALL_CANCELLED' });
    clearTimeout(timer);
  } finally { await f.close(); }
});

it('replays a successful MCP update receipt after the current file enters large mode', async () => {
  const f = await pluginRuntimeFixture();
  try {
    const registry = createOperations({ objectIdSecret: secret }, hostClient(() => f.services, () => ({})));
    const created: any = await registry.execute('create_note', f.principal, { directory: '00-Inbox', fileName: 'receipt.md', content: '# A', requestId: 'receipt-create' });
    const input = { noteId: created.data.id, content: '# B', expectedModifiedAt: created.data.modifiedAt, requestId: 'receipt-save' };
    const first = await registry.execute('update_note', f.principal, input);
    await writeFile(join(f.config.knowledgeRoot, created.data.relativePath), 'x'.repeat(1024 * 1024 + 1));
    expect(await registry.execute('update_note', f.principal, input)).toEqual(first);
  } finally { await f.close(); }
});

it('continues the original list request after response budgeting reduces its backend page size', async () => {
  const f = await pluginRuntimeFixture();
  try {
    const directory = '00-Inbox/' + Array.from({ length: 4 }, (_, index) => String(index) + '-'.repeat(174)).join('/');
    await mkdir(join(f.config.knowledgeRoot, directory), { recursive: true });
    for (let index = 0; index < 30; index++) await f.services.knowledge.create({ directory, fileName: `page-${String(index).padStart(2, '0')}.md`, content: '# Short title', requestId: `page-create-${index}` });
    const externalWebOrigin = 'https://' + Array.from({ length: 4 }, () => 'n'.repeat(50)).join('.') + '.example';
    const registry = createOperations({ objectIdSecret: secret }, hostClient(() => f.services, () => ({ externalWebOrigin })));
    const ids: string[] = []; let cursor: string | undefined;
    do {
      const page: any = await registry.execute('list_notes', f.principal, { limit: 50, directory, ...(cursor ? { cursor } : {}) });
      ids.push(...page.data.items.map((note: any) => note.id)); cursor = page.data.nextCursor;
    } while (cursor);
    expect(ids).toHaveLength(30); expect(new Set(ids).size).toBe(30);
  } finally { await f.close(); }
});

it('preserves a confirmed write receipt after disconnect and reports an overdue writer as unknown with its original requestId', async () => {
  const f = await pluginRuntimeFixture();
  try {
    const receipt = await f.services.knowledge.create({ directory: '00-Inbox', fileName: 'write.md', content: '# Write', requestId: 'write-create' });
    const controller = new AbortController();
    const services = { ...f.services, knowledge: { ...f.services.knowledge, create: async () => {
      controller.abort(); await new Promise((resolve) => setTimeout(resolve, 10)); return receipt;
    } } };
    const client = hostClient(() => services, () => ({}));
    expect(await client.create(f.principal, { requestId: 'write-create' }, { signal: controller.signal, deadline: Date.now() + 1000 })).toMatchObject({ id: receipt.id });
    await expect(client.create(f.principal, { requestId: 'overdue-write' }, { deadline: Date.now() + 1 })).rejects.toMatchObject({ code: 'OPERATION_OUTCOME_UNKNOWN', requestId: 'overdue-write', retryable: true });
  } finally { await f.close(); }
});
