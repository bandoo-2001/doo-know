import { expect, it } from 'vitest';
import { readWorkspaceRoute } from '../apps/web/navigation';

it('keeps the native graph app addressable across refresh without accepting unrelated task selection', () => {
  expect(readWorkspaceRoute('http://localhost/?view=apps&app=graph&appSection=overview&task=other')).toMatchObject({
    view: 'apps', app: 'graph', appSection: 'overview',
  });
  expect(readWorkspaceRoute('http://localhost/?view=apps&app=graph&task=other')).not.toHaveProperty('task');
  expect(readWorkspaceRoute('http://localhost/?view=apps&app=graph&appSection=settings')).not.toHaveProperty('appSection');
  expect(readWorkspaceRoute('http://localhost/?app=graph')).not.toHaveProperty('app');
});
