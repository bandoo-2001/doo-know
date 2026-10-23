import { expect, it, vi } from 'vitest';
import { existsSync, readFileSync, writeFileSync, chmodSync, unlinkSync, renameSync, symlinkSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { join, delimiter } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createFixture } from '../support/fixture.js';
import { openDatabase } from '../../packages/core/db.js';
import { mutationCore, webPrincipal } from '../../packages/core/knowledge/core.js';
import { reconcileService } from '../../packages/core/indexing/reconcile.js';
import * as sourceReader from '../../packages/core/knowledge/file-reader.js';
import { noteService } from '../../packages/core/notes.js';

async function gitReadBarrier(root: string) {
  const bin = join(root, 'controlled-bin'), ready = join(root, 'git-ready'), released = join(root, 'git-released');
  await mkdir(bin);
  // Run real Git after its caller has captured the file list. Only the timing
  // boundary is controlled; mutations, files, SQLite and reconciliation are real.
  const wrapper = `#!${process.execPath}
const fs = require('node:fs');
const { spawnSync } = require('node:child_process');
const ready = ${JSON.stringify(ready)}, released = ${JSON.stringify(released)};
fs.writeFileSync(ready, 'ready', { mode: 0o600 });
const until = Date.now() + 10000, cell = new Int32Array(new SharedArrayBuffer(4));
while (!fs.existsSync(released)) {
  if (Date.now() > until) process.exit(90);
  Atomics.wait(cell, 0, 0, 10);
}
const result = spawnSync('/usr/bin/git', process.argv.slice(2), { stdio: 'inherit' });
process.exit(result.status === null ? 91 : result.status);
`;
  writeFileSync(join(bin, 'git'), wrapper, { mode: 0o700 });
  vi.stubEnv('PATH', bin + delimiter + process.env.PATH);
  return {
    entered: () => vi.waitFor(() => expect(existsSync(ready)).toBe(true), { timeout: 5000, interval: 10 }),
    release: () => writeFileSync(released, 'continue', { mode: 0o600 }),
  };
}

for (const change of ['archive', 'external removal', 'replacement', 'unreadable', 'folder removal', 'folder unreadable', 'folder symlink'] as const) {
  it(`reconciles a source ${change} during Git inspection without inventing or losing a note`, async () => {
    const fixture = await createFixture({ fileTasks: { embedded: false }, indexing: { enabled: false, watch: false } });
    await fixture.app.close();
    const db = openDatabase(fixture.dataRoot), core = mutationCore(fixture.config, db);
    let barrier: Awaited<ReturnType<typeof gitReadBarrier>> | undefined;
    let pending: ReturnType<ReturnType<typeof reconcileService>['reconcile']> | undefined;
    try {
      const created = core.create(webPrincipal, '00-Inbox', 'retained.md', '# Before\r\n', randomUUID());
      const saved = core.update(webPrincipal, created.id, '# Retained\r\n', created.modifiedAt, randomUUID());
      const file = join(fixture.knowledgeRoot, saved.relativePath);
      db.prepare('INSERT INTO shares(note_id,token,enabled) VALUES(?,?,1)').run(saved.id, randomUUID());
      barrier = await gitReadBarrier(fixture.root);
      pending = reconcileService(fixture.config, db).reconcile();
      // Attach a rejection handler immediately while the real Git process waits.
      const settled = pending.then(value => ({ value, error: undefined }), error => ({ value: undefined, error }));
      await barrier.entered();
      let replacement: ReturnType<typeof core.create> | undefined;
      if (change === 'archive' || change === 'replacement') {
        core.archive(webPrincipal, saved.id, saved.modifiedAt, randomUUID());
        if (change === 'replacement')
          replacement = core.create(webPrincipal, '00-Inbox', 'retained.md', '# New source\r\n', randomUUID());
      } else if (change === 'external removal') unlinkSync(file);
      else if (change === 'unreadable') chmodSync(file, 0o000);
      else if (change === 'folder unreadable') chmodSync(join(fixture.knowledgeRoot, '00-Inbox'), 0o000);
      else {
        renameSync(join(fixture.knowledgeRoot, '00-Inbox'), join(fixture.root, 'detached-inbox'));
        if (change === 'folder symlink') {
          await mkdir(join(fixture.root, 'outside'));
          symlinkSync(join(fixture.root, 'outside'), join(fixture.knowledgeRoot, '00-Inbox'));
        }
      }
      barrier.release();
      const outcome = await settled;
      if (change === 'unreadable' || change === 'folder unreadable' || change === 'folder symlink') {
        expect(outcome.error).toMatchObject({ code: 'SOURCE_UNAVAILABLE' });
        expect(db.prepare('SELECT id,active FROM notes').all()).toEqual([{ id: saved.id, active: 1 }]);
        expect(db.prepare('SELECT enabled FROM shares WHERE note_id=?').get(saved.id)).toEqual({ enabled: 1 });
      } else {
        expect.soft(outcome.error).toBeUndefined();
        expect.soft(outcome.value).toMatchObject({ complete: true });
        const rows = db.prepare('SELECT id,active FROM notes ORDER BY rowid').all();
        expect(rows).toEqual([
          { id: saved.id, active: 0 },
          ...(replacement ? [{ id: replacement.id, active: 1 }] : []),
        ]);
        expect(db.prepare('SELECT enabled FROM shares WHERE note_id=?').get(saved.id)).toEqual({ enabled: 0 });
        if (change === 'archive' || change === 'replacement') {
          const archived = join(fixture.knowledgeRoot, '90-Archive', '.trash', saved.id, 'retained.md');
          expect(readFileSync(archived)).toEqual(Buffer.from('# Retained\r\n'));
        }
        if (replacement) expect(readFileSync(file)).toEqual(Buffer.from('# New source\r\n'));
      }
      expect(db.pragma('integrity_check', { simple: true })).toBe('ok');
      expect(db.pragma('foreign_key_check')).toEqual([]);
    } finally {
      barrier?.release();
      await pending?.catch(() => {});
      if (existsSync(join(fixture.knowledgeRoot, '00-Inbox')))
        chmodSync(join(fixture.knowledgeRoot, '00-Inbox'), 0o700);
      vi.unstubAllEnvs();
      db.close();
      await fixture.close();
    }
  });
}

