import { describe, expect, it } from 'vitest';
import { readWorkspaceRoute } from '../apps/web/navigation';
import { resolveToDooContext, toDooContextEntries } from '../apps/web/to-doo-context-navigation';

describe('ToDoo contextual destinations', () => {
  it('validates each destination within its owning module', () => {
    expect(resolveToDooContext('settings', 'data')).toBe('data');
    expect(resolveToDooContext('settings', 'history')).toBe('preferences');
    expect(resolveToDooContext('habits', 'history')).toBe('history');
    expect(resolveToDooContext('notifications', 'acknowledged')).toBe('acknowledged');
    expect(resolveToDooContext('notifications', 'preferences')).toBe('all');
    expect(resolveToDooContext('calendar', 'history')).toBeUndefined();
    expect(toDooContextEntries('settings').map((entry) => entry.id)).toEqual([
      'preferences',
      'connections',
      'data',
      'lists',
    ]);
  });
  it('restores secondary selection from deep links and drops invalid or foreign context', () => {
    const href = 'http://localhost/?view=apps&app=to-doo&appSection=settings&appPage=data';
    expect(readWorkspaceRoute(href)).toMatchObject({ appSection: 'settings', appPage: 'data' });
    expect(
      readWorkspaceRoute(href.replace('appPage=data', 'appPage=history')).appPage,
    ).toBeUndefined();
    expect(readWorkspaceRoute(href.replace('app=to-doo', 'app=blog')).appPage).toBeUndefined();
    expect(readWorkspaceRoute(href.replace('settings', 'calendar')).appPage).toBeUndefined();
  });
});
