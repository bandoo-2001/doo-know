import { existsSync, mkdirSync, writeFileSync, lstatSync, unlinkSync, realpathSync } from 'node:fs';
import { writeFile, readFile, rm } from 'node:fs/promises';
import { dirname, join, posix } from 'node:path';
import { create as createTar } from 'tar';
import type { McpDomainContext } from './mcp-domain-context.js';
import type { ServiceCallOptions } from '../../../packages/plugin-sdk/index.js';
import type { Principal } from '../../../shared/knowledge-contracts.js';
import type { ImportRequest, TransferItem } from '../../../shared/transfer-contracts.js';
import type { McpTransferBinding } from '../../../shared/mcp-domain-tools.js';
import { fail } from '../../../packages/core/knowledge/errors.js';
import {
  beginOperation,
  completeOperation,
  sha256,
  existingResult,
} from '../../../packages/core/knowledge/operations.js';
import { workspaceWriteSync, workspaceExclusive } from '../../../packages/core/workspace/gate.js';
import {
  references,
  localReference,
  rewriteWhiteboardReferences,
  renderMarkdownReferences,
} from '../../../packages/core/render.js';
import { readBlocks } from '../../../packages/core/knowledge/file-reader.js';
import { acquireRead } from '../../../packages/core/agent/budgets.js';
import { safePath, validateRelative } from '../../../packages/core/files.js';
import { isWhiteboard, whiteboardId } from '../../../shared/whiteboard.js';
import {
  parseImport,
  importPreview,
  entryBytes,
  rewriteImportReferences,
  isImportDocument,
  targetPath,
  relativeInput,
} from '../platform/transfer-import.js';

const active = new WeakMap<McpDomainContext['db'], Set<string>>();
type Item = TransferItem & { attempt?: number };
type Job = {
  id: string;
  principal: string;
  client: string;
  request_id: string;
  kind: 'import' | 'export';
  state: string;
  revision: number;
  payload: string;
  items: string;
  result: string | null;
  error: string | null;
  created_at: number;
};
export const knowledgeBundleToolNames = new Set([
  'begin_knowledge_bundle_upload',
  'preview_knowledge_bundle_import',
  'apply_knowledge_bundle_import',
  'list_knowledge_bundle_jobs',
  'get_knowledge_bundle_job',
  'cancel_knowledge_bundle_job',
  'continue_knowledge_bundle_job',
  'export_knowledge_bundle',
]);

/** Portable business files only. Account backups and host restore are deliberately
 * handled by the existing host management boundary, never by these tools. */
