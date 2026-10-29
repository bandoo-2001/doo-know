import { expect, it } from 'vitest';
import { readWorkspaceRoute } from '../apps/web/navigation';

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
