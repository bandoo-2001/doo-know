import { it, expect } from 'vitest';
import { createEditorSession } from '../apps/web/editor/session';
it('裁剪历史只限制撤销范围，不丢失当前正文', () => {
  const s = createEditorSession({ noteId: 'n', generation: 1, markdown: '' });
  for (let i = 0; i < 210; i++) {
    s.sealHistory();
    const v = s.snapshot();
    s.apply({
      noteId: 'n',
      generation: 1,
      baseRevision: v.revision,
      origin: 'source',
      edits: [{ from: v.markdown.length, to: v.markdown.length, insert: 'x' }],
      selection: { anchor: i + 1, head: i + 1, affinity: 'after' },
    });
  }
  expect(s.snapshot().markdown).toHaveLength(210);
  for (let i = 0; i < 200; i++) expect(s.undo().ok).toBe(true);
  expect(s.snapshot().markdown).toBe('x'.repeat(10));
  expect(s.canUndo).toBe(false);
});
it('大段替换受内存上限约束，裁剪历史不截断当前文本', () => {
  const s = createEditorSession({ noteId: 'n', generation: 1, markdown: '' });
  const size = 1024 * 1024;
  for (const letter of ['a', 'b', 'c', 'd', 'e']) {
    s.sealHistory();
    const before = s.snapshot();
    s.apply({
      noteId: 'n',
      generation: 1,
      baseRevision: before.revision,
      origin: 'source',
      edits: [{ from: 0, to: before.markdown.length, insert: letter.repeat(size) }],
      selection: { anchor: 0, head: 0, affinity: 'after' },
    });
  }
  expect(s.snapshot().markdown.length).toBe(size);
  expect(s.snapshot().markdown.replaceAll('e', '')).toBe('');
  let count = 0;
  while (s.canUndo && count < 20) {
    s.undo();
    count++;
  }
  expect(count).toBeLessThanOrEqual(2);
  expect(s.snapshot().markdown.length).toBe(size);
});
