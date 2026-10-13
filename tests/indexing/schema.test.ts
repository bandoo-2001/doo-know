import { it, expect } from 'vitest';
import { createFixture } from '../support/fixture.js';
import { openDatabase } from '../../server/db.js';
it('migrates repeatedly without losing legacy note, share or revision identities', async () => {
  const f = await createFixture();
  try {
    const db = openDatabase(f.dataRoot);
    db.prepare('INSERT INTO notes(id,path) VALUES(?,?)').run('stable-note', '00-Inbox/a.md');
    db.prepare('INSERT INTO shares(note_id,token) VALUES(?,?)').run('stable-note', 'fixture-share');
    db.prepare('INSERT INTO revisions VALUES(?,?,?,?,?)').run(
      'stable-revision',
      'stable-note',
      'history.md',
      'date',
      '123',
    );
    db.close();
    for (let i = 0; i < 2; i++) {
      const d = openDatabase(f.dataRoot);
      expect(d.prepare('SELECT id FROM notes').all()).toEqual([{ id: 'stable-note' }]);
      expect(d.prepare('SELECT note_id FROM shares').get()).toEqual({ note_id: 'stable-note' });
      expect(d.prepare('SELECT id FROM revisions').get()).toEqual({ id: 'stable-revision' });
      const names = (
        d.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[]
      ).map((x) => x.name);
      for (const name of [
        'document_state',
        'operations',
        'write_intents',
        'index_jobs',
        'read_snapshots',
        'read_sessions',
        'file_operations',
        'sync_runs',
      ])
        expect(names).toContain(name);
      expect(d.pragma('foreign_keys', { simple: true })).toBe(1);
      d.close();
    }
  } finally {
    await f.close();
  }
});
