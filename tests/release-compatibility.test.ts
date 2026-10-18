import { it, expect } from 'vitest';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { releaseInfo } from '../apps/server/platform/release.js';

it('advertises generation two for development code that understands recoverable move intents', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dooknow-release-compatibility-'));
  try {
    await writeFile(join(root, 'package.json'), JSON.stringify({ version: '1.1.0-rc.18' }));
    expect(releaseInfo(root)).toMatchObject({
      version: '1.1.0-rc.18-dev',
      databaseCompatibility: 2,
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it.each([1, 2])(
  'keeps a packaged release generation %s authoritative for rollback checks',
  async (generation) => {
    const root = await mkdtemp(join(tmpdir(), 'dooknow-release-compatibility-'));
    try {
      const metadata = { version: 'fixture-release', databaseCompatibility: generation };
      await writeFile(join(root, 'release.json'), JSON.stringify(metadata));
      expect(releaseInfo(root)).toEqual(metadata);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);
