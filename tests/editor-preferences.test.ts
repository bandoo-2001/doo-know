import { describe, expect, it } from 'vitest';
import {
  editorPreferences,
  initializeEditorPreferences,
  setEditorPreferences,
  resetEditorPreferences,
} from '../apps/web/preferences';
import { normalizeSettingsSection } from '../apps/web/settings';

const memory = () => {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) || null,
    setItem: (key: string, value: string) => {
      values.set(key, value);
    },
    removeItem: (key: string) => {
      values.delete(key);
    },
  };
};
describe('device editor preferences', () => {
  it('persists valid display defaults separately for each account', () => {
    const storage = memory();
    initializeEditorPreferences('first', storage);
    setEditorPreferences({
      mode: 'split',
      wrap: false,
      lineNumbers: true,
      fontSize: 18,
      readingWidth: 'wide',
      theme: 'dark',
    });
    initializeEditorPreferences('second', storage);
    expect(editorPreferences.mode).toBe('edit');
    expect(editorPreferences.theme).toBe('light');
    initializeEditorPreferences('first', storage);
    expect(editorPreferences).toMatchObject({
      mode: 'split',
      wrap: false,
      lineNumbers: true,
      fontSize: 18,
      readingWidth: 'wide',
      theme: 'dark',
    });
    resetEditorPreferences();
    expect(editorPreferences.fontSize).toBe(15);
    expect(editorPreferences.lineNumbers).toBe(false);
  });
  it('ignores malformed storage and unsafe or unsupported preference values', () => {
    const storage = { ...memory(), getItem: () => '{broken' };
    initializeEditorPreferences('owner', storage);
    expect(editorPreferences.fontSize).toBe(15);
    setEditorPreferences({ fontSize: 999, theme: 'url(javascript:x)', wrap: 'false' } as never);
    expect(editorPreferences.fontSize).toBe(15);
    expect(editorPreferences.theme).toBe('light');
    expect(editorPreferences.wrap).toBe(true);
    initializeEditorPreferences('owner', {
      getItem: () => {
        throw Error('private');
      },
      setItem: () => {
        throw Error('quota');
      },
      removeItem: () => {},
    });
    expect(() => setEditorPreferences({ fontSize: 16 })).not.toThrow();
    expect(editorPreferences.fontSize).toBe(16);
  });
  it('maps old maintenance links and defaults to the editor category', () => {
    expect(normalizeSettingsSection('maintenance')).toBe('backup');
    expect(normalizeSettingsSection('search')).toBe('search');
    expect(normalizeSettingsSection('unknown')).toBe('editor');
  });
});
