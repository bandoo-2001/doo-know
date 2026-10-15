import { it, expect } from 'vitest';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFixture, loginFixtureOwner } from './support/fixture.js';
import { pluginFixture } from './support/plugin-fixture.js';
import { openDatabase } from '../packages/core/db.js';
import { oauthGrantStore } from '../apps/server/platform/oauth-grants.js';
import { loadHostConfig } from '../apps/server/platform/config.js';
import { createApp } from '../apps/server/app.js';
import { createPlatformBackup, restorePlatformBackup } from '../apps/server/platform/backups.js';
it('encrypts the complete backup and restores a new bound root with stable note identity and revoked sessions, shares, grants and process ownership', async () => {
  const root = await mkdtemp(join(tmpdir(), 'encrypted-backup-')),
    entry = await pluginFixture(root),
    f = await createFixture({ pluginCatalog: [entry] });
  let restored: Awaited<ReturnType<typeof createApp>> | undefined;
  const db = openDatabase(f.dataRoot);
  try {
    const headers = await loginFixtureOwner(f);
    const owner = (db.prepare('SELECT id FROM user').get() as any).id;
    const note = (
      await f.app.inject({
        method: 'POST',
        url: '/api/notes',
        headers,
        payload: {
          folderPath: '00-Inbox',
          fileName: 'encrypted.md',
          content: '# PRIVATE_FIXTURE_CONTENT',
          requestId: 'backup-note',
        },
      })
    ).json();
    const shared = (
      await f.app.inject({
        method: 'POST',
        url: '/api/notes/' + note.id + '/share',
        headers,
        payload: {},
      })
    ).json();
    await f.app.inject({
      method: 'POST',
      url: '/api/platform/plugins/counter/install',
      headers,
      payload: {},
    });
    await f.app.inject({
      method: 'POST',
      url: '/api/platform/plugins/counter/enable',
      headers,
      payload: {},
    });
    const oldGrant = oauthGrantStore(db).approve(
      owner,
      'backup-client',
      ['knowledge:read'],
      ['00-Inbox'],
    );
    db.prepare(
      "INSERT INTO index_meta VALUES('remote_auth_generation','7') ON CONFLICT(key) DO UPDATE SET value='7'",
    ).run();
    await f.app.close();
    db.close();
    const file = join(root, 'backup.dkb'),
      keyFile = join(root, 'recovery-key.pem');
    const backup = await createPlatformBackup(f.config, { destination: file, keyFile });
    expect(backup.file).toBe(file);
    const encrypted = await readFile(file);
    expect(encrypted.includes(Buffer.from('PRIVATE_FIXTURE_CONTENT'))).toBe(false);
    expect(encrypted.includes(Buffer.from(f.config.secret))).toBe(false);
    const target = {
      dataRoot: join(root, 'restored/data'),
      knowledgeRoot: join(root, 'restored/knowledge'),
      profileFile: join(root, 'restored/config/profile.json'),
    };
    const result = await restorePlatformBackup({ source: file, keyFile, target });
    const config = loadHostConfig({ profileFile: result.profileFile });
    expect(config.dataRoot).toBe(target.dataRoot);
    restored = await createApp(config);
    expect((await restored.inject({ url: '/readyz' })).statusCode).toBe(200);
    expect((await restored.inject({ url: '/api/notes/' + note.id, headers })).statusCode).toBe(401);
    const check = openDatabase(target.dataRoot);
    try {
      expect(check.prepare('SELECT id FROM notes WHERE id=?').get(note.id)).toBeTruthy();
      expect(
        (check.prepare('SELECT enabled FROM shares WHERE note_id=?').get(note.id) as any).enabled,
      ).toBe(0);
      expect(() =>
        oauthGrantStore(check).requireExact(oldGrant.reference, owner, 'backup-client', [
          'knowledge:read',
        ]),
      ).toThrow();
      expect(
        Number(
          (
            check
              .prepare("SELECT value FROM index_meta WHERE key='remote_auth_generation'")
              .get() as any
          ).value,
        ),
      ).toBe(8);
      expect(
        check
          .prepare('SELECT desired_enabled,state FROM platform_plugins WHERE id=?')
          .get('counter'),
      ).toMatchObject({ desired_enabled: 0, state: 'disabled' });
      expect(check.pragma('foreign_key_check')).toEqual([]);
      expect(
        (check.prepare("SELECT value FROM index_meta WHERE key='root_identity'").get() as any)
          .value,
      ).toContain(target.knowledgeRoot);
    } finally {
      check.close();
    }
    expect(await readFile(join(target.knowledgeRoot, '00-Inbox/encrypted.md'), 'utf8')).toBe(
      '# PRIVATE_FIXTURE_CONTENT',
    );
    expect(shared).toBeTruthy();
    const corrupt = Buffer.from(encrypted);
    corrupt[corrupt.length - 1] ^= 1;
    const bad = join(root, 'corrupt.dkb');
    await writeFile(bad, corrupt);
    await expect(
      restorePlatformBackup({
        source: bad,
        keyFile,
        target: {
          dataRoot: join(root, 'bad/data'),
          knowledgeRoot: join(root, 'bad/knowledge'),
          profileFile: join(root, 'bad/config/profile.json'),
        },
      }),
    ).rejects.toThrow(/解密或完整性/);
  } finally {
    if (db.open) db.close();
    await restored?.close();
    await f.close();
    await rm(root, { recursive: true, force: true });
  }
}, 30000);
