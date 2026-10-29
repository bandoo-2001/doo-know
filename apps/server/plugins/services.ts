import type { PluginServices, HostCallContext, ServiceCallOptions } from '../../../packages/plugin-sdk/index.js';
import type { AppDatabase } from '../../../packages/core/db.js';
import type { platformRuntime } from '../platform/runtime.js';
import { workspaceExclusive, workspaceWrite } from '../../../packages/core/workspace/gate.js';
import { workspaceExec } from '../../../packages/core/workspace/exec.js';
import { webPrincipal } from '../../../packages/core/knowledge/core.js';
import { currentPrincipalPolicy } from '../../../packages/core/agent/config.js';
import { authorizePath, checkTokenCutoff, requireScope, underPrefix } from '../../../packages/core/agent/auth.js';
import { beginOperation, completeOperation, findOperation } from '../../../packages/core/knowledge/operations.js';
import { fail } from '../../../packages/core/knowledge/errors.js';
import { listMetadata } from '../../../packages/core/knowledge/catalog.js';
import { flushKnowledgeData } from '../../../packages/core/knowledge-data.js';
import type { Principal } from '../../../shared/knowledge-contracts.js';
import { createToDooAgentPort } from '../to-doo/agent-port.js';
import { mcpPolicy } from '../platform/oauth.js';

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
    scopes: [...webPrincipal.scopes, 'blog:publish', 'to-doo:read', 'to-doo:write'].filter((scope) => capabilities.includes(scope)),
  };
  let finishingCommit = false;
  function authorized(capability: string, options?: ServiceCallOptions) {
    if (options?.signal?.aborted || (options?.deadline != null && Date.now() >= options.deadline)) fail(499, 'CALL_CANCELLED');
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
  function blogAuthorized(write: boolean, options?: ServiceCallOptions) {
    let p = authorized('knowledge:read', options);
    if (write) {
      authorized('knowledge:write', options);
      p = authorized('blog:publish', options);
      if (id === 'mcp') {
        const row = db.prepare("SELECT config_json FROM platform_plugins WHERE id='mcp' AND installed=1 AND state='enabled'").get() as { config_json: string } | undefined;
        const policy = row ? JSON.parse(row.config_json) : {};
        if (policy.readOnly !== false || policy.allowPublish !== true) fail(403, 'FORBIDDEN');
      }
    }
    return p;
  }
  function owned(operationId: string) {
    const row = db
      .prepare('SELECT * FROM operations WHERE id=? AND principal=? AND client_id=?')
      .get(operationId, principal.id, principal.clientId) as any;
    if (!row || !row.kind.startsWith(`plugin.${id}.`)) fail(404, 'OPERATION_NOT_FOUND');
    return row;
  }
  function taskPort(options?: ServiceCallOptions) {
    return createToDooAgentPort(runtime.toDoo, {
      authorize(write) {
        let p = authorized('to-doo:read', options);
        if (write) p = authorized('to-doo:write', options);
        if (id === 'mcp') {
          const policy = mcpPolicy(db);
          if (!policy.enabled || !policy.allowToDoo || (write && (policy.readOnly || !policy.allowToDooWrite))) fail(403, 'FORBIDDEN');
        }
        return p;
      },
      access: () => id === 'mcp' ? { listIds: mcpPolicy(db).toDooListIds, domains: mcpPolicy(db).toDooDomains }
        : { listIds: [], domains: ['tasks','records','focus','habits','anniversaries','calendar','statistics','settings'] },
      canReadNote: async (_p, noteId) => {
        try { await k.info(authorized('knowledge:read', options), noteId); return true; } catch { return false; }
      },
    });
  }
  db.exec(
    'CREATE TABLE IF NOT EXISTS plugin_operation_intents(operation_id TEXT PRIMARY KEY REFERENCES operations(id),plugin_id TEXT NOT NULL,details TEXT NOT NULL)',
  );
  return {
    toDoo: {
      query: (input, options) => taskPort(options).query(input, options),
      context: (input, options) => taskPort(options).context(input, options),
      command: (input, options) => taskPort(options).command(input, options),
    },
    ...(id === 'mcp' &&
    context.channel === 'web' &&
    !context.principal &&
    capabilities.includes('protocol:mcp')
      ? { authorization }
      : {}),
    knowledge: {
      info: async (b, options) => k.info(authorized('knowledge:read', options), b.noteId),
      list: async (b, options) =>
        listMetadata(runtime.config, db, runtime.notes, k.info, authorized('knowledge:read', options), b),
      outline: async (b, options) => k.snapshots.outline(authorized('knowledge:read', options), b.noteId, b.cursor),
      readPage: async ({ noteId, ...b }, options) =>
        k.snapshots.read(
          authorized('knowledge:read', options),
          noteId,
          b,
          context.channel === 'mcp' ? 'mcp' : 'web',
        ),
      create: async (b, options) =>
        k.core.create(
          authorized('knowledge:write', options),
          b.directory,
          b.fileName,
          b.content,
          b.requestId,
        ),
      update: async (b, options) =>
        k.core.update(
          authorized('knowledge:write', options),
          b.noteId,
          b.content,
          b.expectedModifiedAt,
          b.requestId,
        ),
      patch: async ({ noteId, ...b }, options) =>
        k.files.submit(
          authorized('knowledge:write', options),
          noteId,
          b,
          context.channel === 'mcp' ? 'mcp' : 'web',
        ),
      archive: async (b, options) =>
        k.core.archive(authorized('knowledge:write', options), b.noteId, b.expectedModifiedAt, b.requestId),
      search: async (b, options) => k.search.search(authorized('knowledge:read', options), b),
      research: async (b, options) =>
        k.research.fetch(authorized('knowledge:read', options), b.noteId, b.chunkId, {
          sourceHash: b.sourceHash,
          sourceRevision: b.sourceRevision == null ? undefined : String(b.sourceRevision),
        }),
      refresh: async (b, options) => k.indexing.refresh(authorized('knowledge:index', options), b),
      status: async (b, options) => k.indexing.status(authorized('knowledge:index', options), b),
      operation: async (b, options) => {
        const p = authorized('knowledge:read', options),
          op = findOperation(db, p, { id: b.operationId, requestId: b.requestId });
        if (op.kind === 'blog.publish' || op.kind === 'blog.unpublish') return runtime.blog.operationStatus(p, b);
        if (db.prepare('SELECT 1 FROM file_operations WHERE id=?').get(op.operationId))
          return k.files.operation(p, op.operationId);
        const intent = db
          .prepare('SELECT path FROM write_intents WHERE id=?')
          .get(op.operationId) as any;
        if (intent) authorizePath(p, intent.path);
        return op;
      },
      cancel: async (b, options) => k.files.cancel(authorized('knowledge:write', options), b.operationId),
    },
    ...(runtime.blog && capabilities.includes('knowledge:read') ? { blog: {
      status: async (b: { noteId: string }, options?: ServiceCallOptions) => runtime.blog.noteStatus(blogAuthorized(false, options), b.noteId),
      publish: async (b: Parameters<NonNullable<PluginServices['blog']>['publish']>[0], options?: ServiceCallOptions) => runtime.blog.publishNote(blogAuthorized(true, options), b, () => blogAuthorized(true, options)),
      unpublish: async (b: Parameters<NonNullable<PluginServices['blog']>['unpublish']>[0], options?: ServiceCallOptions) => runtime.blog.unpublishNote(blogAuthorized(true, options), b, () => blogAuthorized(true, options)),
    } } : {}),
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
              const snapshot = async () => {
                // External files need stable identities before Git captures _data.
                // Keep discovery synchronous while holding the exclusive permit.
                runtime.notes.scan();
                flushKnowledgeData(db);
                return work();
              };
              return exclusive
                ? exclusive(snapshot)
                : workspaceExclusive(db, { kind: 'plugin.' + id }, snapshot);
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
