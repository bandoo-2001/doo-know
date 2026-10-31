import type { McpDomainContext } from './mcp-domain-context.js';
import type { Principal } from '../../../shared/knowledge-contracts.js';
import type { McpTransferBinding } from '../../../shared/mcp-domain-tools.js';
import type { ServiceCallOptions } from '../../../packages/plugin-sdk/index.js';
import type { PortableImportResult } from '../../../shared/portable-delivery-contracts.js';
import { portableDeliveryService } from '../../../packages/core/portable-delivery/service.js';
import { authorizePath } from '../../../packages/core/agent/auth.js';
import { authorizeFolderPath } from '../../../packages/core/knowledge/lifecycle-access.js';
import { sha256 } from '../../../packages/core/knowledge/operations.js';
import { fail } from '../../../packages/core/knowledge/errors.js';

export const portableToolNames = new Set([
  'export_portable_documents',
  'begin_portable_import_upload',
  'import_portable_archive',
  'get_portable_import_result',
]);
const activeImports = new WeakMap<
  McpDomainContext['db'],
  Map<string, { fingerprint: string; promise: Promise<Record<string, unknown>> }>
>();
type ImportJob = {
  id: string;
  principal: string;
  client: string;
  workspace: string;
  request_id: string;
  fingerprint: string;
  transfer_id: string;
  folder: string;
  status: string;
  result: string | null;
  error: string | null;
};

