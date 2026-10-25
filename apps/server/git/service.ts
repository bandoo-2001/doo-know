import { randomUUID, createHash } from 'node:crypto';
import { lstatSync } from 'node:fs';
import { mkdir, rm, lstat, realpath, statfs } from 'node:fs/promises';
import { join, resolve, dirname } from 'node:path';
import type { HostConfig } from '../../../shared/platform-contracts.js';
import type { AppDatabase } from '../../../packages/core/db.js';
import type { platformRuntime } from '../platform/runtime.js';
import type { pluginHost } from '../plugins/host.js';
import {
  workspaceExclusive,
  workspaceWrite,
  workspacePermit,
} from '../../../packages/core/workspace/gate.js';
import { guardedProcess } from '../../../packages/core/processes/guarded.js';
import { setupDirectoryPolicy } from '../platform/setup-directories.js';
import { fail } from '../../../packages/core/knowledge/errors.js';
import { webPrincipal } from '../../../packages/core/knowledge/core.js';
import { gitCredentials } from './credentials.js';
import { measureImport, checkImportSpace, checkImportTree } from './import-budget.js';
import { gitTransport, normalizeRemote, type GitExec } from './transport.js';
import type { GitJob, GitJobInput, GitJobKind, GitRemoteStatus } from './types.js';

type Platform = Pick<
  ReturnType<typeof platformRuntime>,
  'get' | 'status' | 'settings' | 'activate'
>;
type Plugins = Pick<ReturnType<typeof pluginHost>, 'list' | 'install' | 'enable'>;
type Row = {
  id: string;
  owner: string;
  request_id: string;
  kind: GitJobKind;
  params: string;
  root: string | null;
  binding: number;
  status: GitJob['status'];
  phase: string;
  error: string | null;
  result: string | null;
  created_at: number;
  updated_at: number;
};
type Connection = {
  owner: string;
  root: string;
  binding: number;
  url: string;
  host: string;
  branch: string;
  remote_name: string;
  credential_id: string | null;
  checked_at: number | null;
  remote_head: string | null;
  remote_exists: number;
  write_verified: number;
};
const digest = (s: string) => createHash('sha256').update(s).digest('hex');
const oid = (s: unknown): s is string =>
  typeof s === 'string' && /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(s);
const terminalError = (e: any) =>
  /^[A-Z][A-Z0-9_]{1,63}$/.test(e?.code || e?.message || '')
    ? String(e.code || e.message)
    : 'GIT_OPERATION_FAILED';
const kinds = new Set<GitJobKind>([
  'test',
  'clone',
  'connect',
  'check',
  'push',
  'pull',
  'disconnect',
  'ssh-host',
]);

