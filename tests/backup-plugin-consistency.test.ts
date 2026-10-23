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
        throw Object.assign(new Error('Synthetic plugin entry disappeared during inventory'), {
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
  const pluginRoot = join(f.root, 'plugin-packages');
  const pluginData = join(f.dataRoot, 'plugins/synthetic');
  await mkdir(pluginRoot);
  await mkdir(pluginData, { recursive: true });
  const code = join(pluginRoot, 'synthetic.js');
  const data = join(pluginData, 'state.json');
  await writeFile(code, 'export const fixture = true;\n');
  await writeFile(data, '{"value":"before"}\n');
  return {
    ...f,
    code,
    data,
    pluginRoot,
    destination: join(f.root, 'backup.dkb'),
    keyFile: join(f.root, 'backup.pem'),
  };
}

it('preserves stable plugin packages and data in the encrypted backup and actual restore', async () => {
  const f = await fixture();
  try {
    await createPlatformBackup({ ...f.config, pluginRoot: f.pluginRoot }, f);
    const target = {
      dataRoot: join(f.root, 'restored-data'),
      knowledgeRoot: join(f.root, 'restored-knowledge'),
      profileFile: join(f.root, 'restored-config/profile.json'),
      pluginRoot: join(f.root, 'restored-plugins'),
    };
    await restorePlatformBackup({ source: f.destination, keyFile: f.keyFile, target });
    expect(await readFile(join(target.pluginRoot, 'synthetic.js'), 'utf8')).toBe(
      await readFile(f.code, 'utf8'),
    );
    expect(await readFile(join(target.dataRoot, 'plugins/synthetic/state.json'), 'utf8')).toBe(
      '{"value":"before"}\n',
    );
  } finally {
    await f.close();
  }
});

it.each(['packages', 'data'] as const)(
  'refuses a %s change between the database snapshot and completed file copies',
  async (kind) => {
    const f = await fixture();
    const changed = kind === 'packages' ? f.code : f.data;
    const latest =
      kind === 'packages'
        ? 'export const fixture = "changed while copying";\n'
        : '{"value":"changed while copying"}\n';
    try {
      // Keep the real filesystem copy. Change one real synthetic file after the
      // package copy; the database snapshot has already completed at this point.
      copying.source = f.pluginRoot;
      copying.after = () => writeFile(changed, latest);
      await expect(
        createPlatformBackup({ ...f.config, pluginRoot: f.pluginRoot }, f),
      ).rejects.toThrow('备份期间插件文件变化');
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
      createPlatformBackup({ ...f.config, pluginRoot: f.pluginRoot }, f),
    ).rejects.toThrow();
    expect((await readdir(f.root)).some((name) => name.startsWith('.backup-'))).toBe(false);
    await expect(readFile(f.destination)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await readFile(f.data, 'utf8')).toBe('{"value":"before"}\n');
  } finally {
    await f.close();
  }
});

it('does not treat a failed scan inside an existing plugin directory as a missing optional root', async () => {
  const f = await fixture();
  try {
    copying.vanishedPath = f.code;
    await expect(
      createPlatformBackup({ ...f.config, pluginRoot: f.pluginRoot }, f),
    ).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await readFile(f.code, 'utf8')).toBe('export const fixture = true;\n');
    await expect(readFile(f.destination)).rejects.toMatchObject({ code: 'ENOENT' });
    expect((await readdir(f.root)).some((name) => name.startsWith('.backup-'))).toBe(false);
  } finally {
    copying.vanishedPath = '';
    await f.close();
  }
});
