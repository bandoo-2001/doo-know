import { it, expect } from 'vitest';
import { readFile, lstat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { createFixture, loginFixtureOwner } from './support/fixture.js';
import { openDatabase } from '../packages/core/db.js';
import { renameRootInPlace } from '../apps/server/platform/root-migration.js';
it('renames the same inode and compares the exact identity while preserving IDs, history and shares', async () => {
  const f = await createFixture();
  try {
    const headers = await loginFixtureOwner(f);
    const note = (
      await f.app.inject({
        method: 'POST',
        url: '/api/notes',
        headers,
        payload: {
          folderPath: '00-Inbox',
          fileName: 'keep.md',
          content: '# Preserve raw',
          requestId: 'migration-note',
        },
      })
    ).json();
    await f.app.inject({
      method: 'POST',
      url: '/api/notes/' + note.id + '/share',
      headers,
      payload: {},
    });
    await f.app.close();
    const db = openDatabase(f.dataRoot);
    try {
      const raw = (
          db.prepare("SELECT value FROM index_meta WHERE key='root_identity'").get() as any
        ).value,
        st = await lstat(f.knowledgeRoot, { bigint: true }),
        target = join(f.root, 'knowledge-base');
      const receipt = renameRootInPlace(db, {
        oldRoot: f.knowledgeRoot,
        newRoot: target,
        expectedIdentity: raw,
      });
      expect(receipt.identityUpdated).toBe(true);
      expect((await lstat(target, { bigint: true })).ino).toBe(st.ino);
      expect(existsSync(f.knowledgeRoot)).toBe(false);
      expect(await readFile(join(target, '00-Inbox/keep.md'), 'utf8')).toBe('# Preserve raw');
      expect(db.prepare('SELECT id FROM notes WHERE id=?').get(note.id)).toBeTruthy();
      expect(
        (db.prepare('SELECT enabled FROM shares WHERE note_id=?').get(note.id) as any).enabled,
      ).toBe(1);
      expect(db.pragma('foreign_key_check')).toEqual([]);
    } finally {
      db.close();
    }
  } finally {
    await f.close();
  }
});
it('rejects a stale identity before moving and reverses the same directory if post-CAS validation fails', async () => {
  const f = await createFixture();
  await f.app.close();
  const db = openDatabase(f.dataRoot);
  try {
    const raw = (db.prepare("SELECT value FROM index_meta WHERE key='root_identity'").get() as any)
        .value,
      target = join(f.root, 'knowledge-base');
    expect(() =>
      renameRootInPlace(db, {
        oldRoot: f.knowledgeRoot,
        newRoot: target,
        expectedIdentity: 'stale',
      }),
    ).toThrow();
    expect(existsSync(f.knowledgeRoot)).toBe(true);
    let config = 'old';
    expect(() =>
      renameRootInPlace(db, {
        oldRoot: f.knowledgeRoot,
        newRoot: target,
        expectedIdentity: raw,
        configuration: {
          apply() {
            config = 'new';
            throw Error('controlled config failure');
          },
          rollback() {
            config = 'old';
          },
        },
      }),
    ).toThrow(/controlled config/);
    expect(config).toBe('old');
    expect(existsSync(f.knowledgeRoot)).toBe(true);
    expect(existsSync(target)).toBe(false);
    expect(
      (db.prepare("SELECT value FROM index_meta WHERE key='root_identity'").get() as any).value,
    ).toBe(raw);
  } finally {
    db.close();
    await f.close();
  }
});
it('rejects an existing dangling target link without replacing it', async () => {
  const { symlink, readlink } = await import('node:fs/promises');
  const f = await createFixture();
  await f.app.close();
  const db = openDatabase(f.dataRoot);
  try {
    const target = join(f.root, 'knowledge-base');
    await symlink(join(f.root, 'missing'), target);
    const identity = (
      db.prepare("SELECT value FROM index_meta WHERE key='root_identity'").get() as any
    ).value;
    expect(() =>
      renameRootInPlace(db, {
        oldRoot: f.knowledgeRoot,
        newRoot: target,
        expectedIdentity: identity,
      }),
    ).toThrow();
    expect(await readlink(target)).toBe(join(f.root, 'missing'));
    expect(existsSync(f.knowledgeRoot)).toBe(true);
  } finally {
    db.close();
    await f.close();
  }
});
