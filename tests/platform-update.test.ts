import { it, expect } from 'vitest';
import { mkdtemp, mkdir, writeFile, readlink, symlink, readFile, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { updatePlatform, rollbackPlatform } from '../apps/server/platform/updates.js';
import { createFixture } from './support/fixture.js';
it('rejects a corrupt release without switching the current release or changing notes', async () => {
  const temp = await mkdtemp(join(tmpdir(), 'dooknow-update-')),
    f = await createFixture();
  try {
    const installRoot = join(temp, 'install'),
      source = join(temp, 'source');
    await mkdir(join(installRoot, 'releases', 'old'), { recursive: true });
    await mkdir(source);
    await writeFile(
      join(installRoot, 'releases/old/release.json'),
      JSON.stringify({ version: 'old', databaseCompatibility: 1 }),
    );
    await symlink('releases/old', join(installRoot, 'current'));
    await writeFile(join(source, 'broken.tar.gz'), 'corrupt');
    await writeFile(
      join(source, 'release.json'),
      JSON.stringify({
        version: '2.0.0',
        file: 'dooknow-2.0.0-linux-x64.tar.gz',
        sha256: '0'.repeat(64),
        platform: 'linux-x64',
        databaseCompatibility: 1,
      }),
    );
    await writeFile(join(source, 'dooknow-2.0.0-linux-x64.tar.gz'), 'corrupt');
    await expect(
      updatePlatform(
        {
          ...f.config,
          installRoot,
          profileFile: join(temp, 'profile.json'),
          serviceManaged: false,
        },
        { source: pathToFileURL(source + '/').href },
      ),
    ).rejects.toThrow(/校验/);
    expect(await readlink(join(installRoot, 'current'))).toBe('releases/old');
  } finally {
    await f.close();
    await rm(temp, { recursive: true, force: true });
  }
});
it('refuses an incompatible ordinary code rollback after new writes may have been accepted', async () => {
  const temp = await mkdtemp(join(tmpdir(), 'dooknow-rollback-')),
    f = await createFixture();
  try {
    await mkdir(join(temp, 'releases/new'), { recursive: true });
    await mkdir(join(temp, 'releases/old'));
    await writeFile(
      join(temp, 'releases/new/release.json'),
      JSON.stringify({ version: 'new', databaseCompatibility: 2 }),
    );
    await writeFile(
      join(temp, 'releases/old/release.json'),
      JSON.stringify({ version: 'old', databaseCompatibility: 1 }),
    );
    await symlink('releases/new', join(temp, 'current'));
    await writeFile(join(temp, 'installation.json'), JSON.stringify({ previous: 'old' }));
    await expect(
      rollbackPlatform({ ...f.config, installRoot: temp, serviceManaged: false }),
    ).rejects.toThrow(/数据恢复/);
    expect(await readlink(join(temp, 'current'))).toBe('releases/new');
  } finally {
    await f.close();
    await rm(temp, { recursive: true, force: true });
  }
});
async function recoveryFixture() {
  const { openDatabase } = await import('../packages/core/db.js'),
    { sealBackup } = await import('../apps/server/platform/sealed-backup.js');
  const f = await createFixture();
  await f.app.close();
  const installRoot = join(f.root, 'installation');
  await mkdir(join(installRoot, 'releases/1.0.0'), { recursive: true });
  await writeFile(
    join(installRoot, 'releases/1.0.0/release.json'),
    JSON.stringify({ version: '1.0.0', databaseCompatibility: 1 }),
  );
  await symlink('releases/1.0.0', join(installRoot, 'current'));
  const snapshot = join(f.root, 'snapshot.dooknow'),
    plain = join(f.root, 'snapshot.sqlite'),
    keyFile = join(f.root, 'recovery.pem'),
    db = openDatabase(f.dataRoot);
  try {
    db.prepare("INSERT INTO index_meta VALUES('recovery_fixture','before')").run();
    db.prepare('UPDATE maintenance SET active=1 WHERE id=1').run();
    await db.backup(plain);
  } finally {
    db.close();
  }
  await sealBackup(plain, snapshot, keyFile, (await stat(plain)).size);
  const state = {
    previous: '1.0.0',
    candidate: '1.1.0',
    snapshot,
    keyFile,
    wasActive: false,
    phase: 'prepared',
  };
  const config = {
    ...f.config,
    installRoot,
    serviceManaged: false,
    serviceName: 'dooknow-recovery-fixture.service',
    profileFile: join(f.root, 'profile.json'),
  };
  return { f, config, state, journal: join(installRoot, 'update-transaction.json'), openDatabase };
}
it('retries snapshot recovery despite an earlier crashed decryption output', async () => {
  const { recoverTransaction } = await import('../apps/server/platform/updates.js');
  const r = await recoveryFixture();
  try {
    await writeFile(join(r.f.dataRoot, 'app.sqlite.restore'), 'old interrupted output');
    await writeFile(r.journal, JSON.stringify(r.state));
    let db = r.openDatabase(r.f.dataRoot);
    db.prepare(
      "UPDATE index_meta SET value='partial-migration' WHERE key='recovery_fixture'",
    ).run();
    db.close();
    await recoverTransaction(r.config);
    db = r.openDatabase(r.f.dataRoot);
    try {
      expect(
        (db.prepare("SELECT value FROM index_meta WHERE key='recovery_fixture'").get() as any)
          .value,
      ).toBe('before');
    } finally {
      db.close();
    }
    expect(JSON.parse(await readFile(r.journal, 'utf8')).phase).toBe('recovered');
  } finally {
    await r.f.close();
  }
});
it('never restores data again after recovery acceptance, preserving subsequent writes across a retry', async () => {
  const { recoverTransaction } = await import('../apps/server/platform/updates.js');
  const r = await recoveryFixture();
  try {
    await writeFile(r.journal, JSON.stringify({ ...r.state, phase: 'recoveryAccepted' }));
    let db = r.openDatabase(r.f.dataRoot);
    db.prepare('UPDATE maintenance SET active=0 WHERE id=1').run();
    db.prepare("INSERT INTO index_meta VALUES('legitimate_after_recovery','keep')").run();
    db.close();
    await recoverTransaction(r.config);
    db = r.openDatabase(r.f.dataRoot);
    try {
      expect(
        (
          db
            .prepare("SELECT value FROM index_meta WHERE key='legitimate_after_recovery'")
            .get() as any
        )?.value,
      ).toBe('keep');
    } finally {
      db.close();
    }
  } finally {
    await r.f.close();
  }
});
it('refuses an ambiguous pre-acceptance journal after writes have already reopened', async () => {
  const { recoverTransaction } = await import('../apps/server/platform/updates.js');
  const r = await recoveryFixture();
  try {
    await writeFile(r.journal, JSON.stringify({ ...r.state, phase: 'switched' }));
    let db = r.openDatabase(r.f.dataRoot);
    db.prepare('UPDATE maintenance SET active=0 WHERE id=1').run();
    db.prepare("INSERT INTO index_meta VALUES('legitimate_after_old_recovery','keep')").run();
    db.close();
    await expect(recoverTransaction(r.config)).rejects.toThrow(/禁止自动覆盖/);
    db = r.openDatabase(r.f.dataRoot);
    try {
      expect(
        (
          db
            .prepare("SELECT value FROM index_meta WHERE key='legitimate_after_old_recovery'")
            .get() as any
        )?.value,
      ).toBe('keep');
    } finally {
      db.close();
    }
  } finally {
    await r.f.close();
  }
});
