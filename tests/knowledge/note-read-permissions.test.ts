import { expect, it } from 'vitest';
import { chmodSync, unlinkSync, renameSync, symlinkSync, writeFileSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createFixture, loginFixtureOwner } from '../support/fixture.js';
import { openDatabase } from '../../packages/core/db.js';
import { mutationCore, webPrincipal } from '../../packages/core/knowledge/core.js';
import { noteService } from '../../packages/core/notes.js';

for (const failure of ['parent permission', 'file permission', 'parent symlink', 'missing file'] as const) {
  it(`keeps note identity and grants on ${failure} unless the source is really missing`, async () => {
    const fixture = await createFixture({ fileTasks: { embedded: false }, indexing: { enabled: false, watch: false } });
    await fixture.app.close();
    const db = openDatabase(fixture.dataRoot), core = mutationCore(fixture.config, db);
    const folder = join(fixture.knowledgeRoot, '00-Inbox');
    try {
      const note = core.create(webPrincipal, '00-Inbox', 'owned.md', '# Original source\r\n', randomUUID());
      db.prepare('INSERT INTO shares(note_id,token,enabled) VALUES(?,?,1)').run(note.id, randomUUID());
      if (failure === 'parent permission') chmodSync(folder, 0o000);
      else if (failure === 'file permission') chmodSync(join(folder, 'owned.md'), 0o000);
      else if (failure === 'missing file') unlinkSync(join(folder, 'owned.md'));
      else {
        renameSync(folder, join(fixture.root, 'detached-inbox'));
        await mkdir(join(fixture.root, 'outside'));
        symlinkSync(join(fixture.root, 'outside'), folder);
      }
      expect(() => noteService(fixture.config, db).getNote(note.id)).toThrow();
      const active = failure === 'missing file' ? 0 : 1;
      expect(db.prepare('SELECT id,active FROM notes').all()).toEqual([{ id: note.id, active }]);
      expect(db.prepare('SELECT enabled FROM shares WHERE note_id=?').get(note.id)).toEqual({ enabled: active });
    } finally {
      chmodSync(folder, 0o700);
      db.close();
      await fixture.close();
    }
  });
}

it('returns a retryable private HTTP read error and keeps the same note and share after permissions recover', async () => {
  const fixture = await createFixture({ fileTasks: { embedded: false }, indexing: { enabled: false, watch: false } });
  const folder = join(fixture.knowledgeRoot, '00-Inbox');
  let db: ReturnType<typeof openDatabase> | undefined;
  try {
    const headers = await loginFixtureOwner(fixture);
    const created = await fixture.app.inject({ method: 'POST', url: '/api/notes', headers, payload: { folderPath: '00-Inbox', fileName: 'http.md', content: '# HTTP intact\r\n', requestId: randomUUID() } });
    expect(created.statusCode).toBe(201);
    const note = created.json();
    const shared = await fixture.app.inject({ method: 'POST', url: '/api/notes/' + note.id + '/share', headers });
    expect(shared.statusCode).toBe(200);
    db = openDatabase(fixture.dataRoot);
    chmodSync(folder, 0o000);
    const denied = await fixture.app.inject({ url: '/api/notes/' + note.id, headers });
    expect(denied.statusCode).toBe(503);
    expect(denied.json()).toMatchObject({ code: 'SOURCE_UNAVAILABLE', retryable: true });
    expect(denied.body).not.toContain(fixture.root);
    expect(denied.body).not.toContain('cause');
    expect(db.prepare('SELECT active FROM notes WHERE id=?').get(note.id)).toEqual({ active: 1 });
    expect(db.prepare('SELECT enabled FROM shares WHERE note_id=?').get(note.id)).toEqual({ enabled: 1 });
    chmodSync(folder, 0o700);
    const reopened = await fixture.app.inject({ url: '/api/notes/' + note.id, headers });
    expect(reopened.statusCode).toBe(200);
    expect(reopened.json()).toMatchObject({ id: note.id, content: '# HTTP intact\r\n' });
  } finally {
    chmodSync(folder, 0o700);
    db?.close();
    await fixture.close();
  }
});

for (const concurrent of ['completed move', 'reappeared file'] as const) {
  it(`does not delete a valid identity when a read failure races with a ${concurrent}`, async () => {
    const fixture = await createFixture({ fileTasks: { embedded: false }, indexing: { enabled: false, watch: false } });
    await fixture.app.close();
    const db = openDatabase(fixture.dataRoot), core = mutationCore(fixture.config, db);
    const prepare = db.prepare.bind(db);
    try {
      const note = core.create(webPrincipal, '00-Inbox', 'race.md', '# Kept identity\r\n', randomUUID());
      db.prepare('INSERT INTO shares(note_id,token,enabled) VALUES(?,?,1)').run(note.id, randomUUID());
      if (concurrent === 'reappeared file') unlinkSync(join(fixture.knowledgeRoot, note.relativePath));
      let changed = false;
      db.prepare = ((sql: string) => {
        const statement = prepare(sql), get = statement.get.bind(statement);
        statement.get = ((...values: any[]) => {
          const result = get(...values);
          const boundary = concurrent === 'completed move'
            ? sql === 'SELECT * FROM notes WHERE id=?'
            : sql.includes("SELECT 1 FROM write_intents WHERE note_id=? AND kind='move'");
          if (!changed && boundary && values[0] === note.id) {
            changed = true;
            if (concurrent === 'completed move')
              core.move(webPrincipal, note.id, '00-Inbox', 'moved.md', note.modifiedAt, randomUUID());
            else writeFileSync(join(fixture.knowledgeRoot, note.relativePath), '# Reappeared source\r\n');
          }
          return result;
        }) as any;
        return statement;
      }) as any;
      let error: unknown;
      try { noteService(fixture.config, db).getNote(note.id); } catch (cause) { error = cause; }
      db.prepare = prepare;
      expect(changed).toBe(true);
      expect.soft(error).toMatchObject({ code: 'SOURCE_UNAVAILABLE', statusCode: 503 });
      expect(db.prepare('SELECT id,active FROM notes').all()).toEqual([{ id: note.id, active: 1 }]);
      expect(db.prepare('SELECT enabled FROM shares WHERE note_id=?').get(note.id)).toEqual({ enabled: 1 });
      expect(noteService(fixture.config, db).getNote(note.id)).toMatchObject({
        id: note.id,
        content: concurrent === 'completed move' ? '# Kept identity\r\n' : '# Reappeared source\r\n',
      });
    } finally {
      db.prepare = prepare;
      db.close();
      await fixture.close();
    }
  });
}
