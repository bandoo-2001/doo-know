import { afterEach, expect, it, vi } from 'vitest';
import { createWorkspaceNavigation, readWorkspaceRoute } from '../apps/web/navigation';

it('reads each full To Doo view without changing blog navigation', () => {
  for (const appSection of [
    'overview',
    'tasks',
    'board',
    'calendar',
    'timeline',
    'matrix',
    'focus',
    'habits',
    'anniversaries',
    'stats',
    'notifications',
    'settings',
  ]) {
    expect(
      readWorkspaceRoute(`http://localhost/?view=apps&app=to-doo&appSection=${appSection}`),
    ).toMatchObject({
      view: 'apps',
      app: 'to-doo',
      appSection,
    });
  }
  expect(
    readWorkspaceRoute('http://localhost/?view=apps&app=blog&appSection=articles'),
  ).toMatchObject({ app: 'blog', appSection: 'articles' });
});

it('keeps task, list and calendar selection addressable only within To Doo', () => {
  const route = readWorkspaceRoute(
    'http://localhost/?view=apps&app=to-doo&appSection=calendar&task=task-1&list=list-1&date=2026-10-29&calendarView=week',
  );
  expect(route).toMatchObject({
    task: 'task-1',
    list: 'list-1',
    date: '2026-10-29',
    calendarView: 'week',
  });
  expect(readWorkspaceRoute('http://localhost/?note=n1&task=task-1')).not.toHaveProperty('task');
  expect(
    readWorkspaceRoute('http://localhost/?view=apps&app=to-doo&date=2026-02-31'),
  ).not.toHaveProperty('date');
});

afterEach(() => vi.unstubAllGlobals());

function taskNavigation(href: string) {
  const location = new URL(href);
  const history = {
    state: {} as unknown,
    replaceState(state: unknown, _title: string, url?: string | URL | null) {
      this.state = state;
      if (url) location.href = new URL(url, location.href).href;
    },
    pushState(state: unknown, title: string, url?: string | URL | null) {
      this.replaceState(state, title, url);
    },
  };
  vi.stubGlobal('location', location);
  vi.stubGlobal('history', history);
  vi.stubGlobal('window', Object.assign(new EventTarget(), { location }));
  return createWorkspaceNavigation({
    dirty: () => false,
    guard: async (apply) => apply(),
    apply: async () => {},
    error: (cause) => {
      throw cause;
    },
  });
}

it('roundtrips each smart task filter through To Doo navigation', () => {
  const navigation = taskNavigation('http://localhost/?view=apps&app=to-doo&appSection=tasks');
  try {
    for (const taskFilter of [
      'all',
      'inbox',
      'today',
      'upcoming',
      'overdue',
      'unscheduled',
      'done',
      'blocked',
      'archived',
      'trash',
    ] as const) {
      navigation.commit({ view: 'apps', app: 'to-doo', appSection: 'tasks', taskFilter });
      expect(new URL(location.href).searchParams.get('taskFilter')).toBe(taskFilter);
      expect(readWorkspaceRoute(location.href)).toMatchObject({
        view: 'apps',
        app: 'to-doo',
        appSection: 'tasks',
        taskFilter,
      });
      expect(navigation.currentRoute()).toHaveProperty('taskFilter', taskFilter);
    }
  } finally {
    navigation.dispose();
  }
});

it('ignores invalid smart filters and task filters outside To Doo', () => {
  for (const taskFilter of ['', 'TODAY', 'next-week', '../today']) {
    expect(
      readWorkspaceRoute(
        `http://localhost/?view=apps&app=to-doo&taskFilter=${encodeURIComponent(taskFilter)}`,
      ),
    ).not.toHaveProperty('taskFilter');
  }
  for (const href of [
    'http://localhost/?view=apps&app=blog&taskFilter=today',
    'http://localhost/?view=recent&app=to-doo&taskFilter=inbox',
    'http://localhost/?note=n1&taskFilter=all',
  ])
    expect(readWorkspaceRoute(href)).not.toHaveProperty('taskFilter');
});

it('clears smart filters when moving between apps or choosing an unfiltered collection', () => {
  const navigation = taskNavigation(
    'http://localhost/?view=apps&app=to-doo&appSection=tasks&taskFilter=today',
  );
  try {
    navigation.commit({ view: 'apps', app: 'blog', appSection: 'overview' });
    expect(new URL(location.href).searchParams.has('taskFilter')).toBe(false);
    expect(navigation.currentRoute()).toEqual({
      view: 'apps',
      app: 'blog',
      appSection: 'overview',
    });
    navigation.commit({ view: 'apps', app: 'to-doo', appSection: 'tasks', taskFilter: 'inbox' });
    expect(navigation.currentRoute()).toHaveProperty('taskFilter', 'inbox');
    navigation.commit({ view: 'apps', app: 'to-doo', appSection: 'overview' });
    expect(new URL(location.href).searchParams.has('taskFilter')).toBe(false);
    expect(navigation.currentRoute()).toEqual({
      view: 'apps',
      app: 'to-doo',
      appSection: 'overview',
    });
  } finally {
    navigation.dispose();
  }
});
