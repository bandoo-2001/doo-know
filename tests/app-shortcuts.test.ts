import { expect, it } from 'vitest';
import { initializeAppShortcuts, setAppPinned, pinnedApps } from '../apps/web/app-shortcuts';

function memory() {
  const values = new Map<string, string>();
  return { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); } };
}

it('retains pin order after reload and isolates each account', () => {
  const storage = memory();
  initializeAppShortcuts('first', storage);
  expect(pinnedApps.value).toEqual([]);
  expect(setAppPinned('to-doo', true)).toBe(true);
  setAppPinned('blog', true);
  setAppPinned('to-doo', true);
  initializeAppShortcuts('second', storage);
  expect(pinnedApps.value).toEqual([]);
  setAppPinned('blog', true);
  initializeAppShortcuts('first', storage);
  expect(pinnedApps.value).toEqual(['to-doo', 'blog']);
  setAppPinned('to-doo', false);
  initializeAppShortcuts('first', storage);
  expect(pinnedApps.value).toEqual(['blog']);
});

it('filters unknown and duplicate app IDs and ignores malformed stored values', () => {
  initializeAppShortcuts('owner', { ...memory(), getItem: () => '["blog","unknown","blog",null,"to-doo"]' });
  expect(pinnedApps.value).toEqual(['blog', 'to-doo']);
  for (const value of ['{broken', '{}', 'null', '"blog"']) {
    initializeAppShortcuts('owner', { ...memory(), getItem: () => value });
    expect(pinnedApps.value).toEqual([]);
  }
});

it('allows session-only pins and reports when the browser cannot store preferences', () => {
  initializeAppShortcuts('owner', {
    getItem: () => { throw Error('blocked'); },
    setItem: () => { throw Error('quota'); },
  });
  expect(setAppPinned('blog', true)).toBe(false);
  expect(pinnedApps.value).toEqual(['blog']);
  initializeAppShortcuts('other', memory());
  expect(pinnedApps.value).toEqual([]);
});
