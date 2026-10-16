import { it, expect } from 'vitest';
import { readFile, writeFile, symlink, mkdir, rm, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { createFixture, loginFixtureOwner } from './support/fixture.js';
it('creates the first category at the root of an empty knowledge base', async () => {
  const f = await createFixture();
  try {
    const headers = await loginFixtureOwner(f);
    await rm(join(f.knowledgeRoot, '00-Inbox'), { recursive: true });
    expect((await f.app.inject({ url: '/api/tree', headers })).json()).toEqual([]);
    const create = (parent: string, name: string) =>
      f.app.inject({ method: 'POST', url: '/api/folders', headers, payload: { parent, name } });
    const first = await create('', '00-Inbox');
    expect(first.statusCode, first.body).toBe(201);
    expect(first.json()).toMatchObject([{ path: '00-Inbox', type: 'folder', children: [] }]);
    expect((await create('00-Inbox', '阅读')).statusCode).toBe(201);
    expect(await readdir(join(f.knowledgeRoot, '00-Inbox'))).toEqual(['阅读']);
    expect((await create('', '00-Inbox')).statusCode).toBe(409);
  } finally {
    await f.close();
  }
});
it('creates a root README with a stable write receipt in an empty knowledge base', async () => {
  const f = await createFixture();
  try {
    const headers = await loginFixtureOwner(f);
    await rm(join(f.knowledgeRoot, '00-Inbox'), { recursive: true });
    const create = (requestId: string) =>
      f.app.inject({
        method: 'POST',
        url: '/api/notes',
        headers,
        payload: { folderPath: '', fileName: 'README.md', content: '# 知识库\n', requestId },
      });
    const first = await create('root-readme');
    expect(first.statusCode, first.body).toBe(201);
    expect(first.json().relativePath).toBe('README.md');
    expect(await readFile(join(f.knowledgeRoot, 'README.md'), 'utf8')).toBe('# 知识库\n');
    const repeated = await create('root-readme');
    expect(repeated.statusCode, repeated.body).toBe(201);
    expect(repeated.json().id).toBe(first.json().id);
    expect((await create('duplicate-readme')).statusCode).toBe(409);
    expect((await f.app.inject({ url: '/api/tree', headers })).json()).toMatchObject([
      { path: 'README.md', type: 'note', id: first.json().id },
    ]);
  } finally {
    await f.close();
  }
});
it('keeps root creation inside the managed categories and refuses unsafe parents', async () => {
  const f = await createFixture();
  try {
    const headers = await loginFixtureOwner(f);
    await mkdir(join(f.root, 'outside'));
    await symlink(join(f.root, 'outside'), join(f.knowledgeRoot, '00-Inbox/link'));
    for (const [parent, name] of [
      ['', 'other'],
      ['', 'assets'],
      ['', '.hidden'],
      ['', '../escaped'],
      ['.', '10-Projects'],
      ['../outside', 'escaped'],
      ['/tmp', 'escaped'],
      ['00-Inbox/link', 'escaped'],
      ['00-Inbox', 'assets'],
    ]) {
      const result = await f.app.inject({
        method: 'POST',
        url: '/api/folders',
        headers,
        payload: { parent, name },
      });
      expect(result.statusCode, `${parent}/${name}: ${result.body}`).toBe(400);
    }
    for (const fileName of ['other.md', 'AGENTS.md']) {
      const result = await f.app.inject({
        method: 'POST',
        url: '/api/notes',
        headers,
        payload: { folderPath: '', fileName, content: 'blocked' },
      });
      expect(result.statusCode).toBeGreaterThanOrEqual(400);
      expect(result.statusCode).toBeLessThan(500);
    }
    expect(await readdir(f.knowledgeRoot)).toEqual(['00-Inbox']);
    expect(await readdir(join(f.root, 'outside'))).toEqual([]);
  } finally {
    await f.close();
  }
});
it('creates real Chinese Markdown and refuses duplicate names', async () => {
  const f = await createFixture();
  try {
    const h = await loginFixtureOwner(f);
    const r = await f.app.inject({
      method: 'POST',
      url: '/api/notes',
      headers: h,
      payload: { folderPath: '00-Inbox', fileName: '中文笔记.md', content: '# 中文\n内容' },
    });
    expect(r.statusCode).toBe(201);
    expect(await readFile(join(f.knowledgeRoot, '00-Inbox/中文笔记.md'), 'utf8')).toBe(
      '# 中文\n内容',
    );
    expect(r.json().modifiedAt).toMatch(/^\d+$/);
    expect(
      (
        await f.app.inject({
          method: 'POST',
          url: '/api/notes',
          headers: h,
          payload: { folderPath: '00-Inbox', fileName: '中文笔记.md', content: 'bad' },
        })
      ).statusCode,
    ).toBe(409);
  } finally {
    await f.close();
  }
});
it('compares nanosecond versions for external and repeated changes', async () => {
  const f = await createFixture();
  try {
    const h = await loginFixtureOwner(f);
    const r = await f.app.inject({
      method: 'POST',
      url: '/api/notes',
      headers: h,
      payload: { folderPath: '00-Inbox', fileName: '版本.md', content: 'ORIGINAL' },
    });
    const n = r.json();
    const path = join(f.knowledgeRoot, n.relativePath);
    await writeFile(path, 'EXTERNAL_EDIT');
    const save = (expectedModifiedAt: string) =>
      f.app.inject({
        method: 'PUT',
        url: `/api/notes/${n.id}`,
        headers: h,
        payload: { content: 'CONFIRMED_EDIT', expectedModifiedAt },
      });
    const conflict = await save(n.modifiedAt);
    expect(conflict.statusCode).toBe(409);
    expect(await readFile(path, 'utf8')).toBe('EXTERNAL_EDIT');
    await writeFile(path, 'SECOND_EXTERNAL_EDIT');
    const again = await save(conflict.json().currentModifiedAt);
    expect(again.statusCode).toBe(409);
    expect(await readFile(path, 'utf8')).toBe('SECOND_EXTERNAL_EDIT');
    expect((await save(again.json().currentModifiedAt)).statusCode).toBe(200);
    expect(await readFile(path, 'utf8')).toBe('CONFIRMED_EDIT');
  } finally {
    await f.close();
  }
});
it('blocks traversal, hidden files, AGENTS and symlinks', async () => {
  const f = await createFixture();
  try {
    const h = await loginFixtureOwner(f);
    await writeFile(join(f.knowledgeRoot, 'AGENTS.md'), 'PRIVATE_POLICY');
    await mkdir(join(f.knowledgeRoot, '00-Inbox/.hidden'));
    await writeFile(join(f.knowledgeRoot, '00-Inbox/.hidden/private.md'), 'secret');
    await symlink('/etc', join(f.knowledgeRoot, '00-Inbox/link'));
    await symlink('/etc/passwd', join(f.knowledgeRoot, '00-Inbox/evil.md'));
    const tree = await f.app.inject({ url: '/api/tree', headers: h });
    expect(tree.body).not.toContain('AGENTS');
    expect(tree.body).not.toContain('evil.md');
    expect(tree.body).not.toContain('.hidden');
    for (const folderPath of ['../', '/etc', '00-Inbox/link', '00-Inbox/.hidden'])
      expect(
        (
          await f.app.inject({
            method: 'POST',
            url: '/api/notes',
            headers: h,
            payload: { folderPath, fileName: 'bad.md', content: 'bad' },
          })
        ).statusCode,
      ).toBe(400);
    expect(
      (
        await f.app.inject({
          method: 'PUT',
          url: '/api/notes/missing',
          headers: h,
          payload: { content: 'x', force: true },
        })
      ).statusCode,
    ).toBe(400);
  } finally {
    await f.close();
  }
});
it('directory browsing includes the actual file modification time', async () => {
  const f = await createFixture();
  try {
    const h = await loginFixtureOwner(f);
    await writeFile(join(f.knowledgeRoot, '00-Inbox/目录时间.md'), '# Directory');
    const entries = (await f.app.inject({ url: '/api/tree', headers: h })).json();
    const note = entries
      .find((x: any) => x.path === '00-Inbox')
      .children.find((x: any) => x.name === '目录时间.md');
    const { stat } = await import('node:fs/promises');
    expect(note.updatedAt).toBe((await stat(join(f.knowledgeRoot, note.path))).mtime.toISOString());
  } finally {
    await f.close();
  }
});
