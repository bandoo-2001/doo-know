import { expect, it } from 'vitest';
import { mkdtemp, mkdir, writeFile, symlink, readFile, rm, link } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { openDatabase } from '../packages/core/db.js';
import { managementStorage } from '../apps/server/platform/management-storage.js';
import { purgeTrashFile, trashFile } from '../apps/server/platform/management-trash.js';
import { workspaceExclusive } from '../packages/core/workspace/gate.js';
it('pins trash metadata and refuses changed, active, linked, or multiply linked leaves', async () => {
  const root = await mkdtemp(join(tmpdir(), 'management-safe-'));
  const dataRoot = join(root, 'data'),
    knowledgeRoot = join(root, 'knowledge');
  const dir = join(knowledgeRoot, '90-Archive', '.trash', 'fixture-note');
  await mkdir(dir, { recursive: true });
  const db = openDatabase(dataRoot);
  try {
    const file = join(dir, 'test.md');
    await writeFile(file, 'fixture');
    db.prepare('INSERT INTO notes VALUES(?,?,0,?)').run(
      'fixture-note',
      '00-Inbox/test.md',
      'test.md',
    );
    const fingerprint = trashFile(
      knowledgeRoot,
      'fixture-note',
      'test.md',
      (_file, value) => value,
    );
    expect(() =>
      purgeTrashFile(db, knowledgeRoot, 'fixture-note', { name: 'test.md', fingerprint }),
    ).toThrow('WORKSPACE_EXCLUSIVE_REQUIRED');
    await workspaceExclusive(db, { kind: 'test.purge' }, async () => {
      expect(() =>
        purgeTrashFile(db, knowledgeRoot, 'fixture-note', {
          name: 'test.md',
          fingerprint: 'stale',
        }),
      ).toThrow('TRASH_CHANGED');
      db.prepare('UPDATE notes SET active=1 WHERE id=?').run('fixture-note');
      expect(() =>
        purgeTrashFile(db, knowledgeRoot, 'fixture-note', { name: 'test.md', fingerprint }),
      ).toThrow('TRASH_CHANGED');
      db.prepare('UPDATE notes SET active=0 WHERE id=?').run('fixture-note');
    });
    await link(file, join(dir, 'hardlink.md'));
    expect(() => trashFile(knowledgeRoot, 'fixture-note', 'test.md', () => {})).toThrow(
      'INVALID_PATH',
    );
    await rm(join(dir, 'hardlink.md'));
    await symlink(file, join(dir, 'alias.md'));
    expect(() => trashFile(knowledgeRoot, 'fixture-note', 'alias.md', () => {})).toThrow(
      'INVALID_PATH',
    );
    const proof = trashFile(knowledgeRoot, 'fixture-note', 'test.md', (_file, value) => value);
    await workspaceExclusive(db, { kind: 'test.purge' }, async () => {
      expect(
        purgeTrashFile(db, knowledgeRoot, 'fixture-note', { name: 'test.md', fingerprint: proof }),
      ).toEqual({ id: 'fixture-note', ok: true });
    });
    await expect(readFile(file)).rejects.toThrow();
    expect(db.prepare('SELECT trash_path FROM notes').get()).toEqual({ trash_path: null });
    expect(() => trashFile(knowledgeRoot, '../escape', 'test.md', () => {})).toThrow(
      'INVALID_PATH',
    );
  } finally {
    db.close();
    await rm(root, { recursive: true, force: true });
  }
});
it('reports bounded category counts and skips linked roots, hidden files and deep paths', async () => {
  const root = await mkdtemp(join(tmpdir(), 'management-storage-'));
  try {
    const knowledgeRoot = join(root, 'knowledge'),
      dataRoot = join(root, 'data');
    await mkdir(join(knowledgeRoot, 'a', 'b', 'c', 'd', 'e'), { recursive: true });
    await mkdir(dataRoot);
    await writeFile(join(knowledgeRoot, 'note.md'), 'note');
    await writeFile(join(knowledgeRoot, '.hidden.md'), 'private');
    await writeFile(join(knowledgeRoot, 'asset.png'), 'image');
    await writeFile(join(knowledgeRoot, 'a', 'b', 'c', 'd', 'e', 'deep.md'), 'excluded');
    await symlink(knowledgeRoot, join(root, 'linked-models'));
    const result = await managementStorage(
      {
        knowledgeRoot,
        dataRoot,
        origin: 'http://localhost',
        secret: 'fixture',
        modelDir: join(root, 'linked-models'),
      },
      knowledgeRoot,
    );
    expect(result.categories.notes).toEqual({ bytes: 4, count: 1, truncated: true });
    expect(result.categories.assets).toEqual({ bytes: 5, count: 1, truncated: true });
    expect(result.categories.models).toEqual({ bytes: 0, count: 0, truncated: true });
    expect(JSON.stringify(result)).not.toContain(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