for (const target of ['current file', 'later file'] as const) {
  it(`handles an API archive of the ${target} while a real source hash is pending`, async () => {
    const fixture = await createFixture({ fileTasks: { embedded: false }, indexing: { enabled: false, watch: false } });
    await fixture.app.close();
    const db = openDatabase(fixture.dataRoot), core = mutationCore(fixture.config, db);
    let release!: () => void;
    const gate = new Promise<void>(yes => { release = yes; });
    const realHash = sourceReader.hashFile;
    let observed: string | undefined;
    const hook = vi.spyOn(sourceReader, 'hashFile').mockImplementation(async (...args) => {
      if (!observed) { observed = args[0]; await gate; }
      return realHash(...args);
    });
    let pending: ReturnType<ReturnType<typeof reconcileService>['reconcile']> | undefined;
    try {
      const notes = ['first.md', 'second.md'].map(name => core.create(webPrincipal, '00-Inbox', name, '# Retain this source\r\n', randomUUID()));
      pending = reconcileService(fixture.config, db).reconcile();
      const settled = pending.then(value => ({ value, error: undefined }), error => ({ value: undefined, error }));
      await vi.waitFor(() => expect(observed).toBeDefined(), { timeout: 5000 });
      const current = notes.find(n => join(fixture.knowledgeRoot, n.relativePath) === observed)!;
      const archived = target === 'current file' ? current : notes.find(n => n.id !== current.id)!;
      core.archive(webPrincipal, archived.id, archived.modifiedAt, randomUUID());
      release();
      const outcome = await settled;
      expect.soft(outcome.error).toBeUndefined();
      expect.soft(outcome.value).toMatchObject({ complete: true });
      expect(db.prepare('SELECT id,active FROM notes ORDER BY rowid').all()).toEqual(notes.map(n => ({ id: n.id, active: n.id === archived.id ? 0 : 1 })));
      expect(readFileSync(join(fixture.knowledgeRoot, '90-Archive', '.trash', archived.id, archived.relativePath.split('/').at(-1)!))).toEqual(Buffer.from('# Retain this source\r\n'));
    } finally {
      release();
      await pending?.catch(() => {});
      hook.mockRestore();
      db.close();
      await fixture.close();
    }
  });
}

