import { resolveStorageAssetAlias } from '../storage-asset-aliases.js';
import { DOO_ASSETS_DIRECTORY, isCompatibleAssetPath, isDooAssetPath } from '../../../shared/storage-paths.js';
import { primaryRenderDescriptor } from '../../../shared/diagram-primary.js';
import { lstatSync, readFileSync } from 'node:fs';
import { join, posix } from 'node:path';
import type { AppConfig } from '../../../shared/contracts.js';
import { parseDiagramDocument } from '../../../shared/diagram-document.js';
import type { PreparedDiagramPrimary } from '../../../shared/diagram-primary.js';
import type { AppDatabase } from '../db.js';
import type { Principal } from '../../../shared/knowledge-contracts.js';
import { canAccessPath } from '../agent/auth.js';
import { isMissingSource, readDocument, safePath } from '../files.js';
import { localReference, references } from '../render.js';
import { rewriteLibraryReferences } from '../organization/references.js';
import { readBoundDiagramAsset } from './diagram-resource-files.js';
import { hasDiagramDeclarationSync } from './diagram-declaration.js';
import type { DiagramVersionManifest } from './diagram-publications.js';
import { captureNativeLinkProof } from './native-link-proof.js';
import { sha256 } from './operations.js';
import { fail } from './errors.js';
import type { DiagramArtifacts } from './diagram-artifacts.js';

type Move = { from: string; to: string };
export type DiagramRelocation = {
  noteId: string;
  path: string;
  documentHash: string;
  manifest: DiagramVersionManifest;
  originalPath: string;
  originalHash: string;
  originalResources: DiagramVersionManifest['resources'];
};
const inside = (root: string, path: string) => path === root || path.startsWith(root + '/');
export function relocatePath(path: string, moves: Move[]) {
  const move = moves
    .filter((m) => inside(m.from, path))
    .sort((a, b) => b.from.length - a.from.length)[0];
  return move ? move.to + path.slice(move.from.length) : path;
}

