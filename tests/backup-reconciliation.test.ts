import { it, expect } from 'vitest';
import { mkdir, writeFile, readFile, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { createFixture, loginFixtureOwner } from './support/fixture.js';
import { createPlatformBackup, restorePlatformBackup } from '../apps/server/platform/backups.js';

it('preserves reconciliation manifests and all material hashes through encrypted backup and empty-directory restore', async () => {
  const f = await createFixture();
  try {
    await loginFixtureOwner(f);
    await f.app.close();
    const evidence = join(f.dataRoot, 'reconciliation/resolution-operation');
    await mkdir(evidence, { recursive: true });
    const materials = {
      'disk.md': Buffer.from('current disk\r\n'),
      'staged.md': Buffer.from('interrupted proposed change\n'),
      'history.md': Buffer.from('previous version\n'),
      'manifest.json': Buffer.from(
        JSON.stringify({ resolutionOperationId: 'resolution-operation', strategy: 'keep_disk' }),
      ),
    };
    for (const [name, bytes] of Object.entries(materials))
      await writeFile(join(evidence, name), bytes);
    const destination = join(f.root, 'backup.dooknow'),
      keyFile = join(f.root, 'recovery.pem');
    await createPlatformBackup(f.config, { destination, keyFile });
    const target = {
      dataRoot: join(f.root, 'restored-data'),
      knowledgeRoot: join(f.root, 'restored-knowledge'),
      profileFile: join(f.root, 'restored-config/profile.json'),
    };
    await restorePlatformBackup({ source: destination, keyFile, target });
    const hash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
    for (const [name, bytes] of Object.entries(materials))
      expect(
        hash(await readFile(join(target.dataRoot, 'reconciliation/resolution-operation', name))),
      ).toBe(hash(bytes));
  } finally {
    await f.close();
  }
});

it('refuses a symlinked reconciliation tree rather than backing up material outside the data root', async () => {
  const f = await createFixture();
  try {
    await loginFixtureOwner(f);
    await f.app.close();
    const outside = join(f.root, 'outside');
    await mkdir(outside);
    await writeFile(join(outside, 'private.md'), 'outside material');
    await symlink(outside, join(f.dataRoot, 'reconciliation'));
    await expect(
      createPlatformBackup(f.config, {
        destination: join(f.root, 'backup.dooknow'),
        keyFile: join(f.root, 'key.pem'),
      }),
    ).rejects.toThrow(/链接|真实目录/);
  } finally {
    await f.close();
  }
});
