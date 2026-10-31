import { createReadStream } from 'node:fs';
import { mkdir, readFile, writeFile, rm, stat, cp } from 'node:fs/promises';
import { existsSync, mkdirSync, readFileSync, writeFileSync, lstatSync } from 'node:fs';
import { join, posix, dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Parser, extract } from 'tar';
import type { AppConfig } from '../../../shared/contracts.js';
import type { Principal } from '../../../shared/knowledge-contracts.js';
import type { PortableImportResult } from '../../../shared/portable-delivery-contracts.js';
import { portableResourceLimits as limits } from '../../../shared/portable-resource-limits.js';
import { parseDiagramDocument } from '../../../shared/diagram-document.js';
import { isDocument, isWhiteboard } from '../../../shared/whiteboard.js';
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
import { validateDiagramSource, validatePng } from '../knowledge/diagram-artifacts.js';
import { sha256 } from '../knowledge/operations.js';
import { fail } from '../knowledge/errors.js';
import { workspaceWriteSync } from '../workspace/gate.js';
import {
  manifestName,
  validateManifest,
  directoryFiles,
  portablePath,
  hashFile,
} from './manifest.js';
import { checkNativeLinks, destinations, rewriteDestinations } from './paths.js';
import { portableStaging } from './staging.js';

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
async function safeExtract(file: string, destination: string) {
  const info = await stat(file);
  if (info.size > limits.packageBytes) fail(413, 'PORTABLE_BUDGET_EXCEEDED');
  await new Promise<void>((resolve, reject) => {
    const input = createReadStream(file);
    let total = 0;
    const seen = new Set<string>();
    const parser = new Parser({
      strict: true,
      onReadEntry(entry) {
        try {
          const path = entry.path.replace(/\/$/, '');
          portablePath(path);
          const key = path.normalize('NFC').toLowerCase();
          if (!['File', 'OldFile', 'Directory'].includes(entry.type) || seen.has(key))
            fail(400, 'INVALID_PORTABLE_ENTRY');
          seen.add(key);
          total += entry.size;
          if (seen.size > limits.files * 2 + 1 || total > limits.packageBytes)
            fail(413, 'PORTABLE_BUDGET_EXCEEDED');
        } catch (error) {
          parser.abort(error as Error);
        }
        entry.resume();
      },
    });
    parser.once('error', (error) => {
      input.destroy();
      reject(error);
    });
    parser.once('end', () => resolve());
    input.once('error', (error) => parser.abort(error));
    input.pipe(parser as any);
  });
  await extract({
    file,
    cwd: destination,
    strict: true,
    preservePaths: false,
    filter: (_path, entry) => ['File', 'OldFile', 'Directory'].includes((entry as any).type),
    chmod: true,
    processUmask: 0o077,
  });
}

