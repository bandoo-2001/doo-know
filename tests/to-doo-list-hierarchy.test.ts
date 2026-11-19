import { afterEach, beforeEach, expect, it } from 'vitest';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { openDatabase } from '../packages/core/db';
import { noteService } from '../packages/core/notes';
import { createToDooService } from '../packages/core/to-doo/service';
import { canonical, toDooHash } from '../packages/core/to-doo/store';
import {
  TO_DOO_LIST_MAX_DEPTH,
  toDooEntitySchemas,
  type ToDooEntityMap,
} from '../shared/to-doo-contracts';
import type { AppConfig } from '../shared/contracts';

let root: string;
const databases: ReturnType<typeof openDatabase>[] = [];
const services: ReturnType<typeof createToDooService>[] = [];
let service: ReturnType<typeof createToDooService>;
async function bind(name: string) {
  const config: AppConfig = {
    knowledgeRoot: join(root, name, 'knowledge'),
    dataRoot: join(root, name, 'data'),
    origin: 'http://localhost:3010',
    secret: 'list-hierarchy-fixture-only-secret',
  };
  await mkdir(config.knowledgeRoot, { recursive: true });
  const db = openDatabase(config.dataRoot);
  databases.push(db);
  const next = createToDooService(config, db, noteService(config, db));
  services.push(next);
  return next;
}
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'to-doo-list-hierarchy-'));
  service = await bind('source');
});
afterEach(async () => {
  for (const s of services.splice(0)) s.close();
  for (const db of databases.splice(0)) if (db.open) db.close();
  await rm(root, { recursive: true, force: true });
});
const command = (action: string, payload: unknown) =>
  service.command({ requestId: randomUUID(), action, payload });
const list = (id: string) => service.getEntity('list', id) as ToDooEntityMap['list'];
const save = (id: string, fields: Record<string, unknown> = {}) =>
  command('save_entity', {
    kind: 'list',
    entity: { id, name: id, ...fields },
    ...(list(id) ? { expectedRevision: list(id).revision } : {}),
  });
const remove = (id: string, extra: Record<string, unknown> = {}) =>
  command('delete_entity', { kind: 'list', id, expectedRevision: list(id).revision, ...extra });

it('keeps legacy lists at the root and preserves nested icons through restart and checkpoint import', async () => {
  const legacy = toDooEntitySchemas.list.parse({
    id: 'legacy',
    name: 'Existing list',
    revision: 'v1',
    createdAt: '2026-11-16T00:00:00Z',
    updatedAt: '2026-11-16T00:00:00Z',
  });
  expect(legacy).toMatchObject({ parentId: null, icon: null });
  save('root', { icon: 'folder', color: '#4566c6' });
  save('reading', { parentId: 'root', icon: '📚', kind: 'goal' });
  save('notes', { parentId: 'reading', icon: 'dot' });
  service.close();
  service = await bind('source');
  expect(list('reading')).toMatchObject({ parentId: 'root', icon: '📚', kind: 'goal' });
  const target = await bind('target');
  target.importCheckpoint(service.exportCheckpoint(), 'import-hierarchy');
  expect(target.getEntity('list', 'notes')).toMatchObject({ parentId: 'reading', icon: 'dot' });
});

it('rejects missing, deleted and self-referencing parents without writing partial entities', () => {
  expect(() => save('orphan', { parentId: 'missing' })).toThrow(/上级清单不存在/);
  expect(list('orphan')).toBeUndefined();
  expect(() => save('self', { parentId: 'self' })).toThrow(/循环/);
  expect(list('self')).toBeUndefined();
  save('deleted-parent');
  remove('deleted-parent');
  expect(() => save('orphan', { parentId: 'deleted-parent' })).toThrow(/已删除/);
  expect(list('orphan')).toBeUndefined();
});

it('rejects moving a parent under any descendant and keeps the original hierarchy unchanged', () => {
  save('root');
  save('child', { parentId: 'root' });
  save('grandchild', { parentId: 'child' });
  const revision = list('root').revision;
  expect(() => save('root', { parentId: 'grandchild' })).toThrow(/循环/);
  expect(list('root')).toMatchObject({ parentId: null, revision });
  expect(list('grandchild').parentId).toBe('child');
});

