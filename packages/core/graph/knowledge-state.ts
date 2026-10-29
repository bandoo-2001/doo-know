import type { AppConfig } from '../../../shared/contracts.js';
import type {
  GraphExploreQuery,
  GraphSavedView,
  GraphUserCommand,
  GraphUserState,
} from '../../../shared/graph-semantic-contracts.js';
import type { AppDatabase } from '../db.js';
import { createKnowledgeDataDomain } from '../knowledge-data.js';
import { fail } from '../knowledge/errors.js';
import { hash } from './analysis-source.js';
export type Portable = GraphUserState & {
  decisions: Record<string, { decision: 'accept' | 'ignore'; predicate?: string }>;
  merges: Record<string, string>;
  aliases: Record<string, string[]>;
  manual: { id: string; source: string; target: string; predicate: string; noteId: string }[];
  requests: Record<string, { digest: string; version: number }>;
};
export function validateQuery(q: GraphExploreQuery): GraphExploreQuery {
  if (
    !q ||
    typeof q !== 'object' ||
    Array.isArray(q) ||
    Object.keys(q).some(
      (k) =>
        ![
          'folder',
          'q',
          'focus',
          'depth',
          'mode',
          'limit',
          'view',
          'nodeKinds',
          'edgeKinds',
          'includeSuggested',
          'includeSimilarity',
          'minConfidence',
          'target',
        ].includes(k),
    )
  )
    fail(400, 'INVALID_INPUT');
  for (const key of ['folder', 'q', 'focus', 'target'] as const)
    if (
      q[key] !== undefined &&
      (typeof q[key] !== 'string' ||
        q[key]!.length > (key === 'folder' ? 1024 : 256) ||
        /[\u0000-\u001f\u007f]/.test(q[key]!))
    )
      fail(400, 'INVALID_INPUT');
  if (
    q.folder &&
    (q.folder.startsWith('/') || q.folder.split('/').some((p) => !p || p === '.' || p === '..'))
  )
    fail(400, 'INVALID_INPUT');
  if (q.limit !== undefined && (!Number.isInteger(q.limit) || q.limit < 1 || q.limit > 1000))
    fail(400, 'INVALID_INPUT');
  if (q.depth !== undefined && q.depth !== 1 && q.depth !== 2) fail(400, 'INVALID_INPUT');
  if (q.mode !== undefined && !['all', 'orphans'].includes(q.mode)) fail(400, 'INVALID_INPUT');
  if (q.view !== undefined && !['notes', 'knowledge'].includes(q.view)) fail(400, 'INVALID_INPUT');
  if (
    q.minConfidence !== undefined &&
    (!Number.isFinite(q.minConfidence) || q.minConfidence < 0 || q.minConfidence > 1)
  )
    fail(400, 'INVALID_INPUT');
  for (const k of ['includeSuggested', 'includeSimilarity'] as const)
    if (q[k] !== undefined && typeof q[k] !== 'boolean') fail(400, 'INVALID_INPUT');
  for (const [key, allowed] of [
    ['nodeKinds', ['note', 'concept', 'person', 'organization', 'place', 'event', 'technology']],
    ['edgeKinds', ['reference', 'mentions', 'cooccurs', 'similarity', 'semantic', 'manual']],
  ] as const)
    if (
      q[key] !== undefined &&
      (!Array.isArray(q[key]) ||
        q[key]!.length > 8 ||
        q[key]!.some((k) => !(allowed as readonly string[]).includes(k)))
    )
      fail(400, 'INVALID_INPUT');
  return { ...q, limit: q.limit ?? 80, depth: q.depth ?? 1 };
}
export function knowledgeState(config: AppConfig, db: AppDatabase) {
  const read = () =>
    JSON.parse(
      (db.prepare('SELECT data FROM graph_knowledge_user WHERE id=1').get() as { data: string })
        .data,
    ) as Portable;
  function validate(data: unknown): Portable {
    if (!data || typeof data !== 'object' || JSON.stringify(data).length > 2 * 1024 * 1024)
      throw Error('Invalid graph state');
    const v = data as Portable;
    if (
      !Number.isSafeInteger(v.version) ||
      v.version < 0 ||
      !Array.isArray(v.views) ||
      v.views.length > 100 ||
      !Array.isArray(v.manual) ||
      v.manual.length > 1000
    )
      throw Error('Invalid graph state');
    for (const field of ['decisions', 'merges', 'aliases', 'requests'] as const)
      if (
        !v[field] ||
        typeof v[field] !== 'object' ||
        Array.isArray(v[field]) ||
        Object.keys(v[field]).length > 5000
      )
        throw Error('Invalid graph state');
    const string = (s: unknown, max = 256) =>
      typeof s === 'string' && s.length > 0 && s.length <= max && !/[\u0000-\u001f]/.test(s);
    for (const item of v.views) {
      if (!string(item.id) || !string(item.name, 80) || !string(item.createdAt))
        throw Error('Invalid view');
      validateQuery(item.query);
    }
    for (const [id, d] of Object.entries(v.decisions))
      if (
        !string(id) ||
        !d ||
        !['accept', 'ignore'].includes(d.decision) ||
        (d.predicate !== undefined && !string(d.predicate, 128))
      )
        throw Error('Invalid decision');
    for (const [a, b] of Object.entries(v.merges))
      if (!string(a) || !string(b) || a === b) throw Error('Invalid merge');
    for (const [id, aliases] of Object.entries(v.aliases))
      if (
        !string(id) ||
        !Array.isArray(aliases) ||
        aliases.length > 32 ||
        aliases.some((a) => !string(a, 128))
      )
        throw Error('Invalid alias');
    for (const item of v.manual)
      if (
        !item ||
        !string(item.id) ||
        !string(item.source) ||
        !string(item.target) ||
        !string(item.predicate, 128) ||
        !string(item.noteId)
      )
        throw Error('Invalid manual relation');
    for (const [id, req] of Object.entries(v.requests))
      if (!string(id) || !req || !string(req.digest) || !Number.isSafeInteger(req.version))
        throw Error('Invalid request');
    for (const id of Object.keys(v.merges)) canonical(v, id);
    return v;
  }
  const domain = createKnowledgeDataDomain(config, db, 'apps/knowledge-graph/state.json', {
    tables: ['graph_knowledge_user'],
    read,
    validate,
    write(value) {
      db.prepare('UPDATE graph_knowledge_user SET data=? WHERE id=1').run(JSON.stringify(value));
    },
  });
  return {
    read() {
      domain.refresh();
      return read();
    },
    user(): GraphUserState {
      domain.refresh();
      const state = read();
      return { version: state.version, views: state.views };
    },
    command(input: GraphUserCommand, check: (input: GraphUserCommand) => void) {
      if (
        !input ||
        typeof input !== 'object' ||
        typeof input.requestId !== 'string' ||
        !/^[a-zA-Z0-9_-]{1,128}$/.test(input.requestId) ||
        !Number.isSafeInteger(input.expectedVersion)
      )
        fail(400, 'INVALID_INPUT');
      domain.refresh();
      const state = read(),
        digest = hash(JSON.stringify(input)),
        prior = Object.hasOwn(state.requests, input.requestId)
          ? state.requests[input.requestId]
          : undefined;
      if (prior) {
        if (prior.digest !== digest) fail(409, 'IDEMPOTENCY_CONFLICT');
        return { version: state.version, views: state.views };
      }
      if (state.version !== input.expectedVersion) fail(409, 'VERSION_CONFLICT');
      check(input);
      const string = (s: unknown, max = 128) => {
        if (typeof s !== 'string' || !s.trim() || s.length > max || /[\u0000-\u001f]/.test(s))
          fail(400, 'INVALID_INPUT');
        return s.trim();
      };
      switch (input.action) {
        case 'review':
          if (!['accept', 'ignore', 'reset'].includes(input.decision)) fail(400, 'INVALID_INPUT');
          if (input.decision === 'reset') delete state.decisions[input.id];
          else
            state.decisions[input.id] = {
              decision: input.decision,
              ...(input.predicate !== undefined ? { predicate: string(input.predicate) } : {}),
            };
          break;
        case 'merge': {
          const a = canonical(state, input.from),
            b = canonical(state, input.into);
          if (a === b) fail(400, 'INVALID_MERGE');
          state.merges[a] = b;
          break;
        }
        case 'alias': {
          const id = canonical(state, input.entityId),
            alias = string(input.alias);
          state.aliases[id] = [...new Set([...(state.aliases[id] ?? []), alias])];
          break;
        }
        case 'manual-relation': {
          const source = canonical(state, input.source),
            target = canonical(state, input.target),
            predicate = string(input.predicate);
          if (source === target) fail(400, 'INVALID_INPUT');
          state.manual.push({
            id: 'manual:' + hash(input.requestId).slice(0, 24),
            source,
            target,
            predicate,
            noteId: input.noteId,
          });
          break;
        }
        case 'save-view': {
          if (state.views.length >= 100) fail(400, 'VIEW_LIMIT');
          const view: GraphSavedView = {
            id: 'view:' + hash(input.requestId).slice(0, 24),
            name: string(input.name, 80),
            query: validateQuery(input.query),
            createdAt: new Date().toISOString(),
          };
          state.views.push(view);
          break;
        }
        case 'delete-view':
          state.views = state.views.filter((v) => v.id !== input.id);
          break;
        default:
          fail(400, 'INVALID_INPUT');
      }
      state.version++;
      Object.defineProperty(state.requests, input.requestId, {
        value: { digest, version: state.version },
        enumerable: true,
        writable: true,
        configurable: true,
      });
      // Bounded idempotency ledger rejects new requests instead of silently forgetting prior receipts.
      if (Object.keys(state.requests).length > 5000) fail(409, 'GRAPH_STATE_LIMIT');
      validate(state);
      db.transaction(() => {
        const current = read();
        if (current.version !== input.expectedVersion) fail(409, 'VERSION_CONFLICT');
        db.prepare('UPDATE graph_knowledge_user SET data=? WHERE id=1').run(JSON.stringify(state));
      }).immediate();
      domain.flush();
      return { version: state.version, views: state.views };
    },
  };
}
export function canonical(state: Portable, id: string) {
  const seen = new Set<string>();
  while (Object.hasOwn(state.merges, id)) {
    if (seen.has(id) || seen.size >= 100) fail(409, 'GRAPH_MERGE_CYCLE');
    seen.add(id);
    id = state.merges[id];
  }
  return id;
}
