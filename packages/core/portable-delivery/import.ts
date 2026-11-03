import { isDooAssetPath } from '../../../shared/storage-paths.js';
import { portableInputSnapshot, extractPortableStream, type PortableInputSnapshot } from './input-snapshot.js';
import { createWriteStream, linkSync, unlinkSync } from 'node:fs';
import { setImmediate as yieldToRequests } from 'node:timers/promises';
import { pipeline } from 'node:stream/promises';
import { hashAssetSync, assetStamp, openAsset } from '../asset-stream.js';
import { createReadStream } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { existsSync, mkdirSync, readFileSync, lstatSync } from 'node:fs';
import { join, posix } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { AppConfig } from '../../../shared/contracts.js';
import type { Principal } from '../../../shared/knowledge-contracts.js';
import type { PortableImportResult } from '../../../shared/portable-delivery-contracts.js';
import { portableResourceLimits as limits } from '../../../shared/portable-resource-limits.js';
import { boundDiagramSources, normalizeDiagramCode } from '../../../shared/diagram-portability.js';
import { parseDiagramDocument } from '../../../shared/diagram-document.js';
import { isDocument } from '../../../shared/whiteboard.js';
import { primaryRenderDescriptor } from '../../../shared/diagram-primary.js';
import { serializeDiagramRenderInput } from '../../../shared/diagram-document-binding.js';
import type { AppDatabase } from '../db.js';
import type { NoteService } from '../notes.js';
import { assetService } from '../assets.js';
import { authorizePath, requireScope, canAccessPath } from '../agent/auth.js';
import { safePath } from '../files.js';
import { localReference } from '../render.js';
import { mutationCore } from '../knowledge/core.js';
import { primaryDiagramService } from '../knowledge/primary-diagrams.js';
import { diagramCreationService } from '../knowledge/diagram-creation.js';
import { diagramArtifactService, validateDiagramSource, validatePng } from '../knowledge/diagram-artifacts.js';
import { sha256 } from '../knowledge/operations.js';
import { fail } from '../knowledge/errors.js';
import { workspaceWriteSync } from '../workspace/gate.js';
import { manifestName, validateManifest, directoryFiles, portablePath, hashFile } from './manifest.js';
import { checkNativeLinks, nativeLinks, destinations, externalNavigation, rewriteDestinations, internalNoteNavigation, unresolvedInternalNavigation } from './paths.js';
import { portableStaging } from './staging.js';