export function createKnowledgeBundlePort(
  context: McpDomainContext,
  paginate: (
    p: Principal,
    kind: string,
    rows: any[],
    a: any,
    extra?: Record<string, unknown>,
  ) => any,
) {
  const { db, runtime, config, transfers } = context,
    k = runtime.knowledge;
  db.exec(
    'CREATE TABLE IF NOT EXISTS mcp_knowledge_bundle_jobs(id TEXT PRIMARY KEY,principal TEXT NOT NULL,client TEXT NOT NULL,request_id TEXT NOT NULL,kind TEXT NOT NULL,state TEXT NOT NULL,revision INTEGER NOT NULL,payload TEXT NOT NULL,items TEXT NOT NULL,result TEXT,error TEXT,created_at INTEGER NOT NULL,UNIQUE(principal,client,request_id,kind))',
  );
  const running = active.get(db) || new Set<string>();
  active.set(db, running);
  function stageDirectory(jobId: string, create: boolean) {
    if (!/^[a-f0-9-]{36}$/.test(jobId)) fail(400, 'INVALID_INPUT');
    let current = realpathSync(config.dataRoot);
    for (const part of ['mcp', 'bundles', jobId, 'export-stage']) {
      current = join(current, part);
      if (create)
        try {
          mkdirSync(current, { mode: 0o700 });
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        }
      let s;
      try {
        s = lstatSync(current);
      } catch (error) {
        if (!create && (error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
        throw error;
      }
      if (!s.isDirectory() || s.isSymbolicLink()) fail(503, 'MCP_TRANSFER_UNAVAILABLE');
    }
    return current;
  }
  function stageFile(jobId: string, path: string, create: boolean) {
    validateRelative(path, isImportDocument(path) ? 'note' : 'asset');
    let directory = stageDirectory(jobId, create);
    if (!directory) fail(409, 'EXPORT_STAGE_CHANGED');
    for (const part of path.split('/').slice(0, -1)) {
      directory = join(directory, part);
      if (create)
        try {
          mkdirSync(directory, { mode: 0o700 });
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        }
      const s = lstatSync(directory);
      if (!s.isDirectory() || s.isSymbolicLink()) fail(503, 'MCP_TRANSFER_UNAVAILABLE');
    }
    return join(directory, posix.basename(path));
  }
  function authorized(write: boolean, options?: ServiceCallOptions) {
    const p = context.authorize(
      ['knowledge:read', 'knowledge:manage', ...(write ? ['knowledge:write'] : [])],
      options,
    );
    if (!p.knowledgeAll) fail(403, 'FORBIDDEN');
    return p;
  }
  function authorizeTransfer(
    binding: McpTransferBinding,
    write: boolean,
    options?: ServiceCallOptions,
  ) {
    if (
      binding.domain !== 'knowledge' ||
      !['bundle-import', 'bundle-export'].includes(binding.kind) ||
      (write && binding.kind !== 'bundle-import')
    )
      fail(403, 'FORBIDDEN');
    const p = authorized(binding.kind === 'bundle-import', options);
    if (binding.kind === 'bundle-import' && binding.id !== k.organization.context(p).libraryId)
      fail(403, 'FORBIDDEN');
    if (binding.kind === 'bundle-export') owned(p, binding.id);
    return p;
  }
  function owned(p: Principal, id: string) {
    const row = db
      .prepare('SELECT * FROM mcp_knowledge_bundle_jobs WHERE id=? AND principal=? AND client=?')
      .get(id, p.id, p.clientId) as Job | undefined;
    if (!row) fail(404, 'OPERATION_NOT_FOUND');
    return row;
  }
  const items = (j: Job) => JSON.parse(j.items) as Item[];
  function summary(j: Job): Record<string, unknown> {
    const rows = items(j),
      result = j.result ? JSON.parse(j.result) : {};
    return {
      jobId: j.id,
      requestId: j.request_id,
      kind: j.kind,
      state: j.state,
      revision: j.revision,
      total: rows.length,
      completed: rows.filter((i) => i.state === 'succeeded' || i.state === 'skipped').length,
      failed: rows.filter((i) => i.state === 'failed').length,
      ...(result.download ? { download: result.download } : {}),
      ...(j.error ? { error: j.error } : {}),
    };
  }
  function patch(
    id: string,
    change: Partial<Pick<Job, 'state' | 'items' | 'payload' | 'result' | 'error'>>,
  ) {
    const entries = Object.entries(change);
    db.prepare(
      `UPDATE mcp_knowledge_bundle_jobs SET ${entries.map(([key]) => key + '=?').join(',')},revision=revision+1 WHERE id=?`,
    ).run(...entries.map(([, v]) => v), id);
    return db.prepare('SELECT * FROM mcp_knowledge_bundle_jobs WHERE id=?').get(id) as Job;
  }
  function source(p: Principal, transferId: string) {
    const info = transfers.info(p, transferId);
    authorizeTransfer(info.binding, false);
    if (info.binding.kind !== 'bundle-import' || info.mime !== 'application/json')
      fail(400, 'INVALID_INPUT');
    let value: unknown;
    try {
      value = JSON.parse(
        new TextDecoder('utf-8', { fatal: true }).decode(transfers.readUpload(p, transferId).bytes),
      );
    } catch {
      fail(400, 'INVALID_INPUT');
    }
    return parseImport(value);
  }
  function stopped(p: Principal, id: string, write: boolean, options?: ServiceCallOptions) {
    authorized(write, options);
    if (owned(p, id).state === 'cancelled') fail(499, 'CALL_CANCELLED');
  }
  function ensureParents(path: string) {
    let cursor = '';
    for (const part of posix.dirname(path) === '.' ? [] : posix.dirname(path).split('/')) {
      const next = cursor ? cursor + '/' + part : part;
      const absolute = targetPath(
        config.knowledgeRoot,
        next,
        part === 'assets' ? 'asset' : 'folder',
      );
      if (!existsSync(absolute)) {
        if (part === 'assets') mkdirSync(absolute, { mode: 0o700 });
        else runtime.notes.createFolder(cursor, part);
      }
      targetPath(config.knowledgeRoot, next, part === 'assets' ? 'asset' : 'folder');
      cursor = next;
    }
  }
  async function importJob(p: Principal, j: Job, options?: ServiceCallOptions) {
    const b = JSON.parse(j.payload) as ImportRequest,
      rows = items(j),
      mapping = new Map(rows.map((i) => [i.path, i.targetPath]));
    const sceneIds = new Map<string, string[]>();
    for (const entry of b.entries.filter((e) => isWhiteboard(e.path) && isImportDocument(e.path))) {
      const id = JSON.parse(entryBytes(entry).toString('utf8')).dooknow?.id;
      if (typeof id === 'string' && whiteboardId(id))
        sceneIds.set(id, [...(sceneIds.get(id) || []), entry.path]);
    }
    const ordered = rows
      .map((item, index) => ({ item, index }))
      .sort(
        (a, b) =>
          (a.item.kind === 'asset' ? 0 : isWhiteboard(a.item.path) ? 1 : 2) -
          (b.item.kind === 'asset' ? 0 : isWhiteboard(b.item.path) ? 1 : 2),
      );
    for (const { item, index } of ordered) {
      if (['succeeded', 'skipped'].includes(item.state)) continue;
      stopped(p, j.id, true, options);
      try {
        workspaceWriteSync(db, { kind: 'mcp.bundle.import' }, () => {
          const fresh = authorized(true, options);
          ensureParents(item.targetPath);
          const bytes = entryBytes(b.entries[index]);
          if (item.kind === 'asset') {
            const absolute = targetPath(config.knowledgeRoot, item.targetPath, 'asset');
            let created = false;
            try {
              writeFileSync(absolute, bytes, { flag: 'wx', mode: 0o600 });
              created = true;
            } catch (e) {
              if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
              const saved = runtime.assets.file(item.targetPath);
              if (sha256(saved.sourceBytes || saved.bytes) !== sha256(bytes))
                fail(409, 'NAME_CONFLICT');
            }
            try {
              runtime.assets.register(item.targetPath);
            } catch (e) {
              if (created) unlinkSync(absolute);
              throw e;
            }
          } else {
            if (
              references(bytes.toString('utf8')).some((ref) => {
                const path = localReference(item.path, ref);
                return rows.some(
                  (r) => r.path === path && r.kind === 'asset' && r.state === 'failed',
                );
              })
            )
              fail(409, 'IMPORT_DEPENDENCY_FAILED');
            let content = isWhiteboard(item.path)
              ? bytes.toString('utf8')
              : rewriteImportReferences(
                  bytes.toString('utf8'),
                  item.path,
                  item.targetPath,
                  mapping,
                );
            if (!isWhiteboard(item.path))
              content = rewriteWhiteboardReferences(content, (ref) => {
                let target: string | undefined;
                if (whiteboardId(ref)) {
                  const paths = sceneIds.get(ref);
                  if (!paths) return;
                  if (paths.length !== 1) fail(409, 'IMPORT_WHITEBOARD_ID_CONFLICT');
                  target = rows.find((i) => i.path === paths[0])?.targetPath;
                } else {
                  const relative = localReference(item.path, ref);
                  target =
                    (relative && mapping.get(relative)) || localReference(item.targetPath, ref);
                }
                if (!target) return;
                if (rows.some((r) => r.targetPath === target && r.state === 'failed'))
                  fail(409, 'IMPORT_DEPENDENCY_FAILED');
                return (
                  db.prepare('SELECT id FROM notes WHERE path=? AND active=1').get(target) as
                    | { id: string }
                    | undefined
                )?.id;
              });
            const result = k.core.create(
              fresh,
              posix.dirname(item.targetPath) === '.' ? '' : posix.dirname(item.targetPath),
              posix.basename(item.targetPath),
              content,
              `bundle-${j.id}-${index}-${item.attempt || 0}`,
            );
            item.noteId = result.id;
          }
        });
        item.state = 'succeeded';
        delete item.error;
      } catch (error) {
        item.state = 'failed';
        const code = (error as any).code;
        item.error =
          typeof code === 'string' && /^[A-Z][A-Z0-9_]{0,127}$/.test(code)
            ? code
            : 'IMPORT_ITEM_FAILED';
      }
      patch(j.id, { items: JSON.stringify(rows) });
      await new Promise<void>((r) => setImmediate(r));
    }
    const failed = rows.some((i) => i.state === 'failed');
    return patch(j.id, {
      state: failed ? 'failed' : 'succeeded',
      items: JSON.stringify(rows),
      error: failed ? 'IMPORT_ITEM_FAILED' : null,
    });
  }
  async function exportJob(p: Principal, j: Job, options?: ServiceCallOptions) {
    const payload = JSON.parse(j.payload),
      rows = items(j);
    payload.exported ??= {};
    payload.files ??= {};
    payload.stageBytes ??= 0;
    const stage = stageDirectory(j.id, true)!,
      jobRoot = dirname(stage);
    const persist = () =>
      patch(j.id, { items: JSON.stringify(rows), payload: JSON.stringify(payload) });
    const copy = async (path: string, bytes: Buffer) => {
      const digest = sha256(bytes),
        prior = payload.files[path];
      if (prior && prior.hash !== digest) fail(409, 'EXPORT_STAGE_CHANGED');
      if (!prior) {
        if (
          payload.stageBytes + bytes.length > 256 * 1024 * 1024 ||
          Object.keys(payload.files).length >= 10000
        )
          fail(413, 'EXPORT_TOO_LARGE');
        const own = (
          db
            .prepare(
              "SELECT coalesce(sum(CAST(json_extract(payload,'$.stageBytes') AS INTEGER)),0) n FROM mcp_knowledge_bundle_jobs WHERE principal=?",
            )
            .get(p.id) as { n: number }
        ).n;
        const global = (
          db
            .prepare(
              "SELECT coalesce(sum(CAST(json_extract(payload,'$.stageBytes') AS INTEGER)),0) n FROM mcp_knowledge_bundle_jobs",
            )
            .get() as { n: number }
        ).n;
        if (own + bytes.length > 512 * 1024 * 1024 || global + bytes.length > 1024 * 1024 * 1024)
          fail(429, 'EXPORT_STAGING_QUOTA_EXCEEDED');
        payload.files[path] = { hash: digest, bytes: bytes.length };
        payload.stageBytes += bytes.length;
        persist();
      }
      const destination = stageFile(j.id, path, true);
      if (existsSync(destination)) {
        const s = lstatSync(destination);
        if (
          !s.isFile() ||
          s.isSymbolicLink() ||
          s.nlink !== 1 ||
          sha256(await readFile(destination)) !== digest
        )
          fail(409, 'EXPORT_STAGE_CHANGED');
      } else await writeFile(destination, bytes, { flag: 'wx', mode: 0o600 });
    };
    for (const item of rows) {
      if (item.state === 'succeeded') continue;
      stopped(p, j.id, false, options);
      let snapshot = await k.snapshots.available(
        authorized(false, options),
        item.noteId!,
        {},
        j.id,
      );
      if ('operation' in snapshot && config.fileTasks?.embedded !== false) {
        await k.snapshots.drain();
        snapshot = await k.snapshots.available(authorized(false, options), item.noteId!, {}, j.id);
      }
      if ('operation' in snapshot)
        return patch(j.id, {
          state: 'waiting',
          items: JSON.stringify(rows),
          payload: JSON.stringify(payload),
        });
      const ready = snapshot;
      try {
        await workspaceExclusive(db, { kind: 'mcp.bundle.export-source' }, async () => {
          const release = acquireRead(db, p, 'mcp'),
            parts: Buffer[] = [];
          try {
            for await (const block of readBlocks(ready.path, 0, undefined, options?.signal)) {
              stopped(p, j.id, false, options);
              await k.snapshots.check(authorized(false, options), item.noteId!, ready.id,j.id);
              release.renew();
              parts.push(block);
            }
          } finally {
            release();
          }
          let bytes = Buffer.concat(parts),
            content = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
          if (!isWhiteboard(item.path)) {
            const all = db.prepare('SELECT id,path FROM notes WHERE active=1').all() as {
              id: string;
              path: string;
            }[];
            for (const ref of renderMarkdownReferences(content)) {
              const path = whiteboardId(ref)
                  ? all.find((n) => n.id === ref)?.path
                  : localReference(item.path, ref),
                board = all.find((n) => n.path === path && isWhiteboard(n.path));
              if (board && !rows.some((n) => n.noteId === board.id)) {
                if (rows.length >= 5000) fail(413, 'EXPORT_TOO_LARGE');
                rows.push({
                  path: board.path,
                  targetPath: board.path,
                  kind: 'note',
                  state: 'pending',
                  noteId: board.id,
                });
              }
            }
            content = rewriteWhiteboardReferences(content, (ref) => {
              const path = whiteboardId(ref)
                ? all.find((n) => n.id === ref)?.path
                : localReference(item.path, ref);
              return path && rows.some((n) => n.path === path)
                ? posix.relative(posix.dirname(item.path), path)
                : undefined;
            });
            bytes = Buffer.from(content);
            const assets = new Set<string>(payload.assets || []);
            for (const ref of references(content)) {
              const path = localReference(item.path, ref);
              if (path && !isImportDocument(path)) assets.add(path);
            }
            payload.assets = [...assets];
          }
          await k.snapshots.check(authorized(false, options), item.noteId!, ready.id,j.id);
          await copy(item.path, bytes);
          payload.exported[item.noteId!] = {
            path: item.path,
            modifiedAt: ready.modified_at,
            sizeBytes: ready.size_bytes,
            hash: ready.source_hash,
          };
          item.state = 'succeeded';
          persist();
        });
      } finally {
        await k.snapshots.releaseExport(authorized(false, options), item.noteId!, ready.id, j.id);
      }
    }
    return workspaceExclusive(db, { kind: 'mcp.bundle.export-pack' }, async () => {
      const warnings: string[] = [];
      for (const item of rows) {
        stopped(p, j.id, false, options);
        const recorded = payload.exported[item.noteId!],
          n = runtime.notes.row(item.noteId!);
        const s = lstatSync(safePath(config.knowledgeRoot, n.path, 'note'), { bigint: true });
        if (
          !recorded ||
          n.path !== recorded.path ||
          s.mtimeNs.toString() !== recorded.modifiedAt ||
          Number(s.size) !== recorded.sizeBytes
        )
          fail(409, 'STALE_CURSOR');
      }
      for (const path of payload.assets || []) {
        stopped(p, j.id, false, options);
        try {
          const asset = runtime.assets.file(path);
          await copy(path, asset.sourceBytes || asset.bytes);
        } catch (error) {
          if (
            ['EXPORT_TOO_LARGE', 'EXPORT_STAGING_QUOTA_EXCEEDED', 'EXPORT_STAGE_CHANGED'].includes(
              (error as any).code,
            )
          )
            throw error;
          warnings.push('ASSET_REFERENCE_UNAVAILABLE');
        }
      }
      const files = Object.keys(payload.files);
      for (const path of files) {
        const file = stageFile(j.id, path, false),
          s = lstatSync(file);
        if (
          !s.isFile() ||
          s.isSymbolicLink() ||
          s.nlink !== 1 ||
          sha256(await readFile(file)) !== payload.files[path].hash
        )
          fail(409, 'EXPORT_STAGE_CHANGED');
      }
      const manifest = {
        version: 1,
        scope: payload.folderPath || 'all-library',
        notes: rows.length,
        assets: files.length - rows.length,
        files,
        warnings: [...new Set(warnings)],
        includes: 'Markdown, Excalidraw, referenced assets; excludes account, secrets, history',
      };
      await writeFile(stageFile(j.id, 'dooknow-export.json', true), JSON.stringify(manifest), {
        mode: 0o600,
      });
      const chunks: Buffer[] = [];
      let packed = 0;
      for await (const chunk of createTar(
        { cwd: stage, gzip: true, portable: true, noMtime: true },
        [...files, 'dooknow-export.json'],
      )) {
        stopped(p, j.id, false, options);
        const bytes = Buffer.from(chunk);
        packed += bytes.length;
        if (packed > 256 * 1024 * 1024) fail(413, 'EXPORT_TOO_LARGE');
        chunks.push(bytes);
      }
      const download = transfers.createDownload(authorized(false, options), {
        requestId: 'bundle-export-' + j.id,
        binding: { domain: 'knowledge', kind: 'bundle-export', id: j.id },
        name: 'library.tar.gz',
        mime: 'application/gzip',
        bytes: Buffer.concat(chunks),
      });
      stageDirectory(j.id, false);
      await rm(jobRoot, { recursive: true, force: true });
      payload.stageBytes = 0;
      payload.files = {};
      return patch(j.id, {
        state: 'succeeded',
        items: JSON.stringify(rows),
        payload: JSON.stringify(payload),
        result: JSON.stringify({ download }),
        error: null,
      });
    });
  }
  async function run(p: Principal, j: Job, options?: ServiceCallOptions) {
    if (running.has(j.id)) return owned(p, j.id);
    running.add(j.id);
    try {
      return j.kind === 'import' ? await importJob(p, j, options) : await exportJob(p, j, options);
    } catch (error) {
      const current = owned(p, j.id);
      if (current.state === 'cancelled') return current;
      const code = (error as any).code;
      return patch(j.id, {
        state: 'failed',
        error:
          typeof code === 'string' && /^[A-Z][A-Z0-9_]{0,127}$/.test(code)
            ? code
            : 'BUNDLE_OPERATION_FAILED',
      });
    } finally {
      running.delete(j.id);
    }
  }
  function insert(p: Principal, kind: 'import' | 'export', a: any, payload: any, rows: Item[]) {
    const operation = db
      .transaction(() => beginOperation(db, p, 'knowledge.bundle.' + kind, a.requestId, a))
      .immediate();
    let job = db
      .prepare('SELECT * FROM mcp_knowledge_bundle_jobs WHERE id=?')
      .get(operation.operation.id) as Job | undefined;
    if (!job) {
      db.prepare('INSERT INTO mcp_knowledge_bundle_jobs VALUES(?,?,?,?,?,?,?,?,?,?,?,?)').run(
        operation.operation.id,
        p.id,
        p.clientId,
        a.requestId,
        kind,
        'running',
        1,
        JSON.stringify(payload),
        JSON.stringify(rows),
        null,
        null,
        Date.now(),
      );
      job = owned(p, operation.operation.id);
    }
    return { job, fresh: operation.fresh };
  }
  async function call(name: string, a: any, options?: ServiceCallOptions) {
    let p = authorized(
      [
        'begin_knowledge_bundle_upload',
        'preview_knowledge_bundle_import',
        'apply_knowledge_bundle_import',
        'cancel_knowledge_bundle_job',
      ].includes(name),
      options,
    );
    if (name === 'begin_knowledge_bundle_upload')
      return transfers.beginUpload(p, {
        ...a,
        binding: {
          domain: 'knowledge',
          kind: 'bundle-import',
          id: k.organization.context(p).libraryId,
        },
      });
    if (name === 'preview_knowledge_bundle_import') {
      const b = source(p, a.transferId),
        preview = importPreview(config.knowledgeRoot, b);
      return paginate(
        p,
        name + ':' + a.transferId + ':' + a.section,
        a.section === 'items' ? preview.items : preview.warnings.map((warning) => ({ warning })),
        a,
        {
          previewHash: sha256(JSON.stringify(preview)),
          totalBytes: preview.totalBytes,
          totalItems: preview.items.length,
          warningsTotal: preview.warnings.length,
        },
      );
    }
    if (name === 'apply_knowledge_bundle_import') {
      const old = db
        .prepare(
          "SELECT * FROM mcp_knowledge_bundle_jobs WHERE principal=? AND client=? AND kind='import' AND request_id=?",
        )
        .get(p.id, p.clientId, a.requestId) as Job | undefined;
      if (old) {
        beginOperation(db, p, 'knowledge.bundle.import', a.requestId, a);
        return summary(old);
      }
      const b = source(p, a.transferId),
        preview = importPreview(config.knowledgeRoot, b);
      if (sha256(JSON.stringify(preview)) !== a.expectedPreviewHash) fail(409, 'VERSION_CONFLICT');
      const created = insert(
        p,
        'import',
        a,
        b,
        preview.items.map((i) => ({
          path: i.path,
          targetPath: i.targetPath,
          kind: i.kind,
          state: i.decision === 'skip' ? 'skipped' : 'pending',
        })),
      );
      const final = await run(p, created.job, options);
      const result = summary(final);
      completeOperation(db, created.job.id, result);
      return result;
    }
    if (name === 'export_knowledge_bundle') {
      const old = db
        .prepare(
          "SELECT * FROM mcp_knowledge_bundle_jobs WHERE principal=? AND client=? AND kind='export' AND request_id=?",
        )
        .get(p.id, p.clientId, a.requestId) as Job | undefined;
      if (old) {
        beginOperation(db, p, 'knowledge.bundle.export', a.requestId, a);
        return summary(old);
      }
      const c = k.organization.context(p);
      if (c.structureRevision !== a.expectedStructureRevision) fail(409, 'VERSION_CONFLICT');
      if (a.folderPath) {
        relativeInput(a.folderPath);
        targetPath(config.knowledgeRoot, a.folderPath, 'folder');
      }
      const all = db.prepare('SELECT id,path FROM notes WHERE active=1 ORDER BY path').all() as {
        id: string;
        path: string;
      }[];
      const selected = all.filter((n) => !a.folderPath || n.path.startsWith(a.folderPath + '/'));
      if (selected.length > 5000) fail(413, 'EXPORT_TOO_LARGE');
      const created = insert(
        p,
        'export',
        a,
        { folderPath: a.folderPath },
        selected.map((n) => ({
          path: n.path,
          targetPath: n.path,
          kind: 'note',
          state: 'pending',
          noteId: n.id,
        })),
      );
      const final = await run(p, created.job, options);
      const result = summary(final);
      completeOperation(db, created.job.id, result);
      return result;
    }
    if (name === 'list_knowledge_bundle_jobs') {
      const rows = db
        .prepare(
          'SELECT * FROM mcp_knowledge_bundle_jobs WHERE principal=? AND client=? ORDER BY created_at DESC,id',
        )
        .all(p.id, p.clientId) as Job[];
      return paginate(p, name, rows.map(summary), a);
    }
    if (name === 'get_knowledge_bundle_job') {
      const row = a.jobId
        ? owned(p, a.jobId)
        : (db
            .prepare(
              'SELECT * FROM mcp_knowledge_bundle_jobs WHERE principal=? AND client=? AND request_id=? ORDER BY created_at DESC LIMIT 1',
            )
            .get(p.id, p.clientId, a.requestId) as Job | undefined);
      if (!row) fail(404, 'OPERATION_NOT_FOUND');
      return paginate(
        p,
        name + ':' + row.id,
        items(row).map(({ attempt, ...item }) => item),
        a,
        { job: summary(row) },
      );
    }
    if (name === 'cancel_knowledge_bundle_job' || name === 'continue_knowledge_bundle_job') {
      let j = owned(p, a.jobId);
      if (j.kind === 'import') p = authorized(true, options);
      const operation = db
        .transaction(() => beginOperation(db, p, 'knowledge.bundle.' + name, a.requestId, a))
        .immediate();
      if (!operation.fresh && operation.operation.status === 'succeeded')
        return existingResult(operation.operation);
      if (j.revision !== a.expectedRevision) fail(409, 'VERSION_CONFLICT');
      if (name === 'cancel_knowledge_bundle_job') {
        if (!['succeeded', 'failed', 'cancelled'].includes(j.state))
          j = patch(j.id, { state: 'cancelled' });
        const result = summary(j);
        completeOperation(db, operation.operation.id, result);
        return result;
      }
      if (running.has(j.id)) fail(409, 'OPERATION_IN_PROGRESS');
      if (j.state === 'succeeded') {
        const result = summary(j);
        completeOperation(db, operation.operation.id, result);
        return result;
      }
      let payload = j.payload;
      const restartExport = j.kind === 'export' && ['failed', 'cancelled'].includes(j.state);
      if (restartExport) {
        running.add(j.id);
        try {
          const stage = stageDirectory(j.id, false);
          if (stage) await rm(dirname(stage), { recursive: true, force: true });
          const state = JSON.parse(j.payload);
          state.files = {};
          state.exported = {};
          state.stageBytes = 0;
          state.assets = [];
          payload = JSON.stringify(state);
        } finally {
          running.delete(j.id);
        }
      }
      const rows = items(j).map((i) =>
        restartExport
          ? { ...i, state: 'pending' as const }
          : i.state === 'failed'
            ? { ...i, state: 'pending' as const, attempt: (i.attempt || 0) + 1 }
            : i,
      );
      j = patch(j.id, { state: 'running', items: JSON.stringify(rows), payload, error: null });
      const final = await run(p, j, options),
        result = summary(final);
      completeOperation(db, operation.operation.id, result);
      return result;
    }
    fail(404, 'UNKNOWN_TOOL');
  }
  return { call, authorizeTransfer };
}
