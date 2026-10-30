import { describe, expect, test } from 'vitest';
import {
  createWorkspaceMainMenuHost,
  createAppNavigationMemory,
  type WorkspaceMainMenuDefinition,
} from '../apps/web/workspace-main-menu';

const definition = (id: string): WorkspaceMainMenuDefinition => ({
  id,
  label: id,
  activeId: 'tasks',
  items: [{ id: 'tasks', label: '任务', icon: 'task' }],
  utilities: [{ id: 'settings', label: '设置', icon: 'settings' }],
  onSelect() {},
});

describe('workspace menu ownership', () => {
  test('nested customization survives parent updates and disposal restores its latest parent', () => {
    const host = createWorkspaceMainMenuHost();
    const parent = Symbol('app'),
      child = Symbol('custom panel');
    host.set(parent, definition('to-doo'));
    host.set(child, definition('custom'));
    host.set(parent, { ...definition('to-doo'), activeId: 'calendar' });
    expect(host.current.value?.id).toBe('custom');
    host.remove(child);
    expect(host.current.value).toMatchObject({ id: 'to-doo', activeId: 'calendar' });
    host.remove(parent);
    expect(host.current.value).toBeUndefined();
  });
  test('an inactive owner cannot remove another application menu', () => {
    const host = createWorkspaceMainMenuHost();
    const first = Symbol(),
      second = Symbol();
    host.set(first, definition('first'));
    host.set(second, definition('second'));
    host.remove(first);
    expect(host.current.value?.id).toBe('second');
    host.set(second, undefined);
    expect(host.current.value).toBeUndefined();
  });
});

test('each app retains its route independently without storing notes as an app location', () => {
  const memory = createAppNavigationMemory();
  const task = {
    view: 'apps' as const,
    app: 'to-doo' as const,
    appSection: 'board' as const,
    list: 'work',
    taskFilter: 'today' as const,
  };
  memory.remember(task);
  task.list = 'mutated outside';
  memory.remember({ view: 'apps', app: 'blog', appSection: 'design' });
  memory.remember({ note: 'private-note' });
  expect(memory.recall('to-doo')).toMatchObject({
    appSection: 'board',
    list: 'work',
    taskFilter: 'today',
  });
  const recalled = memory.recall('to-doo')!;
  recalled.list = 'mutated recall';
  expect(memory.recall('to-doo')?.list).toBe('work');
  expect(memory.recall('blog')).toMatchObject({ appSection: 'design' });
});
