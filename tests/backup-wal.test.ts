import { it, expect, vi } from 'vitest';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import Database from 'better-sqlite3';
import { openDatabase } from '../packages/core/db.js';
import { backup } from '../apps/server/backup.js';

it('backs up one consistent database snapshot while another WAL connection commits between every default backup step', async () => {
  const root = await mkdtemp(join(tmpdir(), 'backup-wal-')),
    knowledgeRoot = join(root, 'knowledge'),
    dataRoot = join(root, 'data'),
    destination = join(root, 'backup');
  await mkdir(knowledgeRoot);
  const text = '# Original source\r\nKeep these exact bytes.\r\n';
  await writeFile(join(knowledgeRoot, 'source.md'), text);
  const seed = openDatabase(dataRoot);
  seed.exec(`CREATE TABLE backup_counter(value INTEGER NOT NULL);
    INSERT INTO backup_counter VALUES(0);
    CREATE TABLE backup_payload(id INTEGER PRIMARY KEY,value BLOB NOT NULL);
    INSERT INTO notes(id,path) VALUES('source-note','source.md');`);
  seed.transaction(() => {
    const insert = seed.prepare('INSERT INTO backup_payload VALUES(?,zeroblob(4096))');
    for (let id = 1; id <= 320; id++) insert.run(id);
  })();
  expect(seed.pragma('page_count', { simple: true })).toBeGreaterThan(300);
  seed.close();
  const writer = new Database(join(dataRoot, 'app.sqlite'), { timeout: 0 }),
    originalBackup = Database.prototype.backup,
    remaining: number[] = [];
  let commits = 0,
    sourceConnection: Database.Database | undefined;
  // Preserve the native implementation and its default 100-page step. Only
  // force a real competing WAL commit at each native progress callback.
  const wrapped = vi.spyOn(Database.prototype, 'backup').mockImplementation(function (
    this: Database.Database,
    file,
    options,
  ) {
    sourceConnection = this;
    const observedOptions = {
      ...options,
      progress(progress: Database.BackupMetadata) {
        remaining.push(progress.remainingPages);
        writer.prepare('UPDATE backup_counter SET value=value+1').run();
        commits++;
        if (remaining.length >= 8)
          throw new Error('backup restarted after WAL commits: ' + JSON.stringify(remaining));
        // Undefined keeps better-sqlite3's measured default transfer size.
        return options?.progress?.(progress);
      },
    };
    // The documented undefined return preserves the default rate; the package
    // declarations only include its optional numeric override.
    return originalBackup.call(this, file, observedOptions as Database.BackupOptions);
  });
  try {
    await expect(
      backup(
        { knowledgeRoot, dataRoot, origin: 'http://localhost:0', secret: 'synthetic-backup-only' },
        destination,
      ),
    ).resolves.toBeUndefined();
    expect(commits).toBeGreaterThanOrEqual(3);
    expect(remaining.every((value, index) => !index || value < remaining[index - 1])).toBe(true);
    expect(writer.prepare('SELECT value FROM backup_counter').get()).toEqual({ value: commits });
    const copied = new Database(join(destination, 'data/app.sqlite'), { readonly: true });
    try {
      expect(copied.prepare('SELECT value FROM backup_counter').get()).toEqual({ value: 0 });
      expect(copied.prepare('SELECT count(*) n FROM backup_payload').get()).toEqual({ n: 320 });
      expect(copied.prepare('SELECT id,path FROM notes').all()).toEqual([
        { id: 'source-note', path: 'source.md' },
      ]);
      expect(copied.pragma('integrity_check', { simple: true })).toBe('ok');
    } finally {
      copied.close();
    }
    expect(await readFile(join(destination, 'knowledge/source.md'), 'utf8')).toBe(text);
    expect(sourceConnection?.open).toBe(false);
  } finally {
    wrapped.mockRestore();
    writer.close();
    await rm(root, { recursive: true, force: true });
  }
});

it('closes the pinned source read transaction when the native backup rejects', async () => {
  const root = await mkdtemp(join(tmpdir(), 'backup-wal-abort-')),
    knowledgeRoot = join(root, 'knowledge'),
    dataRoot = join(root, 'data');
  await mkdir(knowledgeRoot);
  const seed = openDatabase(dataRoot);
  seed.close();
  const originalBackup = Database.prototype.backup,
    failure = new Error('native backup interrupted');
  let sourceConnection: Database.Database | undefined;
  const wrapped = vi.spyOn(Database.prototype, 'backup').mockImplementation(function (
    this: Database.Database,
    file,
  ) {
    sourceConnection = this;
    return originalBackup.call(this, file, {
      progress: () => {
        throw failure;
      },
    });
  });
  try {
    await expect(
      backup(
        { knowledgeRoot, dataRoot, origin: 'http://localhost:0', secret: 'synthetic-backup-only' },
        join(root, 'backup'),
      ),
    ).rejects.toBe(failure);
    expect(sourceConnection?.open).toBe(false);
    expect(sourceConnection?.inTransaction).toBe(false);
    const writer = new Database(join(dataRoot, 'app.sqlite'), { timeout: 0 });
    try {
      writer.prepare("INSERT INTO index_meta VALUES('after_backup_abort','committed')").run();
      expect(writer.pragma('wal_checkpoint(TRUNCATE)')).toEqual([
        { busy: 0, log: 0, checkpointed: 0 },
      ]);
    } finally {
      writer.close();
    }
  } finally {
    wrapped.mockRestore();
    await rm(root, { recursive: true, force: true });
  }
});