/** Whole self-manifest input: preflight all hashes and render bindings before any note is created. */
export async function importPortableDirectory(
  config: AppConfig,
  db: AppDatabase,
  notes: NoteService,
  p: Principal,
  input: { directoryPath: string; folderPath: string; requestId: string },
): Promise<PortableImportResult> {
  requireScope(p, 'knowledge:write');
  request(input);
  db.exec(
    'CREATE TABLE IF NOT EXISTS portable_import_jobs(id TEXT PRIMARY KEY,principal TEXT NOT NULL,client TEXT NOT NULL,request_id TEXT NOT NULL,fingerprint TEXT NOT NULL,result TEXT NOT NULL,complete INTEGER NOT NULL DEFAULT 0,UNIQUE(principal,client,request_id));',
  );
  const listed = directoryFiles(input.directoryPath),
    manifestPath = join(input.directoryPath, manifestName);
  if (!listed.includes(manifestName) || lstatSync(manifestPath).size > 4 * 1024 ** 2)
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
    const absolute = join(input.directoryPath, file.path);
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
    for (const note of completed.notes)
      authorizePath(p, notes.row(note.noteId).path, 'knowledge:write');
    return completed;
  }
  const id = previous?.id || randomUUID(),
    result: PortableImportResult = previous
      ? JSON.parse(previous.result)
      : { id, notes: [], assets: 0 };
  const mapping = new Map(
      manifest.files.map((file) => [file.path, posix.join(input.folderPath, file.path)]),
    ),
    validatedAssets = assetService({ ...config, knowledgeRoot: input.directoryPath }, db, notes);
  const documents = new Set<string>();
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
  for (const file of manifest.files) {
    const target = mapping.get(file.path)!;
    if (!canAccessPath(p, target)) fail(403, 'FORBIDDEN');
    if (
      existsSync(join(config.knowledgeRoot, target)) &&
      !result.notes.some((note) => note.relativePath === target) &&
      !(
        file.kind === 'asset' &&
        sha256(readFileSync(safePath(config.knowledgeRoot, target, 'asset'))) === file.sha256
      )
    )
      fail(409, 'PORTABLE_IMPORT_COLLISION');
    if (file.kind === 'asset') {
      validatedAssets.file(file.path);
      continue;
    }
    if (
      !isDocument(file.path) ||
      isWhiteboard(file.path) ||
      file.path.split('/').includes('assets')
    )
      fail(400, 'INVALID_PORTABLE_DOCUMENT');
    const documentBytes = await readFile(join(input.directoryPath, file.path));
    if (sha256(documentBytes) !== file.sha256) fail(409, 'PORTABLE_DIGEST_MISMATCH');
    let content: string;
    try {
      content = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(documentBytes);
    } catch {
      fail(400, 'INVALID_PORTABLE_UTF8');
    }
    const parsed = parseDiagramDocument(content);
    if (parsed.status === 'invalid') fail(400, 'INVALID_DIAGRAM_DOCUMENT');
    for (const ref of destinations(content)) {
      if (!ref.url || ref.url.startsWith('#')) continue;
      const local = localReference(file.path, ref.url);
      if (!local) {
        if (
          !ref.image &&
          /^https?:\/\//i.test(ref.url) &&
          !/^\/api(?:\/|$)/i.test(new URL(ref.url).pathname)
        )
          continue;
        fail(422, 'PORTABLE_RESOURCE_UNSUPPORTED');
      }
      if (!fileMap.has(local))
        fail(400, 'PORTABLE_DEPENDENCY_UNAVAILABLE', undefined, false, {
          diagnostics: [{ document: file.path, resource: ref.url }],
        });
    }
    if (parsed.status === 'diagram') {
      const source =
        parsed.primary.source.format === 'excalidraw'
          ? await readFile(
              join(
                input.directoryPath,
                localReference(file.path, parsed.primary.source.path) || '',
              ),
              'utf8',
            )
          : parsed.primary.source.content;
      if (parsed.primary.source.format === 'excalidraw') {
        validateDiagramSource('excalidraw', Buffer.from(source));
        checkNativeLinks(source, file.path);
      }
      const previewPath = localReference(file.path, parsed.primary.previewPath),
        previewEntry = previewPath && fileMap.get(previewPath);
      if (!previewEntry || previewEntry.kind !== 'asset') fail(400, 'INVALID_PORTABLE_MANIFEST');
      const preview = await readFile(join(input.directoryPath, previewPath!));
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
  if (!previous)
    db.prepare('INSERT INTO portable_import_jobs VALUES(?,?,?,?,?,?,0)').run(
      id,
      p.id,
      p.clientId,
      input.requestId,
      fingerprint,
      JSON.stringify(result),
    );
  const persist = () =>
    db
      .prepare('UPDATE portable_import_jobs SET result=? WHERE id=?')
      .run(JSON.stringify(result), id);
  const assets = assetService(config, db, notes),
    core = mutationCore(config, db),
    primary = primaryDiagramService(config, db, notes, assets, p);
  for (const file of manifest.files.filter((file) => file.kind === 'asset'))
    workspaceWriteSync(db, { kind: 'portable.import-asset' }, () => {
      const target = mapping.get(file.path)!,
        bytes = readFileSync(join(input.directoryPath, file.path));
      if (sha256(bytes) !== file.sha256) fail(409, 'PORTABLE_DIGEST_MISMATCH');
      if (!canAccessPath(p, target)) fail(403, 'FORBIDDEN');
      ensureDirectory(config, posix.dirname(target));
      if (!existsSync(join(config.knowledgeRoot, target)))
        writeFileSync(join(config.knowledgeRoot, target), bytes, { flag: 'wx', mode: 0o600 });
      else if (
        sha256(readFileSync(safePath(config.knowledgeRoot, target, 'asset'))) !== file.sha256
      )
        fail(409, 'PORTABLE_IMPORT_COLLISION');
      assets.register(target);
    });
  result.assets = manifest.files.filter((file) => file.kind === 'asset').length;
  persist();
  for (const path of documents) {
    if (result.notes.some((note) => note.sourcePath === path)) continue;
    const target = mapping.get(path)!,
      directory = posix.dirname(target) === '.' ? '' : posix.dirname(target);
    workspaceWriteSync(db, { kind: 'portable.import-directory' }, () => {
      authorizePath(p, target, 'knowledge:write');
      ensureDirectory(config, directory);
    });
    const originalBytes = readFileSync(join(input.directoryPath, path));
    if (sha256(originalBytes) !== fileMap.get(path)!.sha256) fail(409, 'PORTABLE_DIGEST_MISMATCH');
    const original = originalBytes.toString('utf8'),
      before = parseDiagramDocument(original);
    let content = rewriteDestinations(original, path, target, mapping);
    const parsed = parseDiagramDocument(content);
    let note: { id: string };
    if (parsed.status === 'diagram') {
      const creation = diagramCreationService(config, db, p).reserve({
        path: target,
        type: parsed.type,
        requestId: 'portable-reserve-' + id + '-' + sha256(path).slice(0, 16),
      });
      if (before.status !== 'diagram') fail(400, 'INVALID_DIAGRAM_DOCUMENT');
      const source =
        before.primary.source.format === 'excalidraw'
          ? readFileSync(
              join(input.directoryPath, localReference(path, before.primary.source.path)!),
              'utf8',
            )
          : before.primary.source.content;
      const preview = readFileSync(
        join(input.directoryPath, localReference(path, before.primary.previewPath)!),
      );
      if (
        sha256(source) !== before.primary.binding.sourceHash ||
        sha256(preview) !== before.primary.binding.previewHash
      )
        fail(409, 'PORTABLE_DIGEST_MISMATCH');
      const descriptor = primaryRenderDescriptor(parsed),
        prepared = primary.prepare({
          target: { kind: 'creation', intentId: creation.id },
          type: parsed.type,
          source,
          sourceHash: sha256(source),
          title: parsed.title,
          ...descriptor,
          pngBase64: preview.toString('base64'),
          requestId: 'portable-prepare-' + id + '-' + sha256(path).slice(0, 16),
        });
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
) {
  requireScope(p, 'knowledge:write');
  request(input);
  const stage = await portableStaging(config, db, limits.packageBytes);
  try {
    await safeExtract(input.archivePath, stage.directory);
    return await importPortableDirectory(config, db, notes, p, {
      directoryPath: stage.directory,
      folderPath: input.folderPath,
      requestId: input.requestId,
    });
  } finally {
    await stage.release();
  }
}
