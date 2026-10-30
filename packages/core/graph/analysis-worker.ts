import type { AppConfig } from '../../../shared/contracts.js';
import type { GraphModelPort } from '../../../shared/graph-semantic-contracts.js';
import type { AppDatabase } from '../db.js';
import { workspaceRead, workspaceProcess, processIsAlive } from '../workspace/gate.js';
import { sourceAccess, hash } from './analysis-source.js';
import { publishLookup } from './analysis-lookup.js';
import { analysisDiscovery } from './analysis-discovery.js';
import { analyzer, chunks } from './analysis-content.js';
export function analysisWorker(
  config: AppConfig,
  db: AppDatabase,
  model: GraphModelPort,
  access: ReturnType<typeof sourceAccess>,
) {
  let timer: ReturnType<typeof setTimeout> | undefined,
    closed = false,
    started = false,
    running: Promise<void> | undefined,
    abort: AbortController | undefined,
    cursor = 0;
  const discovery = analysisDiscovery(config, db, access);
  const process = workspaceProcess();
  for (const job of db
    .prepare("SELECT note_id,owner_pid,owner_start FROM graph_analysis_jobs WHERE state='running'")
    .all() as { note_id: string; owner_pid: number; owner_start: string }[])
    if (!job.owner_pid || !job.owner_start || !processIsAlive(job.owner_pid, job.owner_start))
      db.prepare(
        "UPDATE graph_analysis_jobs SET state='queued',epoch=epoch+1,lease_until=0,next_run=0 WHERE note_id=?",
      ).run(job.note_id);
  let fingerprint = model.fingerprint();
  let ownJob: { id: string; epoch: number } | undefined;
  const getMeta = (key: string) =>
    (db.prepare('SELECT value FROM graph_analysis_meta WHERE key=?').get(key) as any)?.value;
  const setMeta = (key: string, value: string) =>
    db
      .prepare(
        'INSERT INTO graph_analysis_meta VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value',
      )
      .run(key, value);
  function enqueue(id: string) {
    db.prepare('DELETE FROM graph_analysis_sources WHERE note_id=?').run(id);
    db.prepare(
      `INSERT INTO graph_analysis_jobs(note_id) VALUES(?) ON CONFLICT(note_id) DO UPDATE SET state='queued',epoch=epoch+1,attempts=0,lease_until=0,next_run=0,error=NULL,checkpoint=0`,
    ).run(id);
  }
  function compensate() {
    // Keyset page, never a whole-library filesystem scan per tick. Host DB triggers handle managed writes.
    const rows = db
      .prepare(
        `SELECT n.rowid AS seq,n.id,n.path,n.active,s.fingerprint,s.path AS old_path,j.state,j.observed_fingerprint FROM notes n LEFT JOIN graph_analysis_sources s ON s.note_id=n.id LEFT JOIN graph_analysis_jobs j ON j.note_id=n.id WHERE n.rowid>? ORDER BY n.rowid LIMIT 24`,
      )
      .all(cursor) as any[];
    if (!rows.length) {
      cursor = 0;
      return;
    }
    for (const row of rows) {
      cursor = row.seq;
      if (!row.active || !/\.md$/i.test(row.path)) {
        db.prepare('DELETE FROM graph_analysis_sources WHERE note_id=?').run(row.id);
        db.prepare('DELETE FROM graph_analysis_jobs WHERE note_id=?').run(row.id);
        continue;
      }
      if (row.state === 'running' || row.state === 'queued' || row.state === 'canceled') continue;
      try {
        const actual = access.inspect(row.path);
        if (
          !row.state ||
          (row.fingerprint &&
            (row.fingerprint !== actual.fingerprint || row.old_path !== row.path)) ||
          (row.state === 'done' && !row.fingerprint) ||
          (row.state === 'failed' && row.observed_fingerprint !== actual.fingerprint)
        )
          enqueue(row.id);
      } catch {
        db.prepare('DELETE FROM graph_analysis_sources WHERE note_id=?').run(row.id);
        if (row.state === 'done')
          db.prepare(
            "UPDATE graph_analysis_jobs SET state='failed',error='SOURCE_UNAVAILABLE' WHERE note_id=?",
          ).run(row.id);
      }
    }
  }
  async function processOne() {
    access.barrier();
    const settings = model.settings(),
      nextFingerprint = model.fingerprint();
    if (nextFingerprint !== fingerprint || getMeta('config') !== nextFingerprint) {
      fingerprint = nextFingerprint;
      setMeta('config', fingerprint);
      db.exec(
        "DELETE FROM graph_analysis_sources; UPDATE graph_analysis_jobs SET state='queued',epoch=epoch+1,attempts=0,next_run=0,error=NULL,checkpoint=0",
      );
    }
    if (getMeta('paused') === '1' || (!settings.automatic && getMeta('manual_run') !== '1')) return;
    discovery.step();
    compensate();
    const now = Date.now();
    const job = db
      .prepare(
        `SELECT j.* FROM graph_analysis_jobs j JOIN notes n ON n.id=j.note_id WHERE n.active=1 AND lower(n.path) LIKE '%.md' AND ((j.state='queued' AND j.next_run<=?) OR (j.state='running' AND j.lease_until<?) OR (j.state='failed' AND j.attempts<3 AND j.next_run>0 AND j.next_run<=?)) ORDER BY j.next_run,j.rowid LIMIT 1`,
      )
      .get(now, now, now) as any;
    if (!job) {
      if (
        !db
          .prepare(
            "SELECT 1 FROM graph_analysis_jobs j JOIN notes n ON n.id=j.note_id WHERE n.active=1 AND (j.state IN ('queued','running') OR (j.state='failed' AND j.attempts<3 AND j.next_run>0)) LIMIT 1",
          )
          .get()
      )
        setMeta('manual_run', '0');
      return;
    }
    const source = access.current(job.note_id);
    if (!source) {
      db.prepare('UPDATE graph_analysis_jobs SET next_run=? WHERE note_id=?').run(
        now + 2000,
        job.note_id,
      );
      return;
    }
    const epoch = job.epoch + 1;
    const claimed = db
      .prepare(
        "UPDATE graph_analysis_jobs SET state='running',epoch=?,lease_until=?,attempts=attempts+1,error=NULL,checkpoint=0,owner_pid=?,owner_start=? WHERE note_id=? AND epoch=?",
      )
      .run(epoch, now + 180000, process.pid, process.start, source.id, job.epoch);
    if (!claimed.changes) return;
    ownJob = { id: source.id, epoch };
    abort = new AbortController();
    const signal = abort.signal;
    const timer = setTimeout(() => abort?.abort(), 120000);
    timer.unref();
    let deadlineError = false;
    const interrupted = new Promise<never>((_, reject) =>
      signal.addEventListener(
        'abort',
        () => {
          deadlineError = true;
          reject(Error('ANALYSIS_CANCELED'));
        },
        { once: true },
      ),
    );
    void interrupted.catch(() => {});
    try {
      const input = access.read(source.path),
        sourceHash = hash(input.text),
        work = analyzer(
          input.text,
          source.path,
          source.id,
          sourceHash,
          source.source_revision ?? 0,
        );
      db.prepare(
        'UPDATE graph_analysis_jobs SET observed_fingerprint=? WHERE note_id=? AND epoch=?',
      ).run(input.fingerprint, source.id, epoch);
      const chunked = chunks(
        input.text,
        Math.min(12000, Math.max(100, settings.maxInputCharacters)),
      );
      let error: string | null = null;
      for (let index = 0; index < chunked.parts.length; index++) {
        if (signal.aborted) throw Error('ANALYSIS_CANCELED');
        const part = chunked.parts[index];
        work.local(part);
        if (
          settings.provider !== 'none' &&
          !model.settings().automatic &&
          getMeta('manual_run') !== '1'
        )
          error = 'MODEL_PAUSED';
        if (settings.provider !== 'none' && !error) {
          try {
            const extraction = await Promise.race([model.extract(part.text, signal), interrupted]);
            work.enhance(part, extraction, settings.model);
          } catch (e) {
            if (signal.aborted) throw e;
            error = 'MODEL_EXTRACTION_FAILED';
          }
        }
        db.prepare('UPDATE graph_analysis_jobs SET checkpoint=? WHERE note_id=? AND epoch=?').run(
          index + 1,
          source.id,
          epoch,
        );
        if (index % 8 === 0) await new Promise<void>((r) => setImmediate(r));
        access.barrier();
        const jobNow = db
          .prepare('SELECT epoch,state FROM graph_analysis_jobs WHERE note_id=?')
          .get(source.id) as any;
        if (
          closed ||
          signal.aborted ||
          getMeta('paused') === '1' ||
          jobNow?.epoch !== epoch ||
          jobNow.state !== 'running' ||
          model.fingerprint() !== fingerprint ||
          !access.valid({ ...source, fingerprint: input.fingerprint })
        )
          throw Error('SOURCE_CHANGED');
      }
      const result = work.result(chunked.partial);
      if (result.partial && !error) error = 'PARTIAL_SOURCE_LIMIT';
      db.transaction(() => {
        access.barrier();
        const jobNow = db
          .prepare('SELECT epoch,state FROM graph_analysis_jobs WHERE note_id=?')
          .get(source.id) as any;
        if (
          signal.aborted ||
          closed ||
          jobNow?.epoch !== epoch ||
          jobNow.state !== 'running' ||
          model.fingerprint() !== fingerprint ||
          !access.valid({ ...source, fingerprint: input.fingerprint })
        )
          throw Error('SOURCE_CHANGED');
        db.prepare('INSERT OR REPLACE INTO graph_analysis_sources VALUES(?,?,?,?,?,?,?,?)').run(
          source.id,
          source.path,
          input.fingerprint,
          source.source_revision,
          source.managed_hash,
          fingerprint,
          JSON.stringify(result),
          new Date().toISOString(),
        );
        publishLookup(db, source.id, source.path, result);
        db.prepare(
          'UPDATE graph_analysis_jobs SET state=?,error=?,lease_until=0,next_run=? WHERE note_id=? AND epoch=?',
        ).run(
          error ? 'failed' : 'done',
          error,
          error === 'MODEL_EXTRACTION_FAILED' ? Date.now() + 5000 : 0,
          source.id,
          epoch,
        );
      }).immediate();
    } catch (e) {
      const code =
        e instanceof Error &&
        ['SOURCE_TOO_LARGE', 'UNSAFE_SOURCE', 'SOURCE_CHANGED', 'ANALYSIS_CANCELED'].includes(
          e.message,
        )
          ? e.message
          : 'SOURCE_UNAVAILABLE';
      db.transaction(() => {
        const current = db
          .prepare(
            'SELECT epoch,state,owner_pid,owner_start FROM graph_analysis_jobs WHERE note_id=?',
          )
          .get(source.id) as
          | { epoch: number; state: string; owner_pid: number; owner_start: string }
          | undefined;
        if (
          !current ||
          current.epoch !== epoch ||
          current.state !== 'running' ||
          current.owner_pid !== process.pid ||
          current.owner_start !== process.start
        )
          return;
        db.prepare('DELETE FROM graph_analysis_sources WHERE note_id=?').run(source.id);
        db.prepare(
          'UPDATE graph_analysis_jobs SET state=?,error=?,lease_until=0,next_run=? WHERE note_id=? AND epoch=?',
        ).run(
          code === 'SOURCE_CHANGED' ? 'queued' : 'failed',
          deadlineError ? 'ANALYSIS_CANCELED' : code,
          Date.now() + 2000,
          source.id,
          epoch,
        );
      }).immediate();
    } finally {
      clearTimeout(timer);
      abort = undefined;
      ownJob = undefined;
    }
  }
  function schedule(delay = 250) {
    if (closed || !started) return;
    timer = setTimeout(() => {
      timer = undefined;
      running = workspaceRead(db, { kind: 'graph.analysis' }, processOne)
        .catch(() => {})
        .finally(() => {
          running = undefined;
          schedule();
        });
    }, delay);
    timer.unref();
  }
  return {
    start() {
      if (started || closed) return;
      started = true;
      schedule(0);
    },
    enqueue,
    paused() {
      return getMeta('paused') === '1';
    },
    manual() {
      return getMeta('manual_run') === '1';
    },
    control(action: 'pause' | 'resume' | 'retry' | 'rebuild' | 'cancel') {
      if (action === 'pause' || action === 'cancel') {
        setMeta('paused', '1');
        setMeta('manual_run', '0');
        abort?.abort();
        db.prepare(
          "UPDATE graph_analysis_jobs SET state=?,epoch=epoch+1,lease_until=0 WHERE state IN ('running','queued')",
        ).run(action === 'cancel' ? 'canceled' : 'queued');
      } else {
        setMeta('paused', '0');
        setMeta('manual_run', '1');
        if (action === 'rebuild') {
          abort?.abort();
          db.exec(
            "DELETE FROM graph_analysis_sources; UPDATE graph_analysis_jobs SET state='queued',epoch=epoch+1,attempts=0,next_run=0,error=NULL,checkpoint=0",
          );
        } else
          db.exec(
            "UPDATE graph_analysis_jobs SET state='queued',epoch=epoch+1,attempts=0,next_run=0,error=NULL WHERE state IN ('failed','canceled')",
          );
      }
    },
    async close() {
      closed = true;
      discovery.close();
      if (timer) clearTimeout(timer);
      const job = ownJob;
      abort?.abort();
      await running;
      if (job)
        db.prepare(
          "UPDATE graph_analysis_jobs SET state='queued',epoch=epoch+1,lease_until=0,next_run=0 WHERE note_id=? AND epoch=?",
        ).run(job.id, job.epoch);
    },
  };
}