/** Freeze a current publication context without changing its source or render fingerprint. */
export function planDiagramRelocation(
  config: AppConfig,
  db: AppDatabase,
  noteId: string,
  before: string,
  after: string,
  from: string,
  to: string,
  moves: Move[],
  readAsset: typeof readBoundDiagramAsset = readBoundDiagramAsset,
  prepared?: PreparedDiagramPrimary,
): DiagramRelocation | undefined {
  const original = parseDiagramDocument(before),
    parsed = parseDiagramDocument(after);
  if (original.status !== 'diagram') return;
  if (parsed.status !== 'diagram' || parsed.type !== original.type)
    fail(409, 'DIAGRAM_PREVIEW_REQUIRED');
  if (!prepared && parsed.status === 'diagram') {
    const resources = [
      {
        role: 'preview' as const,
        path: localReference(to, parsed.primary.previewPath),
        hash: parsed.primary.binding.previewHash,
      },
      ...(parsed.primary.source.format === 'excalidraw'
        ? [
            {
              role: 'source' as const,
              path: localReference(to, parsed.primary.source.path),
              hash: parsed.primary.binding.sourceHash,
            },
          ]
        : []),
    ];
    const retained = db
      .prepare(
        'SELECT manifest FROM diagram_document_versions WHERE note_id=? AND document_hash=? AND path=?',
      )
      .get(noteId, sha256(after), to) as { manifest: string } | undefined;
    if (retained) {
      const manifest = JSON.parse(retained.manifest) as DiagramVersionManifest;
      if (
        manifest.type === parsed.type &&
        manifest.sourceHash === parsed.primary.binding.sourceHash &&
        manifest.renderHash === parsed.primary.binding.renderHash &&
        manifest.previewHash === parsed.primary.binding.previewHash &&
        resources.every(
          (r) =>
            r.path &&
            manifest.resources.some(
              (m) => m.role === r.role && m.path === r.path && m.hash === r.hash,
            ),
        )
      ) {
        const render = primaryRenderDescriptor(parsed),
          asset = (role: 'source' | 'preview') => {
            const r = resources.find((r) => r.role === role)!;
            return {
              id: 'retained-' + role,
              relativePath: r.path!,
              markdownPath: posix.relative(posix.dirname(to), r.path!),
              mime: role === 'preview' ? 'image/png' : 'application/vnd.excalidraw+json',
            };
          };
        prepared = {
          id: 'retained-' + sha256(after),
          noteId,
          type: parsed.type,
          documentHash: sha256(before),
          baselineSourceHash: original.primary.binding.sourceHash,
          ...parsed.primary.binding,
          title: parsed.title,
          renderer: render.renderer,
          config: render.config,
          preview: asset('preview'),
          ...(parsed.primary.source.format === 'excalidraw' ? { source: asset('source') } : {}),
          expiresAt: Number.MAX_SAFE_INTEGER,
        };
      }
    }
  }
  if (
    !prepared &&
    JSON.stringify(parsed.primary.binding) !== JSON.stringify(original.primary.binding)
  )
    fail(409, 'DIAGRAM_PREVIEW_REQUIRED');
  const binding = original.primary.binding;
  if (
    prepared &&
    (parsed.primary.binding.sourceHash !== prepared.sourceHash ||
      parsed.primary.binding.renderHash !== prepared.renderHash ||
      parsed.primary.binding.previewHash !== prepared.previewHash)
  )
    fail(409, 'DIAGRAM_PREPARATION_MISMATCH');
  const resources: DiagramVersionManifest['resources'] = [],
    oldResources: DiagramVersionManifest['resources'] = [];
  let nativeLinks: DiagramVersionManifest['nativeLinks'];
  const resource = (
    role: 'source' | 'preview',
    oldRelative: string,
    nextRelative: string,
    hash: string,
  ) => {
    const oldPath = localReference(from, oldRelative),
      path = localReference(to, nextRelative);
    if (!oldPath || !path || (!prepared && path !== relocatePath(oldPath, moves)))
      fail(409, 'DIAGRAM_ARTIFACT_CONFLICT');
    let bytes: Buffer;
    try {
      bytes = readAsset(config, oldPath, role);
    } catch {
      return fail(409, 'DIAGRAM_ARTIFACT_CONFLICT');
    }
    if (sha256(bytes) !== hash) fail(409, 'DIAGRAM_ARTIFACT_CONFLICT');
    if (
      !prepared &&
      role === 'source' &&
      rewriteLibraryReferences(bytes.toString('utf8'), oldPath, path, moves, true).changed
    )
      fail(
        409,
        'DIAGRAM_PREVIEW_REQUIRED',
        '移动需要更新原生链接和匹配预览，请先准备完整图形版本',
        false,
        {
          documents: [
            {
              noteId,
              role: 'primary',
              documentHash: sha256(before),
              sourceHash: binding.sourceHash,
              renderHash: binding.renderHash,
            },
          ],
        },
      );
    const nextHash = prepared
      ? role === 'source'
        ? prepared.sourceHash
        : prepared.previewHash
      : hash;
    if (prepared) {
      const asset = role === 'source' ? prepared.source : prepared.preview;
      if (!asset || asset.relativePath !== path) fail(409, 'DIAGRAM_PREPARATION_MISMATCH');
      const existingPath = relocatePath(
        path,
        moves.map((m) => ({ from: m.to, to: m.from })),
      );
      bytes = readAsset(config, existingPath, role);
      if (sha256(bytes) !== nextHash) fail(409, 'DIAGRAM_ARTIFACT_CONFLICT');
    }
    if (role === 'source')
      nativeLinks = captureNativeLinkProof(path, nextHash, bytes.toString('utf8'));
    resources.push({ role, path, hash: nextHash });
    oldResources.push({ role, path: oldPath, hash });
  };
  resource(
    'preview',
    original.primary.previewPath,
    parsed.primary.previewPath,
    binding.previewHash,
  );
  if (original.primary.source.format === 'excalidraw') {
    if (parsed.primary.source.format !== 'excalidraw') fail(409, 'DIAGRAM_ARTIFACT_CONFLICT');
    resource(
      'source',
      original.primary.source.path,
      parsed.primary.source.path,
      binding.sourceHash,
    );
  }
  // A directory operation cannot turn arbitrary external files into retained published proofs.
  const versions = db
    .prepare(
      'SELECT manifest FROM diagram_document_versions WHERE note_id=? AND document_hash=? AND path=?',
    )
    .all(noteId, sha256(before), from) as { manifest: string }[];
  if (
    !versions.some((v) => {
      const manifest = JSON.parse(v.manifest) as DiagramVersionManifest;
      return oldResources.every((r) =>
        manifest.resources.some((p) => p.role === r.role && p.path === r.path && p.hash === r.hash),
      );
    })
  )
    fail(409, 'DIAGRAM_ARTIFACT_CONFLICT');
  return {
    noteId,
    path: to,
    documentHash: sha256(after),
    originalPath: from,
    originalHash: sha256(before),
    originalResources: oldResources,
    manifest: {
      type: parsed.type,
      sourceHash: parsed.primary.binding.sourceHash,
      renderHash: parsed.primary.binding.renderHash,
      previewHash: parsed.primary.binding.previewHash,
      resources,
      ...(nativeLinks ? { nativeLinks } : {}),
    },
  };
}

