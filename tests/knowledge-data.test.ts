import { afterEach, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, symlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase } from '../packages/core/db';
import {
  createKnowledgeDataDomain,
  readKnowledgeDataFile,
  writeKnowledgeDataFile,
  listKnowledgeDataDirectories,
} from '../packages/core/knowledge-data';

const fixtures: { root: string; db: ReturnType<typeof openDatabase> }[] = [];
afterEach(() => {
  for (const f of fixtures.splice(0)) {
    f.db.close();
    rmSync(f.root, { recursive: true, force: true });
  }
});
function fixture(beforeRead?: () => void) {
  const root = mkdtempSync(join(tmpdir(), 'dooknow-portable-store-'));
  const config = { knowledgeRoot: join(root, 'knowledge') };
  mkdirSync(config.knowledgeRoot);
  const db = openDatabase(join(root, 'local'));
  fixtures.push({ root, db });
  db.exec(
    "CREATE TABLE user_content(value TEXT NOT NULL); INSERT INTO user_content VALUES('original')",
  );
  const domain = () =>
    createKnowledgeDataDomain(config, db, 'apps/test/state.json', {
      tables: ['user_content'],
      read: () => {
        beforeRead?.();
        return {
          value: (db.prepare('SELECT value FROM user_content').get() as { value: string }).value,
        };
      },
      validate(data: unknown) {
        if (!data || typeof data !== 'object' || typeof (data as any).value !== 'string')
          throw Error('Invalid content');
        return data as { value: string };
      },
      write(data: { value: string }) {
        db.prepare('UPDATE user_content SET value=?').run(data.value);
      },
    });
  return {
    root,
    config,
    db,
    domain,
    file: join(config.knowledgeRoot, '_data/apps/test/state.json'),
  };
}
it('migrates existing records, flushes changes and hydrates a fresh SQLite projection', () => {
  const f = fixture(),
    d = f.domain();
  expect(JSON.parse(readFileSync(f.file, 'utf8')).data.value).toBe('original');
  f.db.prepare('UPDATE user_content SET value=?').run('saved');
  d.flush();
  const other = fixture();
  writeKnowledgeDataFile(other.config.knowledgeRoot, 'apps/test/state.json', readFileSync(f.file));
  other.domain();
  expect(other.db.prepare('SELECT value FROM user_content').get()).toEqual({ value: 'saved' });
});
it('imports synchronized changes and refuses to overwrite conflicts or removed authority', () => {
  const f = fixture(),
    d = f.domain();
  const change = (value: string) =>
    writeFileSync(f.file, JSON.stringify({ format: 1, revision: value, data: { value } }));
  change('remote');
  d.refresh();
  expect(f.db.prepare('SELECT value FROM user_content').get()).toEqual({ value: 'remote' });
  f.db.exec("UPDATE user_content SET value='local'");
  change('competing');
  expect(() => d.flush()).toThrow(/冲突|CONFLICT/);
  expect(JSON.parse(readFileSync(f.file, 'utf8')).data.value).toBe('competing');
  expect(f.db.prepare('SELECT value FROM user_content').get()).toEqual({ value: 'local' });
});
it('rejects malformed data without replacing source or the local projection', () => {
  const f = fixture(),
    d = f.domain();
  writeFileSync(f.file, '{broken');
  expect(() => d.refresh()).toThrow();
  expect(readFileSync(f.file, 'utf8')).toBe('{broken');
  expect(f.db.prepare('SELECT value FROM user_content').get()).toEqual({ value: 'original' });
});
it('keeps a pending snapshot recoverable when the file write fails', () => {
  const f = fixture(),
    d = f.domain();
  f.db.exec("UPDATE user_content SET value='pending'");
  const before = readFileSync(f.file);
  rmSync(f.file);
  mkdirSync(f.file);
  expect(() => d.flush()).toThrow();
  rmSync(f.file, { recursive: true });
  writeFileSync(f.file, before);
  d.refresh();
  expect(JSON.parse(readFileSync(f.file, 'utf8')).data.value).toBe('pending');
});
it('does not rewrite unchanged domains and rejects symlinks and path traversal', () => {
  const f = fixture(),
    d = f.domain();
  const before = readFileSync(f.file, 'utf8');
  f.db.exec("UPDATE user_content SET value='original'");
  d.flush();
  expect(readFileSync(f.file, 'utf8')).toBe(before);
  expect(() => writeKnowledgeDataFile(f.config.knowledgeRoot, '../escape.json', '{}')).toThrow();
  const target = join(f.root, 'outside');
  mkdirSync(target);
  symlinkSync(target, join(f.config.knowledgeRoot, '_data/link'));
  expect(() => writeKnowledgeDataFile(f.config.knowledgeRoot, 'link/secret', 'value')).toThrow();
  expect(() => readKnowledgeDataFile(f.config.knowledgeRoot, 'link/secret')).toThrow();
  expect(listKnowledgeDataDirectories(f.config.knowledgeRoot, 'apps')).toEqual(['test']);
});

it('replays a durably staged file write after interruption', () => {
  let interrupt = false;
  const f = fixture(() => {
    if (!interrupt) return;
    interrupt = false;
    rmSync(f.file);
    mkdirSync(f.file);
  });
  const d = f.domain();
  const original = readFileSync(f.file);
  f.db.exec("UPDATE user_content SET value='staged'");
  interrupt = true;
  expect(() => d.flush()).toThrow();
  expect((f.db.prepare('SELECT pending FROM knowledge_data_state').get() as any).pending).toContain(
    'staged',
  );
  rmSync(f.file, { recursive: true });
  writeFileSync(f.file, original);
  d.refresh();
  expect(JSON.parse(readFileSync(f.file, 'utf8')).data.value).toBe('staged');
  expect(
    (f.db.prepare('SELECT pending FROM knowledge_data_state').get() as any).pending,
  ).toBeNull();
});
it('does not recreate a removed authoritative file from stale SQLite data', () => {
  const f = fixture(),
    d = f.domain();
  rmSync(f.file);
  expect(() => d.refresh()).toThrow(/冲突|CONFLICT/);
  expect(readKnowledgeDataFile(f.config.knowledgeRoot, 'apps/test/state.json')).toBeUndefined();
});

it('preserves a local commit made by another process while synchronized data is being validated', () => {
  const f = fixture(),
    other = openDatabase(join(f.root, 'local'));
  let inject = false;
  try {
    const domain = createKnowledgeDataDomain(f.config, f.db, 'apps/race/state.json', {
      tables: ['user_content'],
      read: () => f.db.prepare('SELECT value FROM user_content').get() as { value: string },
      validate(input: unknown) {
        if (!input || typeof (input as any).value !== 'string') throw Error('Invalid fixture data');
        if (inject) {
          inject = false;
          other.prepare("UPDATE user_content SET value='local commit during validation'").run();
        }
        return input as { value: string };
      },
      write: (value) => {
        f.db.prepare('UPDATE user_content SET value=?').run(value.value);
      },
    });
    const file = join(f.config.knowledgeRoot, '_data/apps/race/state.json');
    writeFileSync(
      file,
      JSON.stringify({ format: 1, revision: 'external-change', data: { value: 'remote edit' } }),
    );
    inject = true;
    expect(() => domain.refresh()).toThrow();
    expect(f.db.prepare('SELECT value FROM user_content').get()).toEqual({
      value: 'local commit during validation',
    });
  } finally {
    other.close();
  }
});
