import { it, expect } from 'vitest';
import { mkdir, writeFile, symlink, link, open } from 'node:fs/promises';
import { join } from 'node:path';
import { createFixture, loginFixtureOwner } from './support/fixture.js';

it('protects storage information and counts metadata without reading large files or following links', async () => {
  const f = await createFixture();
  try {
    expect((await f.app.inject({ url: '/api/maintenance/storage' })).statusCode).toBe(401);
    const headers = await loginFixtureOwner(f);
    const history = join(f.dataRoot, 'history'),
      trash = join(f.knowledgeRoot!, '90-Archive/.trash/note');
    await mkdir(history, { recursive: true });
    await mkdir(trash, { recursive: true });
    const large = await open(join(history, 'large.md'), 'wx');
    try {
      await large.truncate(1024 ** 3);
    } finally {
      await large.close();
    }
    await writeFile(join(trash, 'old.md'), 'old');
    await writeFile(join(f.root, 'private'), 'private material outside managed storage');
    await symlink(join(f.root, 'private'), join(history, 'linked.md'));
    await link(join(f.root, 'private'), join(history, 'hard-linked.md'));
    await symlink(f.root, join(trash, 'external-directory'));
    const result = await f.app.inject({ url: '/api/maintenance/storage', headers });
    expect(result.statusCode).toBe(200);
    expect(result.json()).toMatchObject({
      history: { count: 1, bytes: 1024 ** 3, truncated: false },
      trash: { count: 1, bytes: 3, truncated: false },
      backups: { count: 0, bytes: 0, lastCreatedAt: null },
    });
    expect(result.json().warnings.join(' ')).toContain('链接');
    expect(result.body).not.toContain('private material');
    expect(result.body).not.toContain(f.root);
  } finally {
    await f.close();
  }
});

it('does not traverse a symlinked history root and marks depth-limited counts as partial', async () => {
  const f = await createFixture();
  try {
    const headers = await loginFixtureOwner(f);
    const external = join(f.root, 'external');
    await mkdir(external);
    await writeFile(join(external, 'outside.md'), 'not part of storage');
    await symlink(external, join(f.dataRoot, 'history'));
    const nested = join(f.knowledgeRoot!, '90-Archive/.trash/a/b/c/d/e/f');
    await mkdir(nested, { recursive: true });
    await writeFile(join(nested, 'deep.md'), 'not visited');
    const result = (await f.app.inject({ url: '/api/maintenance/storage', headers })).json();
    expect(result.history.count).toBe(0);
    expect(result.trash).toMatchObject({ count: 0, truncated: true });
    expect(result.warnings.join(' ')).toContain('历史版本');
  } finally {
    await f.close();
  }
});

it('reports known upgrade backups and treats them separately from external backups', async () => {
  const f = await createFixture();
  try {
    const headers = await loginFixtureOwner(f);
    // Configuration is captured by reference by createApp, as it is for the other platform routes.
    (f.config as any).installRoot = join(f.root, 'install');
    const backups = join(f.root, 'install/backups');
    await mkdir(backups, { recursive: true });
    await writeFile(join(backups, 'before-update.dooknow'), 'sealed fixture');
    await writeFile(join(backups, 'incomplete.dooknow.part'), 'incomplete');
    const result = (await f.app.inject({ url: '/api/maintenance/storage', headers })).json();
    expect(result.backups).toMatchObject({
      count: 1,
      bytes: Buffer.byteLength('sealed fixture'),
      truncated: false,
    });
    expect(result.backups.lastCreatedAt).toEqual(expect.any(String));
    expect(result.warnings.join(' ')).toContain('自选位置');
  } finally {
    await f.close();
  }
});

it('caps directory enumeration and keeps maintenance information available before binding a library', async () => {
  const f = await createFixture({ knowledgeRoot: undefined });
  try {
    const headers = await loginFixtureOwner(f);
    const history = join(f.dataRoot, 'history');
    await mkdir(history);
    for (let start = 0; start < 5001; start += 100)
      await Promise.all(
        Array.from({ length: Math.min(100, 5001 - start) }, (_, offset) =>
          writeFile(join(history, `${start + offset}.md`), ''),
        ),
      );
    const response = await f.app.inject({ url: '/api/maintenance/storage', headers });
    expect(response.statusCode).toBe(200);
    expect(response.json().history).toEqual({ count: 5000, bytes: 0, truncated: true });
    expect(response.json().warnings.join(' ')).toContain('尚未绑定');
  } finally {
    await f.close();
  }
});
