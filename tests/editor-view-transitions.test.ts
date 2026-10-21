import { describe, expect, it } from 'vitest';
import { createEditorSession } from '../apps/web/editor/session';
import {
  createEditorViewTransitions,
  type EditorViewChange,
  type EditorViewState,
} from '../apps/web/editor/view-transitions';
import type { SelectionBookmark } from '../apps/web/editor/contracts';

function fixture(afterRender: () => Promise<unknown> = async () => {}) {
  const session = createEditorSession({ noteId: 'own', generation: 1, markdown: '正文\r\n' });
  const state: EditorViewState = { kind: 'document', mode: 'edit' };
  let focused: SelectionBookmark | undefined;
  const errors: string[] = [];
  const views = createEditorViewTransitions({
    current: () => state,
    flush: () => session.flush(),
    apply(change) {
      if ('kind' in change) Object.assign(state, { kind: change.kind, mode: 'edit' });
      else state.mode = change.mode;
    },
    afterRender,
    focus(bookmark) {
      focused = bookmark;
    },
    error(cause) {
      errors.push((cause as Error).message);
    },
  });
  return { session, state, views, errors, focused: () => focused };
}

describe('editor view requests', () => {
  it.each<EditorViewChange>([{ kind: 'source' }, { mode: 'preview' }])(
    'keeps the final document choice after composition delayed $kind $mode',
    async (pendingView) => {
      const f = fixture();
      f.session.setComposing(true);
      expect(
        f.session.apply({
          noteId: 'own',
          generation: 1,
          baseRevision: 0,
          origin: 'document',
          edits: [{ from: 2, to: 2, insert: '中文组合' }],
          selection: { anchor: 6, head: 6, affinity: 'after' },
        }).ok,
      ).toBe(true);
      const first = f.views.select(pendingView);
      await f.views.select({ kind: 'document' });
      f.session.setComposing(false);
      await first;
      expect(f.state).toEqual({ kind: 'document', mode: 'edit' });
      expect(f.session.snapshot().markdown).toBe('正文中文组合\r\n');
      expect(f.errors).toEqual([]);
    },
  );

  it('does not move focus back into an editor after reading was selected during rendering', async () => {
    let release!: () => void;
    let entered!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const rendering = new Promise<void>((resolve) => {
      release = resolve;
    });
    const f = fixture(() => {
      entered();
      return rendering;
    });
    const first = f.views.select({ kind: 'source' });
    await started;
    await f.views.select({ mode: 'preview' });
    release();
    await first;
    expect(f.state.mode).toBe('preview');
    expect(f.focused()).toBeUndefined();
  });

  it('preserves an explicit source offset of zero', async () => {
    const f = fixture();
    f.session.setSelection({ anchor: 2, head: 2, affinity: 'after' });
    await f.views.select({ kind: 'source', sourceOffset: 0 });
    expect(f.focused()).toEqual({ anchor: 0, head: 0, affinity: 'after' });
  });

  it('drops failures from canceled requests without changing the document', async () => {
    const f = fixture();
    f.session.setComposing(true);
    const first = f.views.select({ kind: 'source' });
    f.views.cancel();
    f.session.rejectPendingFlush('closed');
    await first;
    expect(f.state).toEqual({ kind: 'document', mode: 'edit' });
    expect(f.session.snapshot().markdown).toBe('正文\r\n');
    expect(f.errors).toEqual([]);
  });

  it('shows a current flush error while preserving the current view and raw source', async () => {
    const f = fixture();
    f.session.setComposing(true);
    const first = f.views.select({ kind: 'source' });
    f.session.rejectPendingFlush('protected input');
    await first;
    expect(f.errors).toEqual(['protected input']);
    expect(f.state).toEqual({ kind: 'document', mode: 'edit' });
    expect(f.session.snapshot().markdown).toBe('正文\r\n');
  });
});
