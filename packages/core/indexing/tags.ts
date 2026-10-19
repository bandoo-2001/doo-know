import { parseDocument, isScalar, isSeq } from 'yaml';
import type { AppDatabase } from '../db.js';
import type { SourceVersion } from '../../../shared/knowledge-contracts.js';
import { readBlocks } from '../knowledge/file-reader.js';
export async function stageTags(
  db: AppDatabase,
  version: SourceVersion,
  path: string,
  valid: () => boolean,
) {
  const parts: Buffer[] = [];
  for await (const bytes of readBlocks(path, 0, 16384)) parts.push(bytes);
  const prefix = Buffer.concat(parts)
      .toString('utf8')
      .replace(/^\ufeff/, ''),
    match = prefix.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/),
    tags: string[] = [];
  if (match) {
    const doc = parseDocument(match[1], {
      logLevel: 'silent',
      prettyErrors: false,
      schema: 'failsafe',
    });
    if (!doc.errors.length) {
      const node = doc.get('tags', true),
        nodes = isSeq(node) ? node.items : [node];
      for (const item of nodes.slice(0, 16))
        if (
          isScalar(item) &&
          typeof item.value === 'string' &&
          Buffer.byteLength(item.value) <= 128 &&
          item.value.trim()
        )
          tags.push(item.value.trim().toLowerCase());
    }
  }
  db.transaction(() => {
    if (!valid()) return;
    db.prepare('DELETE FROM note_tags WHERE note_id=? AND source_revision=?').run(
      version.noteId,
      version.sourceRevision,
    );
    for (const tag of new Set(tags))
      db.prepare('INSERT OR IGNORE INTO note_tags VALUES(?,?,?)').run(
        version.noteId,
        version.sourceRevision,
        tag,
      );
  }).immediate();
}
