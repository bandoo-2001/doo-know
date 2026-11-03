import { expect, test, vi } from 'vitest';
import { toDooEntitySchemas } from '../shared/to-doo-contracts';
import type { ToDooItem } from '../apps/web/to-doo-workbench';
import {
  groupTaskItems,
  boardTaskCards,
  saveTaskSection,
  moveTaskSection,
} from '../apps/web/to-doo-task-groups';

const stamp = {
  revision: 'r1',
  createdAt: '2026-11-01T08:00:00Z',
  updatedAt: '2026-11-01T08:00:00Z',
};
const task = (id: string, extra: Record<string, unknown> = {}) =>
  toDooEntitySchemas.task.parse({ ...stamp, id, title: id, listId: 'work', ...extra });
const section = (id: string, orderKey = 'a0', extra: Record<string, unknown> = {}) =>
  toDooEntitySchemas.section.parse({ ...stamp, id, name: id, listId: 'work', orderKey, ...extra });
const item = (
  id: string,
  extra: Record<string, unknown> = {},
  occurrenceId = 'occ-' + id,
  parentOccurrenceId?: string,
) =>
  ({
    key: id + '@' + occurrenceId,
    task: task(id, extra),
    title: id,
    depth: 0,
    date: '',
    blocks: [],
    status: 'todo',
    occurrence: toDooEntitySchemas.occurrence.parse({
      ...stamp,
      id: occurrenceId,
      taskId: id,
      cycleKey: occurrenceId,
      scheduleRevision: 's1',
      parentOccurrenceId,
    }),
  }) as ToDooItem;

test('grouped lists inherit the parent group and retain empty groups and unassigned tasks', () => {
  const parent = item('parent', { sectionId: 'design' });
  const child = item('child', { parentTaskId: 'parent', sectionId: null });
  const loose = item('loose', { sectionId: 'deleted' });
  const groups = groupTaskItems(
    [parent, child, loose],
    [parent.task, child.task, loose.task],
    [
      section('build', 'b'),
      section('design', 'a'),
      section('deleted', 'c', { deletedAt: stamp.createdAt }),
    ],
    'work',
  );
  expect(groups.map((group) => [group.name, group.items.map((row) => row.task.id)])).toEqual([
    ['design', ['parent', 'child']],
    ['build', []],
    ['未分组', ['loose']],
  ]);
});

test('a filtered child keeps its group even when its parent is absent from visible results', () => {
  const parent = task('parent', { sectionId: 'design' });
  const child = item('child', { parentTaskId: 'parent' });
  expect(
    groupTaskItems([child], [parent, child.task], [section('design')], 'work')[0].items.map(
      (row) => row.task.id,
    ),
  ).toEqual(['child']);
});

test('an explicit child group overrides inheritance so dragging a child to another group remains meaningful', () => {
  const parent = task('parent', { sectionId: 'design' });
  const child = item('child', { parentTaskId: 'parent', sectionId: 'build' });
  const groups = groupTaskItems(
    [child],
    [parent, child.task],
    [section('design', 'a'), section('build', 'b')],
    'work',
  );
  expect(groups.find((group) => group.id === 'build')!.items.map((row) => row.task.id)).toEqual([
    'child',
  ]);
  expect(groups.find((group) => group.id === 'design')!.items).toEqual([]);
});

test('grouping resolves long ancestor chains without repeatedly walking every ancestor for every item', () => {
  let reads = 0;
  const items = Array.from({ length: 200 }, (_, index) =>
    item('task-' + index, {
      sectionId: index === 0 ? 'design' : null,
      parentTaskId: index === 0 ? null : 'task-' + (index - 1),
    }),
  );
  for (const row of items) {
    const parent = row.task.parentTaskId;
    Object.defineProperty(row.task, 'parentTaskId', {
      get: () => {
        reads++;
        return parent;
      },
    });
  }
  expect(
    groupTaskItems(
      items,
      items.map((row) => row.task),
      [section('design')],
      'work',
    )[0].items,
  ).toHaveLength(200);
  expect(reads).toBeLessThan(2000);
});

test('board cards associate recurring children with the correct parent occurrence', () => {
  const one = item('parent', {}, 'parent-one');
  const two = item('parent', {}, 'parent-two');
  const first = item('child', { parentTaskId: 'parent' }, 'child-one', 'parent-one');
  const second = item('child', { parentTaskId: 'parent' }, 'child-two', 'parent-two');
  const lone = item('other-child', { parentTaskId: 'outside-column' });
  const cards = boardTaskCards([one, first, two, second, lone]);
  expect(cards.map((card) => [card.item.key, card.children.map((child) => child.key)])).toEqual([
    ['parent@parent-one', ['child@child-one']],
    ['parent@parent-two', ['child@child-two']],
    ['other-child@occ-other-child', []],
  ]);
});

test('a cancelled adjacent-group form cannot reorder groups, while saving inserts atomically with revisions', async () => {
  const execute = vi.fn(async (_command: unknown, _notice?: string) => ({ ids: ['new-section'] }));
  const request = vi.fn(async () => ({
    version: 'v1',
    sections: [section('one', 'a'), section('two', 'b')],
    page: {},
  }));
  const model = { request, execute };
  expect(execute).not.toHaveBeenCalled();
  await saveTaskSection(
    model as any,
    { id: 'new-section', name: '插入的分组', listId: 'work' },
    { beforeId: 'two' },
  );
  const command = execute.mock.calls[0]?.[0] as any;
  expect(command.action).toBe('import_entities');
  expect(command.payload.entities.map((row: any) => row.entity.id)).toEqual([
    'one',
    'new-section',
    'two',
  ]);
  expect(
    command.payload.entities
      .filter((row: any) => row.expectedRevision)
      .map((row: any) => row.expectedRevision),
  ).toEqual(['r1', 'r1']);
});

test('group ordering reads every page and refuses inconsistent reads', async () => {
  const execute = vi.fn();
  const request = vi
    .fn()
    .mockResolvedValueOnce({
      version: 'v1',
      sections: [section('one')],
      page: { nextCursor: 'next' },
    })
    .mockResolvedValueOnce({ version: 'v2', sections: [section('two')], page: {} });
  await expect(moveTaskSection({ request, execute } as any, section('one'), 1)).rejects.toThrow(
    /更新/,
  );
  expect(request).toHaveBeenCalledTimes(2);
  expect(execute).not.toHaveBeenCalled();
});
