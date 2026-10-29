import { expect, it } from 'vitest';
import { createFixture, loginFixtureOwner } from './support/fixture.js';

it('offers owner-only identity-bound domain settings without granting full access by default', async () => {
  const f = await createFixture({ pluginCatalog: [] });
  try {
    const url = '/api/platform/mcp/permissions';
    expect((await f.app.inject({ url })).statusCode).toBe(401);
    const headers = await loginFixtureOwner(f);
    const result = await f.app.inject({ url, headers });
    expect(result.statusCode).toBe(200);
    const body = result.json();
    expect(body.policy.version).toBe(2);
    expect(body.policy.domains.knowledge.resources.mode).toBe('selected');
    expect(body.policy.domains.knowledge.actions).toEqual(['read']);
    expect(body.policy.domains.blog.actions).not.toContain('publish');
    expect(body.policy.domains).not.toHaveProperty('todo');
    expect(
      body.resources.knowledge.some(
        (x: any) => x.kind === 'directory' && x.id && x.label === '00-Inbox',
      ),
    ).toBe(true);
  } finally {
    await f.close();
  }
});

it('persists bounded organization retention as an owner maintenance setting', async () => {
  const f = await createFixture({ pluginCatalog: [] });
  try {
    const url = '/api/maintenance/organization-settings';
    expect((await f.app.inject({ url })).statusCode).toBe(401);
    const headers = await loginFixtureOwner(f);
    expect((await f.app.inject({ url, headers })).json()).toEqual({ retentionDays: 30 });
    expect(
      (await f.app.inject({ method: 'PUT', url, headers, payload: { retentionDays: 14 } })).json(),
    ).toEqual({ retentionDays: 14 });
    expect((await f.app.inject({ url, headers })).json()).toEqual({ retentionDays: 14 });
    for (const days of [0, 1.5, 3651, '30'])
      expect(
        (await f.app.inject({ method: 'PUT', url, headers, payload: { retentionDays: days } }))
          .statusCode,
      ).toBe(400);
    expect((await f.app.inject({ url, headers })).json()).toEqual({ retentionDays: 14 });
  } finally {
    await f.close();
  }
});
