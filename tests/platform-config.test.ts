import { it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadHostConfig } from '../apps/server/platform/config.js';
it('loads an explicit profile without a knowledge root and resolves command over environment over profile', () => {
  const root = mkdtempSync(join(tmpdir(), 'dooknow-config-'));
  try {
    const secretFile = join(root, 'auth.key'),
      profileFile = join(root, 'profile.json');
    writeFileSync(secretFile, 'test-only-at-least-thirty-two-characters-secret', { mode: 0o600 });
    writeFileSync(
      profileFile,
      JSON.stringify({
        dataRoot: join(root, 'data'),
        secretFile,
        port: 15170,
        origin: 'http://127.0.0.1:15173',
        allowedKnowledgeBases: [join(root, 'libraries')],
      }),
    );
    const config = loadHostConfig({ profileFile, port: 15173 }, { PORT: '15172' });
    expect(config.knowledgeRoot).toBeUndefined();
    expect(config.port).toBe(15173);
    expect(config.dataRoot).toBe(join(root, 'data'));
    expect(config.allowedKnowledgeBases).toEqual([join(root, 'libraries')]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
it('refuses a missing authentication secret instead of replacing it', () => {
  const root = mkdtempSync(join(tmpdir(), 'dooknow-config-'));
  try {
    expect(() =>
      loadHostConfig({ secretFile: join(root, 'missing.key'), dataRoot: join(root, 'data') }, {}),
    ).toThrow();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
it('refuses an installation-root override that does not own the selected profile', () => {
  const root = mkdtempSync(join(tmpdir(), 'dooknow-config-owner-'));
  try {
    const profileFile = join(root, 'profile.json');
    writeFileSync(profileFile, JSON.stringify({ installRoot: join(root, 'owned') }));
    expect(() =>
      loadHostConfig({ profileFile }, { DOOKNOW_INSTALL_ROOT: join(root, 'other') }),
    ).toThrow('此配置已属于另一安装目录');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

it.each(['explicit', 'environment', 'bound'] as const)(
  'fails closed when a %s profile is missing instead of using another instance defaults',
  (selection) => {
    const root = mkdtempSync(join(tmpdir(), 'dooknow-missing-profile-'));
    try {
      const configRoot = join(root, 'other-config'),
        dataRoot = join(root, 'other-data'),
        missingProfile = join(root, 'missing-instance/profile.json'),
        installRoot = join(root, 'install');
      mkdirSync(join(configRoot, 'doo-know/secrets'), { recursive: true });
      mkdirSync(installRoot);
      writeFileSync(
        join(configRoot, 'doo-know/secrets/auth.key'),
        'other-instance-authentication-key-at-least-thirty-two',
        { mode: 0o600 },
      );
      writeFileSync(
        join(configRoot, 'doo-know/profile.json'),
        JSON.stringify({ dataRoot, installRoot: join(root, 'other-installation') }),
      );
      const env: NodeJS.ProcessEnv = { XDG_CONFIG_HOME: configRoot, XDG_DATA_HOME: dataRoot };
      const overrides = selection === 'explicit' ? { profileFile: missingProfile } : {};
      if (selection === 'environment') env.DOOKNOW_PROFILE = missingProfile;
      if (selection === 'bound') {
        env.DOOKNOW_INSTALL_ROOT = installRoot;
        writeFileSync(join(installRoot, 'profile.path'), missingProfile + '\n');
      }
      expect(() => loadHostConfig(overrides, env)).toThrow('配置文件不存在');
      expect(() => readFileSync(missingProfile)).toThrow();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);
