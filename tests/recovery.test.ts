import { it, expect } from 'vitest';
import { writeFile, readFile, mkdir, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { createFixture, loginFixtureOwner } from './support/fixture.js';
import { createApp } from '../server/app.js';
it('keeps old bytes and restores history using checked current version', async () => {
  const f = await createFixture();
  try {
    const h = await loginFixtureOwner(f);
    const n = (
      await f.app.inject({
        method: 'POST',
        url: '/api/notes',
        headers: h,
        payload: { folderPath: '00-Inbox', fileName: '历史.md', content: 'PREVIOUS_CONTENT\r\n' },
      })
    ).json();
    const saved = await f.app.inject({
      method: 'PUT',
      url: `/api/notes/${n.id}`,
      headers: h,
      payload: { content: 'NEW_CONTENT', expectedModifiedAt: n.modifiedAt },
    });
    expect(saved.statusCode).toBe(200);
    const list = await f.app.inject({ url: `/api/notes/${n.id}/revisions`, headers: h });
    expect(list.statusCode).toBe(200);
    expect(list.json().items[0]).not.toHaveProperty('content');
    const r = await f.app.inject({
      method: 'POST',
      url: `/api/notes/${n.id}/revisions/${list.json().items[0].id}/restore`,
      headers: h,
      payload: { expectedModifiedAt: saved.json().modifiedAt },
    });
    expect(r.statusCode).toBe(200);
    expect(await readFile(join(f.knowledgeRoot, n.relativePath), 'utf8')).toBe(
      'PREVIOUS_CONTENT\r\n',
    );
  } finally {
    await f.close();
  }
});
it('deletes revoke shares and restore never overwrites occupied paths', async () => {
  const f = await createFixture();
  try {
    const h = await loginFixtureOwner(f);
    const n = (
      await f.app.inject({
        method: 'POST',
        url: '/api/notes',
        headers: h,
        payload: { folderPath: '00-Inbox', fileName: '删除.md', content: 'DELETED_CONTENT' },
      })
    ).json();
    const s = (
      await f.app.inject({
        method: 'POST',
        url: `/api/notes/${n.id}/share`,
        headers: h,
        payload: {},
      })
    ).json();
    const deleted = await f.app.inject({ method: 'DELETE', url: `/api/notes/${n.id}`, headers: h });
    expect(deleted.statusCode).toBe(200);
    expect((await f.app.inject({ url: `/api/public/shares/${s.token}` })).statusCode).toBe(404);
    const trash = await f.app.inject({ url: '/api/trash', headers: h });
    expect(trash.json()[0].relativePath).toBe('00-Inbox/删除.md');
    await writeFile(join(f.knowledgeRoot, n.relativePath), 'EXISTING_CONTENT');
    expect(
      (
        await f.app.inject({
          method: 'POST',
          url: `/api/notes/${n.id}/restore`,
          headers: h,
          payload: {},
        })
      ).statusCode,
    ).toBe(409);
    expect(await readFile(join(f.knowledgeRoot, n.relativePath), 'utf8')).toBe('EXISTING_CONTENT');
    expect(
      (
        await f.app.inject({
          method: 'POST',
          url: `/api/notes/${n.id}/restore`,
          headers: h,
          payload: { fileName: '已恢复.md' },
        })
      ).statusCode,
    ).toBe(200);
    expect(await readFile(join(f.knowledgeRoot, '00-Inbox/已恢复.md'), 'utf8')).toBe(
      'DELETED_CONTENT',
    );
    expect(
      (await f.app.inject({ url: `/api/notes/${n.id}/share`, headers: h })).json().enabled,
    ).toBe(false);
  } finally {
    await f.close();
  }
});
it('backup failure preserves original and returns failure', async () => {
  const f = await createFixture();
  try {
    const h = await loginFixtureOwner(f);
    const n = (
      await f.app.inject({
        method: 'POST',
        url: '/api/notes',
        headers: h,
        payload: { folderPath: '00-Inbox', fileName: '失败.md', content: 'ORIGINAL_BYTES' },
      })
    ).json();
    await writeFile(join(f.dataRoot, 'history'), 'block-directory');
    const r = await f.app.inject({
      method: 'PUT',
      url: `/api/notes/${n.id}`,
      headers: h,
      payload: { content: 'SHOULD_NOT_SAVE', expectedModifiedAt: n.modifiedAt },
    });
    expect(r.statusCode).toBe(500);
    expect(r.body).not.toContain(f.dataRoot);
    expect(await readFile(join(f.knowledgeRoot, n.relativePath), 'utf8')).toBe('ORIGINAL_BYTES');
  } finally {
    await f.close();
  }
});
it('scans external new/renamed notes privately and persists identities across restart', async () => {
  const f = await createFixture();
  try {
    const h = await loginFixtureOwner(f);
    await mkdir(join(f.knowledgeRoot, '10-Projects/一级/二级/三级'), { recursive: true });
    await writeFile(join(f.knowledgeRoot, '10-Projects/一级/二级/三级/外部.md'), '# 外部');
    const all = (await f.app.inject({ url: '/api/notes', headers: h })).json();
    const n = all.find((x: any) => x.title === '外部');
    expect(n.shared).toBe(false);
    await f.app.close();
    const restarted = await createApp(f.config);
    expect((await restarted.inject({ url: `/api/notes/${n.id}`, headers: h })).statusCode).toBe(
      200,
    );
    await restarted.close();
  } finally {
    await f.close();
  }
});
it('keeps trash retryable when unlink of trash original fails', async () => {
  const f = await createFixture();
  let trashDir = '';
  try {
    const h = await loginFixtureOwner(f);
    const n = (
      await f.app.inject({
        method: 'POST',
        url: '/api/notes',
        headers: h,
        payload: {
          folderPath: '00-Inbox',
          fileName: '重试恢复.md',
          content: 'RESTORABLE_ORIGINAL',
        },
      })
    ).json();
    expect(
      (await f.app.inject({ method: 'DELETE', url: `/api/notes/${n.id}`, headers: h })).statusCode,
    ).toBe(200);
    trashDir = join(f.knowledgeRoot, '90-Archive/.trash', n.id);
    const { chmod, stat } = await import('node:fs/promises');
    await chmod(trashDir, 0o500);
    try {
      expect(
        (
          await f.app.inject({
            method: 'POST',
            url: `/api/notes/${n.id}/restore`,
            headers: h,
            payload: {},
          })
        ).statusCode,
      ).toBe(500);
      expect((await f.app.inject({ url: '/api/trash', headers: h })).json()).toHaveLength(1);
      expect((await stat(join(trashDir, '重试恢复.md'))).nlink).toBe(1);
      expect(await readFile(join(trashDir, '重试恢复.md'), 'utf8')).toBe('RESTORABLE_ORIGINAL');
    } finally {
      await chmod(trashDir, 0o700);
    }
    expect(
      (
        await f.app.inject({
          method: 'POST',
          url: `/api/notes/${n.id}/restore`,
          headers: h,
          payload: {},
        })
      ).statusCode,
    ).toBe(200);
    expect((await f.app.inject({ url: `/api/notes/${n.id}`, headers: h })).json().content).toBe(
      'RESTORABLE_ORIGINAL',
    );
  } finally {
    await f.close();
  }
});
