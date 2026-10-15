import { it, expect } from 'vitest';
import { mkdtemp, writeFile, readFile, rm, symlink, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sealBackup, unsealBackup } from '../apps/server/platform/sealed-backup.js';
import { restorePlatformBackup } from '../apps/server/platform/backups.js';
it('preserves existing output files when encryption or decryption refuses exclusive creation', async () => {
  const root = await mkdtemp(join(tmpdir(), 'backup-existing-'));
  try {
    const source = join(root, 'source'),
      sealed = join(root, 'sealed'),
      key = join(root, 'key');
    await writeFile(source, 'payload');
    await sealBackup(source, sealed, key, 7);
    await expect(sealBackup(source, sealed, key, 7)).rejects.toThrow();
    expect((await readFile(sealed)).subarray(0, 10).toString()).toBe('DOOKNOWBK1');
    await expect(unsealBackup(sealed, source, key)).rejects.toThrow();
    expect(await readFile(source, 'utf8')).toBe('payload');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
it('rejects overlapping restore targets and a symbolic link secrets directory before touching either', async () => {
  const root = await mkdtemp(join(tmpdir(), 'restore-overlap-'));
  try {
    const source = join(root, 'backup');
    await writeFile(source, 'irrelevant');
    await expect(
      restorePlatformBackup({
        source,
        keyFile: join(root, 'key'),
        target: {
          dataRoot: join(root, 'data'),
          pluginRoot: join(root, 'data/plugins'),
          profileFile: join(root, 'config/profile.json'),
        },
      }),
    ).rejects.toThrow(/独立|重叠/);
    await mkdir(join(root, 'config'));
    await mkdir(join(root, 'elsewhere'));
    await symlink(join(root, 'elsewhere'), join(root, 'config/secrets'));
    await expect(
      restorePlatformBackup({
        source,
        keyFile: join(root, 'key'),
        target: { dataRoot: join(root, 'data'), profileFile: join(root, 'config/profile.json') },
      }),
    ).rejects.toThrow(/真实目录/);
    expect(await readFile(source, 'utf8')).toBe('irrelevant');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
