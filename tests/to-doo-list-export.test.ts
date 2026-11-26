import { afterEach, expect, it } from 'vitest';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { openDatabase } from '../packages/core/db';
import { noteService } from '../packages/core/notes';
import { createToDooService } from '../packages/core/to-doo/service';
import {
  createToDooInterop,
  exportPortableJson,
  validatePortableJson,
} from '../packages/core/to-doo/interop';
import { createToDooToolPort } from '../apps/server/to-doo/mcp-tools';
import { createMcpTransferStore } from '../apps/server/mcp/mcp-transfers';
import { requireScope } from '../packages/core/agent/auth';
import { pluginRuntimeFixture } from './support/plugin-runtime';
import type { McpDomainContext } from '../apps/server/mcp/mcp-domain-context';
import type { ToDooService } from '../shared/to-doo-contracts';

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});
async function destination() {
  const root = await mkdtemp(join(tmpdir(), 'to-doo-list-export-'));
  const config = {
    knowledgeRoot: join(root, 'knowledge'),
    dataRoot: join(root, 'data'),
    origin: 'http://localhost:3010',
    secret: 'list-export-test-only-secret',
  };
  await mkdir(config.knowledgeRoot);
  const db = openDatabase(config.dataRoot);
  const service = createToDooService(config, db, noteService(config, db));
  const interop = createToDooInterop(service, { db, dataRoot: config.dataRoot });
  cleanups.push(async () => {
    await interop.close();
    service.close();
    db.close();
    await rm(root, { recursive: true, force: true });
  });
  return { service, interop };
}
function seedHierarchy(service: ToDooService) {
  for (const entity of [
    { id: 'private-parent', name: 'PRIVATE PARENT TITLE', icon: 'folder' },
    {
      id: 'selected-child',
      name: 'Selected reading list',
      parentId: 'private-parent',
      icon: '📚',
      color: '#4566c6',
    },
  ])
    service.command({
      requestId: randomUUID(),
      action: 'save_entity',
      payload: { kind: 'list', entity },
    });
  service.command({
    requestId: randomUUID(),
    action: 'create_task',
    payload: {
      id: 'selected-task',
      title: 'Keep this reading task',
      listId: 'selected-child',
    },
  });
}
function restore(target: Awaited<ReturnType<typeof destination>>, content: string) {
  validatePortableJson(content);
  const preview = target.interop.previewImport({ format: 'json', content });
  target.interop.applyImport({ previewId: preview.id, requestId: randomUUID() });
  return target.service.snapshot({ all: true });
}

it('restores an owner listIds subset without importing its omitted parent or changing the source', async () => {
  const source = await destination(),
    target = await destination();
  seedHierarchy(source.service);
  const selected = source.service.snapshot({ all: true, listIds: ['selected-child'] });
  expect(selected.lists.map((list) => list.id)).toEqual(['selected-child']);
  expect(selected.lists[0].parentId).toBe('private-parent');
  const content = exportPortableJson(selected);
  expect(content).not.toContain('private-parent');
  expect(content).not.toContain('PRIVATE PARENT TITLE');
  const after = restore(target, content);
  expect(after.lists).toHaveLength(1);
  expect(after.lists[0]).toMatchObject({
    id: 'selected-child',
    parentId: null,
    icon: '📚',
    color: '#4566c6',
  });
  expect(after.tasks.find((task) => task.id === 'selected-task')).toMatchObject({
    listId: 'selected-child',
  });
  expect(selected.lists[0].parentId).toBe('private-parent');
  expect(source.service.getEntity('list', 'selected-child')).toMatchObject({
    parentId: 'private-parent',
  });
});

it('keeps the hierarchy restorable when both parent and child are included in the owner export', async () => {
  const source = await destination(),
    target = await destination();
  seedHierarchy(source.service);
  const content = exportPortableJson(
    source.service.snapshot({ all: true, listIds: ['private-parent', 'selected-child'] }),
  );
  const after = restore(target, content);
  expect(after.lists).toHaveLength(2);
  expect(target.service.getEntity('list', 'selected-child')).toMatchObject({
    parentId: 'private-parent',
    icon: '📚',
  });
  expect(target.service.getEntity('list', 'private-parent')).toMatchObject({
    parentId: null,
    icon: 'folder',
  });
});

it('restores a restricted MCP child-list export and warns without leaking the private parent identity', async () => {
  const source = await pluginRuntimeFixture();
  cleanups.push(source.close);
  const target = await destination();
  const service = source.platform.get().toDoo;
  seedHierarchy(service);
  const principal = {
    ...source.principal,
    scopes: [...source.principal.scopes, 'to-doo:read', 'to-doo:share'],
  };
  const transfers = createMcpTransferStore(source.config, source.db);
  const context: McpDomainContext = {
    config: source.config,
    db: source.db,
    runtime: source.platform.get(),
    transfers,
    authorize(scopes) {
      for (const scope of scopes) requireScope(principal, scope);
      return principal;
    },
    toDooAccess: () => ({ listIds: ['selected-child'], domains: ['tasks'] }),
  };
  const port = createToDooToolPort(context);
  const output: any = await port.call('export_to_doo_data', {
    requestId: 'export-selected-child',
    format: 'json',
  });
  expect(output.warnings).toEqual([expect.stringMatching(/顶层清单/)]);
  expect(JSON.stringify(output)).not.toContain('private-parent');
  expect(JSON.stringify(output)).not.toContain('PRIVATE PARENT TITLE');
  const chunks: Buffer[] = [];
  let offset = 0;
  while (true) {
    const chunk = transfers.read(principal, {
      transferId: output.transferId,
      offset,
      maxBytes: 8192,
    });
    chunks.push(Buffer.from(chunk.base64, 'base64'));
    if (chunk.done) break;
    offset = chunk.nextOffset;
  }
  const content = Buffer.concat(chunks).toString('utf8');
  expect(content).not.toContain('private-parent');
  expect(content).not.toContain('PRIVATE PARENT TITLE');
  const after = restore(target, content);
  expect(after.lists).toHaveLength(1);
  expect(after.lists[0]).toMatchObject({ id: 'selected-child', parentId: null, icon: '📚' });
  expect(after.tasks.find((task) => task.id === 'selected-task')).toMatchObject({
    listId: 'selected-child',
  });
  expect(service.getEntity('list', 'selected-child')).toMatchObject({ parentId: 'private-parent' });
});
