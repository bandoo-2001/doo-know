import { expect, it, vi } from 'vitest';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createFixture, loginFixtureOwner } from './support/fixture.js';
import { createPlatformBackup, restorePlatformBackup } from '../apps/server/platform/backups.js';

const copying = vi.hoisted(() => ({
  source: '',
  vanishedPath: '',
  after: undefined as (() => Promise<void>) | undefined,
}));
vi.mock('node:fs/promises', async (original) => {
  const fs = await original<typeof import('node:fs/promises')>();
  return {
    ...fs,
    lstat: async (...args: Parameters<typeof fs.lstat>) => {
      if (String(args[0]) === copying.vanishedPath)
        throw Object.assign(new Error('Synthetic runtime entry disappeared during inventory'), {
          code: 'ENOENT',
        });
      return fs.lstat(...args);
    },
    cp: async (...args: Parameters<typeof fs.cp>) => {
      await fs.cp(...args);
      if (String(args[0]) === copying.source) {
        const after = copying.after;
        copying.after = undefined;
        await after?.();
      }
    },
  };
});

async function fixture() {
  const f = await createFixture();
  await loginFixtureOwner(f);
  await f.app.close();
  const secretDirectory = join(f.dataRoot, 'secrets/plugins');
  const gitData = join(f.dataRoot, 'plugins/git');
  await mkdir(join(secretDirectory, 'mcp/runtime'), { recursive: true });
  await mkdir(gitData, { recursive: true });
  const secret = join(secretDirectory, 'mcp/runtime/objects.key');
  const data = join(gitData, 'state.json');
  await writeFile(secret, 'synthetic-object-secret-fixture', { mode: 0o600 });
  await writeFile(data, '{"value":"before"}\n');
  return {
    ...f,
    secret,
    data,
    secretDirectory,
    destination: join(f.root, 'backup.dkb'),
    keyFile: join(f.root, 'backup.pem'),
  };
}

it('preserves the MCP signing material and Git data in the encrypted backup and actual restore', async () => {
  const f = await fixture();
  try {
    await createPlatformBackup(f.config, f);
    const target = {
      dataRoot: join(f.root, 'restored-data'),
      knowledgeRoot: join(f.root, 'restored-knowledge'),
      profileFile: join(f.root, 'restored-config/profile.json'),
    };
    await restorePlatformBackup({ source: f.destination, keyFile: f.keyFile, target });
    expect(await readFile(join(f.root, 'restored-config/secrets/plugins/mcp/runtime/objects.key'), 'utf8')).toBe(
      await readFile(f.secret, 'utf8'),
    );
    expect(await readFile(join(target.dataRoot, 'plugins/git/state.json'), 'utf8')).toBe(
      '{"value":"before"}\n',
    );
  } finally {
    await f.close();
  }
});

it.each(['secrets', 'data'] as const)(
  'refuses a %s change between the database snapshot and completed file copies',
  async (kind) => {
    const f = await fixture();
    const changed = kind === 'secrets' ? f.secret : f.data;
    const latest =
      kind === 'secrets'
        ? 'updated-synthetic-mcp-secret'
        : '{"value":"changed while copying"}\n';
    try {
      // Keep the real filesystem copy. Change one real synthetic file after the
      // secret directory copy; the database snapshot has already completed at this point.
      copying.source = f.secretDirectory;
      copying.after = () => writeFile(changed, latest);
      await expect(
        createPlatformBackup(f.config, f),
      ).rejects.toThrow('备份期间 Git 或 MCP 的运行文件变化');
      expect(copying.after).toBeUndefined();
      expect(await readFile(changed, 'utf8')).toBe(latest);
      await expect(readFile(f.destination)).rejects.toMatchObject({ code: 'ENOENT' });
      expect((await readdir(f.root)).some((name) => name.startsWith('.backup-'))).toBe(false);
    } finally {
      copying.source = '';
      copying.after = undefined;
      await f.close();
    }
  },
);

it('removes the empty backup stage if the database cannot be opened', async () => {
  const f = await fixture();
  try {
    await writeFile(join(f.dataRoot, 'app.sqlite'), 'Synthetic corrupt database\n');
    await expect(
      createPlatformBackup(f.config, f),
    ).rejects.toThrow();
    expect((await readdir(f.root)).some((name) => name.startsWith('.backup-'))).toBe(false);
    await expect(readFile(f.destination)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await readFile(f.data, 'utf8')).toBe('{"value":"before"}\n');
  } finally {
    await f.close();
  }
});

it('does not treat a failed scan inside an existing runtime directory as a missing optional root', async () => {
  const f = await fixture();
  try {
    copying.vanishedPath = f.secret;
    await expect(
      createPlatformBackup(f.config, f),
    ).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await readFile(f.secret, 'utf8')).toBe('synthetic-object-secret-fixture');
    await expect(readFile(f.destination)).rejects.toMatchObject({ code: 'ENOENT' });
    expect((await readdir(f.root)).some((name) => name.startsWith('.backup-'))).toBe(false);
  } finally {
    copying.vanishedPath = '';
    await f.close();
  }
});