export function gitRemoteService(
  config: HostConfig,
  db: AppDatabase,
  platform: Platform,
  plugins: Plugins,
  options: { exec?: GitExec } = {},
) {
  db.exec(`CREATE TABLE IF NOT EXISTS git_remote_jobs(id TEXT PRIMARY KEY,owner TEXT NOT NULL,request_id TEXT NOT NULL,kind TEXT NOT NULL,params TEXT NOT NULL,root TEXT,binding INTEGER NOT NULL,status TEXT NOT NULL,phase TEXT NOT NULL,error TEXT,result TEXT,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL,UNIQUE(owner,request_id));
    CREATE TABLE IF NOT EXISTS git_remote_connections(owner TEXT NOT NULL,root TEXT NOT NULL,binding INTEGER NOT NULL,url TEXT NOT NULL,host TEXT NOT NULL,branch TEXT NOT NULL,remote_name TEXT NOT NULL,credential_id TEXT,checked_at INTEGER,remote_head TEXT,remote_exists INTEGER NOT NULL DEFAULT 0,write_verified INTEGER NOT NULL DEFAULT 0,PRIMARY KEY(owner,root,binding));`);
  db.prepare(
    "UPDATE git_remote_jobs SET status='needs_reconciliation',error='GIT_TASK_INTERRUPTED',updated_at=? WHERE status IN ('queued','running')",
  ).run(Date.now());
  db.exec(
    "CREATE UNIQUE INDEX IF NOT EXISTS git_remote_one_active ON git_remote_jobs((1)) WHERE status IN ('queued','running')",
  );
  const credentials = gitCredentials(config, db),
    transport = gitTransport(config, db, options);
  const running = new Map<string, { controller: AbortController; promise: Promise<void> }>();
  let closing = false;
  const view = (r: Row): GitJob => ({
    id: r.id,
    requestId: r.request_id,
    kind: r.kind,
    status: r.status,
    phase: r.phase,
    ...(r.error ? { error: r.error } : {}),
    ...(r.result ? { result: JSON.parse(r.result) } : {}),
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  });
  const owned = (owner: string, id: string) => {
    const r = db.prepare('SELECT * FROM git_remote_jobs WHERE id=? AND owner=?').get(id, owner) as
      | Row
      | undefined;
    if (!r) fail(404, 'GIT_TASK_NOT_FOUND');
    return r;
  };
  const listJobs = (owner: string) =>
    (
      db
        .prepare('SELECT * FROM git_remote_jobs WHERE owner=? ORDER BY created_at DESC LIMIT 20')
        .all(owner) as Row[]
    ).map(view);
  const seenRoots = new Set<string>();
  const binding = () => {
    const status = platform.status();
    if (status.knowledgeRoot && status.code) fail(503, status.code);
    if (status.knowledgeRoot) seenRoots.add(status.knowledgeRoot);
    return { root: status.knowledgeRoot || null, binding: status.bindingVersion || 0 };
  };
  function readableRoot(root: string) {
    if (!seenRoots.has(root)) return;
    const current = binding();
    if (current.root !== root) fail(409, 'GIT_BINDING_CHANGED');
  }
  const connection = (owner: string, root: string, version: number) =>
    db
      .prepare('SELECT * FROM git_remote_connections WHERE owner=? AND root=? AND binding=?')
      .get(owner, root, version) as Connection | undefined;
  const identity = (c: Connection | undefined) =>
    c
      ? { url: c.url, branch: c.branch, remoteName: c.remote_name, credentialId: c.credential_id }
      : null;
  function jobBinding(r: Row) {
    const current = binding();
    if (!r.root || current.root !== r.root || current.binding !== r.binding)
      fail(409, 'GIT_BINDING_CHANGED');
    const params = JSON.parse(r.params),
      snapshot = params._root;
    if (snapshot) {
      let s;
      try {
        s = lstatSync(r.root, { bigint: true });
      } catch {
        fail(503, 'SOURCE_UNAVAILABLE');
      }
      if (s.isSymbolicLink() || String(s.dev) !== snapshot.dev || String(s.ino) !== snapshot.ino)
        fail(503, 'SOURCE_UNAVAILABLE');
    }
    if (
      Object.hasOwn(params, '_connection') &&
      JSON.stringify(params._connection) !==
        JSON.stringify(identity(connection(r.owner, r.root, r.binding)))
    )
      fail(409, 'GIT_CONNECTION_CHANGED');
  }
  const phase = (id: string, value: string, result?: unknown) =>
    db
      .prepare(
        'UPDATE git_remote_jobs SET phase=?,updated_at=?,result=coalesce(?,result) WHERE id=?',
      )
      .run(value, Date.now(), result === undefined ? null : JSON.stringify(result), id);
  async function raw(root: string, args: string[], signal?: AbortSignal) {
    readableRoot(root);
    return transport.run(root, args, { signal });
  }
  async function text(root: string, args: string[], signal?: AbortSignal) {
    const r = await raw(root, args, signal);
    if (r.code) fail(409, 'GIT_COMMAND_FAILED');
    return r.stdout.toString('utf8').trimEnd();
  }
  async function dependency(root: string, signal?: AbortSignal) {
    const r = await raw(root, ['--version'], signal),
      m = r.stdout.toString().match(/git version (\d+)\.(\d+)/);
    if (r.code || !m || Number(m[1]) < 2 || (Number(m[1]) === 2 && Number(m[2]) < 39))
      fail(503, 'GIT_DEPENDENCY_MISSING');
  }
  async function repo(root: string, signal?: AbortSignal) {
    const found = await raw(root, ['rev-parse', '--show-toplevel'], signal);
    if (found.code) return undefined;
    if ((await realpath(found.stdout.toString().trim())) !== (await realpath(root)))
      fail(409, 'WRONG_REPOSITORY_ROOT');
    const dot = await lstat(join(root, '.git')).catch(() => undefined);
    if (!dot?.isDirectory() || dot.isSymbolicLink()) fail(409, 'GIT_UNSUPPORTED_WORKTREE');
    const b = await raw(root, ['symbolic-ref', '--quiet', '--short', 'HEAD'], signal);
    if (b.code) fail(409, 'DETACHED_HEAD');
    const h = await raw(root, ['rev-parse', '--verify', 'HEAD'], signal),
      head = h.code ? null : h.stdout.toString().trim();
    if (head && !oid(head)) fail(409, 'INVALID_GIT_HEAD');
    const dir = join(root, '.git');
    for (const marker of [
      'MERGE_HEAD',
      'CHERRY_PICK_HEAD',
      'REVERT_HEAD',
      'rebase-merge',
      'rebase-apply',
      'sequencer',
      'index.lock',
    ])
      if (await lstat(join(dir, marker)).catch(() => undefined))
        fail(409, 'GIT_OPERATION_IN_PROGRESS');
    const dirty = await text(
      root,
      ['status', '--porcelain=v1', '-z', '--untracked-files=all'],
      signal,
    );
    return {
      branch: b.stdout.toString().trim(),
      head,
      changes: dirty ? dirty.split('\0').filter(Boolean).length : 0,
    };
  }
  async function safeTree(root: string, commit: string, signal?: AbortSignal) {
    readableRoot(root);
    if (!oid(commit)) fail(409, 'INVALID_GIT_HEAD');
    const r = await transport.run(root, ['ls-tree', '-rz', commit], {
      signal,
      maxBytes: 8 * 1024 * 1024,
    });
    if (r.code) fail(409, 'GIT_COMMAND_FAILED');
    for (const entry of r.stdout.toString('utf8').split('\0').filter(Boolean))
      if (!/^100(?:644|755) blob [a-f0-9]+\t/.test(entry)) fail(409, 'UNSUPPORTED_GIT_ENTRY');
  }
  async function branchValid(root: string, value: string, signal?: AbortSignal) {
    if (
      value.length > 200 ||
      value.startsWith('-') ||
      (await raw(root, ['check-ref-format', 'refs/heads/' + value], signal)).code
    )
      fail(400, 'GIT_INVALID_BRANCH');
  }
  function secret(owner: string, id: string | undefined, host: string) {
    return id ? credentials.get(owner, id, host as any) : undefined;
  }
  async function remoteRefs(
    owner: string,
    root: string,
    url: string,
    credentialId: string | undefined,
    signal: AbortSignal,
  ) {
    readableRoot(root);
    const remote = normalizeRemote(url),
      credential = secret(owner, credentialId, remote.host);
    const r = await transport.run(
      root,
      ['ls-remote', '--symref', remote.url, 'HEAD', 'refs/heads/*'],
      { url: remote.url, credential, signal, timeoutMs: 120000 },
    );
    const branches: Record<string, string> = {};
    let defaultBranch = '';
    for (const line of r.stdout.toString().split('\n')) {
      const symbolic = line.match(/^ref: refs\/heads\/(.+)\tHEAD$/);
      if (symbolic) defaultBranch = symbolic[1];
      const head = line.match(/^([a-f0-9]{40}(?:[a-f0-9]{24})?)\trefs\/heads\/(.+)$/);
      if (head) branches[head[2]] = head[1];
    }
    return { ...remote, branches, defaultBranch, readVerified: true, writeVerified: false };
  }
  async function ensurePlugin(r: Row, signal: AbortSignal) {
    signal.throwIfAborted();
    let p = plugins.list().find((p) => p.id === 'git');
    if (!p) {
      await plugins.install('git', { signal, onPhase: (value) => phase(r.id, value) });
      signal.throwIfAborted();
      p = plugins.list().find((p) => p.id === 'git');
    }
    signal.throwIfAborted();
    if (p?.state !== 'enabled') await plugins.enable('git', () => signal.throwIfAborted());
    signal.throwIfAborted();
  }
  async function sameDirectory(path: string, proof: { dev: string; ino: string }) {
    const s = await lstat(path, { bigint: true }).catch(() => undefined);
    return (
      !!s &&
      s.isDirectory() &&
      !s.isSymbolicLink() &&
      String(s.dev) === proof.dev &&
      String(s.ino) === proof.ino
    );
  }
  async function publishClone(
    proof: {
      stage: string;
      knowledgeRoot: string;
      dev: string;
      ino: string;
      parentDev?: string;
      parentIno?: string;
    },
    signal: AbortSignal,
  ) {
    const policy = setupDirectoryPolicy(config),
      parent = dirname(proof.knowledgeRoot),
      p = policy(parent, { browse: true });
    policy(proof.knowledgeRoot, { missing: true });
    if (proof.parentDev && (p.dev !== proof.parentDev || p.ino !== proof.parentIno))
      fail(409, 'KNOWLEDGE_ROOT_CHANGED');
    if (await sameDirectory(proof.knowledgeRoot, proof)) return;
    if (await lstat(proof.knowledgeRoot).catch(() => undefined)) fail(409, 'DIRECTORY_EXISTS');
    if (dirname(proof.stage) !== parent || !(await sameDirectory(proof.stage, proof)))
      fail(409, 'KNOWLEDGE_ROOT_CHANGED');
    await guardedProcess(
      db,
      { kind: 'workspace', token: workspacePermit(db, false) },
      '/usr/bin/mv',
      ['--no-clobber', '--no-target-directory', '--', proof.stage, proof.knowledgeRoot],
      parent,
      { signal, maxBytes: 4096, timeoutMs: 10000 },
    ).wait;
    if (!(await sameDirectory(proof.knowledgeRoot, proof))) fail(409, 'DIRECTORY_EXISTS');
  }
  function cloneReceipt(r: Row) {
    if (r.kind !== 'clone' || !r.result) return false;
    const proof = JSON.parse(r.result);
    return (
      ['binding', 'publishing'].includes(r.phase) ||
      ((proof.cloned === true || proof.publishing === true) &&
        typeof proof.knowledgeRoot === 'string')
    );
  }
  async function resumeClone(owner: string, r: Row, input: GitJobInput, signal: AbortSignal) {
    const proof = JSON.parse(r.result!);
    if (r.phase === 'publishing' || proof.publishing === true) {
      await publishClone(proof, signal);
      phase(r.id, 'binding', { ...proof, cloned: true, publishing: false });
    }
    return bindClone(owner, r, input, proof, signal);
  }
  async function bindClone(
    owner: string,
    r: Row,
    input: GitJobInput,
    proof: { knowledgeRoot: string; dev: string; ino: string },
    signal: AbortSignal,
  ) {
    const policy = setupDirectoryPolicy(config),
      target = proof.knowledgeRoot,
      current = policy(target);
    if (current.dev !== proof.dev || current.ino !== proof.ino) fail(409, 'KNOWLEDGE_ROOT_CHANGED');
    const bound = binding();
    if (bound.root && bound.root !== target) fail(409, 'GIT_BINDING_CHANGED');
    const remote = normalizeRemote(input.url!);
    const state = await repo(target, signal);
    if (!state) fail(409, 'GIT_REPOSITORY_MISSING');
    if (
      normalizeRemote(await text(target, ['remote', 'get-url', 'origin'], signal)).url !==
      remote.url
    )
      fail(409, 'GIT_CLONE_CHANGED');
    await ensurePlugin(r, signal);
    const finalIdentity = policy(target);
    if (finalIdentity.dev !== proof.dev || finalIdentity.ino !== proof.ino)
      fail(409, 'KNOWLEDGE_ROOT_CHANGED');
    let receipt: any = { knowledgeRoot: target, bindingVersion: bound.binding };
    if (!bound.root) {
      const validation = platform.settings.validate(owner, target);
      receipt = platform.settings.complete(owner, {
        knowledgeRoot: target,
        validationId: validation.validationId,
        timeZone: input.timeZone || 'Asia/Shanghai',
        requestId: 'git-clone-bind-' + r.id,
      });
    }
    await platform.activate();
    db.prepare(
      'INSERT INTO git_remote_connections(owner,root,binding,url,host,branch,remote_name,credential_id) VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(owner,root,binding) DO NOTHING',
    ).run(
      owner,
      target,
      binding().binding,
      remote.url,
      remote.host,
      state.branch,
      'origin',
      input.credentialId || null,
    );
    return { ...receipt, knowledgeRoot: target, cloned: true, bound: true, branch: state.branch };
  }
  function pendingLocalGit(r: Row) {
    if (
      !db
        .prepare(
          "SELECT 1 FROM sqlite_master WHERE type='table' AND name='plugin_operation_intents'",
        )
        .get()
    )
      return;
    const pending = db
      .prepare(
        `SELECT 1 FROM plugin_operation_intents
      WHERE plugin_id='git' AND json_extract(details,'$.preview.root')=?
      AND json_extract(details,'$.preview.binding')=?
      AND coalesce(json_extract(details,'$.phase'),'') NOT IN ('finished','aborted','acknowledged') LIMIT 1`,
      )
      .get(r.root, r.binding);
    if (pending) fail(409, 'GIT_RECONCILIATION_REQUIRED');
  }
  async function applyPull(
    r: Row,
    branch: string,
    before: string | null,
    target: string,
    signal: AbortSignal,
  ) {
    jobBinding(r);
    pendingLocalGit(r);
    const local = await repo(r.root!, signal);
    if (!local || local.branch !== branch) fail(409, 'GIT_BRANCH_CHANGED');
    if (local.changes) fail(409, 'GIT_LOCAL_CHANGES');
    if (local.head !== before && local.head !== target) fail(409, 'GIT_RECONCILIATION_REQUIRED');
    if (local.head !== target) {
      if (
        local.head &&
        (await raw(r.root!, ['merge-base', '--is-ancestor', local.head, target], signal)).code
      )
        fail(409, 'GIT_DIVERGED');
      await safeTree(r.root!, target, signal);
      jobBinding(r);
      const latest = await repo(r.root!, signal);
      if (latest?.branch !== branch || latest.head !== before || latest.changes)
        fail(409, 'GIT_LOCAL_CHANGES');
      phase(r.id, 'updating_files', { before, target });
      await text(
        r.root!,
        ['merge', '--ff-only', '--no-overwrite-ignore', '--no-edit', target],
        signal,
      );
    }
    // The saved intent remains durable until the directory/index refresh finishes.
    return { pulled: true, commit: target, refreshRequired: true };
  }
  async function sync(owner: string, r: Row, input: GitJobInput, signal: AbortSignal) {
    jobBinding(r);
    const current = binding();
    if (!r.root || r.root !== current.root || r.binding !== current.binding)
      fail(409, 'GIT_BINDING_CHANGED');
    const root = r.root;
    const c = connection(owner, root, r.binding);
    if (!c) fail(409, 'GIT_REMOTE_NOT_CONFIGURED');
    let local = await repo(root, signal);
    if (!local) fail(409, 'GIT_REPOSITORY_MISSING');
    if (local.branch !== c.branch) fail(409, 'GIT_BRANCH_CHANGED');
    const remote = normalizeRemote(c.url),
      credential = secret(owner, c.credential_id || undefined, remote.host);
    if (input.kind === 'push') {
      if (!oid(input.expectedHead)) fail(400, 'GIT_EXPECTED_HEAD_REQUIRED');
      if (local.head !== input.expectedHead) fail(409, 'PREVIEW_STALE');
      phase(r.id, 'checking_remote');
      const refs = await remoteRefs(owner, root, c.url, c.credential_id || undefined, signal);
      const pushed = refs.branches[c.branch] !== input.expectedHead;
      if (pushed) {
        jobBinding(r);
        const latest = await repo(root, signal);
        if (latest?.branch !== c.branch || latest.head !== input.expectedHead)
          fail(409, 'PREVIEW_STALE');
        phase(r.id, 'pushing');
        await transport.run(
          root,
          ['push', '--porcelain', '--', remote.url, `${input.expectedHead}:refs/heads/${c.branch}`],
          { url: remote.url, credential, signal, timeoutMs: 600000 },
        );
      }
      db.prepare(
        'UPDATE git_remote_connections SET remote_head=?,remote_exists=1,checked_at=?,write_verified=CASE WHEN ? THEN 1 ELSE write_verified END WHERE owner=? AND root=? AND binding=?',
      ).run(input.expectedHead, Date.now(), pushed ? 1 : 0, owner, root, r.binding);
      return {
        pushed,
        unchanged: !pushed,
        writeVerified: pushed || !!c.write_verified,
        commit: input.expectedHead,
        localCommitPreserved: true,
      };
    }
    if (input.kind === 'pull') {
      pendingLocalGit(r);
      if (local.changes) fail(409, 'GIT_LOCAL_CHANGES');
      const saved = r.result ? JSON.parse(r.result) : undefined;
      if (saved && Object.hasOwn(saved, 'target')) {
        if (!oid(saved.target) || !(saved.before === null || oid(saved.before)))
          fail(409, 'GIT_RECONCILIATION_REQUIRED');
        return applyPull(r, c.branch, saved.before, saved.target, signal);
      }
    }
    const previous = local.head;
    phase(r.id, 'checking_remote');
    const refs = await remoteRefs(owner, root, c.url, c.credential_id || undefined, signal);
    const remoteHead = refs.branches[c.branch] || null;
    db.prepare(
      'UPDATE git_remote_connections SET remote_head=?,remote_exists=?,checked_at=? WHERE owner=? AND root=? AND binding=?',
    ).run(
      remoteHead,
      Object.keys(refs.branches).length ? 1 : 0,
      Date.now(),
      owner,
      root,
      r.binding,
    );
    if (!remoteHead) {
      if (input.kind === 'pull') fail(409, 'GIT_REMOTE_BRANCH_MISSING');
      return { checked: true, remoteEmpty: !Object.keys(refs.branches).length };
    }
    const ref = 'refs/dooknow/' + digest(owner + '\0' + root + '\0' + r.binding).slice(0, 32);
    phase(r.id, 'fetching');
    jobBinding(r);
    await transport.run(
      root,
      [
        'fetch',
        '--no-tags',
        '--no-recurse-submodules',
        '--no-write-fetch-head',
        '--',
        remote.url,
        `+refs/heads/${c.branch}:${ref}`,
      ],
      { url: remote.url, credential, signal, timeoutMs: 600000 },
    );
    const fetched = await text(root, ['rev-parse', ref], signal);
    if (!oid(fetched)) fail(409, 'INVALID_GIT_HEAD');
    db.prepare(
      'UPDATE git_remote_connections SET remote_head=? WHERE owner=? AND root=? AND binding=?',
    ).run(fetched, owner, root, r.binding);
    if (input.kind === 'check') return { checked: true, remoteHead: fetched };
    local = await repo(root, signal);
    if (!local || local.head !== previous || local.changes) fail(409, 'GIT_LOCAL_CHANGES');
    if (local.head) {
      if (local.head === fetched) return { pulled: true, unchanged: true, commit: fetched };
      if ((await raw(root, ['merge-base', '--is-ancestor', local.head, fetched], signal)).code)
        fail(409, 'GIT_DIVERGED');
    }
    return applyPull(r, c.branch, previous, fetched, signal);
  }
  async function clone(owner: string, r: Row, input: GitJobInput, signal: AbortSignal) {
    if (binding().root) fail(409, 'SETUP_ALREADY_COMPLETE');
    const policy = setupDirectoryPolicy(config);
    if (
      !input.name ||
      input.name.startsWith('.') ||
      input.name !== input.name.trim() ||
      /[\\/\x00-\x1f\x7f]/.test(input.name) ||
      Buffer.byteLength(input.name) > 120
    )
      fail(400, 'INVALID_LIBRARY_NAME');
    const suggested = platform.settings.directories({}).suggestedParent;
    const parent = resolve(input.parentPath || suggested),
      target = join(parent, input.name);
    policy(target, { missing: true });
    if (parent === suggested) await mkdir(parent, { recursive: true, mode: 0o700 });
    const parentProof = policy(parent, { browse: true });
    if (await lstat(target).catch(() => undefined)) fail(409, 'DIRECTORY_EXISTS');
    if (r.result) {
      const old = JSON.parse(r.result);
      if (
        old.cloned === false &&
        typeof old.stage === 'string' &&
        dirname(old.stage) === parent &&
        /^\.dooknow-clone-[a-f0-9-]{36}$/.test(old.stage.slice(parent.length + 1))
      ) {
        const s = await lstat(old.stage, { bigint: true }).catch(() => undefined);
        if (
          s &&
          s.isDirectory() &&
          !s.isSymbolicLink() &&
          String(s.dev) === old.dev &&
          String(s.ino) === old.ino
        )
          await rm(old.stage, { recursive: true });
      }
    }
    const free = await statfs(parent);
    if (Number(free.bavail) * Number(free.bsize) < 512 * 1024 * 1024)
      fail(409, 'INSUFFICIENT_DISK_SPACE');
    await ensurePlugin(r, signal);
    const remote = normalizeRemote(input.url!);
    const credential = secret(owner, input.credentialId, remote.host);
    if (input.branch) await branchValid(parent, input.branch, signal);
    const stage = join(parent, '.dooknow-clone-' + randomUUID());
    await mkdir(stage, { mode: 0o700 });
    const stageProof = await lstat(stage, { bigint: true });
    const budget = new AbortController(),
      combined = AbortSignal.any([signal, budget.signal]);
    let quotaError = '',
      checking: Promise<void> | undefined;
    const quota = setInterval(() => {
      if (checking || budget.signal.aborted) return;
      checking = (async () => {
        await checkImportSpace(parent);
        await measureImport(stage);
      })()
        .catch((error) => {
          quotaError = ['GIT_CLONE_TOO_LARGE', 'INSUFFICIENT_DISK_SPACE'].includes(error?.code)
            ? error.code
            : 'DIRECTORY_NOT_WRITABLE';
          budget.abort();
        })
        .finally(() => {
          checking = undefined;
        });
    }, 250);
    quota.unref();
    let published = false;
    try {
      phase(r.id, 'cloning', {
        stage,
        dev: String(stageProof.dev),
        ino: String(stageProof.ino),
        cloned: false,
      });
      await transport.run(
        parent,
        [
          'clone',
          '--no-checkout',
          '--no-recurse-submodules',
          ...(input.branch ? ['--branch', input.branch] : []),
          '--',
          remote.url,
          stage,
        ],
        { url: remote.url, credential, signal: combined, timeoutMs: 600000 },
      );
      const state = await repo(stage, combined);
      if (!state) fail(409, 'GIT_CLONE_FAILED');
      const staged = await measureImport(stage);
      if (state.head) {
        phase(r.id, 'checking_files');
        const tree = await transport.run(stage, ['ls-tree', '-rlz', state.head], {
          signal: combined,
          maxBytes: 16 * 1024 * 1024,
        });
        if (tree.code) fail(409, 'GIT_COMMAND_FAILED');
        const expanded = checkImportTree(tree.stdout, staged);
        await checkImportSpace(parent, expanded);
        combined.throwIfAborted();
        await text(stage, ['checkout', '--force', 'HEAD'], combined);
      }
      await measureImport(stage);
      await checkImportSpace(parent);
      clearInterval(quota);
      await checking;
      combined.throwIfAborted();
      if (binding().root) fail(409, 'SETUP_ALREADY_COMPLETE');
      const now = policy(parent, { browse: true });
      if (now.dev !== parentProof.dev || now.ino !== parentProof.ino)
        fail(409, 'KNOWLEDGE_ROOT_CHANGED');
      if (await lstat(target).catch(() => undefined)) fail(409, 'DIRECTORY_EXISTS');
      const publication = {
        stage,
        knowledgeRoot: target,
        dev: String(stageProof.dev),
        ino: String(stageProof.ino),
        parentDev: parentProof.dev,
        parentIno: parentProof.ino,
        cloned: false,
        publishing: true,
      };
      phase(r.id, 'publishing', publication);
      await publishClone(publication, combined);
      published = true;
      const proof = policy(target);
      if (proof.dev !== String(stageProof.dev) || proof.ino !== String(stageProof.ino))
        fail(409, 'KNOWLEDGE_ROOT_CHANGED');
      phase(r.id, 'binding', {
        knowledgeRoot: target,
        cloned: true,
        dev: proof.dev,
        ino: proof.ino,
      });
      return bindClone(
        owner,
        r,
        input,
        { knowledgeRoot: target, dev: proof.dev, ino: proof.ino },
        signal,
      );
    } catch (e) {
      if (quotaError) fail(409, quotaError);
      throw e;
    } finally {
      clearInterval(quota);
      await checking;
      if (
        !published &&
        (await sameDirectory(stage, { dev: String(stageProof.dev), ino: String(stageProof.ino) }))
      )
        await rm(stage, { recursive: true, force: true });
    }
  }
  async function work(owner: string, r: Row, input: GitJobInput, signal: AbortSignal) {
    if (
      ['check', 'push', 'pull'].includes(input.kind) &&
      plugins.list().find((p) => p.id === 'git')?.state !== 'enabled'
    )
      fail(409, 'GIT_PLUGIN_DISABLED');
    const cwd = r.root || config.dataRoot;
    if (!(r.kind === 'pull' && r.result && Object.hasOwn(JSON.parse(r.result), 'target')))
      phase(r.id, 'checking_dependency');
    await dependency(cwd, signal);
    if (input.kind === 'ssh-host') return transport.scanHost(input.host!, signal);
    if (input.kind === 'test') {
      phase(r.id, 'testing_connection');
      return remoteRefs(owner, cwd, input.url!, input.credentialId, signal);
    }
    if (input.kind === 'clone') return clone(owner, r, input, signal);
    jobBinding(r);
    const current = binding();
    if (!r.root || current.root !== r.root || current.binding !== r.binding)
      fail(409, 'GIT_BINDING_CHANGED');
    if (input.kind === 'disconnect') {
      db.prepare('DELETE FROM git_remote_connections WHERE owner=? AND root=? AND binding=?').run(
        owner,
        r.root,
        r.binding,
      );
      return { disconnected: true, repositoryPreserved: true };
    }
    if (input.kind === 'connect') {
      await ensurePlugin(r, signal);
      jobBinding(r);
      let state = await repo(r.root, signal);
      if (!state) {
        await text(r.root, ['init', '--initial-branch=main'], signal);
        state = await repo(r.root, signal);
      }
      if (!state) fail(409, 'GIT_REPOSITORY_MISSING');
      const branch = input.branch || state.branch;
      if (branch !== state.branch) fail(409, 'GIT_BRANCH_CHANGED');
      await branchValid(r.root, branch, signal);
      phase(r.id, 'testing_connection');
      const refs = await remoteRefs(owner, r.root, input.url!, input.credentialId, signal);
      jobBinding(r);
      let remoteName = 'origin';
      const old = await raw(r.root, ['remote', 'get-url', 'origin'], signal);
      if (!old.code) {
        let same = false;
        try {
          same = normalizeRemote(old.stdout.toString().trim()).url === refs.url;
        } catch {}
        if (!same) remoteName = 'dooknow';
      }
      const selected = await raw(r.root, ['remote', 'get-url', remoteName], signal);
      if (selected.code) await text(r.root, ['remote', 'add', remoteName, refs.url], signal);
      else if (normalizeRemote(selected.stdout.toString().trim()).url !== refs.url)
        fail(409, 'GIT_REMOTE_ALREADY_EXISTS');
      db.prepare(
        `INSERT INTO git_remote_connections(owner,root,binding,url,host,branch,remote_name,credential_id,checked_at,remote_head,remote_exists) VALUES(?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(owner,root,binding) DO UPDATE SET url=excluded.url,host=excluded.host,branch=excluded.branch,remote_name=excluded.remote_name,credential_id=excluded.credential_id,checked_at=excluded.checked_at,remote_head=excluded.remote_head,remote_exists=excluded.remote_exists,write_verified=0`,
      ).run(
        owner,
        r.root,
        r.binding,
        refs.url,
        refs.host,
        branch,
        remoteName,
        input.credentialId || null,
        Date.now(),
        refs.branches[branch] || null,
        Object.keys(refs.branches).length ? 1 : 0,
      );
      return {
        connected: true,
        branch,
        readVerified: true,
        writeVerified: false,
        remoteEmpty: !Object.keys(refs.branches).length,
      };
    }
    return sync(owner, r, input, signal);
  }
  function launch(r: Row) {
    const controller = new AbortController();
    const promise = new Promise<void>((resolve) => setImmediate(resolve)).then(async () => {
      db.prepare("UPDATE git_remote_jobs SET status='running',updated_at=? WHERE id=?").run(
        Date.now(),
        r.id,
      );
      let result: any;
      try {
        const input = JSON.parse(r.params) as GitJobInput;
        result = await workspaceExclusive(db, { kind: 'git.remote.' + r.kind }, () =>
          cloneReceipt(r)
            ? resumeClone(r.owner, r, input, controller.signal)
            : work(r.owner, r, input, controller.signal),
        );
        if (result?.refreshRequired) {
          phase(r.id, 'refreshing');
          try {
            await platform
              .get()
              .knowledge.indexing.refresh(
                { ...webPrincipal, id: r.owner },
                { requestId: 'git-remote-index-' + r.id },
              );
          } catch {
            result.indexRefreshPending = true;
          }
        }
        db.prepare(
          "UPDATE git_remote_jobs SET status='succeeded',phase='complete',result=?,error=NULL,updated_at=? WHERE id=?",
        ).run(JSON.stringify(result), Date.now(), r.id);
      } catch (e) {
        const cancelled =
          controller.signal.aborted && controller.signal.reason === 'GIT_COMMAND_CANCELLED';
        const code = cancelled
          ? 'GIT_COMMAND_CANCELLED'
          : controller.signal.aborted
            ? 'GIT_TASK_INTERRUPTED'
            : terminalError(e);
        // Unresolved process cleanup must keep its receipt available for reconciliation.
        const uncertain =
          !!(e as { workspaceReleaseError?: unknown })?.workspaceReleaseError ||
          terminalError(e) === 'WORKSPACE_PROCESS_RUNNING' ||
          (['push', 'pull'].includes(r.kind) &&
            [
              'GIT_NETWORK_FAILED',
              'GIT_COMMAND_TIMEOUT',
              'GIT_TASK_INTERRUPTED',
              'GIT_COMMAND_CANCELLED',
            ].includes(code)) ||
          cloneReceipt(db.prepare('SELECT * FROM git_remote_jobs WHERE id=?').get(r.id) as Row);
        db.prepare('UPDATE git_remote_jobs SET status=?,error=?,updated_at=? WHERE id=?').run(
          uncertain ? 'needs_reconciliation' : cancelled ? 'cancelled' : 'failed',
          code,
          Date.now(),
          r.id,
        );
      } finally {
        running.delete(r.id);
      }
    });
    running.set(r.id, { controller, promise });
  }
  function start(owner: string, input: GitJobInput): GitJob {
    if (closing) fail(503, 'GIT_SERVICE_STOPPING');
    if (
      !owner ||
      !input ||
      !kinds.has(input.kind) ||
      typeof input.requestId !== 'string' ||
      !input.requestId ||
      input.requestId.length > 128 ||
      /[\x00-\x1f]/.test(input.requestId)
    )
      fail(400, 'GIT_INVALID_REQUEST');
    const clean: GitJobInput = { kind: input.kind, requestId: input.requestId };
    for (const key of [
      'url',
      'branch',
      'credentialId',
      'name',
      'parentPath',
      'timeZone',
      'expectedHead',
      'host',
    ] as const)
      if (input[key] !== undefined) {
        if (typeof input[key] !== 'string' || input[key]!.length > 4096)
          fail(400, 'GIT_INVALID_REQUEST');
        clean[key] = input[key];
      }
    if (['test', 'clone', 'connect'].includes(clean.kind))
      clean.url = normalizeRemote(clean.url!).url;
    if (clean.kind === 'ssh-host' && !['github.com', 'gitee.com'].includes(clean.host!))
      fail(400, 'GIT_INVALID_REMOTE');
    const request = JSON.stringify(clean),
      existing = db
        .prepare('SELECT * FROM git_remote_jobs WHERE owner=? AND request_id=?')
        .get(owner, input.requestId) as Row | undefined;
    if (existing) {
      const previous = JSON.parse(existing.params);
      delete previous._root;
      delete previous._connection;
      if (JSON.stringify(previous) !== request) fail(409, 'REQUEST_ID_REUSED');
      return view(existing);
    }
    if (db.prepare("SELECT 1 FROM git_remote_jobs WHERE status IN ('queued','running')").get())
      fail(409, 'GIT_TASK_BUSY');
    const b = binding(),
      now = Date.now();
    let snapshot: Record<string, unknown> = {};
    if (b.root) {
      let s;
      try {
        s = lstatSync(b.root, { bigint: true });
      } catch {
        fail(503, 'SOURCE_UNAVAILABLE');
      }
      snapshot = {
        _root: { dev: String(s.dev), ino: String(s.ino) },
        _connection: identity(connection(owner, b.root, b.binding)),
      };
    }
    const params = JSON.stringify({ ...clean, ...snapshot });
    const r: Row = {
      id: randomUUID(),
      owner,
      request_id: input.requestId,
      kind: input.kind,
      params,
      root: b.root,
      binding: b.binding,
      status: 'queued',
      phase: 'queued',
      error: null,
      result: null,
      created_at: now,
      updated_at: now,
    };
    db.prepare('INSERT INTO git_remote_jobs VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)').run(
      r.id,
      r.owner,
      r.request_id,
      r.kind,
      r.params,
      r.root,
      r.binding,
      r.status,
      r.phase,
      r.error,
      r.result,
      r.created_at,
      r.updated_at,
    );
    launch(r);
    return view(r);
  }
  async function status(owner: string): Promise<GitRemoteStatus> {
    const p = plugins.list().find((p) => p.id === 'git'),
      b = binding();
    const result: GitRemoteStatus = {
      pluginInstalled: !!p,
      pluginEnabled: p?.state === 'enabled',
      repository: b.root ? 'missing' : 'unbound',
      branch: null,
      head: null,
      changes: 0,
      connection: null,
      discoveredRemotes: [],
      jobs: listJobs(owner),
    };
    if (!b.root) return result;
    try {
      await workspaceWrite(db, { kind: 'git.remote.status' }, async () => {
        await dependency(b.root!);
        const state = await repo(b.root!);
        if (!state) return;
        Object.assign(result, { repository: 'ready', ...state });
        for (const name of (await text(b.root!, ['remote'])).split('\n').filter(Boolean)) {
          if (!/^[A-Za-z0-9_.-]{1,100}$/.test(name)) continue;
          try {
            const remote = normalizeRemote(await text(b.root!, ['remote', 'get-url', name]));
            result.discoveredRemotes.push({ name, url: remote.url });
          } catch {}
        }
        const c = connection(owner, b.root!, b.binding);
        if (!c) return;
        let available = !c.credential_id;
        try {
          if (c.credential_id) available = !!credentials.get(owner, c.credential_id, c.host as any);
        } catch {}
        let ahead: number | null = null,
          behind: number | null = null;
        if (c.checked_at && !c.remote_head) {
          ahead = state.head ? Number(await text(b.root!, ['rev-list', '--count', 'HEAD'])) : 0;
          behind = 0;
        } else if (c.checked_at && c.remote_head && state.head) {
          const counts = await raw(b.root!, [
            'rev-list',
            '--left-right',
            '--count',
            `HEAD...${c.remote_head}`,
          ]);
          if (!counts.code) {
            const [a, z] = counts.stdout.toString().trim().split(/\s+/).map(Number);
            ahead = a;
            behind = z;
          }
        }
        result.connection = {
          url: c.url,
          host: c.host,
          branch: c.branch,
          remoteName: c.remote_name,
          credentialId: c.credential_id,
          credentialAvailable: available,
          lastCheckedAt: c.checked_at,
          remoteHead: c.remote_head,
          remoteExists: !!c.remote_exists,
          ahead,
          behind,
          writeVerified: !!c.write_verified,
        };
      });
    } catch (e) {
      result.code = terminalError(e);
      if (result.code !== 'WORKSPACE_BUSY') result.repository = 'unavailable';
    }
    return result;
  }
  return {
    assertPluginIdle(id: string) {
      if (
        id === 'git' &&
        db.prepare("SELECT 1 FROM git_remote_jobs WHERE status IN ('queued','running')").get()
      )
        fail(409, 'GIT_TASK_BUSY');
    },
    credentials,
    credentialChanged: (owner: string, id: string) =>
      db
        .prepare(
          'UPDATE git_remote_connections SET write_verified=0,checked_at=NULL WHERE owner=? AND credential_id=?',
        )
        .run(owner, id),
    status,
    start,
    job: (owner: string, id: string) => view(owned(owner, id)),
    listJobs,
    cancel: (owner: string, id: string) => {
      owned(owner, id);
      running.get(id)?.controller.abort('GIT_COMMAND_CANCELLED');
      return view(owned(owner, id));
    },
    retry: (owner: string, id: string) => {
      const r = owned(owner, id);
      if (r.status === 'succeeded') return view(r);
      if (r.status === 'running' || r.status === 'queued') return view(r);
      if (closing) fail(503, 'GIT_SERVICE_STOPPING');
      if (db.prepare("SELECT 1 FROM git_remote_jobs WHERE status IN ('queued','running')").get())
        fail(409, 'GIT_TASK_BUSY');
      if (
        cloneReceipt(r) ||
        (r.kind === 'pull' && r.result && Object.hasOwn(JSON.parse(r.result), 'target'))
      ) {
        r.status = 'queued';
        r.error = null;
        db.prepare(
          "UPDATE git_remote_jobs SET status='queued',error=NULL,updated_at=? WHERE id=?",
        ).run(Date.now(), id);
        launch(r);
        return view(r);
      }
      r.status = 'queued';
      r.error = null;
      r.phase = 'queued';
      db.prepare(
        "UPDATE git_remote_jobs SET status='queued',phase='queued',error=NULL,updated_at=? WHERE id=?",
      ).run(Date.now(), id);
      launch(r);
      return view(r);
    },
    close: async () => {
      closing = true;
      for (const r of running.values()) r.controller.abort('GIT_TASK_INTERRUPTED');
      await Promise.allSettled([...running.values()].map((r) => r.promise));
    },
  };
}
