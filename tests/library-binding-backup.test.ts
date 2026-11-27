import { expect, it } from 'vitest';
import { mkdir, rename, writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createFixture, loginFixtureOwner } from './support/fixture.js';
import { createPlatformBackup } from '../apps/server/platform/backups.js';

it('distinguishes a moved root from a same-path replacement and refuses to back up unrelated notes', async () => {
  const f = await createFixture();
  try {
    const headers = await loginFixtureOwner(f);
    const status = async () =>
      (await f.app.inject({ url: '/api/platform/status', headers })).json();
    const author = await f.app.inject({
      method: 'PUT',
      url: '/api/platform/git/config',
      headers,
      payload: {
        configVersion: 0,
        values: { authorName: 'Previous author', authorEmail: 'previous@example.invalid' },
      },
    });
    expect(author.statusCode).toBe(200);
    const archived = join(f.root, 'archived');
    await rename(f.knowledgeRoot, archived);
    expect(await status()).toMatchObject({
      phase: 'source_unavailable',
      code: 'SOURCE_UNAVAILABLE',
      sourceProblem: 'missing',
      knowledgeRoot: f.knowledgeRoot,
    });
    await mkdir(f.knowledgeRoot);
    await writeFile(join(f.knowledgeRoot, 'replacement.md'), 'Unrelated directory');
    expect(await status()).toMatchObject({
      phase: 'source_unavailable',
      sourceProblem: 'replaced',
    });
    const features = await f.app.inject({ url: '/api/platform/features', headers });
    expect(features.json().git.error).toBe('PORTABLE_GIT_SETTINGS_UNAVAILABLE');
    await expect(
      readFile(join(f.knowledgeRoot, '_doo-data/plugins/git/state.json')),
    ).rejects.toMatchObject({ code: 'ENOENT' });
    const destination = join(f.root, 'test.dkb');
    await expect(createPlatformBackup(f.config, { destination })).rejects.toMatchObject({
      code: 'SOURCE_UNAVAILABLE',
    });
    await expect(readFile(destination)).rejects.toMatchObject({ code: 'ENOENT' });
    await rename(f.knowledgeRoot, join(f.root, 'other'));
    await rename(archived, f.knowledgeRoot);
    expect(await status()).toMatchObject({ phase: 'ready', components: { knowledge: true } });
    expect((await status()).sourceProblem).toBeUndefined();
  } finally {
    await f.close();
  }
});
