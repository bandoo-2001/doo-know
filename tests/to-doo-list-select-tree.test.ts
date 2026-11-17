import { expect, test } from 'vitest';
import {
  matchesToDooListSearch,
  toDooListSelectTree,
  toDooListSubtreeDepth,
} from '../apps/web/to-doo-list-select-tree';

const list = (id: string, parentId: string | null = null, extra: Record<string, unknown> = {}) => ({
  id,
  name: id,
  parentId,
  ...extra,
});
test('builds selectable list branches with the same icons, colors and paths as navigation', () => {
  const tree = toDooListSelectTree([
    list('work', null, { icon: 'folder', color: '#4566c6' }),
    list('product', 'work'),
    list('design', 'product', { icon: '🎨' }),
  ]);
  expect(tree).toHaveLength(1);
  const leaf = tree[0].children[0].children[0];
  expect(tree[0].list).toMatchObject({ icon: 'folder', color: '#4566c6' });
  expect(leaf).toMatchObject({
    value: 'design',
    depth: 2,
    searchText: 'work / product / design',
    list: { icon: '🎨' },
  });
});
test('parent selection excludes itself and descendants through an archived node', () => {
  const tree = toDooListSelectTree(
    [
      list('root'),
      list('child', 'root', { archivedAt: '2026-11-16T00:00:00Z' }),
      list('leaf', 'child'),
      list('other'),
    ],
    { parentMode: true, excludeId: 'root' },
  );
  expect(tree.map((node) => node.value)).toEqual(['other']);
});
test('limits the new parent and creation targets using the entire archived subtree', () => {
  const lists = [
    ...Array.from({ length: 8 }, (_, index) =>
      list('level-' + index, index ? 'level-' + (index - 1) : null),
    ),
    list('moving'),
    list('child', 'moving'),
    list('leaf', 'child', { archivedAt: '2026-11-16T00:00:00Z' }),
  ];
  expect(toDooListSubtreeDepth(lists, 'moving')).toBe(3);
  const tree = toDooListSelectTree(lists, { parentMode: true, excludeId: 'moving' });
  let node = tree[0];
  for (let depth = 0; depth < 5; depth++) {
    expect(node.value).toBe('level-' + depth);
    expect(node.canCreateChild).toBe(depth < 4);
    if (depth < 4) node = node.children[0];
  }
  expect(node.children).toEqual([]);
});
test('keeps partially loaded children available and ignores deleted and archived choices', () => {
  const tree = toDooListSelectTree([
    list('missing-child', 'unloaded'),
    list('deleted', null, { deletedAt: '2026-11-16T00:00:00Z' }),
    list('archived', null, { archivedAt: '2026-11-16T00:00:00Z' }),
  ]);
  expect(tree.map((node) => node.value)).toEqual(['missing-child']);
});
test.each([
  ['前端 类型', '学习 / 前端进阶 / 类型练习', true],
  ['前端类型', '学习 / 前端进阶 / 类型练习', true],
  ['TYPESCRIPT', 'Learning / TypeScript', true],
  ['ｔｙｐｅ', 'TypeScript', true],
  ['旅行', '学习 / 前端进阶 / 类型练习', false],
  ['  ', '学习', true],
])('filters %s against names and parent paths', (query, value, expected) => {
  expect(matchesToDooListSearch(query, value)).toBe(expected);
});
