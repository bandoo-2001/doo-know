import type { AppDatabase } from './db.js';
import type { NoteService } from './notes.js';
export function searchNotes(notes: NoteService, db: AppDatabase, query: string) {
  notes.scan();
  const q = query.trim().toLocaleLowerCase();
  if (!q) return [];
  const result = [];
  for (const { id } of db.prepare('SELECT id FROM notes WHERE active=1').all() as {
    id: string;
  }[]) {
    try {
      const n = notes.getNote(id),
        at = n.content.toLocaleLowerCase().indexOf(q);
      if (
        at >= 0 ||
        n.title.toLocaleLowerCase().includes(q) ||
        n.relativePath.toLocaleLowerCase().includes(q)
      )
        result.push({
          id: n.id,
          title: n.title,
          relativePath: n.relativePath,
          snippet: n.content.slice(Math.max(0, at - 40), Math.max(0, at - 40) + 160),
          updatedAt: n.updatedAt,
        });
    } catch {}
  }
  return result;
}