export type PortableImportOptions = { check?: () => Principal; snapshot?: PortableInputSnapshot };
function request(input: { requestId: string; folderPath: string }) {
  if (!input || !/^[A-Za-z0-9_-]{1,128}$/.test(input.requestId)) fail(400, 'INVALID_REQUEST_ID');
  if (input.folderPath) portablePath(input.folderPath);
}
function ensureDirectory(config: AppConfig, path: string) {
  let current = '';
  for (const part of path.split('/').filter(Boolean)) {
    current = current ? current + '/' + part : part;
    if (existsSync(join(config.knowledgeRoot, current)))
      safePath(config.knowledgeRoot, current, 'folder');
    else mkdirSync(join(config.knowledgeRoot, current), { mode: 0o700 });
  }
}
/** Whole self-manifest input: preflight all hashes and render bindings before any note is created. */
export async function importPortableDirectory(
  config: AppConfig,
  db: AppDatabase,
  notes: NoteService,
  p: Principal,
  input: { directoryPath: string; folderPath: string; requestId: string },
  options: PortableImportOptions = {},
): Promise<PortableImportResult> {
  const principalId = p.id,
    clientId = p.clientId;
  const refresh = () => {
    const next = options.check?.() ?? p;
    if (next.id !== principalId || next.clientId !== clientId) fail(403, 'FORBIDDEN');
    requireScope(next, 'knowledge:write');
    p = next;
    return p;
  };
  refresh();
  request(input);
  db.exec(
    'CREATE TABLE IF NOT EXISTS portable_import_jobs(id TEXT PRIMARY KEY,principal TEXT NOT NULL,client TEXT NOT NULL,request_id TEXT NOT NULL,fingerprint TEXT NOT NULL,result TEXT NOT NULL,complete INTEGER NOT NULL DEFAULT 0,UNIQUE(principal,client,request_id));',
  );
  options.snapshot?.assert(p, input.folderPath, input.directoryPath);
  const sourceFile = (path: string) =>
    options.snapshot?.path(path) ?? join(input.directoryPath, path);
  const listed = options.snapshot?.files() ?? directoryFiles(input.directoryPath),
    manifestPath = listed.includes(manifestName) ? sourceFile(manifestName) : undefined;
  if (!manifestPath || lstatSync(manifestPath).size > 4 * 1024 ** 2)
    fail(400, 'INVALID_PORTABLE_MANIFEST');
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(manifestPath, 'utf8'));
  } catch {
    fail(400, 'INVALID_PORTABLE_MANIFEST');
  }
  const manifest = validateManifest(raw),
    fileMap = new Map(manifest.files.map((file) => [file.path, file]));
  if (
    listed.length !== manifest.files.length + 1 ||
    listed.some((path) => path !== manifestName && !fileMap.has(path))
  )
    fail(400, 'PORTABLE_MANIFEST_FILES_MISMATCH');
  for (const file of manifest.files) {
    refresh();
    const absolute = sourceFile(file.path);
    if (lstatSync(absolute).size !== file.sizeBytes || (await hashFile(absolute)) !== file.sha256)
      fail(400, 'PORTABLE_DIGEST_MISMATCH');
  }
  const fingerprint = sha256(JSON.stringify({ manifest, folderPath: input.folderPath }));
  const previous = db
    .prepare('SELECT * FROM portable_import_jobs WHERE principal=? AND client=? AND request_id=?')
    .get(p.id, p.clientId, input.requestId) as any;
  if (previous && previous.fingerprint !== fingerprint) fail(409, 'REQUEST_ID_CONFLICT');
  if (previous?.complete) {
    const completed: PortableImportResult = JSON.parse(previous.result);
    for (const note of completed.notes) {
      refresh();
      const current = notes.row(note.noteId);
      authorizePath(p, current.path, 'knowledge:write');
      note.relativePath = current.path;
    }
    return completed;
  }
  const id = previous?.id || randomUUID(),
    result: PortableImportResult = previous
      ? JSON.parse(previous.result)
      : { id, notes: [], assets: 0 };
  if (!previous)
    db.prepare('INSERT INTO portable_import_jobs VALUES(?,?,?,?,?,?,0)').run(
      id,
      p.id,
      p.clientId,
      input.requestId,
      fingerprint,
      JSON.stringify(result),
    );
  const mapping = new Map(
      manifest.files.map((file) => [file.path, posix.join(input.folderPath, file.path)]),
    ),
    validatedAssets = options.snapshot
      ? { inspect: options.snapshot.inspect, open: openAsset }
      : assetService({ ...config, knowledgeRoot: input.directoryPath }, db, notes);
  const documents = new Set<string>(),
    embeddedGroups = new Map<string, ReturnType<typeof boundDiagramSources>>();
  // A mutation can have committed just before progress persistence was interrupted.
  // Recover its own durable receipt rather than treating the new identity as a collision.
  if (previous)
    for (const file of manifest.files.filter((file) => file.kind === 'document')) {
      if (result.notes.some((note) => note.sourcePath === file.path)) continue;
      const suffix = id + '-' + sha256(file.path).slice(0, 16);
      const receipt = db
        .prepare(
          "SELECT result FROM operations WHERE principal=? AND client_id=? AND status='succeeded' AND ((kind='create' AND request_id=?) OR (kind='diagram-primary.commit' AND request_id=?))",
        )
        .get(p.id, p.clientId, 'portable-create-' + suffix, 'portable-commit-' + suffix) as
        | { result: string }
        | undefined;
      if (receipt) {
        const recorded = JSON.parse(receipt.result),
          row = notes.row(recorded.id);
        authorizePath(p, row.path, 'knowledge:write');
        if (row.path !== mapping.get(file.path)) fail(409, 'PORTABLE_IMPORT_CONFLICT');
        result.notes.push({ sourcePath: file.path, relativePath: row.path, noteId: row.id });
      }
    }
  const checkIncomingNative = (source: string, sourcePath: string) => {
    checkNativeLinks(source, sourcePath, config.origin);
    for (const link of nativeLinks(source)) {
      if (!link || link.startsWith('#')) continue;
      const local = localReference(sourcePath, link);
      if (local && !fileMap.has(local))
        fail(400, 'PORTABLE_DEPENDENCY_UNAVAILABLE', '原生场景引用不在固定整包清单内', false, {
          diagnostics: [{ document: sourcePath, resource: link }],
        });
    }
  };
  for (const file of manifest.files) {
    refresh();
    const target = mapping.get(file.path)!;
    if (!canAccessPath(p, target)) fail(403, 'FORBIDDEN');
    if (
      existsSync(join(config.knowledgeRoot, target)) &&
      !result.notes.some((note) => note.relativePath === target) &&
      !(
        file.kind === 'asset' &&
        hashAssetSync(safePath(config.knowledgeRoot, target, 'asset')) === file.sha256
      )
    )
      fail(409, 'PORTABLE_IMPORT_COLLISION');
    if (file.kind === 'asset') {
      validatedAssets.inspect(file.path);
      if (/\.excalidraw$/i.test(file.path))
        checkIncomingNative(await readFile(sourceFile(file.path), 'utf8'), file.path);
      continue;
    }
    if (
      !isDocument(file.path) ||
      isDooAssetPath(file.path)
    )
      fail(400, 'INVALID_PORTABLE_DOCUMENT');
    const documentBytes = await readFile(sourceFile(file.path));
    if (sha256(documentBytes) !== file.sha256) fail(409, 'PORTABLE_DIGEST_MISMATCH');
    let content: string;
    try {
      content = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(documentBytes);
    } catch {
      fail(400, 'INVALID_PORTABLE_UTF8');
    }
    const parsed = parseDiagramDocument(content);
    if (parsed.status === 'invalid') fail(400, 'INVALID_DIAGRAM_DOCUMENT');
    if (unresolvedInternalNavigation(content, config.origin))
      fail(422, 'PORTABLE_RESOURCE_UNSUPPORTED', '便携包内文档导航必须使用标准相对链接');
    for (const ref of destinations(content)) {
      if (!ref.url || ref.url.startsWith('#')) continue;
      if (internalNoteNavigation(ref.url, config.origin))
        fail(422, 'PORTABLE_RESOURCE_UNSUPPORTED', '便携包内文档导航必须使用标准相对链接');
      const local = localReference(file.path, ref.url);
      if (!local) {
        if (!ref.image && externalNavigation(ref.url, config.origin)) continue;
        fail(422, 'PORTABLE_RESOURCE_UNSUPPORTED');
      }
      if (!fileMap.has(local))
        fail(400, 'PORTABLE_DEPENDENCY_UNAVAILABLE', undefined, false, {
          diagnostics: [{ document: file.path, resource: ref.url }],
        });
    }
    const groups = boundDiagramSources(content);
    embeddedGroups.set(file.path, groups);
    for (const group of groups) {
      const sourcePath = localReference(file.path, group.sourcePath),
        previewPath = localReference(file.path, group.previewPath);
      if (
        !sourcePath ||
        !previewPath ||
        fileMap.get(sourcePath)?.kind !== 'asset' ||
        fileMap.get(previewPath)?.kind !== 'asset'
      )
        fail(400, 'INVALID_PORTABLE_MANIFEST');
      const sourceBytes = await readFile(sourceFile(sourcePath)),
        previewBytes = await readFile(sourceFile(previewPath));
      const source = validateDiagramSource(group.kind, sourceBytes);
      validatePng(previewBytes);
      if (
        group.binding.kind !== group.kind ||
        sha256(sourceBytes) !== group.binding.sourceHash ||
        sha256(normalizeDiagramCode(group.code)) !== group.binding.codeHash ||
        (group.kind === 'excalidraw'
          ? localReference(file.path, group.code.trim()) !== sourcePath
          : normalizeDiagramCode(source) !== normalizeDiagramCode(group.code))
      )
        fail(409, 'DIAGRAM_PREVIEW_REQUIRED');
      if (group.kind === 'excalidraw') checkIncomingNative(source, sourcePath);
    }
    if (parsed.status === 'diagram') {
      const source =
        parsed.primary.source.format === 'excalidraw'
          ? await readFile(
              sourceFile(localReference(file.path, parsed.primary.source.path) || ''),
              'utf8',
            )
          : parsed.primary.source.content;
      if (parsed.primary.source.format === 'excalidraw') {
        validateDiagramSource('excalidraw', Buffer.from(source));
        checkIncomingNative(source, localReference(file.path, parsed.primary.source.path)!);
      }
      const previewPath = localReference(file.path, parsed.primary.previewPath),
        previewEntry = previewPath && fileMap.get(previewPath);
      if (!previewEntry || previewEntry.kind !== 'asset') fail(400, 'INVALID_PORTABLE_MANIFEST');
      const preview = await readFile(sourceFile(previewPath!));
      validatePng(preview);
      const descriptor = primaryRenderDescriptor(parsed),
        binding = parsed.primary.binding;
      if (
        sha256(source) !== binding.sourceHash ||
        sha256(preview) !== binding.previewHash ||
        sha256(
          serializeDiagramRenderInput({
            type: parsed.type,
            sourceHash: binding.sourceHash,
            title: parsed.title,
            ...descriptor,
          }),
        ) !== binding.renderHash
      )
        fail(409, 'DIAGRAM_PREVIEW_REQUIRED', undefined, false, {
          documents: [{ document: file.path }],
        });
      documents.add(file.path);
    } else documents.add(file.path);
  }
  const persist = () =>
    db
      .prepare('UPDATE portable_import_jobs SET result=? WHERE id=?')
      .run(JSON.stringify(result), id);
  const assets = assetService(config, db, notes),
    core = mutationCore(config, db);
  for (const file of manifest.files.filter((file) => file.kind === 'asset')) {
    refresh();
    const target = mapping.get(file.path)!;
    workspaceWriteSync(db, { kind: 'portable.prepare-import-asset' }, () => {
      refresh();
      if (!canAccessPath(p, target)) fail(403, 'FORBIDDEN');
      ensureDirectory(config, posix.dirname(target));
    });
    if (options.snapshot) {
      const descriptor = validatedAssets.inspect(file.path),
        existing = existsSync(join(config.knowledgeRoot, target))
          ? assets.inspect(target)
          : undefined;
      if (existing && (await hashFile(existing.absolutePath)) !== file.sha256)
        fail(409, 'PORTABLE_IMPORT_COLLISION');
      workspaceWriteSync(db, { kind: 'portable.promote-import-asset' }, () => {
        refresh();
        if (!canAccessPath(p, target)) fail(403, 'FORBIDDEN');
        if (existing && assetStamp(existing.absolutePath) !== existing.stamp)
          fail(409, 'PORTABLE_IMPORT_COLLISION');
        options.snapshot!.promote(
          file.path,
          target,
          descriptor.sizeBytes,
          descriptor.stamp,
          !!existing,
        );
        assets.register(target);
      });
      continue;
    }
    const descriptor = validatedAssets.inspect(file.path),
      temporary = join(config.knowledgeRoot, posix.dirname(target), '.portable-' + randomUUID());
    const reservation = await portableStaging(config, db, descriptor.sizeBytes);
    try {
      await pipeline(
        validatedAssets.open(descriptor, {
          check: () => {
            refresh();
            if (!canAccessPath(p, target)) fail(403, 'FORBIDDEN');
          },
        }),
        createWriteStream(temporary, { flags: 'wx', mode: 0o600 }),
      );
      if ((await hashFile(temporary)) !== file.sha256) fail(409, 'PORTABLE_DIGEST_MISMATCH');
      const existing = existsSync(join(config.knowledgeRoot, target))
        ? assets.inspect(target)
        : undefined;
      if (existing && (await hashFile(existing.absolutePath)) !== file.sha256)
        fail(409, 'PORTABLE_IMPORT_COLLISION');
      workspaceWriteSync(db, { kind: 'portable.import-asset' }, () => {
        refresh();
        if (!canAccessPath(p, target)) fail(403, 'FORBIDDEN');
        const destination = safePath(config.knowledgeRoot, target, 'asset', true);
        if (existing) {
          if (assetStamp(existing.absolutePath) !== existing.stamp)
            fail(409, 'PORTABLE_IMPORT_COLLISION');
        } else {
          try {
            linkSync(temporary, destination);
            unlinkSync(temporary);
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code === 'EEXIST')
              fail(409, 'PORTABLE_IMPORT_COLLISION');
            throw error;
          }
        }
        assets.register(target);
      });
    } finally {
      try {
        unlinkSync(temporary);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      } finally {
        await reservation.release();
      }
    }
  }
  result.assets = manifest.files.filter((file) => file.kind === 'asset').length;
  persist();
  for (const path of documents) {
    // Each committed document releases its gate and yields to owner cancellation/session changes.
    await yieldToRequests();
    refresh();
    if (result.notes.some((note) => note.sourcePath === path)) continue;
    const target = mapping.get(path)!,
      directory = posix.dirname(target) === '.' ? '' : posix.dirname(target);
    workspaceWriteSync(db, { kind: 'portable.import-directory' }, () => {
      refresh();
      authorizePath(p, target, 'knowledge:write');
      ensureDirectory(config, directory);
    });
    const originalBytes = readFileSync(sourceFile(path));
    if (sha256(originalBytes) !== fileMap.get(path)!.sha256) fail(409, 'PORTABLE_DIGEST_MISMATCH');
    const original = originalBytes.toString('utf8'),
      before = parseDiagramDocument(original);
    let content = rewriteDestinations(original, path, target, mapping);
    const parsed = parseDiagramDocument(content);
    let note: { id: string };
    if (parsed.status === 'diagram') {
      const primary = primaryDiagramService(config, db, notes, assets, p);
      const creation = diagramCreationService(config, db, p).reserve({
        path: target,
        type: parsed.type,
        requestId: 'portable-reserve-' + id + '-' + sha256(path).slice(0, 16),
      });
      if (before.status !== 'diagram') fail(400, 'INVALID_DIAGRAM_DOCUMENT');
      const source =
        before.primary.source.format === 'excalidraw'
          ? readFileSync(sourceFile(localReference(path, before.primary.source.path)!), 'utf8')
          : before.primary.source.content;
      const preview = readFileSync(sourceFile(localReference(path, before.primary.previewPath)!));
      if (
        sha256(source) !== before.primary.binding.sourceHash ||
        sha256(preview) !== before.primary.binding.previewHash
      )
        fail(409, 'PORTABLE_DIGEST_MISMATCH');
      const descriptor = primaryRenderDescriptor(parsed),
        prepared = primary.prepareImported(
          {
            target: { kind: 'creation', intentId: creation.id },
            type: parsed.type,
            source,
            sourceHash: sha256(source),
            title: parsed.title,
            ...descriptor,
            pngBase64: preview.toString('base64'),
            requestId: 'portable-prepare-' + id + '-' + sha256(path).slice(0, 16),
          },
          {
            previewPath: mapping.get(localReference(path, before.primary.previewPath)!)!,
            ...(before.primary.source.format === 'excalidraw'
              ? { sourcePath: mapping.get(localReference(path, before.primary.source.path)!)! }
              : {}),
          },
        );
      // Source/render/PNG bytes are unchanged. Rewrite just the immutable asset paths,
      // preserving unknown metadata, binding fields and all source/prose spelling.
      const replacements = new Map<string, string>();
      const oldPreview = localReference(target, parsed.primary.previewPath)!;
      replacements.set(oldPreview, prepared.preview.relativePath);
      if (parsed.primary.source.format === 'excalidraw')
        replacements.set(
          localReference(target, parsed.primary.source.path)!,
          prepared.source!.relativePath,
        );
      content = rewriteDestinations(content, target, target, replacements);
      note = primary.commit({
        preparedId: prepared.id,
        markdown: content,
        requestId: 'portable-commit-' + id + '-' + sha256(path).slice(0, 16),
      });
    } else
      note = core.createPortableMarkdown(
        p,
        directory,
        posix.basename(target),
        content,
        'portable-create-' + id + '-' + sha256(path).slice(0, 16),
      );
    result.notes.push({ sourcePath: path, relativePath: target, noteId: note.id });
    persist();
  }
  // This also repairs the durable preparation after a crash immediately after create.
  // Register the verified imported files themselves, preserving document spelling and paths.
  for (const item of result.notes) {
    refresh();
    for (const group of embeddedGroups.get(item.sourcePath) ?? []) {
      const sourcePath = mapping.get(localReference(item.sourcePath, group.sourcePath) ?? ''),
        previewPath = mapping.get(localReference(item.sourcePath, group.previewPath) ?? '');
      if (!sourcePath || !previewPath) fail(400, 'INVALID_PORTABLE_PATH');
      diagramArtifactService(db, notes, assets, p).prepareImportedPair(item.noteId, {
        kind: group.kind,
        sourcePath,
        previewPath,
        sourceHash: group.binding.sourceHash,
        previewHash: fileMap.get(localReference(item.sourcePath, group.previewPath)!)!.sha256,
        requestId:
          'portable-inline-' + id + '-' + sha256(sourcePath + '\0' + previewPath).slice(0, 16),
      });
    }
  }
  refresh();
  for (const note of result.notes) authorizePath(p, note.relativePath, 'knowledge:write');
  db.prepare('UPDATE portable_import_jobs SET complete=1,result=? WHERE id=?').run(
    JSON.stringify(result),
    id,
  );
  return result;
}

