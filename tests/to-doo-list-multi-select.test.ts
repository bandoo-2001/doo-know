import { expect, test } from 'vitest';
import {
  prepareToDooListMultiSelection,
  readToDooListMultiChange,
} from '../apps/web/to-doo-list-multi-select';

const lists = [
  { id: 'work', name: '工作', icon: 'folder', color: '#4566c6' },
  { id: 'reading', name: '阅读', parentId: 'work', icon: '📚', color: '#4f8c7a' },
];
test('strict checking preserves separate parent and child IDs without implicitly expanding a branch', () => {
  const prepared = prepareToDooListMultiSelection(lists, []);
  const parent = prepared.tree[0],
    child = parent.children![0];
  expect(
    readToDooListMultiChange([{ value: parent.value, label: '工作' }], prepared.controlToDomain),
  ).toEqual(['work']);
  expect(
    readToDooListMultiChange(
      [{ value: parent.value }, { value: child.value }],
      prepared.controlToDomain,
    ),
  ).toEqual(['work', 'reading']);
  expect(child.list).toMatchObject({ icon: '📚', color: '#4f8c7a' });
});
test('converts labeled values and clearing back to unique plain domain IDs', () => {
  const prepared = prepareToDooListMultiSelection(lists, ['reading', 'reading']);
  expect(prepared.values).toHaveLength(1);
  const value = prepared.values[0].value;
  expect(
    readToDooListMultiChange([{ value, label: '阅读' }, { value }], prepared.controlToDomain),
  ).toEqual(['reading']);
  expect(readToDooListMultiChange([], prepared.controlToDomain)).toEqual([]);
});
test('includes an independent unassigned sentinel only when requested', () => {
  const prepared = prepareToDooListMultiSelection(lists, ['inbox', 'reading'], true);
  expect(prepared.tree[0].label).toBe('收集箱');
  expect(readToDooListMultiChange(prepared.values, prepared.controlToDomain)).toEqual([
    'inbox',
    'reading',
  ]);
  expect(
    prepareToDooListMultiSelection(lists, []).tree.some((node) => node.label === '收集箱'),
  ).toBe(false);
});
test('preserves a selected item while the complete catalogue is loading', () => {
  const prepared = prepareToDooListMultiSelection([], ['reading']);
  expect(prepared.tree[0]).toMatchObject({ disabled: true, label: '当前清单（尚未载入）' });
  expect(readToDooListMultiChange(prepared.values, prepared.controlToDomain)).toEqual(['reading']);
});
test('rejects unexpected control values instead of partially clearing a filter', () => {
  const prepared = prepareToDooListMultiSelection(lists, ['reading']);
  for (const value of [
    null,
    false,
    'reading',
    [{ value: 'reading' }],
    [{ value: prepared.values[0].value }, { value: false }],
  ])
    expect(readToDooListMultiChange(value, prepared.controlToDomain)).toBeNull();
});
test('ignores half-checked bookkeeping without adding a parent scope', () => {
  const prepared = prepareToDooListMultiSelection(lists, ['reading']);
  expect(
    readToDooListMultiChange(
      [{ value: prepared.tree[0].value, halfChecked: true }, ...prepared.values],
      prepared.controlToDomain,
    ),
  ).toEqual(['reading']);
});
