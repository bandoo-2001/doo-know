import { expect, it } from 'vitest';
import { readWorkspaceRoute } from '../apps/web/navigation';
it('reads every independent settings page and upgrades the maintenance alias', () => {
  for (const section of [
    'editor',
    'library',
    'search',
    'status',
    'backup',
    'plugins',
    'account',
    'about',
  ])
    expect(readWorkspaceRoute('http://localhost/?view=settings&section=' + section).section).toBe(
      section,
    );
  expect(readWorkspaceRoute('http://localhost/?view=settings&section=maintenance').section).toBe(
    'backup',
  );
  expect(
    readWorkspaceRoute('http://localhost/?view=settings&section=invalid').section,
  ).toBeUndefined();
});