export function verifyDiagramRelocations(
  config: AppConfig,
  plans: DiagramRelocation[],
  original = false,
) {
  for (const plan of plans) {
    if (
      sha256(
        readFileSync(
          safePath(config.knowledgeRoot, original ? plan.originalPath : plan.path, 'note'),
        ),
      ) !== (original ? plan.originalHash : plan.documentHash)
    )
      fail(409, 'DIAGRAM_ARTIFACT_CONFLICT');
    for (const resource of original ? plan.originalResources : plan.manifest.resources) {
      try {
        if (sha256(readBoundDiagramAsset(config, resource.path, resource.role)) !== resource.hash)
          throw Error();
      } catch {
        fail(409, 'DIAGRAM_ARTIFACT_CONFLICT');
      }
    }
  }
}
export function recordDiagramRelocations(db: AppDatabase, plans: DiagramRelocation[]) {
  for (const p of plans) {
    db.prepare(
      'INSERT OR IGNORE INTO diagram_document_versions(note_id,document_hash,path,document_type,source_hash,render_hash,preview_hash,manifest,created_at) VALUES(?,?,?,?,?,?,?,?,?)',
    ).run(
      p.noteId,
      p.documentHash,
      p.path,
      p.manifest.type,
      p.manifest.sourceHash,
      p.manifest.renderHash,
      p.manifest.previewHash,
      JSON.stringify(p.manifest),
      Date.now(),
    );
    db.prepare('UPDATE document_state SET document_type=? WHERE note_id=?').run(
      p.manifest.type,
      p.noteId,
    );
  }
}

