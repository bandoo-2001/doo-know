import { it, expect } from 'vitest';
import {
  initializeEditorPreferences,
  editorPreferences,
  setEditorPreferences,
} from '../apps/web/preferences';
const storage = (value: string | null) => ({
  getItem: () => value,
  setItem: () => {},
  removeItem: () => {},
});
it('无偏好的用户默认文档编辑，旧偏好保留源码视图', () => {
  initializeEditorPreferences('new', storage(null));
  expect(editorPreferences).toMatchObject({ editorKind: 'document', mode: 'edit' });
  for (const mode of ['edit', 'preview', 'split']) {
    initializeEditorPreferences('old', storage(JSON.stringify({ mode })));
    expect(editorPreferences).toMatchObject({ editorKind: 'source', mode });
  }
});
it('文档分屏非法组合回到编辑，旧 API 的分屏意图仍生效', () => {
  initializeEditorPreferences('new', storage(null));
  setEditorPreferences({ editorKind: 'document', mode: 'split' });
  expect(editorPreferences.mode).toBe('edit');
  setEditorPreferences({ mode: 'split' });
  expect(editorPreferences).toMatchObject({ editorKind: 'source', mode: 'split' });
});
