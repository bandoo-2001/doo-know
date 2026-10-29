import { basename, dirname, posix } from 'node:path';
import { lstatSync } from 'node:fs';
import { join } from 'node:path';
import { knowledgeToolByName } from '../../../shared/mcp-knowledge-tools.js';
import type { Principal } from '../../../shared/knowledge-contracts.js';
import type { McpManagedDomainPort, McpTransferBinding } from '../../../shared/mcp-domain-tools.js';
import type { ServiceCallOptions } from '../../../packages/plugin-sdk/index.js';
import type { McpDomainContext } from './mcp-domain-context.js';
import { authorizePath, requireScope } from '../../../packages/core/agent/auth.js';
import { signCursor, decodeCursor, acquireRead } from '../../../packages/core/agent/budgets.js';
import {
  beginOperation,
  completeOperation,
  existingResult,
  sha256,
} from '../../../packages/core/knowledge/operations.js';
import { fail } from '../../../packages/core/knowledge/errors.js';
import {
  lifecyclePrincipal,
  authorizeFolderPath,
} from '../../../packages/core/knowledge/lifecycle-access.js';
import { backlinkService } from '../../../packages/core/knowledge/backlinks.js';
import { diagramArtifactService } from '../../../packages/core/knowledge/diagram-artifacts.js';
import { archiveFolder, restoreFolder } from '../../../packages/core/folders.js';
import {
  resolveDirectory,
  syncDirectoryCatalog,
} from '../../../packages/core/organization/catalog.js';
import {
  readOrganizationSettings,
  updateOrganizationSettings,
} from '../../../packages/core/organization/settings.js';
import { workspaceExclusive, workspaceWriteSync } from '../../../packages/core/workspace/gate.js';
import { readBlocks } from '../../../packages/core/knowledge/file-reader.js';
import { localReference } from '../../../packages/core/render.js';
import { isWhiteboard, whiteboardId, whiteboardReference } from '../../../shared/whiteboard.js';
import { canAccessPath } from '../../../packages/core/auth/permissions.js';
import { conflictService } from '../../../packages/core/knowledge/conflicts.js';
import { findOperation } from '../../../packages/core/knowledge/operations.js';
import { createKnowledgeBundlePort, knowledgeBundleToolNames } from './knowledge-bundles.js';
import { safePath } from '../../../packages/core/files.js';
import { mcpResultFrameSize, mcpMaximumFrameBytes } from '../../../shared/mcp-frame.js';

/** All business calls share the host's live authorization and normal services.
 * No browser owner identity or arbitrary path/file reader is used here. */