/** Target moves can affect native assets outside every moved resource directory. */
export function assertNativeDiagramReferencesUnchanged(
  config: AppConfig,
  db: AppDatabase,
  principal: Principal,
  moves: Move[],
  excludeNoteId = '',
) {
  for (const row of db
    .prepare(
      "SELECT kind,result FROM operations WHERE kind LIKE 'diagram-artifacts:%' AND status='succeeded' AND result IS NOT NULL",
    )
    .all() as { kind: string; result: string }[]) {
    const p = JSON.parse(row.result) as DiagramArtifacts;
    const asset = db.prepare('SELECT path FROM assets WHERE id=?').get(p.source.id) as
      | { path: string }
      | undefined;
    if (!asset) continue;
    try {
      assertLegacyNativeLinks(config, asset.path, p.sourceHash, moves);
    } catch (error) {
      if ((error as { code?: string }).code === 'DIAGRAM_PREVIEW_REQUIRED') {
        const owner = db
          .prepare('SELECT path FROM notes WHERE id=?')
          .get(row.kind.slice('diagram-artifacts:'.length)) as { path: string } | undefined;
        if (!owner || !canAccessPath(principal, owner.path)) fail(403, 'DEPENDENCY_FORBIDDEN');
      }
      if (!isMissingSource(error)) throw error;
    }
  }
  const rows = db
    .prepare(
      'SELECT DISTINCT n.id,n.path FROM notes n JOIN diagram_document_versions v ON v.note_id=n.id AND v.path=n.path WHERE n.active=1 AND n.id<>?',
    )
    .all(excludeNoteId) as { id: string; path: string }[];
  for (const row of rows) {
    const file = safePath(config.knowledgeRoot, row.path, 'note');
    if (lstatSync(file).size > 20 * 1024 * 1024) fail(413, 'FILE_TOO_LARGE');
    const parsed = parseDiagramDocument(readFileSync(file, 'utf8'));
    if (parsed.status !== 'diagram' || parsed.primary.source.format !== 'excalidraw') continue;
    const path = localReference(row.path, parsed.primary.source.path);
    if (!path) fail(409, 'DIAGRAM_ARTIFACT_CONFLICT');
    const bytes = readBoundDiagramAsset(config, path, 'source');
    if (
      !rewriteLibraryReferences(
        bytes.toString('utf8'),
        path,
        relocatePath(path, moves),
        moves,
        true,
      ).changed
    )
      continue;
    if (!canAccessPath(principal, row.path)) fail(403, 'DEPENDENCY_FORBIDDEN');
    fail(409, 'DIAGRAM_PREVIEW_REQUIRED', '改名需要更新关联白板的原生链接和预览', false, {
      documents: [
        {
          noteId: row.id,
          role: 'primary',
          documentHash: sha256(readFileSync(file)),
          sourceHash: parsed.primary.binding.sourceHash,
          renderHash: parsed.primary.binding.renderHash,
        },
      ],
    });
  }
}

function assertLegacyNativeLinks(
  config: AppConfig,
  path: string,
  sourceHash: string,
  moves: Move[],
  readAsset: typeof readBoundDiagramAsset = readBoundDiagramAsset,
) {
  if (!moves.length || !path.endsWith('.excalidraw')) return;
  const bytes = readAsset(config, path, 'source');
  if (sha256(bytes) !== sourceHash) fail(409, 'DIAGRAM_ARTIFACT_CONFLICT');
  if (
    rewriteLibraryReferences(bytes.toString('utf8'), path, relocatePath(path, moves), moves, true)
      .changed
  )
    fail(409, 'DIAGRAM_PREVIEW_REQUIRED', '移动需要更新内嵌白板的原生链接和预览');
}

