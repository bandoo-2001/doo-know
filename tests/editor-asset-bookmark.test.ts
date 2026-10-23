import { it, expect } from 'vitest';
import { captureAssetTarget, resolveAssetTarget } from '../apps/web/editor/asset-bookmark';
it('异步上传不会插入另一笔记、另一代次或已修改的插入位置', () => {
  const s = {
    noteId: 'n',
    generation: 2,
    revision: 1,
    markdown: '原文',
    selection: { anchor: 1, head: 1, affinity: 'after' as const },
  };
  const t = captureAssetTarget(s);
  expect(resolveAssetTarget(t, s)).toEqual(s.selection);
  for (const d of [{ noteId: 'other' }, { generation: 3 }, { revision: 2 }])
    expect(resolveAssetTarget(t, { ...s, ...d })).toBeUndefined();
});
it('文档投影重建或切换编辑方式后不沿用旧原生插入位置', () => {
  const s = {
    noteId: 'n',
    generation: 2,
    revision: 1,
    markdown: '正文',
    selection: {
      anchor: 1,
      head: 1,
      affinity: 'after' as const,
      document: { id: 'projection-a', anchor: 2, head: 2 },
    },
  };
  const target = captureAssetTarget(s);
  expect(
    resolveAssetTarget(target, { ...s, selection: { anchor: 1, head: 1, affinity: 'after' } }),
  ).toBeUndefined();
  expect(
    resolveAssetTarget(target, {
      ...s,
      selection: { ...s.selection, document: { id: 'projection-b', anchor: 2, head: 2 } },
    }),
  ).toBeUndefined();
});
