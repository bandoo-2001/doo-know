import { it, expect } from 'vitest';
import { readFile, lstat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { createFixture, loginFixtureOwner } from './support/fixture.js';
import { openDatabase } from '../packages/core/db.js';
import { renameRootInPlace } from '../apps/server/platform/root-migration.js';
import { libraryIdentity, syncDirectoryCatalog } from '../packages/core/organization/catalog.js';
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
      const previousLibrary = libraryIdentity(db)!;
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
      expect(() => syncDirectoryCatalog({ ...f.config, knowledgeRoot: target }, db)).not.toThrow();
      expect(libraryIdentity(db)).toMatchObject({
        libraryId: previousLibrary.libraryId,
        bindingVersion: previousLibrary.bindingVersion + 1,
      });
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

it('refuses offline root migration while a durable organization task remains queued', async () => {
  const f = await createFixture();
  await f.app.close();
  const db = openDatabase(f.dataRoot);
  try {
    const id = '11111111-1111-4111-8111-111111111111',
      now = Date.now();
    db.prepare(
      "INSERT INTO operations(id,principal,client_id,kind,request_id,params_hash,status,created_at,updated_at) VALUES(?,?,?,?,?,?,'queued',?,?)",
    ).run(
      id,
      'web-owner',
      'browser',
      'organization.organize',
      'pending-root-migration',
      'fixture',
      now,
      now,
    );
    db.prepare(
      "INSERT INTO organization_jobs(id,status,payload,created_at) VALUES(?,'queued','{}',?)",
    ).run(id, now);
    const previous = (
      db.prepare("SELECT value FROM index_meta WHERE key='root_identity'").get() as any
    ).value;
    const target = join(f.root, 'blocked-root');
    expect(() =>
      renameRootInPlace(db, {
        oldRoot: f.knowledgeRoot,
        newRoot: target,
        expectedIdentity: previous,
      }),
    ).toThrow(/未完成/);
    expect(existsSync(f.knowledgeRoot)).toBe(true);
    expect(existsSync(target)).toBe(false);
    expect(libraryIdentity(db)?.bindingVersion).toBe(1);
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
