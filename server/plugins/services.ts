import type { PluginServices, HostCallContext } from '../../packages/plugin-sdk/index.js';
import type { AppDatabase } from '../db.js';
import type { platformRuntime } from '../platform/runtime.js';
import { webPrincipal } from '../knowledge/core.js';
import { currentPrincipalPolicy } from '../agent/config.js';
import { authorizePath, checkTokenCutoff, requireScope, underPrefix } from '../agent/auth.js';
import { beginOperation, completeOperation, findOperation } from '../knowledge/operations.js';
import { fail } from '../knowledge/errors.js';
import { listMetadata } from '../knowledge/catalog.js';
import type { Principal } from '../../shared/knowledge-contracts.js';

export function pluginServices(platform: ReturnType<typeof platformRuntime>, db: AppDatabase,
  id: string, capabilities: string[], context: HostCallContext,
  exclusive?: <T>(work: () => Promise<T>) => Promise<T>): PluginServices {
  const runtime = platform.get(), k = runtime.knowledge;
  const principal: Principal = context.principal || { ...webPrincipal, id: context.ownerId,
    clientId: 'plugin-web:' + id, tokenIssuedAt: Math.floor(Date.now() / 1000),
    scopes: webPrincipal.scopes.filter(scope => capabilities.includes(scope)) };
  function authorized(capability: string) {
    if (!capabilities.includes(capability)) fail(403, 'PLUGIN_CAPABILITY_REQUIRED');
    checkTokenCutoff(db, principal); const policy = currentPrincipalPolicy(runtime.config, db, principal);
    if (!policy) fail(403, 'FORBIDDEN');
    const prefixes = principal.allowedPrefixes.flatMap(original => policy.allowedPrefixes.flatMap(current =>
      underPrefix(original, current) ? [original] : underPrefix(current, original) ? [current] : []));
    const p = { ...principal, scopes: principal.scopes.filter(scope => policy.scopes.includes(scope)), allowedPrefixes: [...new Set(prefixes)] };
    requireScope(p, capability); return p;
  }
  function owned(operationId: string) {
    const row = db.prepare('SELECT * FROM operations WHERE id=? AND principal=? AND client_id=?')
      .get(operationId, principal.id, principal.clientId) as any;
    if (!row || !row.kind.startsWith(`plugin.${id}.`)) fail(404, 'OPERATION_NOT_FOUND'); return row;
  }
  db.exec('CREATE TABLE IF NOT EXISTS plugin_operation_intents(operation_id TEXT PRIMARY KEY REFERENCES operations(id),plugin_id TEXT NOT NULL,details TEXT NOT NULL)');
  return {
    knowledge: {
      info: async b => k.info(authorized('knowledge:read'), b.noteId),
      list: async b => listMetadata(runtime.config, db, runtime.notes, k.info, authorized('knowledge:read'), b),
      outline: async b => k.snapshots.outline(authorized('knowledge:read'), b.noteId, b.cursor),
      readPage: async b => k.snapshots.read(authorized('knowledge:read'), b.noteId, b, context.channel === 'mcp' ? 'mcp' : 'web'),
      create: async b => k.core.create(authorized('knowledge:write'), b.directory, b.fileName, b.content, b.requestId),
      update: async b => k.core.update(authorized('knowledge:write'), b.noteId, b.content, b.expectedModifiedAt, b.requestId),
      patch: async b => k.files.submit(authorized('knowledge:write'), b.noteId, b, context.channel === 'mcp' ? 'mcp' : 'web'),
      archive: async b => k.core.archive(authorized('knowledge:write'), b.noteId, b.expectedModifiedAt, b.requestId),
      search: async b => k.search.search(authorized('knowledge:read'), b),
      research: async b => k.research.fetch(authorized('knowledge:read'), b.noteId, b.chunkId,
        { sourceHash: b.sourceHash, sourceRevision: b.sourceRevision == null ? undefined : String(b.sourceRevision) }),
      refresh: async b => k.indexing.refresh(authorized('knowledge:index'), b),
      status: async b => k.indexing.status(authorized('knowledge:index'), b),
      operation: async b => {
        const p = authorized('knowledge:read'), op = findOperation(db, p, { id: b.operationId, requestId: b.requestId });
        if (db.prepare('SELECT 1 FROM file_operations WHERE id=?').get(op.operationId)) return k.files.operation(p, op.operationId);
        const intent = db.prepare('SELECT path FROM write_intents WHERE id=?').get(op.operationId) as any;
        if (intent) authorizePath(p, intent.path); return op;
      },
      cancel: async b => k.files.cancel(authorized('knowledge:write'), b.operationId),
    },
    ...(capabilities.includes('workspace:git') && exclusive ? { workspace: {
      root: runtime.config.knowledgeRoot, bindingVersion: platform.status().bindingVersion,
      exclusive: async <T>(work: () => Promise<T>) => { authorized('knowledge:write'); return exclusive(work); },
    } } : {}),
    operations: {
      begin: (kind, requestId, params) => {
        if (!/^[a-z][a-zA-Z0-9.]*$/.test(kind)) fail(400, 'INVALID_OPERATION_KIND');
        return db.transaction(() => beginOperation(db, principal, `plugin.${id}.${kind}`, requestId, params)).immediate();
      },
      finish: (operationId, result) => { owned(operationId); completeOperation(db, operationId, result); },
      stage: (operationId, details) => { owned(operationId);
        db.prepare('INSERT INTO plugin_operation_intents VALUES(?,?,?) ON CONFLICT(operation_id) DO UPDATE SET details=excluded.details')
          .run(operationId, id, JSON.stringify(details)); },
      intent: <T>(operationId: string) => { owned(operationId); const r = db.prepare('SELECT details FROM plugin_operation_intents WHERE operation_id=? AND plugin_id=?').get(operationId, id) as any; return r ? JSON.parse(r.details) as T : undefined; },
      find: key => findOperation(db, principal, key),
    },
  };
}
