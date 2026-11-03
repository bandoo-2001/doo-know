import { DOO_ASSETS_DIRECTORY } from '../../../shared/storage-paths.js';
import { mkdirSync, existsSync, linkSync, unlinkSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { join, posix, extname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Readable, Transform } from 'node:stream';
import { createWriteStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { Parser } from 'tar';
import type { AppConfig } from '../../../shared/contracts.js';
import type { Principal } from '../../../shared/knowledge-contracts.js';
import { portableResourceLimits as limits } from '../../../shared/portable-resource-limits.js';
import type { AppDatabase } from '../db.js';
import type { NoteService } from '../notes.js';
import { assetService } from '../assets.js';
import { assetStamp } from '../asset-stream.js';
import { canAccessPath, requireScope } from '../agent/auth.js';
import { safePath } from '../files.js';
import { workspaceWriteSync } from '../workspace/gate.js';
import { fail } from '../knowledge/errors.js';
import { portablePath } from './manifest.js';
import type { portableStaging } from './staging.js';
type Stage = Awaited<ReturnType<typeof portableStaging>>;
/** Trusted upload/extraction ownership. Plain external directories are never consumed.
 * Every file stages beside its real destination, including targets on nested mounts. */
export function portableInputSnapshot(
  config: AppConfig,
  db: AppDatabase,
  notes: NoteService,
  p: Principal,
  folderPath: string,
  stage: Stage,
) {
  if (folderPath) portablePath(folderPath);
  requireScope(p, 'knowledge:write');
  const owner = p.id,
    client = p.clientId,
    entries = new Map<string, { path: string; root: string; name: string; published?: string }>();
  function context(next: Principal, target = folderPath) {
    if (next.id !== owner || next.clientId !== client) fail(403, 'FORBIDDEN');
    requireScope(next, 'knowledge:write');
    if (target && !canAccessPath(next, target)) fail(403, 'FORBIDDEN');
  }
  context(p);
  async function allocate(path: string, current: Principal = p) {
    portablePath(path);
    if (entries.has(path)) fail(400, 'INVALID_PORTABLE_ENTRY');
    const target = posix.join(folderPath, path);
    context(current, target);
    const parent = posix.dirname(target) === '.' ? '' : posix.dirname(target);
    const directory = workspaceWriteSync(db, { kind: 'portable.stage-input' }, () => {
      context(current, target);
      let at = '';
      for (const part of parent.split('/').filter(Boolean)) {
        at = at ? at + '/' + part : part;
        if (existsSync(join(config.knowledgeRoot, at)))
          safePath(config.knowledgeRoot, at, 'folder');
        else {
          mkdirSync(join(config.knowledgeRoot, at), { mode: 0o700 });
          stage.addParent(join(config.knowledgeRoot, at));
        }
      }
      const directory = join(
        config.knowledgeRoot,
        parent,
        '.portable-' + stage.id + '-' + randomUUID(),
      );
      stage.addLocation(directory);
      return directory;
    });
    await mkdir(join(directory, DOO_ASSETS_DIRECTORY), { recursive: true, mode: 0o700 });
    // Confirm ownership before exposing a filename to any payload writer.
    stage.confirmLocation(directory);
    const name = DOO_ASSETS_DIRECTORY + '/' + randomUUID() + extname(path),
      absolute = join(directory, name);
    entries.set(path, { path: absolute, root: directory, name });
    return absolute;
  }
  function entry(path: string) {
    const value = entries.get(path);
    if (!value) fail(400, 'PORTABLE_DEPENDENCY_UNAVAILABLE');
    return value;
  }
  return {
    directory: stage.directory,
    folderPath,
    assert: (next: Principal, folder: string, directory: string) => {
      context(next);
      if (folder !== folderPath || directory !== stage.directory)
        fail(409, 'PORTABLE_STAGING_CONFLICT');
    },
    files: () => [...entries.keys()],
    path: (path: string) => entry(path).path,
    inspect: (path: string) => {
      const value = entry(path);
      return value.published
        ? assetService(config, db, notes).inspect(value.published)
        : assetService({ ...config, knowledgeRoot: value.root }, db, notes).inspect(value.name);
    },
    allocate,
    /** Called only after whole-package preflight, under the normal short publication gate. */
    promote: (path: string, target: string, size: number, stamp: string, existing: boolean) => {
      const value = entry(path);
      if (value.published) fail(409, 'PORTABLE_STAGING_CONFLICT');
      if (assetStamp(value.path) !== stamp) fail(409, 'PORTABLE_VERSION_CONFLICT');
      const destination = safePath(config.knowledgeRoot, target, 'asset', true);
      try {
        if (!existing) linkSync(value.path, destination);
        unlinkSync(value.path);
      } catch (error) {
        if ((error as any).code === 'EEXIST') fail(409, 'PORTABLE_IMPORT_COLLISION');
        throw error;
      }
      value.path = destination;
      value.published = target;
      stage.reduce(size);
    },
  };
}
export type PortableInputSnapshot = ReturnType<typeof portableInputSnapshot>;
/** One bounded archive stream, no duplicate incoming archive and no archive-sized Buffer. */
export async function extractPortableStream(
  input: Readable,
  snapshot: PortableInputSnapshot,
  resize: (bytes: number) => void,
  check: () => Principal,
) {
  let packed = 0,
    total = 0,
    declared = 0,
    count = 0;
  const seen = new Set<string>(),
    directories = new Map<string, string>(),
    tasks: Promise<void>[] = [],
    active = new Set<any>();
  const parser = new Parser({
    strict: true,
    onReadEntry(entry) {
      try {
        check();
        const path = entry.path.replace(/\/$/, '');
        portablePath(path);
        const key = path.normalize('NFC').toLowerCase();
        if (
          !['File', 'OldFile', 'Directory'].includes(entry.type) ||
          seen.has(key) ||
          ++count > limits.files * 2 + 1
        )
          fail(400, 'INVALID_PORTABLE_ENTRY');
        const parts = path.split('/');
        for (let i = 1; i < parts.length; i++) {
          const directory = parts.slice(0, i).join('/'),
            alias = directory.normalize('NFC').toLowerCase();
          if (
            (seen.has(alias) && !directories.has(alias)) ||
            (directories.has(alias) && directories.get(alias) !== directory)
          )
            fail(400, 'INVALID_PORTABLE_ENTRY');
          directories.set(alias, directory);
        }
        if (entry.type === 'Directory') {
          if (directories.has(key) && directories.get(key) !== path)
            fail(400, 'INVALID_PORTABLE_ENTRY');
          directories.set(key, path);
          seen.add(key);
          entry.resume();
          return;
        }
        if (directories.has(key)) fail(400, 'INVALID_PORTABLE_ENTRY');
        seen.add(key);
        declared += entry.size;
        if (declared > limits.packageBytes) fail(413, 'PORTABLE_BUDGET_EXCEEDED');
        active.add(entry);
        const task = (async () => {
          const file = await snapshot.allocate(path, check());
          await pipeline(
            entry as any,
            new Transform({
              transform(chunk, _encoding, callback) {
                try {
                  check();
                  total += chunk.length;
                  if (total > limits.packageBytes) fail(413, 'PORTABLE_BUDGET_EXCEEDED');
                  resize(total);
                  callback(null, chunk);
                } catch (error) {
                  callback(error as Error);
                }
              },
            }),
            createWriteStream(file, { flags: 'wx', mode: 0o600 }),
          );
        })().finally(() => active.delete(entry));
        tasks.push(task);
        void task.catch((error) => parser.abort(error));
      } catch (error) {
        parser.abort(error as Error);
        entry.resume();
      }
    },
  });
  try {
    const guard = new Transform({
      transform(chunk, _encoding, callback) {
        try {
          check();
          packed += chunk.length;
          if (packed > limits.packageBytes) fail(413, 'PORTABLE_BUDGET_EXCEEDED');
          callback(null, chunk);
        } catch (error) {
          callback(error as Error);
        }
      },
    });
    // tar.Parser is a Minipass parser with an `end` event, not a Writable `finish`.
    await new Promise<void>((resolve, reject) => {
      parser.once('end', resolve);
      parser.once('error', (error) => {
        input.destroy();
        guard.destroy();
        reject(error);
      });
      input.once('error', (error) => parser.abort(error));
      guard.once('error', (error) => parser.abort(error));
      input.pipe(guard).pipe(parser as any);
    });
    await Promise.all(tasks);
  } catch (error) {
    for (const entry of active) entry.destroy(error);
    await Promise.allSettled(tasks);
    throw error;
  }
}
