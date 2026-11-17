import { expect, test } from 'vitest';
import { toDooListRows, type ToDooListBranch } from '../apps/web/to-doo-list-tree';

const list = (
  id: string,
  parentId: string | null = null,
  extra: Partial<ToDooListBranch> = {},
) => ({ id, name: id, parentId, ...extra });

test('list navigation keeps sibling order and visits each parent before its descendants', () => {
  const rows = toDooListRows([
    list('child', 'work'),
    list('personal', null, { orderKey: 'b' }),
    list('work', null, { orderKey: 'a' }),
    list('nested', 'child'),
  ]);
  expect(
    rows.map(({ list, depth, ancestorIds, hasChildren }) => [
      list.id,
      depth,
      ancestorIds,
      hasChildren,
    ]),
  ).toEqual([
    ['work', 0, [], true],
    ['child', 1, ['work'], true],
    ['nested', 2, ['work', 'child'], false],
    ['personal', 0, [], false],
  ]);
});

test('collapsing a parent hides its whole branch without hiding unrelated roots', () => {
  const lists = [list('work'), list('child', 'work'), list('nested', 'child'), list('personal')];
  expect(
    toDooListRows(lists, { collapsedIds: new Set(['work']) }).map((row) => row.list.id),
  ).toEqual(['work', 'personal']);
  expect(
    toDooListRows(lists, { collapsedIds: new Set(['child']) }).map((row) => row.list.id),
  ).toEqual(['work', 'child', 'personal']);
});

test('parent selection excludes the edited list and descendants even through an archived intermediate', () => {
  const lists = [
    list('work'),
    list('child', 'work', { archivedAt: '2026-11-16T00:00:00Z' }),
    list('nested', 'child'),
    list('personal'),
  ];
  expect(toDooListRows(lists, { excludeId: 'work' }).map((row) => row.list.id)).toEqual([
    'personal',
  ]);
});

test('partially loaded or archived parents do not make active child lists disappear', () => {
  const rows = toDooListRows([
    list('missing-child', 'not-loaded'),
    list('archived', null, { archivedAt: '2026-11-16T00:00:00Z' }),
    list('active-child', 'archived'),
    list('deleted', null, { deletedAt: '2026-11-16T00:00:00Z' }),
  ]);
  expect(rows.map((row) => [row.list.id, row.depth])).toEqual([
    ['missing-child', 0],
    ['active-child', 0],
  ]);
});

test('invalid legacy cycles render each list once and retain a usable collapse boundary', () => {
  const lists = [list('one', 'two'), list('two', 'one'), list('self', 'self')];
  const rows = toDooListRows(lists);
  expect(new Set(rows.map((row) => row.list.id))).toEqual(new Set(['one', 'two', 'self']));
  expect(rows).toHaveLength(3);
  expect(rows.find((row) => row.list.id === 'two')!.hasChildren).toBe(false);
  expect(toDooListRows(lists, { excludeId: 'one' }).map((row) => row.list.id)).toEqual(['self']);
});

test('duplicate catalog pages retain the refreshed entity and old flat lists keep their original order', () => {
  const rows = toDooListRows([
    { id: 'one', name: 'old' },
    { id: 'two', name: 'two' },
    { id: 'one', name: 'new' },
  ]);
  expect(rows.map((row) => [row.list.name, row.depth])).toEqual([
    ['new', 0],
    ['two', 0],
  ]);
});
