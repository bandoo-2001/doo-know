import {isDocument,isWhiteboard,whiteboardText,documentTitle,MAX_WHITEBOARD_BYTES} from '../../../shared/whiteboard.js';
import fs from 'node:fs/promises';
import nodefs, { constants, lstatSync } from 'node:fs';
import type { BigIntStats } from 'node:fs';
import { basename, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { AppConfig } from '../../../shared/contracts.js';
import type {
  CollectionKind,
  CollectionNote,
  CollectionPage,
  CollectionStatus,
} from '../../../shared/collection-contracts.js';
import type { AppDatabase } from '../db.js';
import type { NoteService } from '../notes.js';
import {
  categories,
  safePath,
  validateRelative,
  validName,
  isMissingSource,
  sourceErrorCode,
} from '../files.js';
import { assertRoot } from '../indexing/reconcile.js';
import { fail } from '../knowledge/errors.js';
import { decodeCursor, signCursor } from '../agent/budgets.js';
import { collectionText, observeCollectionSource } from './source.js';

// Shared across owners, pages and runtime instances in this process.
let reading = 0;
const waiters: (() => void)[] = [];
async function limitedRead<T>(work: () => Promise<T>): Promise<T> {
  if (reading >= 2) await new Promise<void>((resolve) => waiters.push(resolve));
  else reading++;
  try {
    return await work();
  } finally {
    const next = waiters.shift();
    if (next) next();
    else reading--;
  }
}

type Row = {
  id: string;
  path: string;
  modified_ns: string;
  size_bytes: number;
  source_version: string;
  identity: string | null;
  summary_version: string | null;
  title: string | null;
  summary: string | null;
  summary_state: 'ready' | 'unavailable' | null;
  favorite: number;
};
export function collectionService(config: AppConfig, db: AppDatabase, notes: NoteService) {
  // true means a filesystem event requiring subtree reconciliation. false is
  // a degraded-monitor discovery pass, which only lists immediate children.
  const pending = new Map<string, boolean>();
  const directories = new Map(categories.map((path) => [path, '']));
  const inFlight = new Map<string, Promise<void>>();
  const totals = new Map<string, CollectionStatus>();
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let running: Promise<void> | undefined;
  let fallbackRunning: Promise<void> | undefined;
  const yieldWork = () => new Promise<void>((resolve) => setImmediate(resolve));
  function busy() {
    return (
      !!db
        .prepare("SELECT 1 FROM sync_runs WHERE status IN ('running','needs_reconciliation')")
        .get() ||
      !!(db.prepare('SELECT active FROM maintenance WHERE id=1').get() as any)?.active ||
      !!db.prepare("SELECT 1 FROM workspace_gate WHERE mode<>'shared'").get()
    );
  }
  function check() {
    assertRoot(config, db);
    if (busy()) fail(503, 'SYNC_IN_PROGRESS', '工作区维护中', true);
  }
  function observe(path: string) {
    const held = db
      .prepare(
        "SELECT 1 FROM write_intents WHERE (path=? OR note_id IN (SELECT id FROM notes WHERE path=?)) AND status IN ('prepared','conflicted')",
      )
      .get(path, path);
    if (held) return;
    let stat: BigIntStats;
    try {
      validateRelative(path, 'note');
      const file = safePath(config.knowledgeRoot, path, 'note');
      stat = lstatSync(file, { bigint: true });
      if (!stat.isFile() || stat.nlink !== 1n) throw new Error('invalid source');
    } catch (error) {
      // A permission or I/O failure does not establish that this source was
      // deleted. Keep its identity until a later observation can confirm it.
      if (sourceErrorCode(error) && !isMissingSource(error)) return;
      db.prepare('UPDATE notes SET active=0 WHERE path=? AND active=1').run(path);
      db.prepare(
        'UPDATE shares SET enabled=0 WHERE note_id IN (SELECT id FROM notes WHERE path=? AND active=0)',
      ).run(path);
      return;
    }
    // Database failures are not evidence that a source file disappeared.
    let row = db.prepare('SELECT id FROM notes WHERE path=? AND active=1').get(path) as
      | { id: string }
      | undefined;
    if (!row) {
      row = { id: randomUUID() };
      db.prepare('INSERT INTO notes(id,path) VALUES(?,?)').run(row.id, path);
    }
    observeCollectionSource(
      db,
      row.id,
      stat.mtimeNs.toString(),
      Number(stat.size),
      undefined,
      `${stat.dev}:${stat.ino}:${stat.ctimeNs}`,
    );
  }
  async function* directoryNotes(path: string, discovery: boolean): AsyncGenerator<string> {
    let absolute: string;
    try {
      absolute = safePath(config.knowledgeRoot, path, 'folder');
      directories.set(path, lstatSync(absolute, { bigint: true }).mtimeNs.toString());
    } catch {
      return;
    }
    const seen = new Set<string>();
    let entries = 0;
    for await (const child of await fs.opendir(absolute)) {
      if (stopped) return;
      if (++entries % 32 === 0) await yieldWork();
      if (!validName(child.name) || child.name === 'assets') continue;
      const nested = `${path}/${child.name}`;
      seen.add(nested);
      if (child.isDirectory() && !child.isSymbolicLink()) {
        if (!discovery || !directories.has(nested)) yield* directoryNotes(nested, false);
      } else if (isDocument(child.name)) {
        if (!discovery || !db.prepare('SELECT 1 FROM notes WHERE path=? AND active=1').get(nested))
          yield nested;
      }
    }
    if (discovery) {
      const prefix = path + '/';
      for (const note of db
        .prepare(
          "SELECT path FROM notes WHERE active=1 AND substr(path,1,?)=? AND instr(substr(path,?),'/')=0",
        )
        .iterate(prefix.length, prefix, prefix.length + 1) as Iterable<{ path: string }>) {
        if (!seen.has(note.path)) yield note.path;
      }
    }
  }
  async function* eventNotes(path: string, recursive: boolean): AsyncGenerator<string> {
    try {
      validateRelative(path, 'folder');
    } catch {
      if (path !== 'README.md') return;
    }
    let folder = false;
    try {
      const stat = await fs.lstat(join(config.knowledgeRoot, path));
      folder = stat.isDirectory() && !stat.isSymbolicLink();
    } catch {}
    if (folder) {
      yield* directoryNotes(path, !recursive);
    } else if (isDocument(path)) yield path;
    else {
      // A removed directory has no child events on some platforms.
      const prefix = path + '/';
      for (const note of db
        .prepare('SELECT path FROM notes WHERE active=1 AND substr(path,1,?)=?')
        .iterate(prefix.length, prefix) as Iterable<{ path: string }>)
        yield note.path;
      directories.delete(path);
    }
  }
  async function drain() {
    assertRoot(config, db);
    if (busy()) return;
    // An ancestor directory event covers its descendants. Check only path
    // prefixes, so a large batch of unrelated events does not become O(n²).
    const roots = new Map<string, boolean>();
    for (const [path, recursive] of [...pending].sort((a, b) => a[0].length - b[0].length)) {
      let prefix = '',
        covered = false;
      for (const part of path.split('/').slice(0, -1)) {
        prefix = prefix ? `${prefix}/${part}` : part;
        if (roots.get(prefix)) {
          covered = true;
          break;
        }
      }
      if (!covered) roots.set(path, recursive);
    }
    pending.clear();
    let processed = 0;
    for (const [path, recursive] of roots) {
      try {
        for await (const note of eventNotes(path, recursive)) {
          if (stopped) return;
          observe(note);
          if (++processed % 32 === 0) {
            await yieldWork();
            if (busy()) {
              for (const [retryPath, retryRecursive] of roots)
                pending.set(retryPath, retryRecursive);
              return;
            }
          }
        }
      } catch {
        /* One inaccessible subtree must not stop other events. */
      }
    }
  }
  function schedule() {
    if (stopped || timer || running) return;
    timer = setTimeout(() => {
      timer = undefined;
      if (stopped || !db.open) return;
      running = drain()
        .catch(() => {})
        .finally(() => {
          running = undefined;
          if (pending.size) schedule();
        });
    }, 150);
    timer.unref();
  }
  let watcher: ReturnType<typeof nodefs.watch> | undefined;
  let lastWatchAttempt = 0;
  const onEvent = (_event: string, name: string | Buffer | null) => {
    if (!name) return;
    const path = String(name).replace(/\\/g, '/');
    if (
      path
        .split('/')
        .some(
          (part) => part.startsWith('.') || part === 'assets' || part.toLowerCase() === 'agents.md',
        )
    )
      return;
    pending.set(path, true);
    schedule();
  };
  function startWatching() {
    if (stopped || watcher) return;
    lastWatchAttempt = Date.now();
    try {
      const current = nodefs.watch(config.knowledgeRoot, { recursive: true }, onEvent);
      watcher = current;
      current.unref();
      current.on('error', () => {
        current.close();
        if (watcher === current) watcher = undefined;
      });
    } catch {
      watcher = undefined;
    }
  }
  startWatching();
  try {
    const files = notes.scan();
    for (const path of files.notes) observe(path);
    for (const path of files.folders) {
      try {
        directories.set(
          path,
          lstatSync(safePath(config.knowledgeRoot, path, 'folder'), {
            bigint: true,
          }).mtimeNs.toString(),
        );
      } catch {}
    }
  } catch (error) {
    stopped = true;
    watcher?.close();
    throw error;
  }
  // Watch failures never disable the knowledge runtime. Retry watches every30s;
  // between retries inspect at most32 known notes and4 directory timestamps per
  // 2s tick. Only changed directories are listed, and existing subtrees are not
  // rescanned. This is intentionally a bounded, degraded monitor.
  let noteCursor = '',
    directoryCursor = directories.keys();
  const fallback = setInterval(() => {
    if (stopped || watcher || fallbackRunning) return;
    fallbackRunning = (async () => {
      if (busy()) return;
      assertRoot(config, db);
      if (Date.now() - lastWatchAttempt >= 30000) startWatching();
      if (watcher) return;
      const rows = db
        .prepare('SELECT id,path FROM notes WHERE active=1 AND id>? ORDER BY id LIMIT 32')
        .all(noteCursor) as { id: string; path: string }[];
      noteCursor = rows.at(-1)?.id || '';
      for (const row of rows) pending.set(row.path, false);
      pending.set('README.md', false);
      for (let count = 0; count < 4; count++) {
        let next = directoryCursor.next();
        if (next.done) {
          directoryCursor = directories.keys();
          next = directoryCursor.next();
        }
        if (next.done) break;
        const path = next.value;
        let modified = '';
        try {
          modified = (
            await fs.lstat(safePath(config.knowledgeRoot, path, 'folder'), { bigint: true })
          ).mtimeNs.toString();
        } catch {}
        if (directories.get(path) !== modified) {
          directories.set(path, modified);
          pending.set(path, false);
        }
      }
      schedule();
    })()
      .catch(() => {})
      .finally(() => {
        fallbackRunning = undefined;
      });
  }, 2000);
  fallback.unref();

  const version = () =>
    (
      db.prepare("SELECT value FROM index_meta WHERE key='collection_epoch'").get() as {
        value: string;
      }
    ).value;
  function kindInput(value: unknown): CollectionKind {
    if (value !== 'recent' && value !== 'favorites') fail(400, 'INVALID_COLLECTION');
    return value;
  }
  const from = `FROM notes n JOIN collection_catalog c ON c.note_id=n.id
    LEFT JOIN note_favorites f ON f.note_id=n.id AND f.owner_id=?
    WHERE n.active=1 AND (?='recent' OR f.note_id IS NOT NULL)`;
  function status(owner: string, rawKind: unknown): CollectionStatus {
    const kind = kindInput(rawKind);
    check();
    const currentVersion = version(),
      key = JSON.stringify([owner, kind]);
    const cached = totals.get(key);
    if (cached?.version === currentVersion) {
      totals.delete(key);
      totals.set(key, cached);
      return { ...cached };
    }
    const total = (
      db.prepare(`SELECT count(*) total ${from}`).get(owner, kind) as { total: number }
    ).total;
    const result = { version: currentVersion, total };
    totals.delete(key);
    totals.set(key, result);
    if (totals.size > 128) totals.delete(totals.keys().next().value!);
    return { ...result };
  }
  async function summary(row: Row) {
    if (row.summary_version === row.source_version) return;
    const key = row.id + ':' + row.source_version;
    const existing = inFlight.get(key);
    if (existing) return existing;
    const task = limitedRead(async () => {
      let title = '',
        summary = '',
        state: 'ready' | 'unavailable' = 'unavailable';
      try {
        check();
        const path = safePath(config.knowledgeRoot, row.path, 'note');
        const handle = await fs.open(
          path,
          constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
        );
        try {
          const before = await handle.stat({ bigint: true });
          if (
            !before.isFile() ||
            before.nlink !== 1n ||
            before.size > 20n * 1024n * 1024n ||
            before.mtimeNs.toString().padStart(24, '0') !== row.modified_ns ||
            Number(before.size) !== row.size_bytes ||
            (row.identity && `${before.dev}:${before.ino}:${before.ctimeNs}` !== row.identity)
          )
            throw new Error('source changed');
          if (isWhiteboard(row.path) && before.size > BigInt(MAX_WHITEBOARD_BYTES)) throw Error('白板过大');
          const buffer = Buffer.alloc(Math.min(isWhiteboard(row.path) ? MAX_WHITEBOARD_BYTES : 8192, Number(before.size)));
          const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
          const decoder = new TextDecoder('utf-8', { fatal: true });
          // A bounded prefix may end in the middle of a valid UTF-8 character.
          const content = decoder.decode(buffer.subarray(0, bytesRead), {
            stream: before.size > BigInt(bytesRead),
          });
          const after = await handle.stat({ bigint: true });
          const named = await fs.lstat(safePath(config.knowledgeRoot, row.path, 'note'), {
            bigint: true,
          });
          if (
            before.mtimeNs !== after.mtimeNs ||
            before.ctimeNs !== after.ctimeNs ||
            before.size !== after.size ||
            before.ino !== named.ino ||
            before.dev !== named.dev ||
            before.ctimeNs !== named.ctimeNs ||
            named.nlink !== 1n
          )
            throw new Error('source changed');
          ({ title, summary } = collectionText(isWhiteboard(row.path) ? whiteboardText(content) : content));
          state = 'ready';
        } finally {
          await handle.close();
        }
      } catch {
        /* One bad file must not prevent the remaining cards loading. */
      }
      if (!stopped && db.open)
        db.prepare(
          `UPDATE collection_catalog SET title=?,summary=?,summary_state=?,summary_version=? WHERE note_id=? AND source_version=?`,
        ).run(title, summary, state, row.source_version, row.id, row.source_version);
    });
    inFlight.set(key, task);
    try {
      await task;
    } finally {
      inFlight.delete(key);
    }
  }
  async function page(
    owner: string,
    query: { kind?: unknown; limit?: unknown; cursor?: unknown },
  ): Promise<CollectionPage> {
    const kind = kindInput(query.kind);
    const limit = query.limit === undefined ? 24 : Number(query.limit);
    if (
      !Number.isInteger(limit) ||
      limit < 1 ||
      limit > 48 ||
      (query.limit !== undefined && !/^\d+$/.test(String(query.limit)))
    )
      fail(400, 'INVALID_LIMIT');
    const current = status(owner, kind);
    let anchor: { modified: string; id: string } | undefined;
    if (query.cursor !== undefined) {
      const token = decodeCursor(config.secret, query.cursor as string);
      if (
        !token ||
        token.type !== 'collection' ||
        token.owner !== owner ||
        token.kind !== kind ||
        typeof token.version !== 'string' ||
        !/^\d{24}$/.test(token.modified) ||
        typeof token.id !== 'string' ||
        token.id.length > 256
      )
        fail(400, 'INVALID_CURSOR');
      if (token.version !== current.version)
        fail(409, 'COLLECTION_CHANGED', '列表已更新，请刷新后继续');
      anchor = token;
    }
    const rows = db
      .prepare(
        `SELECT n.id,n.path,c.*,f.note_id IS NOT NULL AS favorite ${from}
      ${anchor ? 'AND (c.modified_ns<? OR (c.modified_ns=? AND n.id>?))' : ''}
      ORDER BY c.modified_ns DESC,n.id ASC LIMIT ?`,
      )
      .all(
        owner,
        kind,
        ...(anchor ? [anchor.modified, anchor.modified, anchor.id] : []),
        limit + 1,
      ) as Row[];
    const selected = rows.slice(0, limit);
    await Promise.all(selected.map(summary));
    check();
    if (version() !== current.version) fail(409, 'COLLECTION_CHANGED', '列表已更新，请刷新后继续');
    const items: CollectionNote[] = selected.map((row) => {
      const cached = db
        .prepare(
          'SELECT title,summary,summary_state,summary_version,source_version FROM collection_catalog WHERE note_id=?',
        )
        .get(row.id) as Row;
      return {
        id: row.id,
        path: row.path,
        name: basename(row.path),
        title: cached.title || documentTitle(row.path),
        summary: cached.summary || '',
        summaryState:
          cached.summary_version === cached.source_version
            ? cached.summary_state || 'unavailable'
            : 'pending',
        updatedAt: new Date(Number(BigInt(row.modified_ns) / 1000000n)).toISOString(),
        favorite: !!row.favorite,
      };
    });
    const last = selected.at(-1);
    return {
      ...current,
      items,
      nextCursor:
        rows.length > limit && last
          ? signCursor(config.secret, {
              type: 'collection',
              kind,
              owner,
              version: current.version,
              modified: last.modified_ns,
              id: last.id,
            })
          : null,
    };
  }
  return {
    status,
    page,
    close: async () => {
      stopped = true;
      watcher?.close();
      if (timer) clearTimeout(timer);
      clearInterval(fallback);
      await fallbackRunning;
      await running;
      await Promise.allSettled(inFlight.values());
    },
  };
}
