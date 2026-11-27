import { expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFile, writeFile, mkdir, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { createFixture, loginFixtureOwner } from './support/fixture.js';
import { pluginRuntimeFixture } from './support/plugin-runtime.js';
import { integrationServices } from '../apps/server/features/services.js';
import { writeKnowledgeDataFile } from '../packages/core/knowledge-data.js';

it('adopts the Git author from the repository and rejects a stale settings save', async () => {
  const f = await createFixture();
  try {
    const headers = await loginFixtureOwner(f);
    const initial = (await f.app.inject({ url: '/api/platform/features', headers })).json().git;
    writeKnowledgeDataFile(f.knowledgeRoot, 'plugins/git/state.json', JSON.stringify({
      format: 1, revision: 'synced-config',
      data: {
        schemaVersion: 1,
        plugin: { id: 'git', version: '1.1.4', apiVersion: '^1.0.0' },
        config: { authorName: 'Repository author', authorEmail: 'author@example.invalid' },
        userData: {},
      },
    }));
    const conflict = await f.app.inject({
      method: 'PUT', url: '/api/platform/git/config', headers,
      payload: { configVersion: initial.configVersion, values: { authorName: 'Stale draft' } },
    });
    expect(conflict.statusCode).toBe(409);
    const current = (await f.app.inject({ url: '/api/platform/features', headers })).json().git;
    expect(current).toMatchObject({
      state: 'disabled', config: { authorName: 'Repository author', authorEmail: 'author@example.invalid' },
    });
  } finally { await f.close(); }
});

it('never reads or replaces a symbolic link to a portable Git settings file', async () => {
  const f = await createFixture();
  try {
    const headers = await loginFixtureOwner(f);
    const target = join(f.root, 'outside.json');
    await writeFile(target, 'external content');
    const directory = join(f.knowledgeRoot, '_doo-data/plugins/git');
    await mkdir(directory, { recursive: true });
    await symlink(target, join(directory, 'state.json'));
    const before = (await f.app.inject({ url: '/api/platform/features', headers })).json().git;
    expect(before.error).toBe('PORTABLE_GIT_SETTINGS_UNAVAILABLE');
    const save = await f.app.inject({
      method: 'PUT', url: '/api/platform/git/config', headers,
      payload: { configVersion: before.configVersion, values: { authorName: 'New author' } },
    });
    expect(save.statusCode).toBe(503);
    expect(await readFile(target, 'utf8')).toBe('external content');
    expect((await f.app.inject({ url: '/api/tree', headers })).statusCode).toBe(200);
  } finally { await f.close(); }
});

it('includes external note identities before a Git snapshot so later discovery does not invalidate it', async () => {
  const f = await pluginRuntimeFixture();
  try {
    const runtime = f.platform.get();
    await runtime.collections.close();
    execFileSync('git', ['init', '--initial-branch=main', f.config.knowledgeRoot]);
    await writeFile(join(f.config.knowledgeRoot, '00-Inbox/external.md'), '# external note');
    const services = integrationServices(f.platform, f.db, 'git',
      ['knowledge:read', 'knowledge:write', 'workspace:git'],
      { ownerId: f.principal.id, principal: f.principal, channel: 'web' });
    const workspace = services.workspace!;
    const env = { GIT_INDEX_FILE: join(f.config.dataRoot, 'snapshot-index') };
    const snapshot = () => workspace.exclusive(async () => {
      expect((await workspace.exec(['add', '--all', '--', '.'], { env })).code).toBe(0);
      return (await workspace.exec(['write-tree'], { env })).stdout.toString().trim();
    });
    const preview = await snapshot();
    runtime.notes.scan();
    expect(await snapshot()).toBe(preview);
  } finally { await f.close(); }
});
