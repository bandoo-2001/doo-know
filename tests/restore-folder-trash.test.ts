import { expect, it } from 'vitest';
import {
  mkdir,
  writeFile,
  readFile,
  readdir,
  lstat,
  rename,
  rm,
  symlink,
  link,
} from 'node:fs/promises';
import { join } from 'node:path';
import { createFixture, loginFixtureOwner, origin, testPassword } from './support/fixture.js';
import { createApp } from '../apps/server/app.js';
import { createPlatformBackup, restorePlatformBackup } from '../apps/server/platform/backups.js';
import { loadHostConfig } from '../apps/server/platform/config.js';
import { openDatabase } from '../packages/core/db.js';
import { resetRestoredState } from '../apps/server/platform/restore-state.js';
import { backup, restore as restoreBackup } from '../apps/server/backup.js';

it('restores encrypted folder trash with copied identities while retaining runtime replacement guards and exact contents', async () => {
  const f = await createFixture();
  let restored: Awaited<ReturnType<typeof createApp>> | undefined;
  try {
    const headers = await loginFixtureOwner(f);
    await mkdir(join(f.knowledgeRoot, '00-Inbox/bundle/nested/empty'), { recursive: true });
    const originalBytes = Buffer.from('\ufeff# Original\r\n');
    const latestBytes = Buffer.from('\ufeff# Latest\r\n\r\nExact source bytes\r\n');
    const attachment = Buffer.from([0, 255, 3, 13, 10]);
    await writeFile(join(f.knowledgeRoot, '00-Inbox/bundle/nested/note.md'), originalBytes);
    await writeFile(join(f.knowledgeRoot, '00-Inbox/bundle/attachment.bin'), attachment);
    const tree = (await f.app.inject({ url: '/api/tree', headers })).json();
    const noteId = tree[0].children[0].children
      .find((n: any) => n.name === 'nested')
      .children.find((n: any) => n.name === 'note.md').id;
    const initial = (await f.app.inject({ url: '/api/notes/' + noteId, headers })).json();
    const saved = await f.app.inject({
      method: 'PUT',
      url: '/api/notes/' + noteId,
      headers,
      payload: {
        content: latestBytes.toString('utf8'),
        expectedModifiedAt: initial.modifiedAt,
        requestId: 'backup-folder-save',
      },
    });
    expect(saved.statusCode, saved.body).toBe(200);
    const history = (
      await f.app.inject({ url: '/api/notes/' + noteId + '/revisions', headers })
    ).json();
    expect(history.items).toHaveLength(1);
    const loose = (
      await f.app.inject({
        method: 'POST',
        url: '/api/notes',
        headers,
        payload: {
          folderPath: '00-Inbox',
          fileName: 'loose.md',
          content: '# Loose\r\n',
          requestId: 'backup-loose-create',
        },
      })
    ).json();
    expect(
      (
        await f.app.inject({
          method: 'DELETE',
          url: '/api/notes/' + loose.id,
          headers,
          payload: { expectedModifiedAt: loose.modifiedAt, requestId: 'backup-loose-trash' },
        })
      ).statusCode,
    ).toBe(200);
    const archived = await f.app.inject({
      method: 'DELETE',
      url: '/api/folders',
      headers,
      payload: { path: '00-Inbox/bundle', requestId: 'backup-folder-trash' },
    });
    expect(archived.statusCode, archived.body).toBe(200);
    const id = archived.json().id;
    const sourcePath = join(f.knowledgeRoot, '90-Archive/.trash', id, 'tree');
    const sourceStat = await lstat(sourcePath, { bigint: true });
    const file = join(f.root, 'snapshot.dkb'),
      keyFile = join(f.root, 'recovery.pem');
    await createPlatformBackup(f.config, { destination: file, keyFile });
    const target = {
      dataRoot: join(f.root, 'restored/data'),
      knowledgeRoot: join(f.root, 'restored/knowledge'),
      profileFile: join(f.root, 'restored/config/profile.json'),
    };
    const receipt = await restorePlatformBackup({ source: file, keyFile, target });
    const config = loadHostConfig({ profileFile: receipt.profileFile });
    const trashPath = join(target.knowledgeRoot, '90-Archive/.trash', id, 'tree');
    const copiedStat = await lstat(trashPath, { bigint: true });
    expect(`${copiedStat.dev}:${copiedStat.ino}`).not.toBe(`${sourceStat.dev}:${sourceStat.ino}`);
    restored = await createApp(config);
    const login = await restored.inject({
      method: 'POST',
      url: '/api/auth/sign-in/username',
      headers: { origin },
      payload: { username: 'owner', password: testPassword },
    });
    expect(login.statusCode, login.body).toBe(200);
    const cookie = login.cookies.map((c) => `${c.name}=${c.value}`).join('; ');
    const csrf = await restored.inject({ url: '/api/security/csrf', headers: { cookie } });
    const restoredHeaders = {
      cookie: cookie + '; ' + csrf.cookies.map((c) => `${c.name}=${c.value}`).join('; '),
      origin,
      'x-csrf-token': csrf.json().token,
    };
    const list = () => restored!.inject({ url: '/api/manage/trash', headers: restoredHeaders });
    const restore = (ids: string[], requestId: string) =>
      restored!.inject({
        method: 'POST',
        url: '/api/manage/trash/restore',
        headers: restoredHeaders,
        payload: { ids, requestId },
      });
    expect((await list()).json().items).toEqual(
      expect.arrayContaining([expect.objectContaining({ id, type: 'folder', available: true })]),
    );

    // The controlled copy gets a new identity once; ordinary replacement is still refused.
    const heldPath = join(f.root, 'held-archive');
    await rename(trashPath, heldPath);
    await mkdir(trashPath);
    await writeFile(join(trashPath, 'replacement.md'), '# Replacement');
    expect((await list()).json().items.find((item: any) => item.id === id).available).toBe(false);
    expect((await restore([id], 'replacement-refused')).json().results).toMatchObject([
      { id, ok: false, code: 'TRASH_CHANGED' },
    ]);
    expect(await readFile(join(trashPath, 'replacement.md'), 'utf8')).toBe('# Replacement');
    await rm(trashPath, { recursive: true });
    await symlink(heldPath, trashPath);
    expect((await list()).json().items.find((item: any) => item.id === id).available).toBe(false);
    expect((await restore([id], 'link-refused')).json().results[0].ok).toBe(false);
    await rm(trashPath);
    expect((await list()).json().items.find((item: any) => item.id === id).available).toBe(false);
    expect((await restore([id], 'missing-refused')).json().results[0].ok).toBe(false);
    await rename(heldPath, trashPath);

    expect((await restore([id, loose.id], 'restored-folder-and-note')).json().results).toEqual([
      { id, ok: true, relativePath: '00-Inbox/bundle' },
      { id: loose.id, ok: true, relativePath: '00-Inbox/loose.md' },
    ]);
    expect(await readFile(join(target.knowledgeRoot, '00-Inbox/bundle/nested/note.md'))).toEqual(
      latestBytes,
    );
    expect(await readFile(join(target.knowledgeRoot, '00-Inbox/bundle/attachment.bin'))).toEqual(
      attachment,
    );
    expect(await readdir(join(target.knowledgeRoot, '00-Inbox/bundle/nested/empty'))).toEqual([]);
    expect(
      (await restored.inject({ url: '/api/notes/' + noteId, headers: restoredHeaders })).json(),
    ).toMatchObject({
      id: noteId,
      relativePath: '00-Inbox/bundle/nested/note.md',
      content: latestBytes.toString('utf8'),
    });
    expect(
      (await restored.inject({ url: '/api/notes/' + loose.id, headers: restoredHeaders })).json()
        .content,
    ).toBe('# Loose\r\n');
    expect(
      (
        await restored.inject({
          url: '/api/notes/' + noteId + '/revisions',
          headers: restoredHeaders,
        })
      ).json().items,
    ).toEqual(history.items);
    let historical;
    for (let i = 0; i < 100; i++) {
      historical = await restored.inject({
        method: 'POST',
        url: `/api/notes/${noteId}/revisions/${history.items[0].id}/read`,
        headers: restoredHeaders,
        payload: {},
      });
      if (historical.json().kind === 'ready') break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    expect(historical!.json().data.content).toBe(originalBytes.toString('utf8'));
    expect((await list()).json().items).toEqual([]);
    expect(await readFile(join(sourcePath, 'nested/note.md'))).toEqual(latestBytes);
    const db = openDatabase(target.dataRoot);
    try {
      expect(
        db
          .prepare('SELECT id FROM notes WHERE path=? AND active=1')
          .all('00-Inbox/bundle/nested/note.md'),
      ).toEqual([{ id: noteId }]);
      expect(db.pragma('foreign_key_check')).toEqual([]);
    } finally {
      db.close();
    }
  } finally {
    await restored?.close();
    await f.close();
  }
});

it.each([
  'missing',
  'invalid-id',
  'invalid-path',
  'invalid-identity',
  'linked-parent',
  'linked-tree',
  'linked-child',
  'hardlinked-child',
  'ambiguous-journal',
])(
  'refuses to rebind %s folder trash at the restore boundary without changing stored identity',
  async (problem) => {
    const f = await createFixture();
    const db = openDatabase(f.dataRoot);
    try {
      const headers = await loginFixtureOwner(f);
      await mkdir(join(f.knowledgeRoot, '00-Inbox/bundle'));
      await writeFile(join(f.knowledgeRoot, '00-Inbox/bundle/keep.md'), '# Keep');
      const archived = await f.app.inject({
        method: 'DELETE',
        url: '/api/folders',
        headers,
        payload: { path: '00-Inbox/bundle', requestId: 'unsafe-boundary-archive' },
      });
      expect(archived.statusCode, archived.body).toBe(200);
      await f.app.close();
      const id = archived.json().id;
      const tree = join(f.knowledgeRoot, '90-Archive/.trash', id, 'tree');
      const held = join(f.root, 'held');
      if (problem === 'missing') await rename(tree, held);
      if (problem === 'invalid-id')
        db.prepare('UPDATE folder_trash SET id=? WHERE id=?').run('../outside', id);
      if (problem === 'invalid-path')
        db.prepare('UPDATE folder_trash SET path=? WHERE id=?').run('00-Inbox/../outside', id);
      if (problem === 'invalid-identity')
        db.prepare('UPDATE folder_trash SET identity=? WHERE id=?').run('', id);
      if (problem === 'linked-parent') {
        const parent = join(f.knowledgeRoot, '90-Archive/.trash');
        await rename(parent, held);
        await symlink(held, parent);
      }
      if (problem === 'linked-tree') {
        await rename(tree, held);
        await symlink(held, tree);
      }
      if (problem === 'linked-child') {
        await writeFile(held, 'outside');
        await symlink(held, join(tree, 'link'));
      }
      if (problem === 'hardlinked-child') await link(join(tree, 'keep.md'), held);
      if (problem === 'ambiguous-journal') {
        db.prepare("UPDATE folder_trash SET state='archiving' WHERE id=?").run(id);
        await mkdir(join(f.knowledgeRoot, '00-Inbox/bundle'));
      }
      const before = db.prepare('SELECT id,identity,state FROM folder_trash').all();
      expect(() => resetRestoredState(db, f.config)).toThrow();
      expect(db.prepare('SELECT id,identity,state FROM folder_trash').all()).toEqual(before);
      const original = problem === 'missing' || problem === 'linked-tree' ? held : tree;
      expect(await readFile(join(original, 'keep.md'), 'utf8')).toBe('# Keep');
    } finally {
      db.close();
      await f.close();
    }
  },
);

it.each(['archive-before-move', 'archive-after-move', 'restore-before-move', 'restore-after-move'])(
  'retains pending folder journal recovery and note identity after a copied %s snapshot',
  async (phase) => {
    const f = await createFixture();
    const db = openDatabase(f.dataRoot);
    let restored: Awaited<ReturnType<typeof createApp>> | undefined;
    try {
      const headers = await loginFixtureOwner(f);
      await mkdir(join(f.knowledgeRoot, '00-Inbox/pending'));
      await writeFile(join(f.knowledgeRoot, '00-Inbox/pending/keep.md'), '# Pending\r\n');
      const note = (await f.app.inject({ url: '/api/tree', headers })).json()[0].children[0]
        .children[0];
      const archived = await f.app.inject({
        method: 'DELETE',
        url: '/api/folders',
        headers,
        payload: { path: '00-Inbox/pending', requestId: 'pending-archive' },
      });
      expect(archived.statusCode, archived.body).toBe(200);
      const id = archived.json().id;
      if (phase === 'restore-after-move') {
        const result = await f.app.inject({
          method: 'POST',
          url: '/api/manage/trash/restore',
          headers,
          payload: { ids: [id], requestId: 'pending-restore' },
        });
        expect(result.json().results[0].ok).toBe(true);
      }
      await f.app.close();
      if (phase === 'archive-before-move')
        await rename(
          join(f.knowledgeRoot, '90-Archive/.trash', id, 'tree'),
          join(f.knowledgeRoot, '00-Inbox/pending'),
        );
      const archiving = phase.startsWith('archive');
      db.prepare('UPDATE folder_trash SET state=?,restore_path=? WHERE id=?').run(
        archiving ? 'archiving' : 'restoring',
        archiving ? null : '00-Inbox/pending',
        id,
      );
      db.prepare('UPDATE notes SET active=? WHERE id=?').run(archiving ? 1 : 0, note.id);
      db.prepare(
        "UPDATE operations SET status='prepared',result=NULL WHERE id=(SELECT operation_id FROM folder_trash WHERE id=?)",
      ).run(id);
      const snapshot = join(f.root, 'snapshot');
      await backup(f.config, snapshot);
      const config = {
        ...f.config,
        knowledgeRoot: join(f.root, 'copy/knowledge'),
        dataRoot: join(f.root, 'copy/data'),
      };
      await restoreBackup(snapshot, config);
      restored = await createApp(config);
      const login = await restored.inject({
        method: 'POST',
        url: '/api/auth/sign-in/username',
        headers: { origin },
        payload: { username: 'owner', password: testPassword },
      });
      expect(login.statusCode, login.body).toBe(200);
      const cookie = login.cookies.map((c) => `${c.name}=${c.value}`).join('; ');
      const recoveredTree = await restored.inject({ url: '/api/tree', headers: { cookie } });
      expect(recoveredTree.statusCode, recoveredTree.body).toBe(200);
      const check = openDatabase(config.dataRoot);
      try {
        const active = phase === 'archive-before-move' || phase === 'restore-after-move';
        expect(check.prepare('SELECT id,active FROM notes WHERE id=?').get(note.id)).toEqual({
          id: note.id,
          active: active ? 1 : 0,
        });
        const row = check.prepare('SELECT state FROM folder_trash WHERE id=?').get(id);
        expect(row).toEqual(
          phase === 'archive-before-move'
            ? undefined
            : { state: phase === 'restore-after-move' ? 'restored' : 'trashed' },
        );
        const content = active
          ? '00-Inbox/pending/keep.md'
          : `90-Archive/.trash/${id}/tree/keep.md`;
        expect(await readFile(join(config.knowledgeRoot, content), 'utf8')).toBe('# Pending\r\n');
        expect(check.pragma('foreign_key_check')).toEqual([]);
      } finally {
        check.close();
      }
    } finally {
      if (db.open) db.close();
      await restored?.close();
      await f.close();
    }
  },
);
