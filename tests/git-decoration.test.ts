import { expect, it } from 'vitest';
import { gitDecoration } from '../plugins/git/web/decoration';

it('distinguishes new, modified and deleted notes by Git color', () => {
  const changes = [
    { path: 'notes/new.md', code: '??' },
    { path: 'notes/edited.md', code: ' M' },
    { path: 'notes/deleted.md', code: ' D' },
  ];
  expect(gitDecoration(changes, 'notes/new.md')).toMatchObject({
    color: '#587c0c',
    title: '新增文件，尚未纳入 Git 版本管理',
  });
  expect(gitDecoration(changes, 'notes/edited.md')).toMatchObject({
    color: '#895503',
    title: '文件已修改',
  });
  expect(gitDecoration(changes, 'notes/deleted.md')).toMatchObject({
    color: '#ad0707',
    title: '文件已删除',
  });
  expect(gitDecoration(changes, 'notes/clean.md')).toBeUndefined();
});

it('propagates colors to ancestors with conflicts ahead of other changes', () => {
  const changes = [
    { path: 'notes/sub/new.md', code: '??' },
    { path: 'notes/sub/edited.md', code: 'AM' },
  ];
  expect(gitDecoration(changes.slice(0, 1), 'notes/sub')?.color).toBe('#587c0c');
  expect(gitDecoration(changes, 'notes')?.color).toBe('#895503');
  changes.push({ path: 'notes/conflict.md', code: 'AA' });
  expect(gitDecoration(changes, 'notes')).toMatchObject({
    color: '#ad0707',
    title: '目录包含变更：存在合并冲突',
  });
  expect(gitDecoration(changes, 'note')).toBeUndefined();
});

it('handles staging and rename codes without confusing staged additions with conflicts', () => {
  for (const code of ['A ', ' A'])
    expect(gitDecoration([{ path: 'a.md', code }], 'a.md')).toMatchObject({
      color: '#587c0c',
      title: '新增文件，已暂存',
    });
  expect(gitDecoration([{ path: 'b.md', code: 'R ' }], 'b.md')?.color).toBe('#6c6cc4');
  expect(gitDecoration([{ path: 'b.md', code: 'UU' }], 'b.md')?.title).toBe('存在合并冲突');
});
