import { expect, it } from 'vitest';
import { createFixture, loginFixtureOwner } from './support/fixture.js';
import { openDatabase } from '../packages/core/db.js';

it('shows an owner a blocked organization recovery without exposing its original contents', async () => {
  const f = await createFixture({ fileTasks: { embedded: false } });
  try {
    const headers = await loginFixtureOwner(f),
      db = openDatabase(f.dataRoot);
    try {
      const id = '22222222-2222-4222-8222-222222222222',
        now = Date.now();
      db.prepare(
        "INSERT INTO operations(id,principal,client_id,kind,request_id,params_hash,status,created_at,updated_at) VALUES(?,?,?,?,?,?,'needs_reconciliation',?,?)",
      ).run(
        id,
        'fixture',
        'fixture',
        'organization.organize',
        'blocked-organization',
        'fixture',
        now,
        now,
      );
      db.prepare(
        "INSERT INTO organization_jobs(id,status,payload,manifest,error,created_at) VALUES(?,'needs_reconciliation','{}',?,'ORGANIZATION_EVIDENCE_CONFLICT',?)",
      ).run(id, JSON.stringify({ content: 'private body', path: 'Private/secret.md' }), now);
      expect((await f.app.inject({ url: '/api/tree', headers })).statusCode).toBe(503);
      const response = await f.app.inject({ url: '/api/maintenance/conflicts', headers });
      expect(response.statusCode).toBe(200);
      expect(response.json().organizationConflicts).toEqual([
        { operationId: id, status: 'needs_reconciliation', code: 'ORGANIZATION_EVIDENCE_CONFLICT' },
      ]);
      expect(response.body).not.toContain('private body');
      expect(response.body).not.toContain('Private/secret.md');
    } finally {
      db.close();
    }
  } finally {
    await f.close();
  }
});
