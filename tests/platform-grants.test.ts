import { it, expect } from 'vitest';
import { createFixture, loginFixtureOwner } from './support/fixture.js';
import { openDatabase } from '../server/db.js';
import { initializeGrants } from '../server/platform/grants.js';
import { noteService } from '../server/notes.js';
import { snapshotService } from '../server/knowledge/snapshots.js';
it('uses current OAuth directory grants for bounded reads and rejects revoked token versions', async () => {
  const f = await createFixture(); const db = openDatabase(f.dataRoot);
  const snapshots = snapshotService(f.config, db, noteService(f.config, db));
  try {
    const headers = await loginFixtureOwner(f);
    const note = (await f.app.inject({ method: 'POST', url: '/api/notes', headers,
      payload: { folderPath: '00-Inbox', fileName: 'grant.md', content: '# 私有资料' } })).json();
    const owner = (db.prepare('SELECT id FROM user').get() as any).id;
    initializeGrants(db);
    db.prepare('INSERT INTO platform_grants(id,owner_id,client_id,scopes_json,prefixes_json,created_at) VALUES(?,?,?,?,?,?)')
      .run('fixture-grant', owner, 'chat-client', JSON.stringify(['knowledge:read']), JSON.stringify(['00-Inbox']), Date.now());
    const p = { id: owner, clientId: 'chat-client', scopes: ['knowledge:read'], allowedPrefixes: ['00-Inbox'], grantId: 'fixture-grant', grantVersion: 1 };
    await expect(snapshots.outline(p, note.id)).resolves.toBeDefined();
    db.prepare('UPDATE platform_grants SET version=2 WHERE id=?').run('fixture-grant');
    Object.assign(f.config, { agent: { serviceToken: 'fixture-only-service-token', assertionSecret: 'fixture-only-assertion-secret',
      issuer: 'fixture-issuer', audience: 'fixture-audience', policies: [p] } });
    await expect(snapshots.outline(p, note.id)).rejects.toMatchObject({ code: 'FORBIDDEN' });
  } finally { await snapshots.close(); db.close(); await f.close(); }
});