/** Do not hide resources held by other documents, retained versions or unfinished preparations. */
export function assertFolderDiagramResourcesUnshared(
  config: AppConfig,
  db: AppDatabase,
  path: string,
  checkActive = true,
  moves: Move[] = [],
  preserved: { path: string; hash: string }[] = [],
) {
  const retained = () =>
    fail(
      409,
      'DIAGRAM_RESOURCES_RETAINED',
      '目录资源仍被外部笔记、历史版本或图形准备引用，请先解除引用',
    );
  const notes = db.prepare('SELECT id,path,active FROM notes').all() as {
    id: string;
    path: string;
    active: number;
  }[];
  const own = new Set(notes.filter((n) => n.active && inside(path, n.path)).map((n) => n.id));
  for (const row of db.prepare('SELECT note_id,manifest FROM diagram_document_versions').all() as {
    note_id: string;
    manifest: string;
  }[])
    if (
      !own.has(row.note_id) &&
      (JSON.parse(row.manifest) as DiagramVersionManifest).resources.some(
        (r) =>
          inside(path, resolveStorageAssetAlias(config.knowledgeRoot, r.path)) && !preserved.some((p) => p.path === resolveStorageAssetAlias(config.knowledgeRoot, r.path) && p.hash === r.hash),
      )
    )
      retained();
  for (const row of db
    .prepare('SELECT result FROM diagram_prepared_primaries WHERE expires_at>?')
    .all(Date.now()) as { result: string }[]) {
    const p = JSON.parse(row.result) as PreparedDiagramPrimary;
    if (![p.preview, p.source].some((r) => r && inside(path, resolveStorageAssetAlias(config.knowledgeRoot, r.relativePath)))) continue;
    if (
      own.has(p.noteId) &&
      moves.length &&
      db.prepare("SELECT 1 FROM sqlite_master WHERE name='diagram_operation_previews'").get()
    ) {
      const lease = db
        .prepare(
          'SELECT snapshot FROM diagram_operation_previews WHERE prepared IS NOT NULL AND expires_at>?',
        )
        .all(Date.now()) as { snapshot: string }[];
      const planned = lease.some((row) => {
        const fixed = JSON.parse(
          row.snapshot,
        ) as import('./diagram-operation-previews.js').FixedDiagramSnapshot;
        return (
          fixed.input.noteId === p.noteId &&
          JSON.stringify(fixed.input.moves) ===
            JSON.stringify(moves.map(({ from, to }) => ({ from, to }))) &&
          fixed.sourceHash === p.sourceHash &&
          fixed.renderHash === p.renderHash
        );
      });
      if (planned) continue;
    }
    if (p.creationIntentId) {
      const creation = db
        .prepare('SELECT status FROM diagram_creation_intents WHERE id=?')
        .get(p.creationIntentId) as { status: string } | undefined;
      if (creation?.status === 'published') continue;
      if (creation?.status === 'cancelled' || creation?.status === 'expired') continue;
      retained();
    }
    if (
      !db
        .prepare(
          'SELECT 1 FROM diagram_document_versions WHERE note_id=? AND source_hash=? AND render_hash=? AND preview_hash=?',
        )
        .get(p.noteId, p.sourceHash, p.renderHash, p.previewHash)
    )
      retained();
  }
  assertLegacyArtifactPreparations(config, db, path, moves);
  const assets = (db.prepare('SELECT path FROM assets').all() as { path: string }[]).filter((a) =>
    inside(path, a.path),
  );
  if (!assets.length || !checkActive) return;
  const referencesResource = (notePath: string, url: string) => {
    const target = localReference(notePath, url);
    return target && inside(path, target) && isCompatibleAssetPath(target);
  };
  const assetNames = new Set(assets.map((a) => a.path.split('/').at(-1)));
  const ambiguousHistoricalResource = (url: string) => {
    try {
      const raw = decodeURIComponent(url.split(/[?#]/)[0]);
      return (
        !raw.startsWith('/') &&
        !raw.includes('\\') &&
        !/^[a-z][a-z\d+.-]*:/i.test(raw) &&
        isCompatibleAssetPath(raw) &&
        assetNames.has(raw.split('/').at(-1))
      );
    } catch {
      return false;
    }
  };
  for (const revision of db
    .prepare('SELECT r.note_id,r.file,n.path FROM revisions r JOIN notes n ON n.id=r.note_id')
    .all() as { note_id: string; file: string; path: string }[]) {
    if (own.has(revision.note_id)) continue;
    if (!/^[a-zA-Z0-9-]+\.md$/.test(revision.file)) retained();
    let content: string;
    try {
      content = readDocument(join(config.dataRoot, 'history'), revision.file, {
        allowDiagramLarge: true,
      }).content;
    } catch {
      retained();
    }
    // Old revisions have no stored logical directory. A matching resource name is
    // an unresolved retention root; never guess that a moved note released it.
    if (
      references(content!).some(
        (url) => referencesResource(revision.path, url) || ambiguousHistoricalResource(url),
      )
    )
      retained();
  }
  for (const n of db
    .prepare('SELECT id,path,active,trash_path FROM notes WHERE active=1 OR trash_path IS NOT NULL')
    .all() as {
    id: string;
    path: string;
    active: number;
    trash_path: string | null;
  }[]) {
    if (own.has(n.id)) continue;
    let content: string;
    try {
      content = n.active
        ? readDocument(config.knowledgeRoot, n.path, { allowDiagramLarge: true }).content
        : readDocument(
            safePath(join(config.knowledgeRoot, '90-Archive/.trash'), n.id, 'folder'),
            n.trash_path!,
            { allowDiagramLarge: true },
          ).content;
    } catch {
      retained();
    }
    if (references(content!).some((url) => referencesResource(n.path, url))) retained();
  }
  for (const folder of db
    .prepare("SELECT id,path,notes_json FROM folder_trash WHERE state='trashed'")
    .all() as { id: string; path: string; notes_json: string }[]) {
    if (!/^folder-[a-f0-9-]{36}$/.test(folder.id)) retained();
    const tree = join(config.knowledgeRoot, '90-Archive/.trash', folder.id, 'tree');
    for (const note of JSON.parse(folder.notes_json) as { path: string }[]) {
      if (!note.path.startsWith(folder.path + '/')) retained();
      let content: string;
      try {
        content = readDocument(tree, note.path.slice(folder.path.length + 1), {
          allowDiagramLarge: true,
        }).content;
      } catch {
        retained();
      }
      if (references(content!).some((url) => referencesResource(note.path, url))) retained();
    }
  }
}

/** Old receipts have no expiry/cancel protocol. Saved resource pairs consume the
 * preparation; a historical consumed receipt must not prohibit every future move. */
function assertLegacyArtifactPreparations(
  config: AppConfig,
  db: AppDatabase,
  root: string,
  moves: Move[],
  load = (path: string) =>
    readDocument(config.knowledgeRoot, path, { allowDiagramLarge: true }).content,
  readAsset: typeof readBoundDiagramAsset = readBoundDiagramAsset,
  restoring = new Set<string>(),
) {
  for (const row of db
    .prepare(
      "SELECT kind,result FROM operations WHERE kind LIKE 'diagram-artifacts:%' AND status IN ('prepared','succeeded')",
    )
    .all() as { kind: string; result: string | null }[]) {
    const noteId = row.kind.slice('diagram-artifacts:'.length);
    const note = db.prepare('SELECT path,active FROM notes WHERE id=?').get(noteId) as
      | { path: string; active: number }
      | undefined;
    if (!note) continue;
    if (!row.result) {
      if ((note.active || restoring.has(noteId)) && inside(root, note.path))
        fail(409, 'DIAGRAM_RESOURCES_RETAINED');
      continue;
    }
    const prepared = JSON.parse(row.result) as DiagramArtifacts;
    const currentSource =
      (
        db.prepare('SELECT path FROM assets WHERE id=?').get(prepared.source.id) as
          | { path: string }
          | undefined
      )?.path ?? prepared.source.relativePath;
    const currentPreview =
      (
        db.prepare('SELECT path FROM assets WHERE id=?').get(prepared.preview.id) as
          | { path: string }
          | undefined
      )?.path ?? prepared.preview.relativePath;
    if (![currentSource, currentPreview].some((path) => inside(root, path))) continue;
    const pair = (body: string, path: string) => {
      const targets = new Set(references(body).map((url) => localReference(path, url)));
      return (
        (targets.has(currentSource) && targets.has(currentPreview)) ||
        (targets.has(prepared.source.relativePath) && targets.has(prepared.preview.relativePath))
      );
    };
    let consumed = false;
    try {
      consumed = pair(load(note.path), note.path);
    } catch {
      /* Recoverable history can prove consumption. */
    }
    if (!consumed)
      for (const history of db.prepare('SELECT * FROM revisions WHERE note_id=?').all(noteId) as {
        file: string;
        content_hash?: string;
        references_manifest?: string;
      }[]) {
        if (!/^[a-zA-Z0-9-]+\.md$/.test(history.file)) continue;
        try {
          // Typed reference inventories preserve exact asset identities for ordinary
          // large Markdown whose source reader intentionally requires large-file mode.
          if (history.references_manifest && history.content_hash) {
            const proof = JSON.parse(history.references_manifest) as {
              version: number;
              complete: boolean;
              items: { assetId?: string; hash?: string }[];
            };
            const file = safePath(join(config.dataRoot, 'history'), history.file, 'note'),
              stamp = lstatSync(file);
            if (
              proof.version === 1 &&
              proof.complete === true &&
              Array.isArray(proof.items) &&
              stamp.isFile() &&
              stamp.nlink === 1 &&
              stamp.size <= 20 * 1024 * 1024 &&
              sha256(readFileSync(file)) === history.content_hash &&
              proof.items.some(
                (r) => r.assetId === prepared.source.id && r.hash === prepared.sourceHash,
              ) &&
              proof.items.some(
                (r) =>
                  r.assetId === prepared.preview.id &&
                  r.hash === sha256(readAsset(config, currentPreview, 'preview')),
              )
            ) {
              consumed = true;
              break;
            }
          }
          const body = readDocument(join(config.dataRoot, 'history'), history.file, {
            allowDiagramLarge: true,
          }).content;
          const originalContext = posix.join(
            posix.dirname(posix.dirname(prepared.source.relativePath)),
            'receipt.md',
          );
          if (pair(body, note.path) || pair(body, originalContext)) {
            consumed = true;
            break;
          }
        } catch {
          /* Missing history grants no consumption proof. */
        }
      }
    if (!consumed && (note.active || restoring.has(noteId)))
      fail(409, 'DIAGRAM_RESOURCES_RETAINED');
    try {
      if (sha256(readAsset(config, currentSource, 'source')) !== prepared.sourceHash)
        fail(409, 'DIAGRAM_ARTIFACT_CONFLICT');
    } catch (error) {
      if (isMissingSource(error)) fail(409, 'DIAGRAM_ARTIFACT_CONFLICT');
      throw error;
    }
  }
}

export function planFolderDiagramRestore(
  config: AppConfig,
  db: AppDatabase,
  notes: { id: string; path: string }[],
  from: string,
  to: string,
  physicalRoot: string,
) {
  const plans: DiagramRelocation[] = [],
    moves = [{ from, to }];
  const asset: typeof readBoundDiagramAsset = (cfg, path, role) =>
    inside(from, path)
      ? readBoundDiagramAsset(
          { ...cfg, knowledgeRoot: physicalRoot },
          path.slice(from.length + 1),
          role,
        )
      : readBoundDiagramAsset(cfg, path, role);
  if (from !== to)
    assertLegacyArtifactPreparations(
      config,
      db,
      from,
      moves,
      (path) =>
        inside(from, path)
          ? readDocument(physicalRoot, path.slice(from.length + 1), { allowDiagramLarge: true })
              .content
          : readDocument(config.knowledgeRoot, path, { allowDiagramLarge: true }).content,
      asset,
      new Set(notes.map((note) => note.id)),
    );
  for (const note of notes) {
    const relative = note.path.slice(from.length + 1),
      file = join(physicalRoot, relative);
    const protectedPrimary = db
      .prepare('SELECT 1 FROM diagram_document_versions WHERE note_id=? AND path=?')
      .get(note.id, note.path);
    if (!hasDiagramDeclarationSync(file)) {
      if (protectedPrimary) fail(409, 'DIAGRAM_ARTIFACT_CONFLICT');
      continue;
    }
    if (lstatSync(file).size > 20 * 1024 * 1024) fail(413, 'FILE_TOO_LARGE');
    const content = readFileSync(file, 'utf8'),
      target = relocatePath(note.path, moves);
    const rewrite = rewriteLibraryReferences(content, note.path, target, moves);
    if (rewrite.changed)
      fail(
        409,
        'RELATIVE_REFERENCES_REQUIRE_REVIEW',
        '恢复目录需要调整外部相对链接，请保留回收站并核对恢复位置',
      );
    const plan = planDiagramRelocation(
      config,
      db,
      note.id,
      content,
      content,
      note.path,
      target,
      moves,
      asset,
    );
    if (!plan && protectedPrimary) fail(409, 'DIAGRAM_ARTIFACT_CONFLICT');
    if (plan) plans.push(plan);
  }
  return plans;
}
