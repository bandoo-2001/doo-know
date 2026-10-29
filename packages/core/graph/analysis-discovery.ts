import { opendirSync, type Dir } from 'node:fs';
import type { AppConfig } from '../../../shared/contracts.js';
import type { AppDatabase } from '../db.js';
import { portableLibrary } from '../portable-library.js';
import { safePath, validName } from '../files.js';
import type { sourceAccess } from './analysis-source.js';
/** Incremental fallback only when the host's indexing watcher is disabled. */
export function analysisDiscovery(
  config: AppConfig,
  db: AppDatabase,
  access: ReturnType<typeof sourceAccess>,
) {
  const enabled = config.indexing?.enabled === false;
  const stack: { path: string; dir: Dir }[] = [];
  let root = config.knowledgeRoot,
    nextRound = 0;
  let library: ReturnType<typeof portableLibrary> | undefined;
  function close() {
    for (const entry of stack.splice(0))
      try {
        entry.dir.closeSync();
      } catch {}
  }
  function step() {
    if (!enabled) return;
    access.barrier();
    if (root !== config.knowledgeRoot) {
      close();
      root = config.knowledgeRoot;
      library = undefined;
    }
    if (!stack.length) {
      if (Date.now() < nextRound) return;
      stack.push({ path: '', dir: opendirSync(root) });
    }
    library ??= portableLibrary(config, db);
    for (let budget = 0; budget < 32 && stack.length; budget++) {
      const current = stack.at(-1)!;
      let item;
      try {
        item = current.dir.readSync();
      } catch {
        close();
        nextRound = Date.now() + 2000;
        return;
      }
      if (!item) {
        current.dir.closeSync();
        stack.pop();
        continue;
      }
      if (
        !validName(item.name) ||
        item.name === '_data' ||
        item.name === 'assets' ||
        item.isSymbolicLink()
      )
        continue;
      const path = current.path ? current.path + '/' + item.name : item.name;
      if (item.isDirectory()) {
        if (stack.length < 32)
          try {
            stack.push({ path, dir: opendirSync(safePath(root, path, 'folder')) });
          } catch {}
        continue;
      }
      if (!item.isFile() || !/\.md$/i.test(item.name)) continue;
      if (db.prepare('SELECT 1 FROM notes WHERE path=? AND active=1').get(path)) continue;
      if (
        db
          .prepare(
            "SELECT 1 FROM write_intents WHERE path=? AND status IN ('prepared','conflicted')",
          )
          .get(path)
      )
        continue;
      try {
        access.inspect(path);
        access.barrier();
        const id = library.identity(path);
        db.transaction(() => {
          if (db.prepare('SELECT 1 FROM notes WHERE path=? AND active=1').get(path)) return;
          db.prepare(
            'INSERT INTO notes(id,path) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET path=excluded.path,active=1',
          ).run(id, path);
          db.prepare(
            'UPDATE document_state SET active=1,source_revision=source_revision+1,content_hash=NULL WHERE note_id=?',
          ).run(id);
        }).immediate();
      } catch {}
    }
    library.flush();
    if (!stack.length) nextRound = Date.now() + 2000;
  }
  return { step, close };
}
