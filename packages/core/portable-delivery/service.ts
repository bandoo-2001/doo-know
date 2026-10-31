import { boundWhiteboardLines, portableBoundWhiteboards } from './embedded.js';
import { hasDiagramBindingProof } from '../knowledge/diagram-publications.js';
import { assertRoot } from '../indexing/reconcile.js';
import { mediaMime } from '../../../shared/media.js';
import {
  stageRemoteResource,
  stageDataResource,
  resourceDiagnostic,
  type RemoteDependencies,
} from './remote.js';
import type { AssetDescriptor } from '../assets.js';
import {
  createReadStream,
  readFileSync,
  writeFileSync,
  mkdirSync,
  lstatSync,
  rmSync,
  constants,
  openSync,
  fstatSync,
  closeSync,
} from 'node:fs';
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join, posix, extname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { create as createTar } from 'tar';
import type { AppConfig } from '../../../shared/contracts.js';
import type { Principal } from '../../../shared/knowledge-contracts.js';
import type {
  PortableDelivery,
  PortableDeliveryRequest,
} from '../../../shared/portable-delivery-contracts.js';
import { portableResourceLimits as limits } from '../../../shared/portable-resource-limits.js';
import { parseDiagramDocument } from '../../../shared/diagram-document.js';
import { isWhiteboard, whiteboardId } from '../../../shared/whiteboard.js';
import { renderPreparedDiagramDocument } from '../../../shared/diagram-primary.js';
import { renderPortableImage, encodePortablePathSegment } from '../../../shared/portable-figure.js';
import { boundDiagramSources, normalizeDiagramCode } from '../../../shared/diagram-portability.js';
import type { AppDatabase } from '../db.js';
import type { NoteService } from '../notes.js';
import { assetService } from '../assets.js';
import { authorizePath, requireScope, canAccessPath } from '../agent/auth.js';
import { safePath } from '../files.js';
import { localReference, markdown } from '../render.js';
import {
  workspaceExclusive,
  workspaceProcess,
  processIsAlive,
  assertOrganizationReadable,
} from '../workspace/gate.js';
import { resolvePrimaryDiagram } from '../knowledge/diagram-resource-resolver.js';
import { sha256 } from '../knowledge/operations.js';
import { fail } from '../knowledge/errors.js';
import { manifestName, hashFile, portablePath, type PortableManifest } from './manifest.js';
import {
  destinations,
  rewriteDestinations,
  checkNativeLinks,
  internalNoteNavigation,
  unresolvedInternalNavigation,
} from './paths.js';
import {
  importPortableArchive,
  importPortableDirectory,
  type PortableImportOptions,
} from './import.js';

type Proof = { noteId?: string; path: string; hash: string; stamp: string };
type Row = {
  id: string;
  principal: string;
  client: string;
  request_id: string;
  fingerprint: string;
  status: string;
  result: string | null;
  proofs: string;
  artifact: string;
  bytes: number;
  expires: number;
  pid: number;
  process_start: string;
};
const activeRequests = new WeakMap<
  AppDatabase,
  Map<string, { fingerprint: string; promise: Promise<PortableDelivery> }>
>();
const requestId = (value: string) => {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(value))
    fail(400, 'INVALID_REQUEST_ID');
  return value;
};
function stamp(path: string) {
  const s = lstatSync(path, { bigint: true });
  if (!s.isFile() || s.isSymbolicLink() || s.nlink !== 1n) fail(409, 'PORTABLE_VERSION_CONFLICT');
  return [s.dev, s.ino, s.size, s.mtimeNs, s.ctimeNs].join(':');
}
function fixedBytes(path: string, max: number) {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = fstatSync(fd, { bigint: true });
    if (!before.isFile() || before.nlink !== 1n || before.size > BigInt(max))
      fail(413, 'PORTABLE_BUDGET_EXCEEDED');
    const bytes = readFileSync(fd);
    if (
      stamp(path) !==
      [before.dev, before.ino, before.size, before.mtimeNs, before.ctimeNs].join(':')
    )
      fail(409, 'PORTABLE_VERSION_CONFLICT');
    return bytes;
  } finally {
    closeSync(fd);
  }
}