it('checks the whole moved subtree against the eight-level limit', () => {
  for (let depth = 1; depth <= TO_DOO_LIST_MAX_DEPTH; depth++)
    save('level-' + depth, { parentId: depth === 1 ? null : 'level-' + (depth - 1) });
  expect(() => save('too-deep', { parentId: 'level-8' })).toThrow(/最多支持 8 层/);
  save('branch');
  save('leaf', { parentId: 'branch' });
  expect(() => save('branch', { parentId: 'level-7' })).toThrow(/最多支持 8 层/);
  expect(list('branch').parentId).toBeNull();
  save('branch', { parentId: 'level-6' });
  expect(list('branch').parentId).toBe('level-6');
  expect(list('leaf').parentId).toBe('branch');
});

it('preserves children and their tasks when deletion or direct tombstoning targets a parent', () => {
  save('root');
  save('child', { parentId: 'root' });
  const taskId = command('create_task', { title: 'Keep child work', listId: 'child' }).ids[0];
  expect(() => remove('root', { cascade: true })).toThrow(/先移动或移除子清单/);
  expect(() => save('root', { deletedAt: '2026-11-16T00:00:00Z' })).toThrow(/先移动子清单/);
  expect(list('root').deletedAt).toBeNull();
  expect(service.getEntity('task', taskId)).toMatchObject({ listId: 'child', deletedAt: null });
  save('child', { parentId: null });
  remove('root');
  expect(list('root').deletedAt).not.toBeNull();
  expect(list('child').deletedAt).toBeNull();
});

it('requires active children to be moved or archived before their parent is archived', () => {
  save('root');
  save('child', { parentId: 'root' });
  const archivedAt = '2026-11-16T00:00:00Z';
  expect(() => save('root', { archivedAt })).toThrow(/先归档或移动子清单/);
  save('child', { archivedAt });
  save('root', { archivedAt });
  expect(() => save('child', { archivedAt: null })).toThrow(/上级清单已归档/);
  save('root', { archivedAt: null });
  save('child', { archivedAt: null });
  expect(list('child').archivedAt).toBeNull();
});

it('requires a deleted parent to be restored before its child can be restored', () => {
  save('root');
  save('child', { parentId: 'root' });
  remove('child');
  remove('root');
  expect(() => remove('child', { restore: true })).toThrow(/上级清单不存在或已删除/);
  expect(list('child').deletedAt).not.toBeNull();
  remove('root', { restore: true });
  remove('child', { restore: true });
  expect(list('child')).toMatchObject({ parentId: 'root', deletedAt: null });
});

it('imports child-first batches atomically and rejects cycles within a batch', () => {
  command('import_entities', {
    entities: [
      { kind: 'list', entity: { id: 'child', name: 'Child', parentId: 'root', icon: '📚' } },
      { kind: 'list', entity: { id: 'root', name: 'Root', icon: 'folder' } },
    ],
  });
  expect(list('child').parentId).toBe('root');
  expect(() =>
    command('import_entities', {
      entities: [
        { kind: 'list', entity: { id: 'cycle-a', name: 'A', parentId: 'cycle-b' } },
        { kind: 'list', entity: { id: 'cycle-b', name: 'B', parentId: 'cycle-a' } },
      ],
    }),
  ).toThrow(/循环/);
  expect(list('cycle-a')).toBeUndefined();
  expect(list('cycle-b')).toBeUndefined();
});

it('normalizes omitted legacy list fields before comparing an imported checkpoint with current data', () => {
  save('legacy');
  const checkpoint = service.exportCheckpoint();
  for (const entry of checkpoint.entities) {
    if (entry.kind !== 'list') continue;
    Reflect.deleteProperty(entry.entity, 'parentId');
    Reflect.deleteProperty(entry.entity, 'icon');
  }
  const { digest: _digest, ...payload } = checkpoint;
  checkpoint.digest = toDooHash(canonical(payload));
  expect(() => service.importCheckpoint(checkpoint, 'legacy-checkpoint')).not.toThrow();
  expect(list('legacy')).toMatchObject({ parentId: null, icon: null });
});