for (const restored of ['leaf symlink', 'parent symlink', 'missing child behind parent symlink', 'regular file'] as const) {
  it(`rechecks a missing path restored as a ${restored} while another source is hashing`, async () => {
    const fixture = await createFixture({ fileTasks: { embedded: false }, indexing: { enabled: false, watch: false } });
    await fixture.app.close();
    const db = openDatabase(fixture.dataRoot), core = mutationCore(fixture.config, db);
    let barrier: Awaited<ReturnType<typeof gitReadBarrier>> | undefined;
    let pending: ReturnType<ReturnType<typeof reconcileService>['reconcile']> | undefined;
    let release!: () => void;
    const gate = new Promise<void>(yes => { release = yes; });
    const realHash = sourceReader.hashFile;
    let hashing = false;
    const hook = vi.spyOn(sourceReader, 'hashFile').mockImplementation(async (...args) => {
      if (args[0].endsWith('/z-later.md')) { hashing = true; await gate; }
      return realHash(...args);
    });
    try {
      await mkdir(join(fixture.knowledgeRoot, '00-Inbox/first'));
      const note = core.create(webPrincipal, '00-Inbox/first', 'a.md', '# Retained original\r\n', randomUUID());
      core.create(webPrincipal, '00-Inbox', 'z-later.md', '# Later source\r\n', randomUUID());
      db.prepare('INSERT INTO shares(note_id,token,enabled) VALUES(?,?,1)').run(note.id, randomUUID());
      const file = join(fixture.knowledgeRoot, note.relativePath);
      const parent = restored.includes('parent symlink');
      const retained = join(fixture.root, parent ? 'retained-folder' : 'retained.md');
      barrier = await gitReadBarrier(fixture.root);
      pending = reconcileService(fixture.config, db).reconcile();
      const settled = pending.then(value => ({ value, error: undefined }), error => ({ value: undefined, error }));
      await barrier.entered();
      renameSync(parent ? join(fixture.knowledgeRoot, '00-Inbox/first') : file, retained);
      barrier.release();
      await vi.waitFor(() => expect(hashing).toBe(true), { timeout: 5000 });
      if (restored === 'regular file') renameSync(retained, file);
      else {
        const target = restored === 'missing child behind parent symlink' ? join(fixture.root, 'empty-folder') : retained;
        if (target !== retained) await mkdir(target);
        symlinkSync(target, parent ? join(fixture.knowledgeRoot, '00-Inbox/first') : file);
      }
      release();
      const outcome = await settled;
      if (restored === 'regular file') expect(outcome).toMatchObject({ value: { complete: true }, error: undefined });
      else expect.soft(outcome.error).toMatchObject({ code: 'SOURCE_UNAVAILABLE', statusCode: 503 });
      expect.soft(db.prepare('SELECT active FROM notes WHERE id=?').get(note.id)).toEqual({ active: 1 });
      expect.soft(db.prepare('SELECT enabled FROM shares WHERE note_id=?').get(note.id)).toEqual({ enabled: 1 });
      expect(readFileSync(restored === 'missing child behind parent symlink' ? join(retained, 'a.md') : file))
        .toEqual(Buffer.from('# Retained original\r\n'));
      expect(db.pragma('integrity_check', { simple: true })).toBe('ok');
    } finally {
      barrier?.release();
      release();
      await pending?.catch(() => {});
      hook.mockRestore();
      vi.unstubAllEnvs();
      db.close();
      await fixture.close();
    }
  });
}

it('uses a catalog identity registered while an untracked source is being hashed', async () => {
  const fixture = await createFixture({ fileTasks: { embedded: false }, indexing: { enabled: false, watch: false } });
  await fixture.app.close();
  const db = openDatabase(fixture.dataRoot);
  let release!: () => void;
  const gate = new Promise<void>(yes => { release = yes; });
  const realHash = sourceReader.hashFile;
  let reading = false;
  const hook = vi.spyOn(sourceReader, 'hashFile').mockImplementation(async (...args) => {
    reading = true;
    await gate;
    return realHash(...args);
  });
  let pending: ReturnType<ReturnType<typeof reconcileService>['reconcile']> | undefined;
  try {
    writeFileSync(join(fixture.knowledgeRoot, '00-Inbox/external.md'), '# Actual external bytes\r\n');
    pending = reconcileService(fixture.config, db).reconcile();
    const settled = pending.then(value => ({ value, error: undefined }), error => ({ value: undefined, error }));
    await vi.waitFor(() => expect(reading).toBe(true), { timeout: 5000 });
    noteService(fixture.config, db).scan();
    const chosen = db.prepare('SELECT id FROM notes WHERE active=1').get() as { id: string };
    release();
    expect(await settled).toMatchObject({ value: { complete: true }, error: undefined });
    expect(db.prepare('SELECT id,active FROM notes').all()).toEqual([{ id: chosen.id, active: 1 }]);
    expect(db.prepare('SELECT note_id,active FROM document_state').all()).toEqual([{ note_id: chosen.id, active: 1 }]);
  } finally {
    release();
    await pending?.catch(() => {});
    hook.mockRestore();
    db.close();
    await fixture.close();
  }
});

it('keeps the metadata-only fast scan from reading unchanged source bodies', async () => {
  const fixture = await createFixture({ fileTasks: { embedded: false }, indexing: { enabled: false, watch: false } });
  await fixture.app.close();
  const db = openDatabase(fixture.dataRoot);
  const realHash = sourceReader.hashFile;
  const reads: string[] = [];
  const hook = vi.spyOn(sourceReader, 'hashFile').mockImplementation(async (...args) => {
    reads.push(args[0]);
    return realHash(...args);
  });
  try {
    const core = mutationCore(fixture.config, db);
    const note = core.create(webPrincipal, '00-Inbox', 'cached.md', '# Cached source\r\n', randomUUID());
    const result = await reconcileService(fixture.config, db).reconcile(undefined, false);
    expect(result).toMatchObject({ added: 0, changed: 0, complete: true });
    expect(reads).toEqual([]);
    expect(db.prepare('SELECT id,active FROM notes').all()).toEqual([{ id: note.id, active: 1 }]);
  } finally {
    hook.mockRestore();
    db.close();
    await fixture.close();
  }
});
