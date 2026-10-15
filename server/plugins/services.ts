import type { PluginServices, HostCallContext } from '../../packages/plugin-sdk/index.js';
import type { AppDatabase } from '../db.js';
import type { platformRuntime } from '../platform/runtime.js';
import { workspaceExclusive, workspaceWrite } from '../workspace/gate.js';
import { workspaceExec } from '../workspace/exec.js';
import { webPrincipal } from '../knowledge/core.js';
import { currentPrincipalPolicy } from '../agent/config.js';
import { authorizePath, checkTokenCutoff, requireScope, underPrefix } from '../agent/auth.js';
import { beginOperation, completeOperation, findOperation } from '../knowledge/operations.js';
import { fail } from '../knowledge/errors.js';
import { listMetadata } from '../knowledge/catalog.js';
import type { Principal } from '../../shared/knowledge-contracts.js';

export function pluginServices(
  platform: ReturnType<typeof platformRuntime>,
  db: AppDatabase,
  id: string,
  capabilities: string[],
  context: HostCallContext,
  exclusive?: <T>(work: () => Promise<T>) => Promise<T>,
  authorization?: PluginServices['authorization'],
): PluginServices {
  const runtime = platform.get(),
    k = runtime.knowledge;
  const principal: Principal = context.principal || {
    ...webPrincipal,
    id: context.ownerId,
    clientId: 'plugin-web:' + id,
    tokenIssuedAt: Math.floor(Date.now() / 1000),
    scopes: webPrincipal.scopes.filter((scope) => capabilities.includes(scope)),
  };
  let finishingCommit = false;
  function authorized(capability: string) {
    if (!capabilities.includes(capability)) fail(403, 'PLUGIN_CAPABILITY_REQUIRED');
    checkTokenCutoff(db, principal);
    let policy = currentPrincipalPolicy(runtime.config, db, principal);
    if (
      !policy &&
      finishingCommit &&
      !context.principal &&
      context.channel === 'web' &&
      db.prepare('SELECT id FROM user WHERE id=?').get(context.ownerId) &&
      db.prepare("SELECT id FROM platform_plugins WHERE id=? AND state='stopping'").get(id)
    )
      policy = {
        ...principal,
        scopes: webPrincipal.scopes,
        allowedPrefixes: webPrincipal.allowedPrefixes,
      };
    if (!policy) fail(403, 'FORBIDDEN');
    const prefixes = principal.allowedPrefixes.flatMap((original) =>
      policy.allowedPrefixes.flatMap((current) =>
        underPrefix(original, current)
          ? [original]
          : underPrefix(current, original)
            ? [current]
            : [],
      ),
    );
    const p = {
      ...principal,
      scopes: principal.scopes.filter((scope) => policy.scopes.includes(scope)),
      allowedPrefixes: [...new Set(prefixes)],
    };
    requireScope(p, capability);
    return p;
  }
  function owned(operationId: string) {
    const row = db
      .prepare('SELECT * FROM operations WHERE id=? AND principal=? AND client_id=?')
      .get(operationId, principal.id, principal.clientId) as any;
    if (!row || !row.kind.startsWith(`plugin.${id}.`)) fail(404, 'OPERATION_NOT_FOUND');
    return row;
  }
  db.exec(
    'CREATE TABLE IF NOT EXISTS plugin_operation_intents(operation_id TEXT PRIMARY KEY REFERENCES operations(id),plugin_id TEXT NOT NULL,details TEXT NOT NULL)',
  );
  return {
    ...(id === 'mcp' &&
    context.channel === 'web' &&
    !context.principal &&
    capabilities.includes('protocol:mcp')
      ? { authorization }
      : {}),
    knowledge: {
      info: async (b) => k.info(authorized('knowledge:read'), b.noteId),
      list: async (b) =>
        listMetadata(runtime.config, db, runtime.notes, k.info, authorized('knowledge:read'), b),
      outline: async (b) => k.snapshots.outline(authorized('knowledge:read'), b.noteId, b.cursor),
      readPage: async ({ noteId, ...b }) =>
        k.snapshots.read(
          authorized('knowledge:read'),
          noteId,
          b,
          context.channel === 'mcp' ? 'mcp' : 'web',
        ),
      create: async (b) =>
        k.core.create(
          authorized('knowledge:write'),
          b.directory,
          b.fileName,
          b.content,
          b.requestId,
        ),
      update: async (b) =>
        k.core.update(
          authorized('knowledge:write'),
          b.noteId,
          b.content,
          b.expectedModifiedAt,
          b.requestId,
        ),
      patch: async ({ noteId, ...b }) =>
        k.files.submit(
          authorized('knowledge:write'),
          noteId,
          b,
          context.channel === 'mcp' ? 'mcp' : 'web',
        ),
      archive: async (b) =>
        k.core.archive(authorized('knowledge:write'), b.noteId, b.expectedModifiedAt, b.requestId),
      search: async (b) => k.search.search(authorized('knowledge:read'), b),
      research: async (b) =>
        k.research.fetch(authorized('knowledge:read'), b.noteId, b.chunkId, {
          sourceHash: b.sourceHash,
          sourceRevision: b.sourceRevision == null ? undefined : String(b.sourceRevision),
        }),
      refresh: async (b) => k.indexing.refresh(authorized('knowledge:index'), b),
      status: async (b) => k.indexing.status(authorized('knowledge:index'), b),
      operation: async (b) => {
        const p = authorized('knowledge:read'),
          op = findOperation(db, p, { id: b.operationId, requestId: b.requestId });
        if (db.prepare('SELECT 1 FROM file_operations WHERE id=?').get(op.operationId))
          return k.files.operation(p, op.operationId);
        const intent = db
          .prepare('SELECT path FROM write_intents WHERE id=?')
          .get(op.operationId) as any;
        if (intent) authorizePath(p, intent.path);
        return op;
      },
      cancel: async (b) => k.files.cancel(authorized('knowledge:write'), b.operationId),
    },
    ...(capabilities.includes('workspace:git')
      ? {
          workspace: {
            root: runtime.config.knowledgeRoot,
            bindingVersion: platform.status().bindingVersion,
            read: async <T>(work: () => Promise<T>) => {
              authorized('knowledge:read');
              return workspaceWrite(db, { kind: 'plugin.' + id + '.read' }, work);
            },
            exclusive: async <T>(work: () => Promise<T>) => {
              authorized('knowledge:write');
              return exclusive
                ? exclusive(work)
                : workspaceExclusive(db, { kind: 'plugin.' + id }, work);
            },
            exec: (args, options) => {
              authorized('knowledge:read');
              return workspaceExec(db, platform.get().config.knowledgeRoot, args, options);
            },
          },
        }
      : {}),
    operations: {
      begin: (kind, requestId, params) => {
        if (!/^[a-z][a-zA-Z0-9.]*$/.test(kind)) fail(400, 'INVALID_OPERATION_KIND');
        return db
          .transaction(() =>
            beginOperation(db, principal, `plugin.${id}.${kind}`, requestId, params),
          )
          .immediate();
      },
      committing: (operationId) => {
        authorized('knowledge:write');
        owned(operationId);
        db.prepare(
          "UPDATE operations SET status='committing',updated_at=? WHERE id=? AND status IN ('prepared','committing')",
        ).run(Date.now(), operationId);
        finishingCommit = true;
      },
      finish: (operationId, result) => {
        const previous = owned(operationId);
        if (previous.status !== 'succeeded') completeOperation(db, operationId, result);
      },
      fail: (operationId, code) => {
        owned(operationId);
        if (!/^[A-Z][A-Z0-9_]{0,63}$/.test(code)) fail(400, 'INVALID_OPERATION_ERROR');
        db.prepare(
          "UPDATE operations SET status='failed',error=?,updated_at=? WHERE id=? AND status<>'succeeded'",
        ).run(code, Date.now(), operationId);
      },
      pending: () =>
        (
          db
            .prepare(
              "SELECT o.id,o.request_id,o.status,o.result,i.details FROM plugin_operation_intents i JOIN operations o ON o.id=i.operation_id WHERE i.plugin_id=? AND o.principal=? AND o.client_id=? AND json_extract(i.details,'$.phase') NOT IN ('finished','aborted','acknowledged') ORDER BY o.created_at",
            )
            .all(id, principal.id, principal.clientId) as any[]
        ).map((r) => ({
          operationId: r.id,
          requestId: r.request_id,
          details: JSON.parse(r.details),
          status: r.status,
          result: r.result ? JSON.parse(r.result) : null,
        })),
      stage: (operationId, details) => {
        owned(operationId);
        db.prepare(
          'INSERT INTO plugin_operation_intents VALUES(?,?,?) ON CONFLICT(operation_id) DO UPDATE SET details=excluded.details',
        ).run(operationId, id, JSON.stringify(details));
      },
      intent: <T>(operationId: string) => {
        owned(operationId);
        const r = db
          .prepare(
            'SELECT details FROM plugin_operation_intents WHERE operation_id=? AND plugin_id=?',
          )
          .get(operationId, id) as any;
        return r ? (JSON.parse(r.details) as T) : undefined;
      },
      find: (key) => findOperation(db, principal, key),
    },
  };
}
