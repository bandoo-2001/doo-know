import { it, expect } from 'vitest';
import { mkdtemp, mkdir, writeFile, readlink, symlink, readFile, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { updatePlatform, rollbackPlatform } from '../apps/server/platform/updates.js';
import { createFixture } from './support/fixture.js';
import Database from 'better-sqlite3';

it.each([
  ['damaged JSON', '{damaged'],
  ['null record', 'null'],
  ['array record', '[]'],
  ['numeric previous version', '{"previous":42}'],
  ['parent traversal', '{"previous":"../outside"}'],
  ['absolute path', '{"previous":"/outside"}'],
])('safely refuses invalid rollback installation metadata: %s', async (_, content) => {
  const f = await createFixture();
  try {
    const installRoot = join(f.root, 'install');
    await mkdir(join(installRoot, 'releases/1.2.3'), { recursive: true });
    await writeFile(join(installRoot, 'releases/1.2.3/release.json'), JSON.stringify({ version: '1.2.3', databaseCompatibility: 2 }));
    await symlink('releases/1.2.3', join(installRoot, 'current'));
    await writeFile(join(installRoot, 'installation.json'), content);
    const retained = join(f.knowledgeRoot, '00-Inbox/metadata.md');
    await writeFile(retained, '# 最新内容\r\n');
    await expect(rollbackPlatform({ ...f.config, installRoot, serviceManaged: false }))
      .rejects.toThrow(/没有可用的上一发行版本.*当前程序与资料已保留/);
    expect(await readlink(join(installRoot, 'current'))).toBe('releases/1.2.3');
    expect(await readFile(join(installRoot, 'installation.json'), 'utf8')).toBe(content);
    expect(await readFile(retained, 'utf8')).toBe('# 最新内容\r\n');
    await expect(stat(join(installRoot, 'management.sqlite'))).rejects.toMatchObject({ code: 'ENOENT' });
  } finally { await f.close(); }
});

it('preserves installation record filesystem failures instead of masking them as missing versions', async () => {
  const f = await createFixture();
  try {
    const installRoot = join(f.root, 'install');
    await mkdir(join(installRoot, 'installation.json'), { recursive: true });
    await expect(rollbackPlatform({ ...f.config, installRoot })).rejects.toMatchObject({ code: 'EISDIR' });
  } finally { await f.close(); }
});

it.each(['missing installation record', 'deleted previous release'])(
  'rejects rollback with an actionable message before changing data: %s',
  async (scenario) => {
    const f = await createFixture();
    try {
      const installRoot = join(f.root, 'install');
      await mkdir(join(installRoot, 'releases/1.2.3'), { recursive: true });
      await writeFile(join(installRoot, 'releases/1.2.3/release.json'), JSON.stringify({ version: '1.2.3', databaseCompatibility: 2 }));
      await symlink('releases/1.2.3', join(installRoot, 'current'));
      if (scenario === 'deleted previous release')
        await writeFile(join(installRoot, 'installation.json'), JSON.stringify({ current: '1.2.3', previous: '1.2.2', databaseCompatibility: 2 }));
      const retained = join(f.knowledgeRoot, '00-Inbox/retained.md');
      await writeFile(retained, '# Latest legal content\r\n');
      const db = new Database(join(f.dataRoot, 'app.sqlite'), { readonly: true });
      try {
      const rows = db.prepare('SELECT * FROM notes ORDER BY id').all();
      await expect(rollbackPlatform({ ...f.config, installRoot, serviceManaged: false }))
        .rejects.toThrow(/没有可用的上一发行版本/);
      expect(await readlink(join(installRoot, 'current'))).toBe('releases/1.2.3');
      expect(await readFile(retained, 'utf8')).toBe('# Latest legal content\r\n');
      expect(db.prepare('SELECT * FROM notes ORDER BY id').all()).toEqual(rows);
      expect((db.prepare('SELECT active FROM maintenance WHERE id=1').get() as any).active).toBe(0);
      } finally { db.close(); }
    } finally { await f.close(); }
  },
);

it.each([
  {
    name: 'latest metadata downgrade',
    currentEpoch: 2,
    candidateEpoch: 1,
    explicit: false,
    rejected: true,
  },
  {
    name: 'explicit old version downgrade',
    currentEpoch: 2,
    candidateEpoch: 1,
    explicit: true,
    rejected: true,
  },
  {
    name: 'generation one to two upgrade',
    currentEpoch: 1,
    candidateEpoch: 2,
    explicit: true,
    rejected: false,
  },
  {
    name: 'same generation older version',
    currentEpoch: 2,
    candidateEpoch: 2,
    explicit: true,
    rejected: true,
  },
  {
    name: 'latest metadata selects an older version in the same generation',
    currentEpoch: 2,
    candidateEpoch: 2,
    explicit: false,
    rejected: true,
  },
  {
    name: 'RC versions compare numerically',
    currentEpoch: 2,
    candidateEpoch: 2,
    current: '1.1.0-rc.9',
    candidate: '1.1.0-rc.19',
    explicit: false,
    rejected: false,
  },
  {
    name: 'an unorderable current release fails closed',
    currentEpoch: 2,
    candidateEpoch: 2,
    current: '20261019',
    candidate: '1.1.0-rc.21',
    explicit: false,
    rejected: true,
    unorderable: true,
  },
  {
    name: 'an explicit unorderable candidate fails closed',
    currentEpoch: 2,
    candidateEpoch: 2,
    current: '1.1.0-rc.21',
    candidate: '20261017',
    explicit: true,
    rejected: true,
    unorderable: true,
  },
])(
  'enforces update direction and compatibility before fetching the archive: $name',
  async ({ currentEpoch, candidateEpoch, current, candidate, explicit, rejected, unorderable }) => {
    const f = await createFixture();
    try {
      const installRoot = join(f.root, 'install'),
        source = join(f.root, 'releases-source'),
        currentVersion = current || (currentEpoch === 1 ? '1.1.0-rc.17' : '1.1.0-rc.18'),
        candidateVersion = candidate || (currentEpoch === 1 ? '1.1.0-rc.18' : '1.1.0-rc.17');
      await mkdir(join(installRoot, 'releases', currentVersion), { recursive: true });
      await mkdir(source);
      await writeFile(
        join(installRoot, 'releases', currentVersion, 'release.json'),
        JSON.stringify({ version: currentVersion, databaseCompatibility: currentEpoch }),
      );
      await symlink('releases/' + currentVersion, join(installRoot, 'current'));
      const file = `dooknow-${candidateVersion}-linux-x64.tar.gz`;
      await writeFile(
        join(source, explicit ? `release-${candidateVersion}.json` : 'release.json'),
        JSON.stringify({
          version: candidateVersion,
          file,
          sha256: '0'.repeat(64),
          platform: 'linux-x64',
          databaseCompatibility: candidateEpoch,
        }),
      );
      // Rejected updates must stop before fetching an archive or touching current data.
      // Permitted upgrades continue to the existing integrity check.
      if (!rejected) await writeFile(join(source, file), 'intentionally invalid release archive');
      const retained = join(f.knowledgeRoot, '00-Inbox', 'compatibility.md');
      await writeFile(retained, '# Preserve current data and source\n');
      await expect(
        updatePlatform(
          {
            ...f.config,
            installRoot,
            profileFile: join(f.root, 'profile.json'),
            serviceManaged: false,
          },
          {
            source: pathToFileURL(source + '/').href,
            ...(explicit ? { version: candidateVersion } : {}),
          },
        ),
      ).rejects.toThrow(
        !rejected
          ? /校验/
          : unorderable
            ? /无法比较.*dooknow rollback.*恢复/
            : candidateEpoch < currentEpoch
              ? /兼容代次较低.*数据恢复/
              : /版本较旧.*dooknow rollback/,
      );
      expect(await readlink(join(installRoot, 'current'))).toBe('releases/' + currentVersion);
      expect(await readFile(retained, 'utf8')).toBe('# Preserve current data and source\n');
      await expect(readFile(join(installRoot, 'update-transaction.json'))).rejects.toMatchObject({
        code: 'ENOENT',
      });
    } finally {
      await f.close();
    }
  },
);

it('rejects a corrupt release without switching the current release or changing notes', async () => {
  const temp = await mkdtemp(join(tmpdir(), 'dooknow-update-')),
    f = await createFixture();
  try {
    const installRoot = join(temp, 'install'),
      source = join(temp, 'source');
    await mkdir(join(installRoot, 'releases', '1.0.0'), { recursive: true });
    await mkdir(source);
    await writeFile(
      join(installRoot, 'releases/1.0.0/release.json'),
      JSON.stringify({ version: '1.0.0', databaseCompatibility: 1 }),
    );
    await symlink('releases/1.0.0', join(installRoot, 'current'));
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
    expect(await readlink(join(installRoot, 'current'))).toBe('releases/1.0.0');
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