export async function importPortableArchive(
  config: AppConfig,
  db: AppDatabase,
  notes: NoteService,
  p: Principal,
  input: { archivePath: string; folderPath: string; requestId: string },
  options: PortableImportOptions = {},
) {
  requireScope(p, 'knowledge:write');
  request(input);
  const stage = await portableStaging(config, db);
  try {
    const principalId = p.id,
      clientId = p.clientId,
      check = () => {
        const next = options.check?.() ?? p;
        if (next.id !== principalId || next.clientId !== clientId) fail(403, 'FORBIDDEN');
        requireScope(next, 'knowledge:write');
        return next;
      };
    const snapshot = portableInputSnapshot(config, db, notes, check(), input.folderPath, stage),
      before = assetStamp(input.archivePath);
    if ((await stat(input.archivePath)).size > limits.packageBytes)
      fail(413, 'PORTABLE_BUDGET_EXCEEDED');
    await extractPortableStream(createReadStream(input.archivePath), snapshot, stage.resize, check);
    if (assetStamp(input.archivePath) !== before) fail(409, 'PORTABLE_VERSION_CONFLICT');
    return await importPortableDirectory(
      config,
      db,
      notes,
      p,
      { directoryPath: stage.directory, folderPath: input.folderPath, requestId: input.requestId },
      { ...options, snapshot },
    );
  } finally {
    await stage.release();
  }
}
