import { it, expect } from 'vitest';
import { mkdtemp, mkdir, writeFile, readlink, symlink, readFile, rm } from 'node:fs/promises';
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