export function createKnowledgeToolPort(context: McpDomainContext): McpManagedDomainPort {
  const { db, runtime, config, transfers } = context,
    k = runtime.knowledge;
  db.exec(
    'CREATE TABLE IF NOT EXISTS mcp_knowledge_operation_bindings(operation_id TEXT PRIMARY KEY REFERENCES operations(id),binding TEXT NOT NULL)',
  );
  const identity = (p: Principal) =>
    sha256(
      JSON.stringify([
        p.id,
        p.clientId,
        p.knowledgeAll,
        p.allowedPrefixes,
        p.knowledgeResourcePaths,
        p.permissionPolicy,
        p.permissionCeiling,
      ]),
    );
  function note(p: Principal, noteId: string, scope = 'knowledge:read') {
    const n = runtime.notes.row(noteId);
    authorizePath(p, n.path, scope);
    return n;
  }
  function lifecycle(p: Principal, id: string) {
    const n = runtime.notes.row(id, true);
    return { n, p: lifecyclePrincipal(db, p, 'note', id, n.path) };
  }
  function archivedFolder(p: Principal, folderId: string) {
    const row = db.prepare('SELECT * FROM folder_trash WHERE id=?').get(folderId) as any;
    if (!row) fail(404, 'NOT_FOUND');
    let effective = p;
    try {
      authorizeFolderPath(p, row.path);
    } catch {
      const dir = db
        .prepare("SELECT id FROM organization_directories WHERE dev||':'||ino=? LIMIT 1")
        .get(row.identity) as any;
      if (!dir) fail(403, 'FORBIDDEN');
      effective = lifecyclePrincipal(db, p, 'directory', dir.id, row.path);
    }
    return { row, p: effective };
  }
  function paged(
    p: Principal,
    kind: string,
    rows: any[],
    args: any,
    extra: Record<string, unknown> = {},
  ) {
    const revision = sha256(JSON.stringify(rows)),
      scope = identity(p);
    let offset = 0;
    if (args.cursor) {
      const c = decodeCursor(config.secret, args.cursor);
      if (
        c.kind !== kind ||
        c.scope !== scope ||
        c.revision !== revision ||
        !Number.isSafeInteger(c.offset) ||
        c.offset < 0 ||
        c.offset > rows.length
      )
        fail(400, 'INVALID_CURSOR');
      offset = c.offset;
    }
    const items = rows.slice(offset, offset + args.limit);
    const output = () => ({
      ...extra,
      items,
      ...(offset + items.length < rows.length
        ? {
            nextCursor: signCursor(config.secret, {
              kind,
              scope,
              revision,
              offset: offset + items.length,
            }),
          }
        : {}),
    });
    while (items.length && mcpResultFrameSize({ data: output() }) > mcpMaximumFrameBytes)
      items.pop();
    if (!items.length && offset < rows.length) fail(413, 'RESPONSE_TOO_LARGE');
    return output();
  }
  function binding(a: any, extra?: Record<string, unknown>) {
    return (
      extra ||
      Object.fromEntries(
        ['noteId', 'folderId', 'directoryId'].filter((key) => a[key]).map((key) => [key, a[key]]),
      )
    );
  }
  function remember(operationId: string, a: any, extra?: Record<string, unknown>) {
    db.prepare('INSERT OR IGNORE INTO mcp_knowledge_operation_bindings VALUES(?,?)').run(
      operationId,
      JSON.stringify(binding(a, extra)),
    );
  }
  function receipt(
    p: Principal,
    kind: string,
    a: any,
    work: () => Record<string, unknown>,
    extra?: Record<string, unknown>,
  ) {
    return workspaceWriteSync(db, { kind: 'mcp.' + kind }, () =>
      db
        .transaction(() => {
          const op = beginOperation(db, p, 'knowledge.' + kind, a.requestId, a);
          remember(op.operation.id, a, extra);
          if (!op.fresh) return existingResult(op.operation);
          const result = work();
          completeOperation(db, op.operation.id, result);
          return result;
        })
        .immediate(),
    );
  }
  async function checkVersion(
    p: Principal,
    noteId: string,
    expected: string,
    reauthorize: () => Principal,
  ) {
    note(p, noteId);
    const info = await k.info(p, noteId);
    note(reauthorize(), noteId);
    if (info.modifiedAt !== expected) fail(409, 'VERSION_CONFLICT');
    assertSourceVersion(reauthorize(), noteId, expected);
    return info;
  }
  function assertSourceVersion(p: Principal, noteId: string, expected: string) {
    const n = note(p, noteId),
      stat = lstatSync(safePath(config.knowledgeRoot, n.path, 'note'), { bigint: true });
    if (!stat.isFile() || stat.nlink !== 1n || stat.mtimeNs.toString() !== expected)
      fail(409, 'VERSION_CONFLICT');
  }
  function replay(p: Principal, kind: string, a: any) {
    const old = db
      .prepare(
        "SELECT * FROM operations WHERE principal=? AND client_id=? AND kind=? AND request_id=? AND status='succeeded'",
      )
      .get(p.id, p.clientId, 'knowledge.' + kind, a.requestId) as any;
    if (!old) return undefined;
    beginOperation(db, p, 'knowledge.' + kind, a.requestId, a);
    const bindingRow = db
      .prepare('SELECT binding FROM mcp_knowledge_operation_bindings WHERE operation_id=?')
      .get(old.id) as { binding: string } | undefined;
    const binding = bindingRow && JSON.parse(bindingRow.binding),
      result = existingResult(old);
    if (binding?.noteId) note(p, binding.noteId, 'knowledge:write');
    else if (kind === 'document-upload' && result.id) note(p, result.id, 'knowledge:write');
    else fail(403, 'FORBIDDEN');
    return result;
  }
  function authorizeTransfer(
    binding: McpTransferBinding,
    write: boolean,
    options?: ServiceCallOptions,
  ) {
    if (binding.kind === 'bundle-import' || binding.kind === 'bundle-export')
      return bundles.authorizeTransfer(binding, write, options);
    if (binding.domain !== 'knowledge') fail(403, 'FORBIDDEN');
    if (
      ![
        'asset-upload',
        'asset-download',
        'document-create',
        'document-update',
        'document-download',
      ].includes(binding.kind)
    )
      fail(403, 'FORBIDDEN');
    const upload = ['asset-upload', 'document-create', 'document-update'].includes(binding.kind);
    if (write && !upload) fail(403, 'FORBIDDEN');
    const p = context.authorize(
      ['knowledge:read', ...(upload ? ['knowledge:write'] : [])],
      options,
    );
    if (binding.kind === 'document-create') authorizePath(p, binding.id, 'knowledge:write');
    else {
      const n = note(p, binding.id, upload ? 'knowledge:write' : 'knowledge:read');
      if (
        !upload &&
        binding.revision &&
        lstatSync(safePath(config.knowledgeRoot, n.path, 'note'), {
          bigint: true,
        }).mtimeNs.toString() !== binding.revision
      )
        fail(409, 'STALE_CURSOR');
    }
    return p;
  }
  async function permittedAsset(p: Principal, noteId: string, assetId: string) {
    const n = note(p, noteId),
      row = db.prepare('SELECT path FROM assets WHERE id=?').get(assetId) as
        | { path: string }
        | undefined;
    if (!row) fail(404, 'NOT_FOUND');
    // Directory grants manage their asset bucket. A selected note can only
    // download sources referenced by that note or uploaded for that note.
    const uploaded = db
      .prepare(
        "SELECT 1 FROM operations WHERE principal=? AND client_id=? AND kind='knowledge.asset-upload' AND json_extract(result,'$.id')=? AND json_extract(result,'$.noteId')=?",
      )
      .get(p.id, p.clientId, assetId, noteId);
    const prepared = db
      .prepare(
        "SELECT 1 FROM operations o JOIN mcp_knowledge_operation_bindings b ON b.operation_id=o.id WHERE o.principal=? AND o.client_id=? AND o.kind='knowledge.diagram' AND o.status='succeeded' AND json_extract(b.binding,'$.noteId')=? AND (json_extract(o.result,'$.source.id')=? OR json_extract(o.result,'$.preview.id')=?)",
      )
      .get(p.id, p.clientId, noteId, assetId, assetId);
    if (!canAccessPath(p, row.path) && !uploaded && !prepared)
      return runtime.assets.publicAsset(n.id, assetId);
    return runtime.assets.byId(assetId);
  }
  async function call(
    name: string,
    input: unknown,
    options?: ServiceCallOptions,
  ): Promise<Record<string, unknown>> {
    const def = knowledgeToolByName.get(name);
    if (!def) fail(404, 'UNKNOWN_TOOL');
    const parsed = def.input.safeParse(input);
    if (!parsed.success) fail(400, 'INVALID_INPUT');
    const a: any = parsed.data;
    let p = context.authorize(def.scopes, options);
    const revalidate = () => context.authorize(def.scopes, options);
    let result: any;
    if (knowledgeBundleToolNames.has(name)) result = await bundles.call(name, a, options);
    else if (name === 'list_note_revisions') {
      note(p, a.noteId);
      const rows = db
        .prepare(
          'SELECT id,file,created_at AS createdAt,modified_at AS modifiedAt FROM revisions WHERE note_id=? ORDER BY rowid DESC',
        )
        .all(a.noteId) as any[];
      result = paged(
        p,
        name,
        rows.map((r) => {
          if (!/^[A-Za-z0-9-]+\.md$/.test(r.file)) fail(404, 'REVISION_NOT_FOUND');
          const st = lstatSync(join(config.dataRoot, 'history', r.file));
          if (!st.isFile() || st.isSymbolicLink() || st.nlink !== 1)
            fail(404, 'REVISION_NOT_FOUND');
          return { id: r.id, createdAt: r.createdAt, modifiedAt: r.modifiedAt, sizeBytes: st.size };
        }),
        a,
      );
    } else if (name === 'read_note_revision') {
      note(p, a.noteId);
      const { noteId, revisionId, ...read } = a;
      result = await k.snapshots.read(p, noteId + '@' + revisionId, read, 'mcp');
    } else if (name === 'restore_note_revision') {
      note(p, a.noteId, 'knowledge:write');
      result = await k.files.restore(p, a.noteId, a.revisionId, a.expectedModifiedAt, a.requestId);
    } else if (name === 'list_archived_notes') {
      const rows = (
        db
          .prepare(
            'SELECT id,path AS relativePath FROM notes WHERE active=0 AND trash_path IS NOT NULL ORDER BY path,id',
          )
          .all() as any[]
      ).filter((r) => {
        try {
          lifecycle(p, r.id);
          return true;
        } catch {
          return false;
        }
      });
      result = paged(p, name, rows, a);
    } else if (name === 'restore_archived_note') {
      const access = lifecycle(p, a.noteId);
      result = k.core.restore(access.p, a.noteId, a.fileName, a.requestId);
    } else if (name === 'archive_note_folder') {
      // Recover the original request before resolving a directory which is now inactive.
      const old = db
        .prepare(
          "SELECT * FROM operations WHERE principal=? AND client_id=? AND kind='knowledge.archive-folder' AND request_id=?",
        )
        .get(p.id, p.clientId, a.requestId) as any;
      if (old) {
        const prior = beginOperation(db, p, 'knowledge.archive-folder', a.requestId, a);
        let row = JSON.parse(old.result || 'null');
        if (!row) {
          const core = db
            .prepare(
              "SELECT * FROM operations WHERE principal=? AND client_id=? AND kind='folder.archive' AND request_id=?",
            )
            .get(p.id, p.clientId, a.requestId) as any;
          if (!core) fail(409, 'OPERATION_OUTCOME_UNKNOWN');
          row = existingResult(core);
          archivedFolder(p, row.id);
          completeOperation(db, prior.operation.id, row);
        }
        archivedFolder(p, row.id);
        result = row;
      } else {
        syncDirectoryCatalog(config, db);
        const dir = resolveDirectory(db, a.directoryId);
        if (!dir) fail(404, 'DIRECTORY_NOT_FOUND');
        authorizeFolderPath(p, dir.path, 'knowledge:write');
        if (dir.subtreeRevision !== a.expectedSubtreeRevision) fail(409, 'VERSION_CONFLICT');
        result = await workspaceExclusive(db, { kind: 'mcp.folder.archive' }, async () => {
          syncDirectoryCatalog(config, db);
          const current = resolveDirectory(db, a.directoryId);
          if (!current || current.subtreeRevision !== a.expectedSubtreeRevision)
            fail(409, 'VERSION_CONFLICT');
          const op = db
            .transaction(() => beginOperation(db, p, 'knowledge.archive-folder', a.requestId, a))
            .immediate();
          remember(op.operation.id, a);
          const r = archiveFolder(
            config,
            db,
            dir.path,
            a.requestId,
            () => runtime.notes.scan(),
            p,
            revalidate,
          );
          db.transaction(() => completeOperation(db, op.operation.id, r)).immediate();
          return r;
        });
      }
    } else if (name === 'list_archived_folders') {
      const rows = (
        db
          .prepare(
            "SELECT id,path AS relativePath,deleted_at AS deletedAt,notes_json FROM folder_trash WHERE state='trashed' ORDER BY deleted_at DESC,id",
          )
          .all() as any[]
      )
        .filter((r) => {
          try {
            archivedFolder(p, r.id);
            return true;
          } catch {
            return false;
          }
        })
        .map(({ notes_json, ...r }) => ({ ...r, noteCount: JSON.parse(notes_json).length }));
      result = paged(p, name, rows, a);
    } else if (name === 'restore_archived_folder') {
      const access = archivedFolder(p, a.folderId);
      const leaf = a.name || basename(access.row.path),
        target = dirname(access.row.path) === '.' ? leaf : dirname(access.row.path) + '/' + leaf;
      const refs =
        access.p.knowledgeResourcePaths?.filter(
          (r) => r.kind === 'directory' && r.path === access.row.path,
        ) || [];
      if (refs.length)
        access.p = {
          ...access.p,
          allowedPrefixes: [...access.p.allowedPrefixes, target],
          knowledgeResourcePaths: [
            ...(access.p.knowledgeResourcePaths || []),
            ...refs.map((r) => ({ ...r, path: target })),
          ],
        };
      authorizeFolderPath(access.p, target, 'knowledge:write');
      result = await workspaceExclusive(db, { kind: 'mcp.folder.restore' }, async () =>
        restoreFolder(config, db, a.folderId, a.name, a.requestId, access.p, () => {
          const fresh = archivedFolder(revalidate(), a.folderId).p;
          return {
            ...fresh,
            allowedPrefixes: access.p.allowedPrefixes,
            knowledgeResourcePaths: access.p.knowledgeResourcePaths,
          };
        }),
      );
    } else if (name === 'get_note_backlinks')
      result = backlinkService(config, db, runtime.notes, p, 3).page(a.noteId, a.cursor);
    else if (name === 'list_note_collection')
      result = await runtime.collections.page(p.ownerId || p.id, a, p, revalidate);
    else if (name === 'get_note_collection_status')
      result = runtime.collections.status(p.ownerId || p.id, a.kind, p);
    else if (name === 'set_note_favorite') {
      note(p, a.noteId);
      result = receipt(p, 'favorite', a, () => {
        note(revalidate(), a.noteId);
        return runtime.notes.setFavorite(p.ownerId || p.id, a.noteId, a.favorite);
      });
    } else if (name === 'list_note_assets') {
      const n = note(p, a.noteId),
        items = [];
      const uploaded = new Set(
        (
          db
            .prepare(
              "SELECT json_extract(result,'$.relativePath') AS path FROM operations WHERE principal=? AND client_id=? AND kind='knowledge.asset-upload' AND status='succeeded' AND json_extract(result,'$.noteId')=?",
            )
            .all(p.id, p.clientId, a.noteId) as { path: string }[]
        ).map((r) => r.path),
      );
      for (const row of db
        .prepare(
          "SELECT json_extract(o.result,'$.source.relativePath') AS source,json_extract(o.result,'$.preview.relativePath') AS preview FROM operations o JOIN mcp_knowledge_operation_bindings b ON b.operation_id=o.id WHERE o.principal=? AND o.client_id=? AND o.kind='knowledge.diagram' AND o.status='succeeded' AND json_extract(b.binding,'$.noteId')=?",
        )
        .all(p.id, p.clientId, a.noteId) as { source: string; preview: string }[]) {
        uploaded.add(row.source);
        uploaded.add(row.preview);
      }
      for (const path of runtime.assets.candidatePaths(a.noteId)) {
        try {
          const fresh = revalidate();
          note(fresh, a.noteId);
          if (!canAccessPath(fresh, path) && !uploaded.has(path))
            await runtime.assets.publicSource(
              a.noteId,
              posix.relative(posix.dirname(n.path), path),
            );
          note(revalidate(), a.noteId);
          items.push(runtime.assets.register(path));
        } catch {}
      }
      result = paged(p, name + ':' + a.noteId, items, a);
    } else if (name === 'begin_note_asset_upload') {
      await checkVersion(p, a.noteId, a.expectedModifiedAt, revalidate);
      result = transfers.beginUpload(revalidate(), {
        ...a,
        binding: {
          domain: 'knowledge',
          kind: 'asset-upload',
          id: a.noteId,
          revision: a.expectedModifiedAt,
        },
      });
    } else if (name === 'complete_note_asset_upload') {
      const prior = replay(p, 'asset-upload', a);
      if (prior) {
        const { noteId, ...saved } = prior;
        result = saved;
      } else {
        const info = transfers.info(p, a.transferId);
        p = authorizeTransfer(info.binding, true, options);
        if (info.binding.kind !== 'asset-upload') fail(403, 'FORBIDDEN');
        const claim = 'asset-' + sha256(a.requestId),
          uploaded = transfers.readUpload(p, a.transferId, undefined, claim);
        const n = info.binding.id;
        result = await receiptAsync(
          p,
          'asset-upload',
          a,
          async () => {
            await checkVersion(revalidate(), n, info.binding.revision!, revalidate);
            const saved = workspaceWriteSync(db, { kind: 'mcp.asset.commit' }, () => {
              assertSourceVersion(revalidate(), n, info.binding.revision!);
              return runtime.assets.upload(
                n,
                uploaded.name,
                uploaded.mime,
                uploaded.bytes,
                'mcp-' + sha256(p.id + '\0' + p.clientId + '\0' + a.requestId),
              );
            });
            return { ...saved, noteId: n };
          },
          { noteId: n },
        );
        transfers.complete(p, a.transferId, claim, result);
        const { noteId, ...saved } = result;
        result = saved;
      }
    } else if (name === 'download_note_asset') {
      const info = await k.info(p, a.noteId),
        asset = await permittedAsset(revalidate(), a.noteId, a.assetId);
      note(revalidate(), a.noteId);
      if (
        lstatSync(safePath(config.knowledgeRoot, info.relativePath, 'note'), {
          bigint: true,
        }).mtimeNs.toString() !== info.modifiedAt
      )
        fail(409, 'STALE_CURSOR');
      result = transfers.createDownload(p, {
        requestId: a.requestId,
        binding: {
          domain: 'knowledge',
          kind: 'asset-download',
          id: a.noteId,
          revision: info.modifiedAt,
          metadata: { assetId: a.assetId },
        },
        name: basename(asset.path),
        mime: asset.mime,
        bytes: a.source ? asset.sourceBytes || asset.bytes : asset.bytes,
      });
    } else if (name === 'prepare_note_diagram') {
      note(p, a.noteId, 'knowledge:write');
      const prior = replay(p, 'diagram', a);
      if (prior) result = prior;
      else {
        const expected = {
          domain: 'knowledge' as const,
          kind: 'asset-upload',
          id: a.noteId,
          revision: a.expectedModifiedAt,
        };
        const claim = 'diagram-' + sha256(a.requestId);
        const { source, preview } = db
          .transaction(() => ({
            source: transfers.readUpload(p, a.sourceTransferId, expected, claim),
            preview: transfers.readUpload(p, a.previewTransferId, expected, claim),
          }))
          .immediate();
        result = await receiptAsync(p, 'diagram', a, async () => {
          await checkVersion(revalidate(), a.noteId, a.expectedModifiedAt, revalidate);
          return workspaceWriteSync(db, { kind: 'mcp.diagram.commit' }, () => {
            assertSourceVersion(revalidate(), a.noteId, a.expectedModifiedAt);
            return diagramArtifactService(db, runtime.notes, runtime.assets, revalidate()).prepare(
              a.noteId,
              {
                kind: a.kind,
                source: source.bytes.toString('utf8'),
                sourceHash: a.sourceHash,
                pngBase64: preview.bytes.toString('base64'),
                requestId: 'mcp-' + sha256(a.requestId),
              },
            );
          });
        });
        const compact = {
          sourceHash: result.sourceHash,
          sourceId: result.source.id,
          previewId: result.preview.id,
        };
        transfers.complete(p, a.sourceTransferId, claim, compact);
        transfers.complete(p, a.previewTransferId, claim, compact);
      }
    } else if (name === 'resolve_note_whiteboard') {
      const parent = note(p, a.noteId),
        ref = whiteboardReference(a.source);
      if (!ref) fail(404, 'NOT_FOUND');
      const targetId =
        whiteboardId(ref) ||
        (
          db
            .prepare('SELECT id FROM notes WHERE active=1 AND path=?')
            .get(localReference(parent.path, ref)) as any
        )?.id;
      if (!targetId) fail(404, 'NOT_FOUND');
      const target = note(p, targetId);
      if (!isWhiteboard(target.path)) fail(404, 'NOT_FOUND');
      const info = await k.info(p, targetId);
      note(revalidate(), targetId);
      note(revalidate(), a.noteId);
      result = {
        id: targetId,
        relativePath: target.path,
        modifiedAt: info.modifiedAt,
        contentHash: info.contentHash,
        documentType: 'whiteboard',
      };
    } else if (name === 'begin_note_document_upload') {
      if (a.noteId) {
        const info = await checkVersion(p, a.noteId, a.expectedModifiedAt, revalidate);
        if (basename(info.relativePath) !== a.name) fail(400, 'INVALID_INPUT');
      }
      const target = a.noteId || (a.directory ? a.directory + '/' : '') + a.name;
      if (!a.noteId && target.length > 2048) fail(400, 'INVALID_PATH');
      if (!a.noteId) authorizePath(p, target, 'knowledge:write');
      if (
        !/\.(md|excalidraw)$/i.test(a.name) ||
        a.mime !==
          (/\.excalidraw$/i.test(a.name) ? 'application/vnd.excalidraw+json' : 'text/markdown')
      )
        fail(400, 'INVALID_INPUT');
      result = transfers.beginUpload(revalidate(), {
        ...a,
        binding: {
          domain: 'knowledge',
          kind: a.noteId ? 'document-update' : 'document-create',
          id: target,
          ...(a.noteId
            ? { revision: a.expectedModifiedAt }
            : { metadata: { directory: a.directory } }),
        },
      });
    } else if (name === 'complete_note_document_upload') {
      const prior = replay(p, 'document-upload', a);
      if (prior) result = prior;
      else {
        const info = transfers.info(p, a.transferId);
        p = authorizeTransfer(info.binding, true, options);
        if (!['document-create', 'document-update'].includes(info.binding.kind))
          fail(403, 'FORBIDDEN');
        const claim = 'document-' + sha256(a.requestId),
          upload = transfers.readUpload(p, a.transferId, undefined, claim);
        result = await receiptAsync(
          p,
          'document-upload',
          a,
          async () => {
            let content: string;
            try {
              content = new TextDecoder('utf-8', { fatal: true }).decode(upload.bytes);
            } catch {
              fail(400, 'INVALID_INPUT');
            }
            const fresh = authorizeTransfer(info.binding, true, options);
            if (info.binding.kind === 'document-update')
              return k.core.update(
                fresh,
                info.binding.id,
                content,
                info.binding.revision!,
                'mcp-' + sha256(a.requestId),
              );
            const directory = String(info.binding.metadata?.directory ?? '');
            if (info.binding.id !== (directory ? directory + '/' : '') + upload.name)
              fail(403, 'FORBIDDEN');
            if (info.binding.id.length > 2048) fail(400, 'INVALID_PATH');
            return k.core.create(
              fresh,
              directory,
              upload.name,
              content,
              'mcp-' + sha256(a.requestId),
            );
          },
          { transfer: info.binding },
        );
        transfers.complete(p, a.transferId, claim, result);
      }
    } else if (name === 'download_note_document') {
      const n = note(p, a.noteId),
        ready = await k.snapshots.available(p, a.noteId, { snapshotId: a.snapshotId });
      if ('operation' in ready) result = { kind: 'accepted', operation: ready.operation };
      else {
        const release = acquireRead(db, p, 'mcp'),
          parts: Buffer[] = [];
        try {
          for await (const block of readBlocks(ready.path, 0, undefined, options?.signal)) {
            await k.snapshots.check(revalidate(), a.noteId, ready.id);
            release.renew();
            parts.push(block);
          }
          result = transfers.createDownload(p, {
            requestId: a.requestId,
            binding: {
              domain: 'knowledge',
              kind: 'document-download',
              id: a.noteId,
              revision: ready.modified_at,
              metadata: { snapshotId: ready.id },
            },
            name: basename(n.path),
            mime: isWhiteboard(n.path) ? 'application/vnd.excalidraw+json' : 'text/markdown',
            bytes: Buffer.concat(parts),
          });
        } finally {
          release();
        }
      }
    } else if (name === 'get_note_share') {
      note(p, a.noteId);
      result = runtime.shares.status(a.noteId);
    } else if (['create_note_share', 'rotate_note_share', 'revoke_note_share'].includes(name)) {
      note(p, a.noteId);
      const old = db
        .prepare(
          'SELECT * FROM operations WHERE principal=? AND client_id=? AND kind=? AND request_id=?',
        )
        .get(p.id, p.clientId, 'knowledge.' + name, a.requestId) as any;
      if (old) result = receipt(p, name, a, () => fail(409, 'OPERATION_OUTCOME_UNKNOWN'));
      else {
        await checkVersion(revalidate(), a.noteId, a.expectedModifiedAt, revalidate);
        result = receipt(p, name, a, () => {
          assertSourceVersion(revalidate(), a.noteId, a.expectedModifiedAt);
          const current = runtime.shares.status(a.noteId);
          if (name === 'create_note_share' && current.enabled && a.expectedToken === undefined)
            fail(409, 'VERSION_CONFLICT');
          if (a.expectedToken !== undefined && (current.token ?? null) !== a.expectedToken)
            fail(409, 'VERSION_CONFLICT');
          requireScope(revalidate(), 'knowledge:share');
          if (name === 'revoke_note_share') return { ...runtime.shares.revoke(a.noteId) };
          const effectivePermission =
            a.permission ?? (current.enabled ? current.permission : 'view');
          if (effectivePermission === 'edit') requireScope(revalidate(), 'knowledge:write');
          const settings: any = {};
          for (const key of ['permission', 'expiresAt'])
            if (Object.hasOwn(a, key)) settings[key] = a[key];
          return { ...runtime.shares.create(a.noteId, name === 'rotate_note_share', settings) };
        });
      }
    } else if (
      name === 'get_knowledge_organization_settings' ||
      name === 'update_knowledge_organization_settings'
    ) {
      if (!p.knowledgeAll) fail(403, 'FORBIDDEN');
      if (name === 'get_knowledge_organization_settings') result = readOrganizationSettings(db);
      else
        result = receipt(p, name, a, () => {
          if (!revalidate().knowledgeAll) fail(403, 'FORBIDDEN');
          if (readOrganizationSettings(db).retentionDays !== a.expectedRetentionDays)
            fail(409, 'VERSION_CONFLICT');
          return updateOrganizationSettings(db, a);
        });
    } else if (name === 'list_knowledge_conflicts' || name === 'resolve_knowledge_conflict') {
      const check = () => {
        const fresh = revalidate();
        if (!fresh.knowledgeAll) fail(403, 'FORBIDDEN');
        return fresh;
      };
      check();
      const service = conflictService(config, db, p, check);
      if (name === 'list_knowledge_conflicts') {
        const all = await service.list();
        result = paged(
          p,
          name + ':' + a.kind,
          a.kind === 'files'
            ? all.items
            : a.kind === 'sync'
              ? all.syncConflicts
              : all.organizationConflicts || [],
          a,
        );
      } else result = await service.resolve(a.conflictId, a);
    } else if (name === 'get_knowledge_operation') {
      const op = findOperation(db, p, { id: a.operationId, requestId: a.requestId });
      const row = db
        .prepare('SELECT binding FROM mcp_knowledge_operation_bindings WHERE operation_id=?')
        .get(op.operationId) as { binding: string } | undefined;
      if (row) {
        const b = JSON.parse(row.binding);
        if (b.noteId) lifecycle(p, b.noteId);
        else if (b.folderId) archivedFolder(p, b.folderId);
        else if (b.directoryId) {
          const dir = db
            .prepare('SELECT id,path FROM organization_directories WHERE id=?')
            .get(b.directoryId) as any;
          if (!dir) fail(403, 'FORBIDDEN');
          lifecyclePrincipal(db, p, 'directory', dir.id, dir.path);
        } else if (b.transfer) {
          if (op.kind === 'knowledge.document-upload' && op.result?.id)
            note(p, String(op.result.id));
          else authorizeTransfer(b.transfer, true, options);
        } else if (!p.knowledgeAll) fail(403, 'FORBIDDEN');
      } else {
        const noteRow = db
          .prepare(
            'SELECT note_id FROM file_operations WHERE id=? UNION SELECT note_id FROM write_intents WHERE id=?',
          )
          .get(op.operationId, op.operationId) as any;
        if (noteRow) lifecycle(p, noteRow.note_id);
        else {
          const folder = db
            .prepare('SELECT id FROM folder_trash WHERE operation_id=?')
            .get(op.operationId) as any;
          if (folder) {
            requireScope(p, 'knowledge:archive');
            archivedFolder(p, folder.id);
          } else if (
            (op.kind === 'resolve_conflict' || op.kind.startsWith('knowledge.bundle.')) &&
            p.knowledgeAll
          )
            requireScope(p, 'knowledge:manage');
          else fail(404, 'OPERATION_NOT_FOUND');
        }
      }
      if (op.kind.includes('note_share')) requireScope(p, 'knowledge:share');
      if (op.kind.includes('organization_settings')) requireScope(p, 'knowledge:manage');
      result = db.prepare('SELECT 1 FROM file_operations WHERE id=?').get(op.operationId)
        ? k.files.operation(p, op.operationId)
        : op;
    } else fail(404, 'UNKNOWN_TOOL');
    // Reads are rechecked after awaits; write replays still need the current grant.
    const fresh = revalidate();
    if (def.scopes.includes('knowledge:manage') && !fresh.knowledgeAll) fail(403, 'FORBIDDEN');
    if (name === 'list_note_collection' && identity(p) !== identity(fresh))
      fail(409, 'COLLECTION_CHANGED');
    if (name === 'list_note_collection')
      for (const item of result.items) authorizePath(fresh, item.path);
    if (name === 'list_note_assets') note(fresh, a.noteId);
    const out = def.output.safeParse(result);
    if (!out.success) fail(502, 'INVALID_BACKEND_RESPONSE');
    return out.data as Record<string, unknown>;
  }
  async function receiptAsync(
    p: Principal,
    kind: string,
    a: any,
    work: () => Promise<Record<string, unknown>>,
    extra?: Record<string, unknown>,
  ) {
    const prior = db
      .transaction(() => beginOperation(db, p, 'knowledge.' + kind, a.requestId, a))
      .immediate();
    remember(prior.operation.id, a, extra);
    if (!prior.fresh && prior.operation.status !== 'prepared')
      return existingResult(prior.operation);
    try {
      const result = await work();
      return db
        .transaction(() => {
          const current = db
            .prepare('SELECT * FROM operations WHERE id=?')
            .get(prior.operation.id) as any;
          if (current.status === 'succeeded') return existingResult(current);
          completeOperation(db, prior.operation.id, result);
          return result;
        })
        .immediate();
    } catch (error) {
      const current = db
        .prepare('SELECT * FROM operations WHERE id=?')
        .get(prior.operation.id) as any;
      if (current.status === 'succeeded') return existingResult(current);
      throw error;
    }
  }
  const bundles = createKnowledgeBundlePort(context, paged);
  return { call, authorizeTransfer };
}
