import { afterEach, expect, it } from 'vitest';
import { organizationFixture } from './support/organization-fixture.js';
import { organizationService } from '../packages/core/organization/service.js';
import {
  readOrganizationSettings,
  updateOrganizationSettings,
} from '../packages/core/organization/settings.js';
const close: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (close.length) await close.pop()!();
});
function fixture() {
  const f = organizationFixture(),
    service = organizationService(f.config, f.db, f.notes);
  close.push(async () => {
    await service.close();
    f.close();
  });
  return { ...f, service };
}
it('defaults undo retention to 30 days and persists valid administrative settings', () => {
  const f = fixture();
  expect(readOrganizationSettings(f.db)).toEqual({ retentionDays: 30 });
  expect(updateOrganizationSettings(f.db, { retentionDays: 3650 })).toEqual({
    retentionDays: 3650,
  });
  expect(readOrganizationSettings(f.db)).toEqual({ retentionDays: 3650 });
  expect(updateOrganizationSettings(f.db, { retentionDays: 1 })).toEqual({ retentionDays: 1 });
});
it.each([0, 3651, -1, 1.5, NaN, Infinity, '30', null, undefined])(
  'rejects invalid undo retention %s without changing the setting',
  (retentionDays) => {
    const f = fixture();
    updateOrganizationSettings(f.db, { retentionDays: 60 });
    expect(() => updateOrganizationSettings(f.db, { retentionDays } as any)).toThrowError(
      expect.objectContaining({ code: 'INVALID_RETENTION_DAYS', statusCode: 400 }),
    );
    expect(readOrganizationSettings(f.db)).toEqual({ retentionDays: 60 });
  },
);
it('uses the selected duration only for future commits without shortening or reviving existing material', async () => {
  const f = fixture();
  async function create(name: string) {
    const c = f.service.context(f.p),
      r = await f.service.submit(f.p, {
        libraryId: c.libraryId,
        expectedStructureRevision: c.structureRevision,
        requestId: name,
        actions: [{ type: 'create_directory', parentId: f.directory('Topic').id, name }],
      });
    await f.service.drain();
    expect(f.service.operation(f.p, { operationId: r.operation.operationId }).status).toBe(
      'succeeded',
    );
    return f.db
      .prepare('SELECT id,status,finished_at,expires_at,cleaned FROM organization_jobs WHERE id=?')
      .get(r.operation.operationId) as {
      id: string;
      status: string;
      finished_at: number;
      expires_at: number;
      cleaned: number;
    };
  }
  const first = await create('Default');
  expect(first.expires_at - first.finished_at).toBe(30 * 86400000);
  updateOrganizationSettings(f.db, { retentionDays: 7 });
  expect(
    f.db
      .prepare('SELECT id,status,finished_at,expires_at,cleaned FROM organization_jobs WHERE id=?')
      .get(first.id),
  ).toEqual(first);
  const second = await create('Custom');
  expect(second.expires_at - second.finished_at).toBe(7 * 86400000);
  f.db.prepare('UPDATE organization_jobs SET expires_at=0 WHERE id=?').run(first.id);
  expect(f.service.operation(f.p, { operationId: first.id }).result?.undoAvailable).toBe(false);
  updateOrganizationSettings(f.db, { retentionDays: 90 });
  expect(
    f.db
      .prepare('SELECT expires_at,status,cleaned FROM organization_jobs WHERE id=?')
      .get(first.id),
  ).toEqual({ expires_at: 0, status: 'succeeded', cleaned: 0 });
  expect(f.service.operation(f.p, { operationId: first.id }).result?.undoAvailable).toBe(false);
  const third = await create('Future');
  expect(third.expires_at - third.finished_at).toBe(90 * 86400000);
  expect(third.expires_at).toBeGreaterThan(second.expires_at);
  const existing = f.db
    .prepare('SELECT expires_at FROM organization_jobs WHERE id=?')
    .get(second.id);
  expect(existing).toEqual({ expires_at: second.expires_at });
});
