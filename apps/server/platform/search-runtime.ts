import { createHash, randomBytes } from 'node:crypto';
import { artifactFetch } from './distribution.js';
import { existsSync, readFileSync, createReadStream } from 'node:fs';
import {
  mkdir,
  open,
  readFile,
  writeFile,
  rename,
  rm,
  copyFile,
  lstat,
  readdir,
  statfs,
} from 'node:fs/promises';
import { join, dirname, resolve } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:net';
import type { HostConfig, SearchDistribution } from '../../../shared/platform-contracts.js';
import type { AppDatabase } from '../../../packages/core/db.js';
import type { platformRuntime } from './runtime.js';
import { guardedProcess } from '../../../packages/core/processes/guarded.js';
import {
  workspaceProcess,
  processIsAlive,
  guardIsAlive,
  processGroupIsAlive,
} from '../../../packages/core/workspace/gate.js';
import {
  beginOperation,
  existingResult,
  completeOperation,
} from '../../../packages/core/knowledge/operations.js';
import { webPrincipal } from '../../../packages/core/knowledge/core.js';
import { fail } from '../../../packages/core/knowledge/errors.js';
import { privateFile } from '../../../packages/core/agent/config.js';
const PYTHON_SHA = 'e17275eaf95ceb5877aa6816e209b7733f41fee401d39c3921b88fb73fc4a4ba';
const MODEL_MANIFEST_SHA = 'd0c67f164fa76600fc586e2fea0f9b5ca7866fc7b78f7486d9ed7e472c017b01';
const SPACE = '6fabd979756dff4dc79f1430da4cdff500badfb47db0eb8c0d4b07b02770faf5';
const REVISION = '7999e1d3359715c523056ef9478215996d62a620';
async function digest(file: string) {
  const h = createHash('sha256');
  for await (const block of createReadStream(file)) h.update(block);
  return h.digest('hex');
}
function failure(code: string): never {
  return fail(503, code, code, true);
}
export function searchRuntimeManager(
  config: HostConfig,
  db: AppDatabase,
  platform: ReturnType<typeof platformRuntime>,
) {
  db.exec(`CREATE TABLE IF NOT EXISTS search_preparations(id TEXT PRIMARY KEY REFERENCES operations(id),owner_id TEXT NOT NULL,distribution_json TEXT NOT NULL,state TEXT NOT NULL DEFAULT 'queued',phase TEXT NOT NULL DEFAULT 'queued',completed_bytes INTEGER NOT NULL DEFAULT 0,total_bytes INTEGER NOT NULL,error TEXT,cancel_requested INTEGER NOT NULL DEFAULT 0,runner_pid INTEGER,runner_start TEXT,updated_at INTEGER NOT NULL);
  CREATE UNIQUE INDEX IF NOT EXISTS one_search_preparation ON search_preparations((1)) WHERE state IN ('queued','running');
  CREATE TABLE IF NOT EXISTS search_runtime(id INTEGER PRIMARY KEY CHECK(id=1),task_id TEXT NOT NULL,active_json TEXT NOT NULL,parent_pid INTEGER NOT NULL,parent_start TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS search_processes(task_id TEXT NOT NULL,role TEXT NOT NULL,pid INTEGER NOT NULL,process_start TEXT NOT NULL,process_group INTEGER NOT NULL,PRIMARY KEY(task_id,role,pid,process_start));`);
  const metadata = config.applicationRoot && join(config.applicationRoot, 'search-runtime.json');
  const distribution: SearchDistribution | undefined =
    config.searchDistribution ||
    (metadata && existsSync(metadata) ? JSON.parse(readFileSync(metadata, 'utf8')) : undefined);
  const runtimeRoot = resolve(config.searchRuntimeRoot || join(config.dataRoot, '..', 'runtimes'));
  const modelsRoot = resolve(config.searchModelsRoot || join(config.dataRoot, '..', 'models'));
  const cacheRoot = resolve(
    config.searchCacheRoot ||
      join(process.env.XDG_CACHE_HOME || join(homedir(), '.cache'), 'doo-know/search'),
  );
  const externallyManaged = !!(
    config.vectorServiceUrl ||
    config.tokenizerPython ||
    config.modelDir
  );
  let startup: Promise<void> | undefined;
  const terminal = new Map<string, { state: string; code: string }>();
  let running: Promise<void> | undefined,
    controller: AbortController | undefined,
    closing = false,
    runtimeError: string | undefined;
  let vector: ReturnType<typeof guardedProcess> | undefined;
  const self = workspaceProcess();
  function task(id: string) {
    const row = db.prepare('SELECT * FROM search_preparations WHERE id=?').get(id) as any;
    if (!row) fail(404, 'SEARCH_TASK_NOT_FOUND');
    return row;
  }
  const actor = (owner: string) => ({ ...webPrincipal, id: owner, clientId: 'platform-web' });
  function stages(id: string, phase: string) {
    db.prepare('UPDATE search_preparations SET phase=?,updated_at=? WHERE id=?').run(
      phase,
      Date.now(),
      id,
    );
  }
  function aliveChildren(id: string) {
    return (db.prepare('SELECT * FROM search_processes WHERE task_id=?').all(id) as any[]).some(
      guardIsAlive,
    );
  }
  function recover() {
    for (const [id, failed] of terminal)
      try {
        db.transaction(() => {
          db.prepare(
            'UPDATE search_preparations SET state=?,phase=?,error=?,updated_at=? WHERE id=?',
          ).run(failed.state, failed.state, failed.code, Date.now(), id);
          db.prepare('UPDATE operations SET status=?,error=?,updated_at=? WHERE id=?').run(
            failed.state,
            failed.code,
            Date.now(),
            id,
          );
        }).immediate();
        terminal.delete(id);
      } catch {
        runtimeError = 'SEARCH_STORAGE_UNAVAILABLE';
      }
    for (const row of db
      .prepare("SELECT * FROM search_preparations WHERE state IN ('queued','running')")
      .all() as any[]) {
      if (
        (row.runner_pid && processIsAlive(row.runner_pid, row.runner_start)) ||
        aliveChildren(row.id)
      )
        continue;
      db.transaction(() => {
        db.prepare(
          "UPDATE search_preparations SET state='failed',phase='interrupted',error='PREPARATION_INTERRUPTED',updated_at=? WHERE id=?",
        ).run(Date.now(), row.id);
        db.prepare(
          "UPDATE operations SET status='failed',error='PREPARATION_INTERRUPTED',updated_at=? WHERE id=?",
        ).run(Date.now(), row.id);
      }).immediate();
    }
    for (const p of db.prepare('SELECT * FROM search_processes').all() as any[])
      if (!guardIsAlive(p))
        db.prepare(
          'DELETE FROM search_processes WHERE task_id=? AND role=? AND pid=? AND process_start=?',
        ).run(p.task_id, p.role, p.pid, p.process_start);
  }
  function safeSource(d: SearchDistribution) {
    if (
      !d ||
      !/^[a-z0-9][a-z0-9.-]{0,100}$/.test(d.version) ||
      d.platform !== 'linux-x64' ||
      d.pythonVersion !== '3.14.4' ||
      d.spaceId !== SPACE ||
      d.modelRevision !== REVISION ||
      !Number.isSafeInteger(d.bytes) ||
      d.bytes <= 0 ||
      d.bytes > 2 * 1024 ** 3 ||
      !/^[a-f0-9]{64}$/.test(d.sha256)
    )
      failure('INVALID_SEARCH_DISTRIBUTION');
    const url = new URL(d.url);
    if (
      url.username ||
      url.password ||
      url.hash ||
      (!['https:', 'file:'].includes(url.protocol) &&
        !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)))
    )
      failure('INVALID_SEARCH_SOURCE');
    return url;
  }
  function environment(id = 'runtime') {
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env))
      if (
        v !== undefined &&
        !k.startsWith('PYTHON') &&
        !k.startsWith('PIP_') &&
        !k.startsWith('NODE_') &&
        !['LD_PRELOAD', 'LD_LIBRARY_PATH', 'BASH_ENV', 'ENV'].includes(k)
      )
        env[k] = v;
    return {
      ...env,
      TMPDIR: join(runtimeRoot, 'tmp', id),
      PYTHONNOUSERSITE: '1',
      PYTHONUNBUFFERED: '1',
      PYTHONPATH: resolve(config.vectorRuntimeRoot || 'runtime/vector-service'),
      HF_HUB_OFFLINE: '1',
      TRANSFORMERS_OFFLINE: '1',
      HF_HUB_DISABLE_TELEMETRY: '1',
      PIP_CONFIG_FILE: '/dev/null',
      PIP_NO_INDEX: '1',
      PIP_NO_CACHE_DIR: '1',
      PIP_DISABLE_PIP_VERSION_CHECK: '1',
    };
  }
  async function command(id: string, binary: string, args: string[], signal: AbortSignal) {
    signal.throwIfAborted();
    const result = await guardedProcess(
      db,
      { kind: 'search', taskId: id, role: 'preparation' },
      binary,
      args,
      runtimeRoot,
      { env: environment(id), signal, timeoutMs: 600000, maxBytes: 4 * 1024 * 1024 },
    ).wait;
    signal.throwIfAborted();
    if (result.code !== 0) {
      await writeFile(
        join(config.dataRoot, 'search-preparation-error.log'),
        result.stderr.toString('utf8').slice(-8192).split(config.secret).join('[REDACTED]'),
        { mode: 0o600 },
      ).catch(() => {});
      if (/Disk quota exceeded|No space left on device/.test(result.stderr.toString('utf8')))
        failure('INSUFFICIENT_SEARCH_DISK_SPACE');
      failure('SEARCH_' + task(id).phase.toUpperCase() + '_FAILED');
    }
    return result.stdout.toString('utf8');
  }
  async function download(id: string, d: SearchDistribution, signal: AbortSignal) {
    const source = safeSource(d);
    await mkdir(cacheRoot, { recursive: true, mode: 0o700 });
    const target = join(cacheRoot, d.sha256 + '.tar.gz');
    if (existsSync(target) && (await digest(target)) === d.sha256) {
      db.prepare('UPDATE search_preparations SET completed_bytes=? WHERE id=?').run(d.bytes, id);
      return target;
    }
    const fd = await open(target + '.part', 'w', 0o600);
    let total = 0,
      last = 0;
    const h = createHash('sha256');
    try {
      let stream: AsyncIterable<Buffer | Uint8Array>;
      if (source.protocol === 'file:') stream = createReadStream(fileURLToPath(source));
      else {
        const response = await artifactFetch(config, source, signal);
        if (!response.ok || Number(response.headers.get('content-length') || 0) > d.bytes)
          failure('SEARCH_DOWNLOAD_FAILED');
        stream = response.body as any;
      }
      for await (const bytes of stream) {
        signal.throwIfAborted();
        total += bytes.length;
        if (total > d.bytes) failure('SEARCH_DISTRIBUTION_TOO_LARGE');
        h.update(bytes);
        await fd.writeFile(bytes);
        if (total - last > 1024 * 1024) {
          db.prepare(
            'UPDATE search_preparations SET completed_bytes=?,updated_at=? WHERE id=?',
          ).run(total, Date.now(), id);
          last = total;
        }
      }
      if (total !== d.bytes || h.digest('hex') !== d.sha256) failure('SEARCH_CHECKSUM_MISMATCH');
      await fd.sync();
    } finally {
      await fd.close();
    }
    await rename(target + '.part', target);
    db.prepare('UPDATE search_preparations SET completed_bytes=? WHERE id=?').run(total, id);
    return target;
  }
  function safeNames(output: string, prefix = '') {
    for (const name of output.trim().split('\n'))
      if (
        !name ||
        name.startsWith('/') ||
        !name.startsWith(prefix) ||
        name.split('/').some((p) => p === '..') ||
        /[\x00-\x1f]/.test(name)
      )
        failure('INVALID_SEARCH_ARCHIVE');
  }
  async function port() {
    const server = createServer();
    await new Promise<void>((yes, no) => {
      server.once('error', no);
      server.listen(0, '127.0.0.1', () => yes());
    });
    const number = (server.address() as any).port as number;
    await new Promise<void>((r) => server.close(() => r()));
    return number;
  }
  async function stopRuntime() {
    if (!vector) return;
    const previous = vector;
    vector = undefined;
    let done = false;
    try {
      if (previous.child.pid) process.kill(-previous.child.pid, 'SIGTERM');
    } catch {}
    const force = setTimeout(() => {
      if (!done)
        try {
          if (previous.child.pid) process.kill(-previous.child.pid, 'SIGKILL');
        } catch {}
    }, 5000);
    force.unref();
    try {
      await previous.wait.catch(() => {});
    } finally {
      done = true;
      clearTimeout(force);
    }
  }
  async function activate(active: any, id: string) {
    if (
      resolve(active.directory) !== join(runtimeRoot, active.version) ||
      resolve(active.modelDir) !== join(modelsRoot, 'bge-small-zh-v1.5', REVISION)
    )
      failure('SEARCH_RUNTIME_CONFIGURATION_CONFLICT');
    const existing = db
      .prepare('SELECT parent_pid,parent_start FROM search_runtime WHERE id=1')
      .get() as any;
    if (
      existing &&
      existing.parent_pid !== self.pid &&
      processIsAlive(existing.parent_pid, existing.parent_start)
    )
      failure('SEARCH_RUNTIME_OWNED_BY_OTHER_PROCESS');
    await stopRuntime();
    for (const old of db
      .prepare("SELECT * FROM search_processes WHERE role='runtime'")
      .all() as any[]) {
      if (guardIsAlive(old)) {
        try {
          process.kill(-old.process_group, 'SIGTERM');
        } catch {}
        const until = Date.now() + 10000;
        while (processGroupIsAlive(old.process_group) && Date.now() < until)
          await new Promise((r) => setTimeout(r, 25));
        if (processGroupIsAlive(old.process_group)) failure('PREVIOUS_SEARCH_RUNTIME_RUNNING');
      }
    }
    const key = join(
      config.secretFile ? dirname(config.secretFile) : join(config.dataRoot, 'secrets'),
      'vector.key',
    );
    await mkdir(dirname(key), { recursive: true, mode: 0o700 });
    if (!existsSync(key))
      await writeFile(key, randomBytes(48).toString('base64url'), { mode: 0o600, flag: 'wx' });
    const token = privateFile(key, 8192).trim();
    await mkdir(join(runtimeRoot, 'tmp', 'runtime'), { recursive: true, mode: 0o700 });
    const number = await port(),
      url = 'http://127.0.0.1:' + number;
    db.prepare(
      'INSERT INTO search_runtime VALUES(1,?,?,?,?) ON CONFLICT(id) DO UPDATE SET task_id=excluded.task_id,active_json=excluded.active_json,parent_pid=excluded.parent_pid,parent_start=excluded.parent_start',
    ).run(id, JSON.stringify(active), self.pid, self.start);
    vector = guardedProcess(
      db,
      { kind: 'search', taskId: id, role: 'runtime' },
      join(active.directory, 'venv/bin/python'),
      [
        join(resolve(config.vectorRuntimeRoot || 'runtime/vector-service'), 'app.py'),
        '--model-dir',
        active.modelDir,
        '--index-root',
        join(config.dataRoot, 'indexes'),
        '--token-file',
        key,
        '--host',
        '127.0.0.1',
        '--port',
        String(number),
      ],
      runtimeRoot,
      { env: environment(), timeoutMs: 0, maxBytes: 256 * 1024 },
    );
    let exited = false;
    const child = vector;
    void child.wait.then(
      () => {
        exited = true;
        runtimeError = 'VECTOR_RUNTIME_EXITED';
      },
      () => {
        exited = true;
        runtimeError = 'VECTOR_RUNTIME_FAILED';
      },
    );
    const until = Date.now() + 45000;
    let ready = false;
    while (Date.now() < until && !closing && !exited && !task(id).cancel_requested) {
      try {
        const response = await fetch(url + '/describe', {
          headers: { authorization: 'Bearer ' + token },
          signal: AbortSignal.timeout(1000),
        });
        const value = await response.json();
        if (response.ok && value.spaceId === SPACE && value.dimensions === 512) {
          ready = true;
          break;
        }
      } catch {}
      await new Promise((r) => setTimeout(r, 100));
    }
    if (!ready) {
      await stopRuntime();
      failure('SEARCH_RUNTIME_START_FAILED');
    }
    await platform.reconfigureSearch({
      tokenizerPython: join(active.directory, 'venv/bin/python'),
      modelDir: active.modelDir,
      vectorServiceUrl: url,
      vectorServiceToken: token,
      embeddingSpaceId: SPACE,
    });
    await platform.get().knowledge.worker.capabilities(true);
    runtimeError = undefined;
  }
  async function run(id: string) {
    const abort = new AbortController();
    controller = abort;
    const signal = abort.signal;
    let previousActive: any;
    try {
      const row = task(id),
        d: SearchDistribution = JSON.parse(row.distribution_json);
      safeSource(d);
      platform.get();
      db.prepare(
        "UPDATE search_preparations SET state='running',runner_pid=?,runner_start=?,updated_at=? WHERE id=? AND state='queued'",
      ).run(self.pid, self.start, Date.now(), id);
      db.prepare("UPDATE operations SET status='running' WHERE id=?").run(id);
      await mkdir(join(runtimeRoot, 'tmp', id), { recursive: true, mode: 0o700 });
      const disk = await statfs(runtimeRoot);
      if (disk.bavail * disk.bsize < d.bytes * 4 + 128 * 1024 * 1024)
        failure('INSUFFICIENT_SEARCH_DISK_SPACE');
      const raw = platform.get().config.knowledgeRoot;
      for (const target of [runtimeRoot, modelsRoot, cacheRoot])
        if (target === raw || target.startsWith(raw + '/') || raw.startsWith(target + '/'))
          failure('SEARCH_PATH_CONFLICT');
      stages(id, 'downloading');
      const archive = await download(id, d, signal);
      stages(id, 'verifying');
      const directory = join(runtimeRoot, d.version),
        bundle = join(directory, 'bundle');
      await mkdir(bundle, { recursive: true, mode: 0o700 });
      const names = await command(id, '/usr/bin/tar', ['-tzf', archive], signal);
      safeNames(names);
      const types = await command(id, '/usr/bin/tar', ['-tvzf', archive], signal);
      if (
        types
          .trim()
          .split('\n')
          .some((line) => !['-', 'd'].includes(line[0]))
      )
        failure('INVALID_SEARCH_ARCHIVE');
      await command(
        id,
        '/usr/bin/tar',
        ['-xzf', archive, '--no-same-owner', '--no-same-permissions', '-C', bundle],
        signal,
      );
      const info = JSON.parse(await readFile(join(bundle, 'bundle.json'), 'utf8'));
      if (
        info.version !== d.version ||
        info.spaceId !== SPACE ||
        info.files['python.tar.gz'] !== PYTHON_SHA
      )
        failure('INVALID_SEARCH_DISTRIBUTION');
      for (const [name, expected] of Object.entries(info.files)) {
        if (
          typeof expected !== 'string' ||
          !/^([a-zA-Z0-9._+-]+\/)*[a-zA-Z0-9._+-]+$/.test(name) ||
          name.split('/').some((p) => p === '..')
        )
          failure('INVALID_SEARCH_DISTRIBUTION');
        const file = join(bundle, name);
        const st = await lstat(file);
        if (!st.isFile() || st.isSymbolicLink() || (await digest(file)) !== expected)
          failure('SEARCH_CHECKSUM_MISMATCH');
      }
      if ((await digest(join(bundle, 'python.tar.gz'))) !== PYTHON_SHA)
        failure('SEARCH_CHECKSUM_MISMATCH');
      const inner = await command(
        id,
        '/usr/bin/tar',
        ['-tzf', join(bundle, 'python.tar.gz')],
        signal,
      );
      safeNames(inner, 'python/');
      if (!existsSync(join(directory, '.python-ready'))) {
        await rm(join(directory, 'python'), { recursive: true, force: true });
        await command(
          id,
          '/usr/bin/tar',
          ['-xzf', join(bundle, 'python.tar.gz'), '--no-same-owner', '-C', directory],
          signal,
        );
        await writeFile(join(directory, '.python-ready'), PYTHON_SHA, { mode: 0o600 });
      }
      const modelDir = join(modelsRoot, 'bge-small-zh-v1.5', REVISION);
      await mkdir(modelDir, { recursive: true, mode: 0o700 });
      if ((await digest(join(bundle, 'model/dooknow-model-manifest.json'))) !== MODEL_MANIFEST_SHA)
        failure('MODEL_MANIFEST_MISMATCH');
      const manifest = JSON.parse(
        await readFile(join(bundle, 'model/dooknow-model-manifest.json'), 'utf8'),
      );
      if (manifest.revision !== REVISION) failure('MODEL_REVISION_MISMATCH');
      for (const name of [...Object.keys(manifest.sha256), 'dooknow-model-manifest.json']) {
        const source = join(bundle, 'model', name),
          target = join(modelDir, name);
        await mkdir(dirname(target), { recursive: true, mode: 0o700 });
        if (existsSync(target)) {
          if ((await digest(target)) !== (await digest(source)))
            failure('EXISTING_MODEL_CHECKSUM_MISMATCH');
        } else await copyFile(source, target);
      }
      stages(id, 'creating_venv');
      const python = join(directory, 'python/bin/python3.14'),
        venv = join(directory, 'venv');
      if (!existsSync(join(directory, '.venv-ready'))) {
        await rm(venv, { recursive: true, force: true });
        await command(id, python, ['-m', 'venv', venv], signal);
        await writeFile(join(directory, '.venv-ready'), 'created', { mode: 0o600 });
      }
      stages(id, 'installing');
      await command(
        id,
        join(venv, 'bin/python'),
        [
          '-m',
          'pip',
          '--isolated',
          '--no-input',
          '--disable-pip-version-check',
          'install',
          '--quiet',
          '--no-index',
          '--require-hashes',
          '--find-links',
          join(bundle, 'wheelhouse'),
          '-r',
          join(bundle, 'requirements.txt'),
        ],
        signal,
      );
      stages(id, 'validating_model');
      const checked = await command(
        id,
        join(venv, 'bin/python'),
        [
          '-c',
          "import sys,json;from embedding import Embedding;e=Embedding(sys.argv[1]);print(json.dumps({'spaceId':e.space_id,'dimension':e.dimension}))",
          modelDir,
        ],
        signal,
      );
      const valid = JSON.parse(checked.trim());
      if (valid.spaceId !== SPACE || valid.dimension !== 512) failure('EMBEDDING_SPACE_MISMATCH');
      signal.throwIfAborted();
      previousActive = db.prepare('SELECT * FROM search_runtime WHERE id=1').get();
      stages(id, 'starting');
      await activate(
        { directory, modelDir, version: d.version, pythonVersion: d.pythonVersion },
        id,
      );
      signal.throwIfAborted();
      db.transaction(() => {
        db.prepare(
          "UPDATE search_preparations SET state='succeeded',phase='ready',error=NULL,updated_at=? WHERE id=?",
        ).run(Date.now(), id);
        completeOperation(db, id, { taskId: id, status: 'succeeded', version: d.version });
      }).immediate();
    } catch (e) {
      const cancelled = abort.signal.aborted || task(id).cancel_requested;
      if (cancelled && task(id).phase === 'starting') {
        await stopRuntime();
        if (previousActive)
          db.prepare(
            'INSERT INTO search_runtime VALUES(1,?,?,?,?) ON CONFLICT(id) DO UPDATE SET task_id=excluded.task_id,active_json=excluded.active_json,parent_pid=excluded.parent_pid,parent_start=excluded.parent_start',
          ).run(previousActive.task_id, previousActive.active_json, self.pid, self.start);
        else db.prepare('DELETE FROM search_runtime WHERE id=1 AND task_id=?').run(id);
      }
      const code = cancelled
        ? 'PREPARATION_CANCELLED'
        : typeof (e as any).code === 'string' && (e as any).code.match(/^[A-Z][A-Z0-9_]{0,63}$/)
          ? (e as any).code
          : 'SEARCH_PREPARATION_FAILED';
      terminal.set(id, { state: cancelled ? 'cancelled' : 'failed', code });
      try {
        db.transaction(() => {
          db.prepare(
            'UPDATE search_preparations SET state=?,phase=?,error=?,updated_at=? WHERE id=?',
          ).run(
            cancelled ? 'cancelled' : 'failed',
            cancelled ? 'cancelled' : 'failed',
            code,
            Date.now(),
            id,
          );
          db.prepare('UPDATE operations SET status=?,error=?,updated_at=? WHERE id=?').run(
            cancelled ? 'cancelled' : 'failed',
            code,
            Date.now(),
            id,
          );
        }).immediate();
      } catch {
        runtimeError = 'SEARCH_STORAGE_UNAVAILABLE';
      }
    } finally {
      controller = undefined;
      if (
        !(
          db
            .prepare("SELECT * FROM search_processes WHERE task_id=? AND role='preparation'")
            .all(id) as any[]
        ).some(guardIsAlive)
      )
        await rm(join(runtimeRoot, 'tmp', id), { recursive: true, force: true }).catch(() => {});
    }
  }
  async function status() {
    recover();
    let components: any = { tokenizerReady: false, vectorReady: false };
    try {
      components = await platform.get().knowledge.worker.capabilities();
    } catch {}
    const row = db
      .prepare('SELECT * FROM search_preparations ORDER BY updated_at DESC LIMIT 1')
      .get() as any;
    const active = db.prepare('SELECT active_json FROM search_runtime WHERE id=1').get() as any;
    return {
      distributionAvailable: !!distribution,
      downloadBytes: distribution?.bytes || 0,
      externallyManaged,
      components,
      ...(runtimeError ? { code: runtimeError } : {}),
      ...(active
        ? { runtime: { version: JSON.parse(active.active_json).version, pythonVersion: '3.14.4' } }
        : {}),
      ...(row
        ? {
            task: {
              id: row.id,
              state: terminal.get(row.id)?.state || row.state,
              phase: terminal.get(row.id)?.state || row.phase,
              completedBytes: row.completed_bytes,
              totalBytes: row.total_bytes,
              error: terminal.get(row.id)?.code || row.error,
            },
          }
        : {}),
    };
  }
  return {
    status,
    prepare: (owner: string, requestId: string) => {
      if (closing) failure('SEARCH_RUNTIME_STOPPING');
      if (externallyManaged) failure('SEARCH_RUNTIME_EXTERNALLY_MANAGED');
      if (!distribution) failure('SEARCH_DISTRIBUTION_UNAVAILABLE');
      safeSource(distribution);
      platform.get();
      recover();
      const value = db
        .transaction(() => {
          const op = beginOperation(db, actor(owner), 'search_prepare', requestId, {
            sha256: distribution.sha256,
            version: distribution.version,
            runtimeRoot,
            modelsRoot,
          });
          if (!op.fresh) return { taskId: op.operation.id };
          if (
            db
              .prepare("SELECT 1 FROM search_preparations WHERE state IN ('queued','running')")
              .get()
          )
            fail(409, 'SEARCH_PREPARATION_BUSY');
          db.prepare(
            'INSERT INTO search_preparations(id,owner_id,distribution_json,total_bytes,runner_pid,runner_start,updated_at) VALUES(?,?,?,?,?,?,?)',
          ).run(
            op.operation.id,
            owner,
            JSON.stringify(distribution),
            distribution.bytes,
            self.pid,
            self.start,
            Date.now(),
          );
          return { taskId: op.operation.id };
        })
        .immediate();
      if (task(value.taskId).state === 'queued' && !running) {
        running = run(value.taskId).finally(() => {
          running = undefined;
        });
      }
      return value;
    },
    cancel: async (owner: string, id: string) => {
      const row = task(id);
      if (row.owner_id !== owner) fail(404, 'SEARCH_TASK_NOT_FOUND');
      if (!['queued', 'running'].includes(row.state)) return { taskId: id, state: row.state };
      db.prepare('UPDATE search_preparations SET cancel_requested=1 WHERE id=?').run(id);
      controller?.abort();
      if (running) await running;
      else {
        for (const child of db
          .prepare("SELECT * FROM search_processes WHERE task_id=? AND role='preparation'")
          .all(id) as any[]) {
          if (!guardIsAlive(child)) continue;
          try {
            process.kill(-child.process_group, 'SIGTERM');
          } catch {}
          const until = Date.now() + 5000;
          while (processGroupIsAlive(child.process_group) && Date.now() < until)
            await new Promise((r) => setTimeout(r, 25));
          if (processGroupIsAlive(child.process_group)) {
            try {
              process.kill(-child.process_group, 'SIGKILL');
            } catch {}
          }
        }
        if (aliveChildren(id)) failure('PREPARATION_PROCESS_STILL_RUNNING');
        db.transaction(() => {
          db.prepare(
            "UPDATE search_preparations SET state='cancelled',phase='cancelled',error='PREPARATION_CANCELLED',updated_at=? WHERE id=?",
          ).run(Date.now(), id);
          db.prepare(
            "UPDATE operations SET status='cancelled',error='PREPARATION_CANCELLED',updated_at=? WHERE id=?",
          ).run(Date.now(), id);
        }).immediate();
      }
      return { taskId: id, state: task(id).state };
    },
    start: () => {
      if (startup) return startup;
      startup = (async () => {
        recover();
        if (externallyManaged) return;
        const active = db.prepare('SELECT * FROM search_runtime WHERE id=1').get() as any;
        if (active && platform.status().components.knowledge) {
          try {
            const info = JSON.parse(active.active_json);
            await activate(info, active.task_id);
            const row = task(active.task_id);
            if (
              row.state !== 'cancelled' &&
              (['running', 'queued'].includes(row.state) || row.error === 'PREPARATION_INTERRUPTED')
            )
              db.transaction(() => {
                db.prepare(
                  "UPDATE search_preparations SET state='succeeded',phase='ready',error=NULL,updated_at=? WHERE id=?",
                ).run(Date.now(), row.id);
                completeOperation(db, row.id, {
                  taskId: row.id,
                  status: 'succeeded',
                  version: info.version,
                });
              }).immediate();
          } catch (e) {
            runtimeError = (e as any).code || 'SEARCH_RUNTIME_START_FAILED';
          }
        }
      })().finally(() => {
        startup = undefined;
      });
      return startup;
    },
    close: async () => {
      closing = true;
      controller?.abort();
      await running;
      await startup;
      await stopRuntime();
    },
  };
}
