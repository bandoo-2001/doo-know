import { it, expect } from 'vitest';
import { mkdtemp, rm, writeFile, readFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
// @ts-expect-error build tool is plain ESM
import { buildPlugins } from '../scripts/build-plugins.mjs';
import { createFixture, loginFixtureOwner } from './support/fixture.js';
it('previews all changes privately, rejects stale previews, publishes one idempotent commit and restores a note through core', async () => {
  const output = await mkdtemp(join(tmpdir(), 'git-plugin-artifacts-'));
  const catalog = await buildPlugins({
    output,
    ids: ['git'],
    baseURL: pathToFileURL(output + '/').href,
  });
  const f = await createFixture({ pluginCatalog: catalog });
  const git = (...args: string[]) =>
    execFileSync('git', ['-C', f.knowledgeRoot, ...args], { encoding: 'utf8' }).trim();
  try {
    const headers = await loginFixtureOwner(f),
      post = (url: string, payload: any) => f.app.inject({ method: 'POST', url, headers, payload });
    const call = async (id: string, input: any = {}) => {
      const r = await post('/api/plugins/git/call', {
        kind:
          id === 'git.status' || id === 'git.history' || id === 'git.diff' ? 'provider' : 'command',
        id,
        input,
      });
      if (r.statusCode !== 200)
        throw Object.assign(Error(r.json().code || r.body), { code: r.json().code });
      return r.json();
    };
    await post('/api/platform/plugins/git/install', {});
    await f.app.inject({
      method: 'PUT',
      url: '/api/platform/plugins/git/config',
      headers,
      payload: {
        configVersion: 0,
        values: { authorName: 'Fixture', authorEmail: 'fixture@example.invalid' },
      },
    });
    expect((await post('/api/platform/plugins/git/enable', {})).statusCode).toBe(200);
    expect((await call('git.status')).repository).toBe('missing');
    await call('git.initialize', { requestId: 'git-init' });
    expect(git('symbolic-ref', '--short', 'HEAD')).toBe('main');
    const created = await post('/api/notes', {
      folderPath: '00-Inbox',
      fileName: '带 空格.md',
      content: '# original',
      requestId: 'git-note',
    });
    expect(created.statusCode).toBe(201);
    const note = created.json();
    const first = await call('git.preview', { message: 'Initial knowledge' });
    expect(first.changes.some((c: any) => c.path === '00-Inbox/带 空格.md')).toBe(true);
    await expect(readFile(join(f.knowledgeRoot, '.git/index'))).rejects.toThrow();
    const committed = await call('git.commit', { token: first.token, requestId: 'commit-initial' });
    expect(committed.commit).toBe(git('rev-parse', 'HEAD'));
    expect(
      (await call('git.commit', { token: first.token, requestId: 'commit-initial' })).commit,
    ).toBe(committed.commit);
    expect(git('rev-list', '--count', 'HEAD')).toBe('1');
    await writeFile(join(f.knowledgeRoot, '00-Inbox/带 空格.md'), '# staged');
    git('add', '--all');
    const staged = git('show', ':00-Inbox/带 空格.md');
    await writeFile(join(f.knowledgeRoot, '00-Inbox/带 空格.md'), '# current complete file');
    await writeFile(join(f.knowledgeRoot, '.gitignore'), 'ignored.bin\n');
    await writeFile(join(f.knowledgeRoot, 'ignored.bin'), 'ignored');
    await writeFile(join(f.knowledgeRoot, '00-Inbox/new.md'), '# new');
    const preview = await call('git.preview', { message: 'All changes' });
    expect(preview.partialStaging).toContain('00-Inbox/带 空格.md');
    expect(git('show', ':00-Inbox/带 空格.md')).toBe(staged);
    expect(preview.changes.some((c: any) => c.path === 'ignored.bin')).toBe(false);
    await writeFile(join(f.knowledgeRoot, '00-Inbox/new.md'), '# changed after preview');
    await expect(
      call('git.commit', { token: preview.token, requestId: 'stale-commit' }),
    ).rejects.toMatchObject({ code: 'PREVIEW_STALE' });
    expect(git('show', ':00-Inbox/带 空格.md')).toBe(staged);
    expect(git('rev-list', '--count', 'HEAD')).toBe('1');
    const current = await call('git.preview', { message: 'All current changes' });
    const second = await call('git.commit', { token: current.token, requestId: 'commit-second' });
    expect(second.needsReconciliation).toBe(false);
    expect(git('show', 'HEAD:00-Inbox/带 空格.md')).toBe('# current complete file');
    expect(git('status', '--porcelain')).toBe('');
    const history = await call('git.history', { noteId: note.id, limit: 1 });
    expect(history.items).toHaveLength(1);
    expect(history.nextCursor).toBeTruthy();
    const older = await call('git.history', {
      noteId: note.id,
      limit: 1,
      cursor: history.nextCursor,
    });
    expect(older.items[0].commit).toBe(committed.commit);
    const info = (await f.app.inject({ url: '/api/notes/' + note.id, headers })).json();
    const restored = await call('git.restore', {
      noteId: note.id,
      commit: committed.commit,
      expectedModifiedAt: info.modifiedAt,
      requestId: 'git-restore',
    });
    expect(restored.id).toBe(note.id);
    expect(await readFile(join(f.knowledgeRoot, '00-Inbox/带 空格.md'), 'utf8')).toBe('# original');
    const revisions = (
      await f.app.inject({ url: '/api/notes/' + note.id + '/revisions', headers })
    ).json();
    expect(revisions.items.length).toBeGreaterThan(0);
    git('config', 'filter.untrusted.clean', 'sh -c exit');
    await expect(call('git.preview', { message: 'unsafe filter' })).rejects.toMatchObject({
      code: 'UNTRUSTED_GIT_FILTER',
    });
  } finally {
    await f.close();
    await rm(output, { force: true, recursive: true });
  }
}, 60000);
