import { it, expect } from 'vitest';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { initializeOwner } from '../apps/server/auth.js';
import { testPassword } from './support/credentials.js';
const exec = promisify(execFile);
it('refuses to bind an existing profile to a different installation before creating data or secrets', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dooknow-cli-owner-'));
  try {
    const profileFile = join(root, 'profile.json');
    const profile = {
      dataRoot: join(root, 'data'),
      secretFile: join(root, 'missing.key'),
      installRoot: join(root, 'owned'),
      port: 15177,
      origin: 'http://127.0.0.1:15177',
    };
    await writeFile(profileFile, JSON.stringify(profile), { mode: 0o600 });
    await expect(
      exec(process.execPath, [
        '--import',
        'tsx',
        'scripts/manage.ts',
        'install',
        '--profile',
        profileFile,
        '--install-root',
        join(root, 'other'),
        '--no-service',
      ]),
    ).rejects.toMatchObject({
      code: 1,
      stderr: expect.stringContaining('此配置已属于另一安装目录'),
    });
    expect(JSON.parse(await readFile(profileFile, 'utf8'))).toEqual(profile);
    await expect(readFile(profile.secretFile)).rejects.toMatchObject({ code: 'ENOENT' });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
it('reinstall with an existing owner needs no TTY and preserves the secret and profile', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dooknow-cli-'));
  try {
    const secretFile = join(root, 'auth.key'),
      profileFile = join(root, 'profile.json');
    const secret = 'cli-fixture-secret-at-least-thirty-two-characters';
    await writeFile(secretFile, secret, { mode: 0o600 });
    const profile = {
      dataRoot: join(root, 'data'),
      secretFile,
      origin: 'http://127.0.0.1:15177',
      port: 15177,
    };
    await writeFile(profileFile, JSON.stringify(profile), { mode: 0o600 });
    await initializeOwner({ ...profile, secret }, 'owner', testPassword);
    const result = await exec(process.execPath, [
      '--import',
      'tsx',
      'scripts/manage.ts',
      'install',
      '--profile',
      profileFile,
      '--no-service',
    ]);
    expect(result.stdout).toContain('账号已存在');
    expect(await readFile(secretFile, 'utf8')).toBe(secret);
    expect(JSON.parse(await readFile(profileFile, 'utf8'))).toEqual(profile);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
it('fresh noninteractive installation never creates an empty-password owner', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dooknow-cli-'));
  try {
    await expect(
      exec(process.execPath, [
        '--import',
        'tsx',
        'scripts/manage.ts',
        'install',
        '--profile',
        join(root, 'profile.json'),
        '--data-root',
        join(root, 'data'),
        '--port',
        '15179',
        '--no-service',
      ]),
    ).rejects.toMatchObject({ code: 1, stderr: expect.stringContaining('账号初始化需要本机终端') });
    expect(JSON.parse(await readFile(join(root, 'profile.json'), 'utf8'))).toMatchObject({
      dataRoot: join(root, 'data'),
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it('does not recreate a missing bound profile even through the installation creation entry', async () => {
  const { mkdir } = await import('node:fs/promises');
  const root = await mkdtemp(join(tmpdir(), 'dooknow-cli-missing-bound-'));
  try {
    const installRoot = join(root, 'install'),
      profileFile = join(root, 'original-config/profile.json');
    await mkdir(installRoot);
    await writeFile(join(installRoot, 'profile.path'), profileFile + '\n');
    await expect(
      exec(process.execPath, [
        '--import',
        'tsx',
        'scripts/manage.ts',
        'install',
        '--profile',
        profileFile,
        '--install-root',
        installRoot,
        '--data-root',
        join(root, 'wrong-data'),
        '--port',
        '15179',
        '--no-service',
      ]),
    ).rejects.toMatchObject({ code: 1, stderr: expect.stringContaining('配置文件不存在') });
    await expect(readFile(profileFile)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(readFile(join(root, 'original-config/secrets/auth.key'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
it('lets a legacy launcher recover its trusted profile after the candidate migration without inherited XDG settings', async () => {
  const { mkdir } = await import('node:fs/promises');
  const root = await mkdtemp(join(tmpdir(), 'dooknow-legacy-launcher-'));
  try {
    const installRoot = join(root, 'install'),
      profileFile = join(root, 'custom/profile.json');
    const secretFile = join(root, 'auth.key'),
      secret = 'legacy-launcher-fixture-secret-at-least-thirty-two';
    await mkdir(installRoot);
    await mkdir(join(root, 'custom'));
    await writeFile(secretFile, secret, { mode: 0o600 });
    const profile = {
      dataRoot: join(root, 'data'),
      secretFile,
      installRoot,
      serviceManaged: false,
      port: 15177,
      origin: 'http://127.0.0.1:15177',
    };
    await writeFile(profileFile, JSON.stringify(profile));
    await initializeOwner({ ...profile, secret }, 'owner', testPassword);
    const entry = join(process.cwd(), 'scripts/manage.ts');
    const inherited: NodeJS.ProcessEnv = {
      ...process.env,
      XDG_CONFIG_HOME: join(root, 'unrelated'),
      DOOKNOW_INSTALL_ROOT: installRoot,
    };
    delete inherited.DOOKNOW_PROFILE;
    await mkdir(join(root, 'unrelated/doo-know'), { recursive: true });
    await writeFile(
      join(root, 'unrelated/doo-know/profile.json'),
      JSON.stringify({
        ...profile,
        installRoot: join(root, 'another-installation'),
        dataRoot: join(root, 'another-data'),
      }),
    );
    await expect(
      exec(process.execPath, ['--import', 'tsx', entry, 'status'], { env: inherited }),
    ).rejects.toMatchObject({ stderr: expect.stringContaining('安装目录尚未绑定配置') });
    // This is the existing updater's invocation of the newly downloaded candidate.
    await exec(process.execPath, ['--import', 'tsx', entry, 'migrate', '--profile', profileFile], {
      env: inherited,
    });
    expect((await readFile(join(installRoot, 'profile.path'), 'utf8')).trim()).toBe(profileFile);
    const result = await exec(process.execPath, ['--import', 'tsx', entry, 'status'], {
      env: inherited,
    });
    expect(JSON.parse(result.stdout)).toMatchObject({ profileFile, dataRoot: profile.dataRoot });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
it('completes provider initialization before closing an offline self-check database', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dooknow-selfcheck-'));
  try {
    const secretFile = join(root, 'auth.key'),
      profileFile = join(root, 'profile.json'),
      secret = 'selfcheck-fixture-secret-at-least-thirty-two-characters';
    await writeFile(secretFile, secret, { mode: 0o600 });
    const profile = {
      dataRoot: join(root, 'data'),
      secretFile,
      origin: 'http://127.0.0.1:15177',
      port: 15177,
    };
    await writeFile(profileFile, JSON.stringify(profile), { mode: 0o600 });
    await initializeOwner({ ...profile, secret }, 'owner', testPassword);
    const result = await exec(process.execPath, [
      '--import',
      'tsx',
      'scripts/manage.ts',
      'self-check',
      '--profile',
      profileFile,
      '--data-root',
      join(root, 'independent-check'),
    ]);
    expect(JSON.parse(result.stdout)).toMatchObject({ check: 'ok' });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
for (const suffix of ['-other', '/other-profile.json'])
  it('uninstall checks exact service ownership before any control action: ' + suffix, async () => {
    const { mkdir, chmod } = await import('node:fs/promises');
    const root = await mkdtemp(join(tmpdir(), 'dooknow-uninstall-owner-'));
    try {
      const secretFile = join(root, 'auth.key'),
        profileFile = join(root, 'profile.json'),
        secret = 'uninstall-fixture-secret-at-least-thirty-two-characters',
        configRoot = join(root, 'config'),
        bin = join(root, 'bin'),
        log = join(root, 'systemctl.log');
      await writeFile(secretFile, secret, { mode: 0o600 });
      const profile = {
        dataRoot: join(root, 'data'),
        secretFile,
        origin: 'http://127.0.0.1:15177',
        serviceName: 'other-install.service',
      };
      await writeFile(profileFile, JSON.stringify(profile), { mode: 0o600 });
      await initializeOwner({ ...profile, secret }, 'owner', testPassword);
      await mkdir(join(configRoot, 'systemd/user'), { recursive: true });
      await writeFile(
        join(configRoot, 'systemd/user/other-install.service'),
        '# DooKnow profile: ' + profileFile + suffix + '\n[Service]\nExecStart=/bin/true\n',
      );
      await mkdir(bin);
      await writeFile(
        join(bin, 'systemctl'),
        '#!/bin/sh\nprintf "%s\\n" "$*" >> "$DOOKNOW_FAKE_SYSTEMCTL_LOG"\ncase "$*" in *is-active*) printf "inactive\\n"; exit 3;; esac\n',
      );
      await chmod(join(bin, 'systemctl'), 0o700);
      await expect(
        exec(
          process.execPath,
          ['--import', 'tsx', 'scripts/manage.ts', 'uninstall', '--profile', profileFile],
          {
            env: {
              ...process.env,
              XDG_CONFIG_HOME: configRoot,
              PATH: bin + ':' + process.env.PATH,
              DOOKNOW_FAKE_SYSTEMCTL_LOG: log,
            },
          },
        ),
      ).rejects.toMatchObject({ code: 1 });
      const calls = await readFile(log, 'utf8').catch(() => '');
      expect(calls).not.toMatch(/disable|enable|stop|restart|daemon-reload/);
      expect(
        await readFile(join(configRoot, 'systemd/user/other-install.service'), 'utf8'),
      ).toContain(profileFile + suffix);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
it('uninstall leaves a launcher whose installation directory only shares a prefix', async () => {
  const { mkdir } = await import('node:fs/promises');
  const root = await mkdtemp(join(tmpdir(), 'uninstall-launcher-'));
  try {
    const secretFile = join(root, 'auth.key'),
      profileFile = join(root, 'profile.json'),
      bin = join(root, 'bin'),
      secret = 'launcher-fixture-secret-at-least-thirty-two-characters',
      installRoot = join(root, 'owned');
    await writeFile(secretFile, secret, { mode: 0o600 });
    const profile = {
      dataRoot: join(root, 'data'),
      secretFile,
      origin: 'http://127.0.0.1:15177',
      installRoot,
      serviceName: 'missing-fixture.service',
    };
    await writeFile(profileFile, JSON.stringify(profile), { mode: 0o600 });
    await initializeOwner({ ...profile, secret }, 'owner', testPassword);
    await mkdir(bin);
    const other = '#!/bin/bash\nexport DOOKNOW_INSTALL_ROOT=' + installRoot + '-other\n';
    await writeFile(join(bin, 'dooknow'), other);
    await exec(
      process.execPath,
      ['--import', 'tsx', 'scripts/manage.ts', 'uninstall', '--profile', profileFile],
      { env: { ...process.env, XDG_CONFIG_HOME: join(root, 'config'), DOOKNOW_BIN_DIR: bin } },
    );
    expect(await readFile(join(bin, 'dooknow'), 'utf8')).toBe(other);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
