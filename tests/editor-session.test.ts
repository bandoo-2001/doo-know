import { it, expect } from 'vitest';
import { createEditorSession } from '../apps/web/editor/session';
const sel = { anchor: 1, head: 1, affinity: 'after' as const };
it('两种编辑方式共享原文和逆序撤销，切换不构成内容修改', async () => {
  const s = createEditorSession({ noteId: 'n', generation: 1, markdown: '原文' });
  expect(
    s.apply({
      noteId: 'n',
      generation: 1,
      baseRevision: 0,
      origin: 'document',
      edits: [{ from: 0, to: 0, insert: 'A' }],
      selection: sel,
    }).ok,
  ).toBe(true);
  await s.prepareSwitch('source');
  s.apply({
    noteId: 'n',
    generation: 1,
    baseRevision: 1,
    origin: 'source',
    edits: [{ from: 0, to: 0, insert: 'B' }],
    selection: sel,
  });
  await s.prepareSwitch('document');
  expect(s.snapshot().markdown).toBe('BA原文');
  expect(s.undo()).toMatchObject({ ok: true, markdown: 'A原文' });
  expect(s.undo()).toMatchObject({ ok: true, markdown: '原文' });
  expect(s.redo()).toMatchObject({ ok: true, markdown: 'A原文' });
});
it('拒绝过期代次、笔记和版本，不让旧编辑器回写', () => {
  const s = createEditorSession({ noteId: 'n', generation: 2, markdown: '原文' });
  for (const delta of [{ noteId: 'old' }, { generation: 1 }, { baseRevision: 9 }])
    expect(
      s.apply({
        noteId: 'n',
        generation: 2,
        baseRevision: 0,
        origin: 'source',
        edits: [{ from: 0, to: 2, insert: '损坏' }],
        selection: sel,
        ...delta,
      }).ok,
    ).toBe(false);
  expect(s.snapshot().markdown).toBe('原文');
  s.dispose();
  expect(s.undo().ok).toBe(false);
});
it('输入法组合期间 flush 等待组合结束，快照包含最终字符', async () => {
  const s = createEditorSession({ noteId: 'n', generation: 1, markdown: '' });
  s.setComposing(true);
  let done = false;
  const pending = s.flush().then((x) => {
    done = true;
    return x;
  });
  await Promise.resolve();
  expect(done).toBe(false);
  s.apply({
    noteId: 'n',
    generation: 1,
    baseRevision: 0,
    origin: 'source',
    edits: [{ from: 0, to: 0, insert: '中文😀' }],
    selection: sel,
  });
  s.setComposing(false);
  expect((await pending).markdown).toBe('中文😀');
});
