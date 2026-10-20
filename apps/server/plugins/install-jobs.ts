import { randomUUID } from 'node:crypto';
import type { AppDatabase } from '../../../packages/core/db.js';
import type { pluginHost } from './host.js';
import type { FastifyInstance } from 'fastify';
import { fail } from '../../../packages/core/knowledge/errors.js';
type Host = Pick<ReturnType<typeof pluginHost>, 'catalog' | 'list' | 'install'>;
type Row = {
  id: string;
  owner: string;
  request_id: string;
  plugin_id: string;
  version: string;
  status: string;
  phase: string;
  error: string | null;
  created_at: number;
  updated_at: number;
};
export function pluginInstallJobs(db: AppDatabase, host: Host, beforeAction: (id: string) => void = () => {}) {
  db.exec(
    'CREATE TABLE IF NOT EXISTS plugin_install_jobs(id TEXT PRIMARY KEY,owner TEXT NOT NULL,request_id TEXT NOT NULL,plugin_id TEXT NOT NULL,version TEXT NOT NULL,status TEXT NOT NULL,phase TEXT NOT NULL,error TEXT,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL,UNIQUE(owner,request_id));',
  );
  const active = new Map<string, { controller: AbortController; promise: Promise<void> }>();
  let closing = false;
  const view = (r: Row) => ({
    id: r.id,
    requestId: r.request_id,
    pluginId: r.plugin_id,
    version: r.version,
    status: r.status,
    phase: r.phase,
    ...(r.error ? { error: r.error } : {}),
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  });
  const getRow = (owner: string, id: string) => {
    const r = db
      .prepare('SELECT * FROM plugin_install_jobs WHERE id=? AND owner=?')
      .get(id, owner) as Row | undefined;
    if (!r) fail(404, 'PLUGIN_INSTALL_NOT_FOUND');
    return r;
  };
  for (const row of db
    .prepare("SELECT * FROM plugin_install_jobs WHERE status IN ('queued','running')")
    .all() as Row[]) {
    const installed = host
      .list()
      .some((p) => p.id === row.plugin_id && p.installedVersion === row.version);
    db.prepare(
      'UPDATE plugin_install_jobs SET status=?,phase=?,error=?,updated_at=? WHERE id=?',
    ).run(
      installed ? 'succeeded' : 'needs_reconciliation',
      installed ? 'complete' : row.phase,
      installed ? null : 'PLUGIN_INSTALL_INTERRUPTED',
      Date.now(),
      row.id,
    );
  }
  function start(owner: string, input: { id: string; requestId: string }) {
    if (closing) fail(503, 'PLUGIN_HOST_STOPPING');
    if (
      !input ||
      typeof input.id !== 'string' ||
      typeof input.requestId !== 'string' ||
      !/^[A-Za-z0-9_.:-]{1,128}$/.test(input.requestId)
    )
      fail(400, 'INVALID_REQUEST_ID');
    beforeAction(input.id);
    const entry = host.catalog().find((p) => p.id === input.id);
    if (!entry) fail(404, 'PLUGIN_NOT_IN_CATALOG');
    const previous = db
      .prepare('SELECT * FROM plugin_install_jobs WHERE owner=? AND request_id=?')
      .get(owner, input.requestId) as Row | undefined;
    if (previous) {
      if (previous.plugin_id !== input.id) fail(409, 'REQUEST_ID_REUSED');
      return view(previous);
    }
    const pending = db
      .prepare(
        "SELECT * FROM plugin_install_jobs WHERE plugin_id=? AND status IN ('queued','running')",
      )
      .get(input.id) as Row | undefined;
    if (pending) {
      if (pending.owner !== owner) fail(409, 'PLUGIN_INSTALL_BUSY');
      return view(pending);
    }
    const now = Date.now(),
      row: Row = {
        id: randomUUID(),
        owner,
        request_id: input.requestId,
        plugin_id: input.id,
        version: entry.version,
        status: 'queued',
        phase: 'queued',
        error: null,
        created_at: now,
        updated_at: now,
      };
    db.prepare('INSERT INTO plugin_install_jobs VALUES(?,?,?,?,?,?,?,?,?,?)').run(
      row.id,
      row.owner,
      row.request_id,
      row.plugin_id,
      row.version,
      row.status,
      row.phase,
      row.error,
      now,
      now,
    );
    const controller = new AbortController();
    const promise = new Promise<void>((resolve) => setImmediate(resolve)).then(async () => {
      db.prepare("UPDATE plugin_install_jobs SET status='running',updated_at=? WHERE id=?").run(
        Date.now(),
        row.id,
      );
      try {
        await host.install(row.plugin_id, {
          signal: controller.signal,
          onPhase: (phase) =>
            db
              .prepare('UPDATE plugin_install_jobs SET phase=?,updated_at=? WHERE id=?')
              .run(phase, Date.now(), row.id),
        });
        db.prepare(
          "UPDATE plugin_install_jobs SET status='succeeded',phase='complete',error=NULL,updated_at=? WHERE id=?",
        ).run(Date.now(), row.id);
      } catch (e) {
        const raw = (e as any)?.code || (e as any)?.name;
        const code = controller.signal.aborted
          ? 'PLUGIN_INSTALL_INTERRUPTED'
          : raw === 'TimeoutError'
            ? 'PLUGIN_DOWNLOAD_TIMEOUT'
            : /^[A-Z][A-Z0-9_]{1,63}$/.test(raw || '')
              ? raw
              : 'PLUGIN_INSTALL_FAILED';
        db.prepare('UPDATE plugin_install_jobs SET status=?,error=?,updated_at=? WHERE id=?').run(
          controller.signal.aborted ? 'needs_reconciliation' : 'failed',
          code,
          Date.now(),
          row.id,
        );
      } finally {
        active.delete(row.id);
      }
    });
    active.set(row.id, { controller, promise });
    return view(row);
  }
  return {
    start,
    get: (owner: string, id: string) => view(getRow(owner, id)),
    list: (owner: string) =>
      (
        db
          .prepare(
            'SELECT * FROM plugin_install_jobs WHERE owner=? ORDER BY created_at DESC LIMIT 20',
          )
          .all(owner) as Row[]
      ).map(view),
    close: async () => {
      closing = true;
      for (const task of active.values()) task.controller.abort();
      await Promise.allSettled([...active.values()].map((t) => t.promise));
    },
  };
}
export function registerPluginInstallRoutes(
  app: FastifyInstance,
  jobs: ReturnType<typeof pluginInstallJobs>,
) {
  app.get('/api/platform/plugin-installations', async (req) => ({
    items: jobs.list((req as any).ownerId),
  }));
  app.get<{ Params: { id: string } }>('/api/platform/plugin-installations/:id', async (req) =>
    jobs.get((req as any).ownerId, req.params.id),
  );
  app.post('/api/platform/plugin-installations', async (req, reply) =>
    reply.code(202).send(jobs.start((req as any).ownerId, req.body as any)),
  );
}