/** Transport only: the strict planner/importer and their version closure live in core. */
export function createPortableToolPort(
  context: McpDomainContext,
  paginate: (
    p: Principal,
    kind: string,
    rows: any[],
    args: any,
    extra?: Record<string, unknown>,
  ) => any,
) {
  const { config, db, runtime, transfers } = context;
  const core = portableDeliveryService(config, db, runtime.notes);
  db.exec(
    `CREATE TABLE IF NOT EXISTS mcp_portable_imports(id TEXT PRIMARY KEY,principal TEXT NOT NULL,client TEXT NOT NULL,workspace TEXT NOT NULL,request_id TEXT NOT NULL,fingerprint TEXT NOT NULL,transfer_id TEXT NOT NULL,folder TEXT NOT NULL,status TEXT NOT NULL,result TEXT,error TEXT,UNIQUE(principal,client,workspace,request_id))`,
  );
  function workspace() {
    return (
      (db.prepare("SELECT value FROM index_meta WHERE key='root_identity'").get() as any)?.value ||
      'unbound'
    );
  }
  function principal(write: boolean, options?: ServiceCallOptions) {
    return context.authorize(['knowledge:read', ...(write ? ['knowledge:write'] : [])], options);
  }
  function folder(p: Principal, path: string) {
    if (!path) {
      if (!p.knowledgeAll) fail(403, 'FORBIDDEN');
      return;
    }
    authorizeFolderPath(p, path);
    authorizeFolderPath(p, path, 'knowledge:write');
  }
  function importBinding(p: Principal, path: string): McpTransferBinding {
    return {
      domain: 'knowledge',
      kind: 'portable-import',
      id: runtime.knowledge.organization.context(p).libraryId,
      metadata: { folderPath: path },
    };
  }
  function authorizeTransfer(
    binding: McpTransferBinding,
    write: boolean,
    options?: ServiceCallOptions,
  ) {
    if (
      binding.domain !== 'knowledge' ||
      !['portable-import', 'portable-export'].includes(binding.kind)
    )
      fail(403, 'FORBIDDEN');
    if (binding.kind === 'portable-export') {
      if (write) fail(403, 'FORBIDDEN');
      const p = principal(false, options);
      core.validate(p, binding.id);
      return p;
    }
    const p = principal(true, options),
      target = binding.metadata?.folderPath;
    if (
      typeof target !== 'string' ||
      binding.id !== runtime.knowledge.organization.context(p).libraryId
    )
      fail(403, 'FORBIDDEN');
    folder(p, target);
    return p;
  }
  function owned(p: Principal, a: any): ImportJob {
    const row = a.importId
      ? db
          .prepare(
            'SELECT * FROM mcp_portable_imports WHERE id=? AND principal=? AND client=? AND workspace=?',
          )
          .get(a.importId, p.id, p.clientId, workspace())
      : db
          .prepare(
            'SELECT * FROM mcp_portable_imports WHERE request_id=? AND principal=? AND client=? AND workspace=?',
          )
          .get(a.requestId, p.id, p.clientId, workspace());
    if (!row) fail(404, 'PORTABLE_IMPORT_NOT_FOUND');
    folder(p, (row as ImportJob).folder);
    return row as ImportJob;
  }
  function progress(p: Principal, job: ImportJob) {
    let result: PortableImportResult | undefined = job.result ? JSON.parse(job.result) : undefined;
    const hasTable = db
      .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='portable_import_jobs'")
      .get();
    const current = (
      hasTable
        ? db
            .prepare(
              'SELECT result,complete FROM portable_import_jobs WHERE principal=? AND client=? AND request_id=?',
            )
            .get(p.id, p.clientId, job.request_id)
        : undefined
    ) as { result: string; complete: number } | undefined;
    if (current) result = JSON.parse(current.result);
    // Refresh portable identities once per response, never once per imported item.
    if (result?.notes.length) runtime.notes.row(result.notes[0].noteId);
    const paths = new Map(
      (
        db.prepare('SELECT id,path FROM notes WHERE active=1').all() as {
          id: string;
          path: string;
        }[]
      ).map((note) => [note.id, note.path]),
    );
    for (const item of result?.notes || []) {
      const path = paths.get(item.noteId);
      if (!path) fail(404, 'PORTABLE_IMPORT_NOT_FOUND');
      authorizePath(p, path);
      authorizePath(p, path, 'knowledge:write');
    }
    return {
      result,
      summary: {
        importId: job.id,
        requestId: job.request_id,
        state: current?.complete ? 'succeeded' : job.status,
        notesImported: result?.notes.length || 0,
        assetsImported: result?.assets || 0,
        ...(job.error && !current?.complete ? { error: job.error } : {}),
      },
    };
  }
  async function call(name: string, a: any, options?: ServiceCallOptions) {
    let p = principal(name !== 'export_portable_documents', options);
    if (name === 'export_portable_documents') {
      const delivery = await core.create(
        p,
        { selection: a.selection, requestId: a.requestId },
        { signal: options?.signal, check: () => principal(false, options) },
      );
      p = principal(false, options);
      const stream = await core.download(p, delivery.id);
      const download = await transfers.createDownloadStream(p, {
        requestId: 'portable-' + delivery.id,
        binding: { domain: 'knowledge', kind: 'portable-export', id: delivery.id },
        name: delivery.fileName,
        mime: delivery.mime,
        totalBytes: delivery.sizeBytes,
        sha256: delivery.sha256,
        stream,
        signal: options?.signal,
        check: () => { core.validate(principal(false, options), delivery.id); },
      });
      core.validate(principal(false, options), delivery.id);
      const { downloadUrl: _url, ...metadata } = delivery;
      return { ...metadata, download };
    }
    if (name === 'begin_portable_import_upload') {
      folder(p, a.folderPath);
      return transfers.beginUpload(p, { ...a, binding: importBinding(p, a.folderPath) });
    }
    if (name === 'get_portable_import_result') {
      const job = owned(p, a),
        { result, summary } = progress(p, job);
      return paginate(p, name + ':' + job.id, result?.notes || [], a, { import: summary });
    }
    if (name === 'import_portable_archive') {
      folder(p, a.folderPath);
      const info = transfers.info(p, a.transferId);
      authorizeTransfer(info.binding, true, options);
      const binding = importBinding(p, a.folderPath);
      // Exact binding check prevents a generic upload or another target from being consumed.
      const upload = transfers.openUpload(p, a.transferId, binding, 'portable-' + sha256(a.requestId));
      const fingerprint = sha256(JSON.stringify([a.transferId, a.folderPath, upload.sha256]));
      let job = db
        .prepare(
          'SELECT * FROM mcp_portable_imports WHERE principal=? AND client=? AND workspace=? AND request_id=?',
        )
        .get(p.id, p.clientId, workspace(), a.requestId) as ImportJob | undefined;
      if (job && job.fingerprint !== fingerprint) fail(409, 'REQUEST_ID_CONFLICT');
      if (!job) {
        const id = sha256(JSON.stringify([p.id, p.clientId, workspace(), a.requestId]));
        db.prepare('INSERT INTO mcp_portable_imports VALUES(?,?,?,?,?,?,?,?,?,?,?)').run(
          id,
          p.id,
          p.clientId,
          workspace(),
          a.requestId,
          fingerprint,
          a.transferId,
          a.folderPath,
          'running',
          null,
          null,
        );
        job = owned(p, { importId: id });
      }
      if (job.status === 'succeeded') {
        const summary = progress(p, job).summary;
        transfers.complete(p, a.transferId, 'portable-' + sha256(a.requestId), summary);
        return summary;
      }
      let active = activeImports.get(db);
      if (!active) {
        active = new Map();
        activeImports.set(db, active);
      }
      const activeKey = JSON.stringify([p.id, p.clientId, workspace(), a.requestId]),
        pending = active.get(activeKey);
      if (pending) {
        if (pending.fingerprint !== fingerprint) fail(409, 'REQUEST_ID_CONFLICT');
        return pending.promise.then(
          () => progress(principal(true, options), owned(p, { importId: job!.id })).summary,
        );
      }
      db.prepare("UPDATE mcp_portable_imports SET status='running',error=NULL WHERE id=?").run(
        job.id,
      );
      const work = (async () => {
        try {
          options?.signal?.throwIfAborted();
          const result = await core.importArchive(
            principal(true, options),
            {
              archivePath: upload.path,
              folderPath: a.folderPath,
              requestId: a.requestId,
            },
            {
              check: () => {
                options?.signal?.throwIfAborted();
                if (workspace() !== job.workspace) fail(409, 'MCP_TRANSFER_BINDING_CHANGED');
                const fresh = principal(true, options);
                folder(fresh, a.folderPath);
                return fresh;
              },
            },
          );
          db.prepare(
            "UPDATE mcp_portable_imports SET status='succeeded',result=?,error=NULL WHERE id=?",
          ).run(JSON.stringify(result), job.id);
          const summary = progress(
            principal(true, options),
            owned(p, { importId: job.id }),
          ).summary;
          transfers.complete(p, a.transferId, 'portable-' + sha256(a.requestId), summary);
          return summary;
        } catch (error) {
          const code = (error as any).code;
          db.prepare("UPDATE mcp_portable_imports SET status='failed',error=? WHERE id=?").run(
            typeof code === 'string' && /^[A-Z_]{1,64}$/.test(code)
              ? code
              : 'PORTABLE_IMPORT_FAILED',
            job.id,
          );
          throw error;
        }
      })();
      active.set(activeKey, { fingerprint, promise: work });
      return work.finally(() => active!.delete(activeKey));
    }
    fail(404, 'UNKNOWN_TOOL');
  }
  return { call, authorizeTransfer };
}