/** Frozen local dependency closure. Compression and downloads never hold a workspace lock. */
export function portableDeliveryService(
  config: AppConfig,
  db: AppDatabase,
  notes: NoteService,
  dependencies: RemoteDependencies = {},
) {
  db.exec(
    `CREATE TABLE IF NOT EXISTS portable_deliveries(id TEXT PRIMARY KEY,principal TEXT NOT NULL,client TEXT NOT NULL,request_id TEXT NOT NULL,fingerprint TEXT NOT NULL,status TEXT NOT NULL,result TEXT,proofs TEXT NOT NULL,artifact TEXT NOT NULL,bytes INTEGER NOT NULL DEFAULT 0,expires INTEGER NOT NULL,UNIQUE(principal,client,request_id));`,
  );
  const columns = db.prepare('PRAGMA table_info(portable_deliveries)').all() as { name: string }[];
  if (!columns.some((column) => column.name === 'pid'))
    db.exec('ALTER TABLE portable_deliveries ADD COLUMN pid INTEGER NOT NULL DEFAULT 0');
  if (!columns.some((column) => column.name === 'process_start'))
    db.exec("ALTER TABLE portable_deliveries ADD COLUMN process_start TEXT NOT NULL DEFAULT ''");
  const root = join(config.dataRoot, 'portable-deliveries'),
    assets = assetService(config, db, notes);
  function adjust(id: string, bytes: number) {
    db.transaction(() => {
      const total = (
        db
          .prepare('SELECT coalesce(sum(bytes),0) n FROM portable_deliveries WHERE id<>?')
          .get(id) as any
      ).n;
      const hasStaging = db
        .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='portable_staging_runs'")
        .get();
      const staging = hasStaging
        ? (db.prepare('SELECT coalesce(sum(bytes),0) n FROM portable_staging_runs').get() as any).n
        : 0;
      if (total + staging + bytes > limits.stagedBytes)
        fail(413, 'PORTABLE_STAGING_QUOTA_EXCEEDED');
      db.prepare('UPDATE portable_deliveries SET bytes=? WHERE id=?').run(bytes, id);
    }).immediate();
  }
  async function expire() {
    const old = db
      .prepare(
        "SELECT id,pid,process_start,status,expires FROM portable_deliveries WHERE expires<? OR status='preparing'",
      )
      .all(Date.now()) as Pick<Row, 'id' | 'pid' | 'process_start' | 'status' | 'expires'>[];
    for (const item of old) {
      if (item.expires >= Date.now() && processIsAlive(item.pid, item.process_start)) continue;
      await rm(join(root, item.id), { recursive: true, force: true });
      db.prepare('DELETE FROM portable_deliveries WHERE id=?').run(item.id);
    }
  }
  function own(p: Principal, id: string) {
    requireScope(p, 'knowledge:read');
    const row = db
      .prepare('SELECT * FROM portable_deliveries WHERE id=? AND principal=? AND client=?')
      .get(id, p.id, p.clientId) as Row | undefined;
    if (!row || row.expires < Date.now() || row.status !== 'ready')
      fail(404, 'PORTABLE_DELIVERY_NOT_FOUND');
    return row;
  }
  function currentNote(id: string) {
    const row = db.prepare('SELECT id,path FROM notes WHERE id=? AND active=1').get(id) as
      | { id: string; path: string }
      | undefined;
    if (!row) fail(404, 'NOTE_NOT_FOUND');
    return row;
  }
  function check(p: Principal, proofs: Proof[]) {
    assertOrganizationReadable(db);
    assertRoot(config, db);
    for (const proof of proofs) {
      if (proof.noteId) {
        const row = currentNote(proof.noteId);
        authorizePath(p, row.path);
        if (row.path !== proof.path) fail(409, 'PORTABLE_VERSION_CONFLICT');
      }
      try {
        if (
          stamp(safePath(config.knowledgeRoot, proof.path, proof.noteId ? 'note' : 'asset')) !==
          proof.stamp
        )
          fail(409, 'PORTABLE_VERSION_CONFLICT');
      } catch {
        fail(409, 'PORTABLE_VERSION_CONFLICT');
      }
    }
  }
  async function build(
    p: Principal,
    input: PortableDeliveryRequest,
    options: { signal?: AbortSignal; check?: () => Principal } = {},
  ): Promise<PortableDelivery> {
    const signal = options.signal,
      principalId = p.id,
      clientId = p.clientId;
    const checkBuild = (_principal: Principal, proofs: Proof[]) => {
      if (signal?.aborted) throw signal.reason ?? Error('PORTABLE_CANCELLED');
      const current = options.check?.() ?? p;
      if (current.id !== principalId || current.clientId !== clientId) fail(403, 'FORBIDDEN');
      p = current;
      check(p, proofs);
    };
    checkBuild(p, []);
    requireScope(p, 'knowledge:read');
    requestId(input?.requestId);
    await expire();
    const fingerprint = sha256(JSON.stringify(input.selection));
    const old = db
      .prepare('SELECT * FROM portable_deliveries WHERE principal=? AND client=? AND request_id=?')
      .get(p.id, p.clientId, input.requestId) as Row | undefined;
    if (old) {
      if (old.fingerprint !== fingerprint) fail(409, 'REQUEST_ID_CONFLICT');
      if (old.status === 'ready') {
        checkBuild(p, JSON.parse(old.proofs));
        return JSON.parse(old.result!);
      }
      fail(409, 'PORTABLE_DELIVERY_IN_PROGRESS');
    }
    const id = randomUUID(),
      directory = join(root, id),
      stage = join(directory, 'stage');
    await mkdir(stage, { recursive: true, mode: 0o700 });
    const process = workspaceProcess();
    db.prepare(
      'INSERT INTO portable_deliveries(id,principal,client,request_id,fingerprint,status,result,proofs,artifact,bytes,expires,pid,process_start) VALUES(?,?,?,?,?,?,NULL,?,?,0,?,?,?)',
    ).run(
      id,
      p.id,
      p.clientId,
      input.requestId,
      fingerprint,
      'preparing',
      '[]',
      '',
      Date.now() + 24 * 60 * 60 * 1000,
      process.pid,
      process.start,
    );
    try {
      const captured = await workspaceExclusive(db, { kind: 'portable.capture' }, async () => {
        assertRoot(config, db);
        const active = db.prepare('SELECT id,path FROM notes WHERE active=1').all() as {
          id: string;
          path: string;
        }[];
        let selected: string[];
        if (input.selection?.kind === 'single') selected = [input.selection.noteId];
        else if (
          input.selection?.kind === 'multiple' &&
          Array.isArray(input.selection.noteIds) &&
          input.selection.noteIds.length
        )
          selected = [...new Set(input.selection.noteIds)];
        else if (
          input.selection?.kind === 'directory' &&
          typeof input.selection.path === 'string'
        ) {
          const path = input.selection.path;
          if (path) {
            portablePath(path);
            if (!canAccessPath(p, path)) fail(403, 'FORBIDDEN');
          }
          selected = active
            .filter(
              (note) => (!path || note.path.startsWith(path + '/')) && canAccessPath(p, note.path),
            )
            .map((note) => note.id);
        } else return fail(400, 'INVALID_PORTABLE_SELECTION');
        if (!selected.length) fail(400, 'EMPTY_PORTABLE_SELECTION');
        if (selected.length > limits.documents) fail(413, 'PORTABLE_BUDGET_EXCEEDED');
        const capture = join(directory, 'capture');
        mkdirSync(capture, { mode: 0o700 });
        const queue = [...selected],
          docs = new Map<string, { noteId: string; snapshot: string; target: string }>(),
          resources = new Map<
            string,
            {
              path: string;
              snapshot: string;
              descriptor?: AssetDescriptor;
              remote?: { url: string; document: string };
            }
          >(),
          proofs: Proof[] = [],
          mapping = new Map<string, string>(),
          aliases = new Map<string, string>(),
          notePaths = new Map<string, string>(),
          captures = new Map<string, string>();
        let total = 0,
          capturedBytes = 0;
        const captureBytes = (bytes: Buffer) => {
          capturedBytes += bytes.length;
          if (capturedBytes > limits.packageBytes) fail(413, 'PORTABLE_BUDGET_EXCEEDED');
          adjust(id, capturedBytes + total);
          const file = join(capture, randomUUID());
          writeFileSync(file, bytes, { flag: 'wx', mode: 0o600 });
          return file;
        };
        const addProof = (path: string, bytes: Buffer, noteId?: string) => {
          if (captures.has(path)) return captures.get(path)!;
          if (proofs.length >= limits.files) fail(413, 'PORTABLE_BUDGET_EXCEEDED');
          proofs.push({
            path,
            noteId,
            hash: sha256(bytes),
            stamp: stamp(safePath(config.knowledgeRoot, path, noteId ? 'note' : 'asset')),
          });
          const snapshot = captureBytes(bytes);
          captures.set(path, snapshot);
          return snapshot;
        };
        const addAsset = (path: string, document: string, url: string) => {
          if (resources.has(path)) return;
          try {
            if (mediaMime(path)) {
              const descriptor = assets.inspect(path),
                snapshot = join(capture, randomUUID() + extname(path));
              capturedBytes += descriptor.sizeBytes;
              if (capturedBytes > limits.packageBytes || proofs.length >= limits.files)
                fail(413, 'PORTABLE_BUDGET_EXCEEDED');
              adjust(id, capturedBytes);
              proofs.push({ path, hash: '', stamp: descriptor.stamp });
              resources.set(path, { path: '', snapshot, descriptor });
              return;
            }
            const asset = assets.file(path),
              bytes = asset.sourceBytes || asset.bytes;
            if (extname(path).toLowerCase() === '.excalidraw')
              checkNativeLinks(bytes.toString('utf8'), document, config.origin);
            const snapshot = addProof(path, bytes);
            const target = 'assets/diagram-' + sha256(bytes) + extname(path).toLowerCase();
            resources.set(path, { path: target, snapshot });
            mapping.set(path, target);
          } catch (error) {
            if (
              [
                'PORTABLE_RESOURCE_UNSUPPORTED',
                'DIAGRAM_PREVIEW_REQUIRED',
                'PORTABLE_BUDGET_EXCEEDED',
                'PORTABLE_STAGING_QUOTA_EXCEEDED',
              ].includes((error as any).code)
            )
              throw error;
            fail(409, 'PORTABLE_DEPENDENCY_UNAVAILABLE', '引用资源无法完整导出', false, {
              diagnostics: [{ document, resource: resourceDiagnostic(url) }],
            });
          }
        };
        for (let index = 0; index < queue.length; index++) {
          if (queue.length > limits.documents) fail(413, 'PORTABLE_BUDGET_EXCEEDED');
          const noteId = queue[index],
            row = currentNote(noteId);
          authorizePath(p, row.path);
          const bytes = fixedBytes(
            safePath(config.knowledgeRoot, row.path, 'note'),
            20 * 1024 ** 2,
          );
          addProof(row.path, bytes, noteId);
          let content = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes),
            target = row.path;
          const parsed = parseDiagramDocument(content);
          if (parsed.status === 'invalid') fail(422, 'INVALID_DIAGRAM_DOCUMENT');
          if (parsed.status === 'diagram' || isWhiteboard(row.path)) {
            const resolved = resolvePrimaryDiagram(config, db, notes, p, noteId);
            if (
              resolved.publication ||
              resolved.preview?.state !== 'ready' ||
              resolved.source.content === undefined
            )
              fail(409, 'DIAGRAM_PREVIEW_REQUIRED', '图形需要匹配当前源的完整预览', false, {
                documents: [
                  {
                    noteId,
                    role: 'primary',
                    documentHash: resolved.documentHash,
                    sourceHash: resolved.source.hash,
                    renderHash: resolved.preview?.renderHash,
                  },
                ],
              });
            if (
              parsed.status === 'diagram' &&
              !hasDiagramBindingProof(db, noteId, {
                sourceHash: resolved.source.hash,
                renderHash: resolved.preview.renderHash,
                previewHash: resolved.preview.hash,
                previewPath: localReference(row.path, parsed.primary.previewPath)!,
                ...(parsed.primary.source.format === 'excalidraw'
                  ? { sourcePath: localReference(row.path, parsed.primary.source.path)! }
                  : {}),
              })
            )
              fail(409, 'DIAGRAM_PREVIEW_REQUIRED', '图形需要对应当前渲染元组的准备记录', false, {
                documents: [
                  {
                    noteId,
                    role: 'primary',
                    documentHash: resolved.documentHash,
                    sourceHash: resolved.source.hash,
                    renderHash: resolved.preview.renderHash,
                  },
                ],
              });
            if (resolved.source.format === 'excalidraw')
              checkNativeLinks(resolved.source.content, row.path, config.origin);
            if (isWhiteboard(row.path)) {
              target = row.path.replace(/\.excalidraw$/i, '.md');
              const native = 'assets/diagram-' + sha256(bytes) + '.excalidraw';
              resources.set(row.path, { path: native, snapshot: captures.get(row.path)! });
              const pgPath = localReference(row.path, resolved.preview.path)!;
              addAsset(pgPath, row.path, resolved.preview.path);
              content = renderPreparedDiagramDocument({
                title: resolved.title!,
                source: resolved.source.content,
                prepared: {
                  id: 'export',
                  noteId,
                  type: 'whiteboard',
                  documentHash: null,
                  baselineSourceHash: null,
                  sourceHash: resolved.source.hash,
                  renderHash: resolved.preview.renderHash,
                  previewHash: resolved.preview.hash,
                  title: resolved.title!,
                  renderer: resolved.render!.renderer,
                  config: resolved.render!.config,
                  preview: {
                    id: 'export',
                    relativePath: pgPath,
                    markdownPath: resolved.preview.path,
                    mime: 'image/png',
                  },
                  source: {
                    id: 'export-source',
                    relativePath: row.path,
                    markdownPath: posix.relative(posix.dirname(row.path), native),
                    mime: 'application/vnd.excalidraw+json',
                  },
                  expiresAt: Date.now() + 1000,
                },
              });
              // The generated source link already targets the package copy.
              mapping.set(native, native);
            }
          }
          mapping.set(row.path, target);
          docs.set(row.path, {
            noteId,
            snapshot: isWhiteboard(row.path)
              ? captureBytes(Buffer.from(content))
              : captures.get(row.path)!,
            target,
          });
          for (const group of boundDiagramSources(content)) {
            // Canonical whiteboards are refreshed below through their independent
            // semantic resource. Inline SVG/Mermaid must prove the original PNG pair.
            try {
              const native = localReference(row.path, group.sourcePath),
                preview = localReference(row.path, group.previewPath);
              if (
                !native ||
                !preview ||
                group.binding.kind !== group.kind ||
                group.binding.codeHash !== sha256(normalizeDiagramCode(group.code))
              )
                throw Error();
              const sourceAsset = assets.file(native),
                png = assets.file(preview).bytes;
              if (group.kind === 'excalidraw') {
                const ref = group.code.trim();
                if (localReference(row.path, ref) !== native) {
                  const linked = active.find((note) =>
                    whiteboardId(ref)
                      ? note.id === ref
                      : note.path === localReference(row.path, ref),
                  );
                  if (!linked) throw Error();
                  authorizePath(p, linked.path);
                  const state = resolvePrimaryDiagram(config, db, notes, p, linked.id);
                  if (state.source.hash !== group.binding.sourceHash) throw Error();
                }
              }

              if (sha256(sourceAsset.sourceBytes || sourceAsset.bytes) !== group.binding.sourceHash)
                throw Error();
              const receipts = db
                .prepare(
                  "SELECT o.kind,o.params_hash FROM operations o JOIN assets s ON s.id=json_extract(o.result,'$.source.id') JOIN assets p ON p.id=json_extract(o.result,'$.preview.id') WHERE o.kind LIKE 'diagram-artifacts:%' AND o.status='succeeded' AND s.path=? AND p.path=? AND json_extract(o.result,'$.sourceHash')=?",
                )
                .all(native, preview, group.binding.sourceHash) as {
                kind: string;
                params_hash: string;
              }[];
              if (
                !receipts.some(
                  (receipt) =>
                    receipt.params_hash ===
                    sha256(
                      JSON.stringify({
                        kind: group.kind,
                        noteId: receipt.kind.slice('diagram-artifacts:'.length),
                        previewHash: sha256(png),
                        sourceHash: group.binding.sourceHash,
                      }),
                    ),
                )
              )
                throw Error();
            } catch {
              fail(409, 'DIAGRAM_PREVIEW_REQUIRED', '内嵌图形需要匹配当前源码的固定 PNG', false, {
                documents: [{ noteId, role: 'embedded' }],
              });
            }
          }
          for (const ref of destinations(content)) {
            if (!ref.url || ref.url.startsWith('#')) continue;
            const own = internalNoteNavigation(ref.url, config.origin);
            if (own) {
              if (ref.image)
                fail(422, 'PORTABLE_RESOURCE_UNSUPPORTED', '文档导航不能作为图片资源', false, {
                  diagnostics: [{ document: row.path, resource: resourceDiagnostic(ref.url) }],
                });
              let linked: { id: string; path: string };
              try {
                linked = currentNote(own.noteId);
                authorizePath(p, linked.path);
              } catch {
                fail(409, 'PORTABLE_DEPENDENCY_UNAVAILABLE', '关联文档不可用', false, {
                  diagnostics: [{ document: row.path, resource: resourceDiagnostic(ref.url) }],
                });
              }
              notePaths.set(own.noteId, linked.path);
              if (!queue.includes(linked.id)) queue.push(linked.id);
              continue;
            }
            const local = localReference(row.path, ref.url);
            if (!local) {
              try {
                const url = new URL(ref.url, config.origin),
                  assetId =
                    url.origin === new URL(config.origin).origin &&
                    /^\/api\/assets\/([A-Za-z0-9-]+)$/.exec(url.pathname)?.[1];
                if (assetId) {
                  const descriptor = assets.inspectById(assetId);
                  addAsset(descriptor.path, row.path, ref.url);
                  aliases.set(ref.url, descriptor.path);
                  continue;
                }
              } catch (error) {
                if ((error as any).code) throw error;
                fail(409, 'PORTABLE_DEPENDENCY_UNAVAILABLE', '应用附件引用不可用', false, {
                  diagnostics: [{ document: row.path, resource: resourceDiagnostic(ref.url) }],
                });
              }
            }
            if (!local) {
              if (
                !ref.image &&
                /^https?:\/\//i.test(ref.url) &&
                !/^\/api(?:\/|$)/i.test(new URL(ref.url).pathname)
              )
                continue;
              if (/^blob:/i.test(ref.url))
                fail(
                  409,
                  'PORTABLE_REQUIRES_PERSISTENCE',
                  '临时媒体需要在浏览器中先保存为附件',
                  false,
                  {
                    diagnostics: [{ document: row.path, resource: resourceDiagnostic(ref.url) }],
                    action: 'persist-browser-resources',
                  },
                );
              if (/^(?:https?:|data:)/i.test(ref.url)) {
                if (!resources.has(ref.url))
                  resources.set(ref.url, {
                    path: '',
                    snapshot: '',
                    remote: { url: ref.url, document: row.path },
                  });
                continue;
              }
              fail(422, 'PORTABLE_RESOURCE_UNSUPPORTED', '资源地址无法安全导出', false, {
                diagnostics: [{ document: row.path, resource: resourceDiagnostic(ref.url) }],
              });
            }
            if (resources.has(local) || mapping.get(local) === local) continue;
            if (/\.(?:md|excalidraw)$/i.test(local) && !local.split('/').includes('assets')) {
              const linked = active.find((note) => note.path === local);
              try {
                if (!linked) throw Error();
                authorizePath(p, linked.path);
              } catch {
                fail(409, 'PORTABLE_DEPENDENCY_UNAVAILABLE', '关联文档不可用', false, {
                  diagnostics: [{ document: row.path, resource: resourceDiagnostic(ref.url) }],
                });
              }
              if (!queue.includes(linked.id)) queue.push(linked.id);
            } else addAsset(local, row.path, ref.url);
          }
          const snapshotLines = boundWhiteboardLines(content);
          for (const token of markdown.parse(content, {}))
            if (
              token.type === 'fence' &&
              token.info.trim() === 'excalidraw' &&
              !snapshotLines.has(token.map?.[0] ?? -1)
            ) {
              const ref = token.content.trim(),
                linked = active.find((note) =>
                  whiteboardId(ref) ? note.id === ref : note.path === localReference(row.path, ref),
                );
              try {
                if (!linked) throw Error();
                authorizePath(p, linked.path);
              } catch {
                fail(409, 'PORTABLE_DEPENDENCY_UNAVAILABLE', '嵌入白板不可用', false, {
                  diagnostics: [{ document: row.path, resource: 'whiteboard' }],
                });
              }
              if (!queue.includes(linked.id)) queue.push(linked.id);
            }
        }
        // Convert legacy embeds while the semantic resources and note identities are fixed.
        for (const [path, doc] of docs) {
          let content = readFileSync(doc.snapshot, 'utf8');
          const lines = content.split('\n'),
            snapshotLines = boundWhiteboardLines(content);
          for (const token of markdown.parse(content, {}).reverse())
            if (
              token.type === 'fence' &&
              token.info.trim() === 'excalidraw' &&
              token.map &&
              !snapshotLines.has(token.map[0])
            ) {
              const ref = token.content.trim(),
                linked = active.find((note) =>
                  whiteboardId(ref) ? note.id === ref : note.path === localReference(path, ref),
                );
              if (!linked) fail(409, 'PORTABLE_DEPENDENCY_UNAVAILABLE');
              const resource = resolvePrimaryDiagram(config, db, notes, p, linked.id);
              if (resource.preview?.state !== 'ready')
                fail(409, 'DIAGRAM_PREVIEW_REQUIRED', undefined, false, {
                  documents: [{ noteId: linked.id }],
                });
              const preview = localReference(linked.path, resource.preview.path)!;
              addAsset(preview, path, resource.preview.path);
              const image = posix.relative(posix.dirname(path), preview),
                noteLink = posix.relative(posix.dirname(path), linked.path);
              lines.splice(
                token.map[0],
                token.map[1] - token.map[0],
                renderPortableImage(resource.title || '白板', image) +
                  '\n\n[白板文档](' +
                  noteLink.split('/').map(encodePortablePathSegment).join('/') +
                  ')',
              );
            }
          const transformed = lines.join('\n');
          if (transformed !== content) doc.snapshot = captureBytes(Buffer.from(transformed));
        }
        checkBuild(p, proofs);
        return {
          docs,
          resources,
          proofs,
          mapping,
          notePaths,
          aliases,
          capture,
          capturedBytes,
          selected: selected.map((noteId) => mapping.get(currentNote(noteId).path)!),
          single: input.selection.kind === 'single' && docs.size === 1 && resources.size === 0,
        };
      });
      const plan = captured as typeof captured & {
        files: PortableManifest['files'];
        total: number;
      };
      // All network I/O, media copies, hashes and compression execute outside the workspace gate.
      let capturedBytes = plan.capturedBytes,
        total = 0;
      if (plan.resources.size + plan.docs.size > limits.files)
        fail(413, 'PORTABLE_BUDGET_EXCEEDED');
      for (const [source, resource] of plan.resources) {
        checkBuild(p, plan.proofs);
        let hash: string,
          extension = extname(source).toLowerCase();
        if (resource.remote) {
          const temporary = join(plan.capture, randomUUID());
          const onBytes = (bytes: number) => {
            checkBuild(p, plan.proofs);
            if (capturedBytes + bytes > limits.packageBytes) fail(413, 'PORTABLE_BUDGET_EXCEEDED');
            adjust(id, capturedBytes + bytes);
          };
          try {
            const result = resource.remote.url.startsWith('data:')
              ? await stageDataResource(resource.remote.url, { destination: temporary, onBytes })
              : await stageRemoteResource(resource.remote.url, {
                  ...dependencies,
                  destination: temporary,
                  onBytes,
                  signal,
                });
            extension = result.ext;
            resource.snapshot = temporary + extension;
            const { rename } = await import('node:fs/promises');
            await rename(temporary, resource.snapshot);
            // The response header and URL do not establish the type: validate the complete container.
            assetService({ ...config, knowledgeRoot: plan.capture }, db, notes).inspect(
              posix.basename(resource.snapshot),
            );
            capturedBytes += result.sizeBytes;
            hash = result.sha256;
          } catch (error) {
            const code = (error as any).code;
            if (
              [
                'FORBIDDEN',
                'PORTABLE_VERSION_CONFLICT',
                'PORTABLE_BUDGET_EXCEEDED',
                'PORTABLE_STAGING_QUOTA_EXCEEDED',
              ].includes(code)
            )
              throw error;
            fail(409, 'PORTABLE_DEPENDENCY_UNAVAILABLE', '远程媒体无法完整导出', false, {
              diagnostics: [
                {
                  document: resource.remote.document,
                  resource: resourceDiagnostic(resource.remote.url),
                },
              ],
              reason: (error as Error).message,
            });
          }
        } else if (resource.descriptor) {
          const { createWriteStream } = await import('node:fs');
          await pipeline(
            assets.open(resource.descriptor, { check: () => checkBuild(p, plan.proofs) }),
            createWriteStream(resource.snapshot, { flags: 'wx', mode: 0o600 }),
          );
          hash = await hashFile(resource.snapshot);
          plan.proofs.find((proof) => proof.path === source)!.hash = hash;
        } else hash = await hashFile(resource.snapshot);
        resource.path = 'assets/diagram-' + hash + extension;
        if (!plan.docs.has(source)) plan.mapping.set(source, resource.path);
      }
      for (const [url, path] of plan.aliases) plan.mapping.set(url, plan.mapping.get(path)!);
      const files: PortableManifest['files'] = [],
        seen = new Map<string, string>();
      async function copyFile(
        path: string,
        snapshot: string,
        kind: 'document' | 'asset',
        hash?: string,
      ) {
        portablePath(path);
        hash ??= await hashFile(snapshot);
        const key = path.normalize('NFC').toLowerCase();
        if (seen.has(key)) {
          if (seen.get(key) === hash) return;
          fail(409, 'PORTABLE_PATH_COLLISION');
        }
        const sizeBytes = (await stat(snapshot)).size;
        total += sizeBytes;
        if (total > limits.packageBytes || files.length >= limits.files)
          fail(413, 'PORTABLE_BUDGET_EXCEEDED');
        adjust(id, capturedBytes + total);
        seen.set(key, hash);
        await mkdir(join(stage, posix.dirname(path)), { recursive: true, mode: 0o700 });
        const { createWriteStream } = await import('node:fs');
        await pipeline(
          createReadStream(snapshot),
          new Transform({
            transform(chunk, _encoding, callback) {
              try {
                checkBuild(p, plan.proofs);
                callback(null, chunk);
              } catch (e) {
                callback(e as Error);
              }
            },
          }),
          createWriteStream(join(stage, path), { flags: 'wx', mode: 0o600 }),
        );
        files.push({ path, kind, sizeBytes, sha256: hash });
      }
      for (const [path, doc] of plan.docs) {
        const content = rewriteDestinations(
          portableBoundWhiteboards(
            await readFile(doc.snapshot, 'utf8'),
            path,
            doc.target,
            plan.mapping,
          ),
          path,
          doc.target,
          plan.mapping,
          { origin: config.origin, notePaths: plan.notePaths },
        );
        const unresolved = unresolvedInternalNavigation(content, config.origin);
        if (unresolved)
          fail(422, 'PORTABLE_RESOURCE_UNSUPPORTED', '应用内导航需要可安全改写的标准链接', false, {
            diagnostics: [{ document: path, resource: unresolved }],
          });
        const rendered = join(plan.capture, randomUUID());
        await writeFile(rendered, content, { flag: 'wx', mode: 0o600 });
        capturedBytes += Buffer.byteLength(content);
        adjust(id, capturedBytes + total);
        await copyFile(doc.target, rendered, 'document');
        await rm(rendered, { force: true });
        capturedBytes -= Buffer.byteLength(content);
        if (![...plan.resources.values()].some((resource) => resource.snapshot === doc.snapshot)) {
          capturedBytes -= (await stat(doc.snapshot)).size;
          await rm(doc.snapshot, { force: true });
        }
        adjust(id, capturedBytes + total);
      }
      for (const resource of plan.resources.values()) {
        await copyFile(resource.path, resource.snapshot, 'asset');
        capturedBytes -= (await stat(resource.snapshot)).size;
        await rm(resource.snapshot, { force: true });
        adjust(id, capturedBytes + total);
      }
      await rm(plan.capture, { recursive: true, force: true });
      capturedBytes = 0;
      adjust(id, total);
      Object.assign(plan, { files, total });
      const fileName = plan.single ? posix.basename(plan.files[0].path) : 'documents.tar.gz',
        artifact = join(directory, fileName);
      if (plan.single) {
        adjust(id, plan.total * 2);
        await writeFile(artifact, await readFile(join(stage, plan.files[0].path)), {
          flag: 'wx',
          mode: 0o600,
        });
      } else {
        const manifest: PortableManifest = {
          format: 'dooknow-portable',
          version: 1,
          files: plan.files,
          selected: plan.selected,
        };
        const manifestBytes = Buffer.from(JSON.stringify(manifest)),
          stageBytes = plan.total + manifestBytes.length;
        if (stageBytes > limits.packageBytes) fail(413, 'PORTABLE_BUDGET_EXCEEDED');
        adjust(id, stageBytes);
        await writeFile(join(stage, manifestName), manifestBytes, { mode: 0o600 });
        // tar writes a file stream; no package-sized Buffer/base64 allocation.
        const archive = createTar({ cwd: stage, gzip: true, portable: true, noMtime: true }, [
          ...plan.files.map((file) => file.path),
          manifestName,
        ]);
        const { createWriteStream } = await import('node:fs');
        let packed = 0;
        await pipeline(
          archive,
          new Transform({
            transform(chunk, _encoding, callback) {
              try {
                checkBuild(p, plan.proofs);
              } catch (error) {
                return callback(error as Error);
              }
              packed += chunk.length;
              if (packed > limits.packageBytes)
                return callback(
                  Object.assign(Error('PORTABLE_BUDGET_EXCEEDED'), {
                    code: 'PORTABLE_BUDGET_EXCEEDED',
                  }),
                );
              try {
                adjust(id, stageBytes + packed);
                callback(null, chunk);
              } catch (error) {
                callback(error as Error);
              }
            },
          }),
          createWriteStream(artifact, { flags: 'wx', mode: 0o600 }),
        );
      }
      checkBuild(p, plan.proofs);
      for (const proof of plan.proofs)
        if (
          (await hashFile(
            safePath(config.knowledgeRoot, proof.path, proof.noteId ? 'note' : 'asset'),
          )) !== proof.hash
        )
          fail(409, 'PORTABLE_VERSION_CONFLICT');
      checkBuild(p, plan.proofs);
      const sizeBytes = (await stat(artifact)).size;
      const result: PortableDelivery = {
        id,
        kind: plan.single ? 'markdown' : 'archive',
        fileName,
        mime: plan.single ? 'text/markdown' : 'application/gzip',
        sizeBytes,
        sha256: await hashFile(artifact),
        downloadUrl: '/api/portable-deliveries/' + id + '/download',
        ...(!plan.single ? { manifestVersion: 1 as const } : {}),
      };
      await rm(stage, { recursive: true, force: true });
      adjust(id, sizeBytes);
      await workspaceExclusive(db, { kind: 'portable.publish' }, async () => {
        checkBuild(p, plan.proofs);
        db.prepare(
          "UPDATE portable_deliveries SET status='ready',result=?,proofs=?,artifact=? WHERE id=?",
        ).run(JSON.stringify(result), JSON.stringify(plan.proofs), artifact, id);
      });
      return result;
    } catch (error) {
      await rm(directory, { recursive: true, force: true });
      db.prepare('DELETE FROM portable_deliveries WHERE id=?').run(id);
      throw error;
    }
  }
  function create(
    p: Principal,
    input: PortableDeliveryRequest,
    options: { signal?: AbortSignal; check?: () => Principal } = {},
  ): Promise<PortableDelivery> {
    requireScope(p, 'knowledge:read');
    requestId(input?.requestId);
    let requests = activeRequests.get(db);
    if (!requests) {
      requests = new Map();
      activeRequests.set(db, requests);
    }
    const key = JSON.stringify([p.id, p.clientId, input.requestId]),
      fingerprint = sha256(JSON.stringify(input.selection)),
      active = requests.get(key);
    if (active) {
      if (active.fingerprint !== fingerprint) fail(409, 'REQUEST_ID_CONFLICT');
      return active.promise.then((result) => {
        check(p, JSON.parse(own(p, result.id).proofs));
        return result;
      });
    }
    const promise = build(p, input, options).finally(() => requests!.delete(key));
    requests.set(key, { fingerprint, promise });
    return promise;
  }
  async function download(p: Principal, id: string, options: { check?: () => Principal } = {}) {
    const principalId = p.id,
      clientId = p.clientId;
    const checkDownload = (proofs: Proof[]) => {
      const current = options.check?.() ?? p;
      if (current.id !== principalId || current.clientId !== clientId) fail(403, 'FORBIDDEN');
      p = current;
      check(p, proofs);
    };
    const row = own(p, id),
      proofs: Proof[] = JSON.parse(row.proofs),
      result: PortableDelivery = JSON.parse(row.result!);
    checkDownload(proofs);
    if ((await hashFile(row.artifact)) !== result.sha256) fail(409, 'PORTABLE_ARTIFACT_CONFLICT');
    for (const proof of proofs)
      if (
        (await hashFile(
          safePath(config.knowledgeRoot, proof.path, proof.noteId ? 'note' : 'asset'),
        )) !== proof.hash
      )
        fail(409, 'PORTABLE_VERSION_CONFLICT');
    checkDownload(proofs);
    const artifactStamp = stamp(row.artifact),
      input = createReadStream(row.artifact, {
        fd: openSync(row.artifact, constants.O_RDONLY | constants.O_NOFOLLOW),
        autoClose: true,
      });
    const checked = new Transform({
      transform(chunk, _encoding, callback) {
        try {
          checkDownload(proofs);
          if (stamp(row.artifact) !== artifactStamp) fail(409, 'PORTABLE_ARTIFACT_CONFLICT');
          callback(null, chunk);
        } catch (error) {
          callback(error as Error);
        }
      },
      flush(callback) {
        try {
          checkDownload(proofs);
          if (stamp(row.artifact) !== artifactStamp) fail(409, 'PORTABLE_ARTIFACT_CONFLICT');
          callback();
        } catch (error) {
          callback(error as Error);
        }
      },
    });
    checked.once('error', () => {
      db.prepare('DELETE FROM portable_deliveries WHERE id=?').run(id);
      void rm(join(root, id), { recursive: true, force: true });
    });
    input.on('error', (error) => checked.destroy(error));
    checked.on('close', () => input.destroy());
    input.pipe(checked);
    return checked;
  }
  function metadata(p: Principal, id: string): PortableDelivery {
    const row = own(p, id);
    return JSON.parse(row.result!);
  }
  return {
    create,
    download,
    metadata,
    validate: (p: Principal, id: string) => {
      const row = own(p, id);
      check(p, JSON.parse(row.proofs));
      return JSON.parse(row.result!) as PortableDelivery;
    },
    importArchive: (
      p: Principal,
      input: { archivePath: string; folderPath: string; requestId: string },
      options: PortableImportOptions = {},
    ) => importPortableArchive(config, db, notes, p, input, options),
    importDirectory: (
      p: Principal,
      input: { directoryPath: string; folderPath: string; requestId: string },
      options: PortableImportOptions = {},
    ) => importPortableDirectory(config, db, notes, p, input, options),
  };
}
