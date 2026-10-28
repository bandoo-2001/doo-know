import { it, expect } from 'vitest';
import { mkdtemp, mkdir, writeFile, readFile, rm, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { initializeOwner } from '../apps/server/auth.js';
import { testPassword } from './support/credentials.js';
import { prepareUninstallPurge } from '../apps/server/platform/uninstall-purge.js';
import type { HostConfig } from '../shared/platform-contracts.js';
import Database from 'better-sqlite3';
import { symlink, rename, chmod } from 'node:fs/promises';

const exec = promisify(execFile);
async function fixture(run: (root: string, config: HostConfig) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), 'purge-boundary-'));
  try {
    for (const folder of [
      'plugins',
      'runtimes',
      'models',
      'cache/search',
      'data/indexes',
      'config/secrets',
      'knowledge',
    ]) {
      await mkdir(join(root, folder), { recursive: true });
      await writeFile(join(root, folder, 'keep.txt'), 'original');
    }
    await run(root, {
      dataRoot: join(root, 'data'),
      knowledgeRoot: join(root, 'knowledge'),
      profileFile: join(root, 'config/profile.json'),
      secretFile: join(root, 'config/secrets/auth.key'),
      installRoot: join(root, 'install'),
      searchCacheRoot: join(root, 'cache/search'),
      secret: 'fixture',
      origin: 'http://127.0.0.1:15177',
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

it('refuses a cleanup anywhere inside a protected root knowledge library', async () => {
  await fixture(async (root, config) => {
    config.knowledgeRoot = '/';
    expect(() => prepareUninstallPurge(config)()).toThrow(/重叠/);
    expect(await readFile(join(root, 'plugins/keep.txt'), 'utf8')).toBe('original');
  });
});

it('refuses clearing the entire shared XDG cache root', async () => {
  await fixture(async (root, config) => {
    config.searchCacheRoot = join(root, 'cache');
    expect(() => prepareUninstallPurge(config, { XDG_CACHE_HOME: join(root, 'cache') })).toThrow(
      /受保护目录/,
    );
    expect(await readFile(join(root, 'cache/search/keep.txt'), 'utf8')).toBe('original');
  });
});

for (const file of ['backup.dooknow', 'backup.dooknow-backup', 'arbitrary.bin']) {
  it(`refuses the entire purge before removing anything when a backup is inside models: ${file}`, async () => {
    await fixture(async (root, config) => {
      await writeFile(
        join(root, 'models', file),
        file.endsWith('.bin') ? 'DOOKNOWBK1sealed-backup' : 'backup',
      );
      expect(() => prepareUninstallPurge(config)()).toThrow(/备份/);
      expect(await readFile(join(root, 'plugins/keep.txt'), 'utf8')).toBe('original');
      await access(join(root, 'models', file));
    });
  });
}

it('preserves an arbitrarily named backup private key inside a cache target', async () => {
  await fixture(async (root, config) => {
    const file = join(root, 'cache/search/recovery.bin');
    await writeFile(file, '-----BEGIN PRIVATE KEY-----\nretained-recovery-key\n');
    expect(() => prepareUninstallPurge(config)).toThrow(/私钥/);
    expect(await readFile(file, 'utf8')).toContain('retained-recovery-key');
    await access(join(root, 'plugins/keep.txt'));
  });
});

it('protects a knowledge root recorded only in the database', async () => {
  await fixture(async (root, config) => {
    config.knowledgeRoot = undefined;
    const db = new Database(join(config.dataRoot, 'app.sqlite'));
    db.exec('CREATE TABLE platform_settings(id INTEGER PRIMARY KEY,knowledge_root TEXT)');
    db.prepare('INSERT INTO platform_settings VALUES(1,?)').run(join(root, 'models'));
    db.close();
    expect(() => prepareUninstallPurge(config)()).toThrow(/重叠/);
    expect(await readFile(join(root, 'models/keep.txt'), 'utf8')).toBe('original');
    await access(join(root, 'plugins/keep.txt'));
  });
});

for (const ancestor of [false, true]) {
  it(`refuses symlink ${ancestor ? 'ancestors' : 'roots'} before deleting any resource`, async () => {
    await fixture(async (root, config) => {
      await symlink(join(root, 'models'), join(root, 'linked'));
      config.pluginRoot = join(root, 'linked', ...(ancestor ? ['subfolder'] : []));
      expect(() => prepareUninstallPurge(config)()).toThrow(/符号链接/);
      expect(await readFile(join(root, 'models/keep.txt'), 'utf8')).toBe('original');
      await access(join(root, 'runtimes/keep.txt'));
    });
  });
}

it('detects replacement of a planned cleanup root before removing any target', async () => {
  await fixture(async (root, config) => {
    const purge = prepareUninstallPurge(config);
    await rename(join(root, 'models'), join(root, 'previous-models'));
    await mkdir(join(root, 'models'));
    await writeFile(join(root, 'models/new.txt'), 'new owner');
    expect(purge).toThrow(/身份发生变化/);
    expect(await readFile(join(root, 'models/new.txt'), 'utf8')).toBe('new owner');
    await access(join(root, 'plugins/keep.txt'));
  });
});

it('refuses a replacement program releases directory before removing resources', async () => {
  await fixture(async (root, config) => {
    const releases = join(root, 'install/releases');
    await mkdir(join(releases, 'old'), { recursive: true });
    const purge = prepareUninstallPurge(config);
    await rename(releases, join(root, 'previous-releases'));
    await mkdir(releases);
    await writeFile(join(releases, 'new-owner.txt'), 'new owner');
    expect(purge).toThrow(/身份发生变化/);
    expect(await readFile(join(releases, 'new-owner.txt'), 'utf8')).toBe('new owner');
    await access(join(root, 'plugins/keep.txt'));
  });
});

it('protects the physical database when app.sqlite is linked into a cleanup target', async () => {
  await fixture(async (root, config) => {
    const file = join(root, 'models/database.sqlite');
    const db = new Database(file);
    db.exec(
      "CREATE TABLE retained_notes(content TEXT); INSERT INTO retained_notes VALUES('original')",
    );
    db.close();
    const before = await readFile(file);
    await symlink(file, join(root, 'data/app.sqlite'));
    expect(() => prepareUninstallPurge(config)).toThrow(/重叠/);
    expect(await readFile(file)).toEqual(before);
    await access(join(root, 'plugins/keep.txt'));
  });
});

it('removes a venv symlink without touching the external interpreter', async () => {
  await fixture(async (root, config) => {
    const external = join(root, 'external-python');
    await writeFile(external, 'interpreter');
    await symlink(external, join(root, 'runtimes/python'));
    prepareUninstallPurge(config)();
    expect(await readFile(external, 'utf8')).toBe('interpreter');
    await expect(access(join(root, 'runtimes'))).rejects.toMatchObject({ code: 'ENOENT' });
    await access(join(root, 'knowledge/keep.txt'));
  });
});

it('preserves backups stored inside a program release before any purge', async () => {
  await fixture(async (root, config) => {
    const folder = join(root, 'install/releases/old/backups');
    await mkdir(folder, { recursive: true });
    await writeFile(join(folder, 'copy.bin'), 'backup');
    expect(() => prepareUninstallPurge(config)()).toThrow(/备份/);
    await access(join(root, 'plugins/keep.txt'));
    await access(join(folder, 'copy.bin'));
  });
});

it('supports custom and nested resource roots without confusing common path prefixes', async () => {
  await fixture(async (root, config) => {
    config.pluginRoot = join(root, 'knowledge-other');
    config.searchRuntimeRoot = join(root, 'knowledge-other/runtime');
    await mkdir(config.searchRuntimeRoot, { recursive: true });
    prepareUninstallPurge(config)();
    await expect(access(config.pluginRoot)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await readFile(join(root, 'knowledge/keep.txt'), 'utf8')).toBe('original');
  });
});

it('rejects unsafe purge before stopping or disabling a managed service', async () => {
  await fixture(async (root, config) => {
    config.pluginRoot = config.knowledgeRoot;
    config.serviceName = 'purge-fixture.service';
    const secret = 'uninstall-guard-fixture-secret-at-least-thirty-two-characters';
    await writeFile(config.secretFile!, secret, { mode: 0o600 });
    await writeFile(config.profileFile!, JSON.stringify(config), { mode: 0o600 });
    await initializeOwner({ ...config, secret }, 'owner', testPassword);
    const units = join(root, 'xdg/systemd/user'),
      bin = join(root, 'bin'),
      log = join(root, 'controls.log');
    await mkdir(units, { recursive: true });
    await mkdir(bin);
    const unit = join(units, config.serviceName);
    await writeFile(
      unit,
      '# DooKnow profile: ' + config.profileFile + '\n[Service]\nExecStart=/bin/true\n',
    );
    await writeFile(
      join(bin, 'systemctl'),
      '#!/bin/sh\nprintf "%s\\n" "$*" >> "$DOOKNOW_FAKE_SYSTEMCTL_LOG"\n',
    );
    await chmod(join(bin, 'systemctl'), 0o700);
    await expect(
      exec(
        process.execPath,
        [
          '--import',
          'tsx',
          'scripts/manage.ts',
          'uninstall',
          '--purge',
          '--profile',
          config.profileFile!,
        ],
        {
          env: {
            ...process.env,
            XDG_CONFIG_HOME: join(root, 'xdg'),
            PATH: bin + ':' + process.env.PATH,
            DOOKNOW_FAKE_SYSTEMCTL_LOG: log,
            DOOKNOW_NO_SAVED_PROXY: '1',
          },
        },
      ),
    ).rejects.toMatchObject({ code: 1, stderr: expect.stringContaining('重叠') });
    expect(await readFile(log, 'utf8').catch(() => '')).not.toMatch(/stop|disable|daemon-reload/);
    await access(unit);
    expect(await readFile(join(root, 'knowledge/keep.txt'), 'utf8')).toBe('original');
  });
});

it('restricts purge to uninstall and documents its retention policy in help', async () => {
  await expect(
    exec(process.execPath, ['--import', 'tsx', 'scripts/manage.ts', 'status', '--purge']),
  ).rejects.toMatchObject({ code: 1, stderr: expect.stringContaining('--purge 仅用于 uninstall') });
  const result = await exec(process.execPath, [
    '--import',
    'tsx',
    'scripts/manage.ts',
    'uninstall',
    '--help',
  ]);
  expect(result.stdout).toContain('uninstall [--purge]');
  expect(result.stdout).toContain('保留原文');
});

for (const purge of [false, true]) {
  it(`uninstall ${purge ? 'purges managed resources' : 'keeps managed resources by default'} and preserves originals and recovery material`, async () => {
    const root = await mkdtemp(join(tmpdir(), 'uninstall-purge-'));
    try {
      const profileFile = join(root, 'config/profile.json');
      const secretFile = join(root, 'config/auth.key');
      const secret = 'fixture-secret-for-uninstall-at-least-thirty-two-characters';
      const profile = {
        dataRoot: join(root, 'data'),
        knowledgeRoot: join(root, 'knowledge'),
        installRoot: join(root, 'install'),
        secretFile,
        searchCacheRoot: join(root, 'cache/search'),
        origin: 'http://127.0.0.1:15177',
        serviceName: 'purge-fixture.service',
      };
      const resources = ['plugins', 'runtimes', 'models', 'cache/search', 'data/indexes'];
      const kept = [
        'knowledge/note.md',
        'install/backups/before.dooknow',
        'data/backups/data.dooknow',
        'config/backup-key.pem',
      ];
      for (const name of [...resources.map((p) => p + '/payload'), ...kept]) {
        await mkdir(join(root, name, '..'), { recursive: true });
        await writeFile(join(root, name), 'unchanged\r\n');
      }
      await writeFile(secretFile, secret, { mode: 0o600 });
      await writeFile(profileFile, JSON.stringify(profile), { mode: 0o600 });
      await initializeOwner({ ...profile, secret }, 'owner', testPassword);
      const databaseBefore = await readFile(join(root, 'data/app.sqlite'));
      const result = await exec(
        process.execPath,
        [
          '--import',
          'tsx',
          'scripts/manage.ts',
          'uninstall',
          '--profile',
          profileFile,
          ...(purge ? ['--purge'] : []),
        ],
        {
          env: {
            ...process.env,
            XDG_CONFIG_HOME: join(root, 'empty-config'),
            DOOKNOW_BIN_DIR: join(root, 'bin'),
            DOOKNOW_NO_SAVED_PROXY: '1',
          },
        },
      );
      expect(result.stdout).toContain('已卸载');
      for (const name of resources) {
        if (purge) await expect(access(join(root, name))).rejects.toMatchObject({ code: 'ENOENT' });
        else expect(await readFile(join(root, name, 'payload'), 'utf8')).toBe('unchanged\r\n');
      }
      for (const name of kept)
        expect(await readFile(join(root, name), 'utf8')).toBe('unchanged\r\n');
      expect(await readFile(secretFile, 'utf8')).toBe(secret);
      expect(await readFile(profileFile, 'utf8')).toBe(JSON.stringify(profile));
      expect(await readFile(join(root, 'data/app.sqlite'))).toEqual(databaseBefore);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
}
