import { randomBytes, createHash } from 'node:crypto';
import { readFile, writeFile, copyFile, mkdir, rm, lstat, realpath, open } from 'node:fs/promises';
import { join } from 'node:path';
import type {
  PluginContext,
  PluginCall,
  PluginServices,
} from '../../../packages/plugin-sdk/index.js';
const hash = (b: string | Buffer) => createHash('sha256').update(b).digest('hex');
function error(code: string, statusCode = 409): never {
  throw Object.assign(Error(code), { code, statusCode });
}
const fixed = [
  '-c',
  'core.hooksPath=/dev/null',
  '-c',
  'core.fsmonitor=false',
  '-c',
  'protocol.ext.allow=never',
  '-c',
  'commit.gpgSign=false',
  '-c',
  'tag.gpgSign=false',
  '-c',
  'gc.auto=0',
  '-c',
  'maintenance.auto=false',
  '-c',
  'core.untrackedCache=false',
  '--no-pager',
  '--literal-pathspecs',
];
const decoder = new TextDecoder('utf-8', { fatal: true });
const text = (b: Buffer) => {
  try {
    return decoder.decode(b);
  } catch {
    return error('UNSUPPORTED_GIT_FILENAME');
  }
};
const oid = (s: unknown): s is string =>
  typeof s === 'string' && /^[a-f0-9]{40}([a-f0-9]{24})?$/.test(s);
export function activate(ctx: PluginContext) {
  const previews = join(ctx.dataRoot, 'previews');
  function workspace(call: PluginCall) {
    if (!call.services.workspace) error('PLUGIN_CAPABILITY_REQUIRED', 403);
    return call.services.workspace;
  }
  async function raw(
    call: PluginCall,
    args: string[],
    env: Record<string, string> = {},
    input?: string | Buffer,
    maxBytes = 2 * 1024 * 1024,
  ) {
    return workspace(call).exec([...fixed, ...args], {
      env: { GIT_OPTIONAL_LOCKS: '0', ...env },
      input,
      maxBytes,
    });
  }
  async function git(
    call: PluginCall,
    args: string[],
    env: Record<string, string> = {},
    input?: string | Buffer,
    maxBytes?: number,
  ) {
    const r = await raw(call, args, env, input, maxBytes);
    if (r.code !== 0) error('GIT_COMMAND_FAILED');
    return text(r.stdout).trimEnd();
  }
  async function exists(path: string) {
    try {
      return await lstat(path);
    } catch (e) {
      if ((e as any).code === 'ENOENT') return undefined;
      throw e;
    }
  }
  async function indexHash(path: string) {
    const s = await exists(path);
    if (!s) return 'absent';
    if (!s.isFile() || s.isSymbolicLink() || s.size > 64 * 1024 * 1024)
      error('UNSUPPORTED_GIT_INDEX');
    return hash(await readFile(path));
  }
  async function repository(call: PluginCall, write = false) {
    const version = await raw(call, ['--version']);
    if (version.code !== 0) error('GIT_DEPENDENCY_MISSING', 503);
    const match = text(version.stdout).match(/git version (\d+)\.(\d+)/);
    if (!match || Number(match[1]) < 2 || (Number(match[1]) === 2 && Number(match[2]) < 39))
      error('GIT_DEPENDENCY_MISSING', 503);
    const found = await raw(call, ['rev-parse', '--show-toplevel']);
    if (found.code !== 0) return undefined;
    const root = await realpath(workspace(call).root);
    if ((await realpath(text(found.stdout).trim())) !== root) error('WRONG_REPOSITORY_ROOT');
    const dir = await git(call, ['rev-parse', '--absolute-git-dir']),
      format = await git(call, ['rev-parse', '--show-object-format']);
    if (!['sha1', 'sha256'].includes(format)) error('UNSUPPORTED_GIT_OBJECT_FORMAT');
    const branchResult = await raw(call, ['symbolic-ref', '-q', 'HEAD']),
      branch = branchResult.code === 0 ? text(branchResult.stdout).trim() : null;
    const headResult = await raw(call, ['rev-parse', '--verify', 'HEAD']),
      head = headResult.code === 0 ? text(headResult.stdout).trim() : null;
    if (head !== null && !oid(head)) error('INVALID_GIT_HEAD');
    const repo = {
      root,
      dir,
      index: join(dir, 'index'),
      format,
      branch,
      head,
      zero: '0'.repeat(format === 'sha1' ? 40 : 64),
    };
    if (write) {
      if (!branch || !/^refs\/heads\//.test(branch)) error('DETACHED_HEAD');
      for (const marker of [
        'MERGE_HEAD',
        'CHERRY_PICK_HEAD',
        'REVERT_HEAD',
        'rebase-merge',
        'rebase-apply',
        'sequencer',
        'index.lock',
      ])
        if (await exists(join(dir, marker)))
          error(marker === 'index.lock' ? 'GIT_INDEX_LOCKED' : 'GIT_OPERATION_IN_PROGRESS');
      if (
        (await raw(call, ['config', '--get-regexp', '^filter\\..*\\.(clean|smudge|process)$']))
          .stdout.length
      )
        error('UNTRUSTED_GIT_FILTER');
      for (const key of ['core.sparseCheckout', 'index.sparse'])
        if ((await raw(call, ['config', '--bool', key])).stdout.toString().trim() === 'true')
          error('UNSUPPORTED_GIT_INDEX');
      if (await git(call, ['rev-parse', '--shared-index-path'])) error('UNSUPPORTED_GIT_INDEX');
      await validateIndex(call);
      const flags = await git(call, ['ls-files', '-v', '-z']);
      if (flags.split('\0').some((s) => /^[a-zS] /.test(s))) error('UNSUPPORTED_GIT_INDEX');
      const files = (
        await raw(call, ['ls-files', '--cached', '--others', '--exclude-standard', '-z'])
      ).stdout;
      if (files.length) {
        const attrs = await git(call, ['check-attr', '-z', '--stdin', 'filter'], {}, files);
        const records = attrs.split('\0');
        for (let i = 2; i < records.length; i += 3)
          if (!['unspecified', 'unset', ''].includes(records[i])) error('UNTRUSTED_GIT_FILTER');
      }
    }
    return repo;
  }
  async function required(call: PluginCall, write = true) {
    return (await repository(call, write)) || error('GIT_REPOSITORY_MISSING');
  }
  async function status(call: PluginCall) {
    const records = (
        await git(call, [
          'status',
          '--porcelain=v1',
          '-z',
          '--untracked-files=all',
          '--ignore-submodules=all',
        ])
      ).split('\0'),
      changes: any[] = [];
    for (let i = 0; i < records.length; i++) {
      if (!records[i]) continue;
      const code = records[i].slice(0, 2),
        path = records[i].slice(3);
      changes.push({
        code,
        path,
        ...(/[RC]/.test(code) ? { originalPath: records[++i] } : {}),
        staged: ![' ', '?'].includes(code[0]),
        unstaged: code[1] !== ' ',
      });
    }
    if (changes.length > 2000) error('GIT_TOO_MANY_CHANGES');
    return changes;
  }
  async function validateIndex(call: PluginCall, env: Record<string, string> = {}) {
    const staged = await git(call, ['ls-files', '--stage', '-z'], env);
    for (const item of staged.split('\0').filter(Boolean)) {
      const record = item.match(/^(\d{6}) [a-f0-9]+ (\d)\t/s);
      if (!record || record[2] !== '0') error('GIT_CONFLICT');
      if (!['100644', '100755'].includes(record[1])) error('UNSUPPORTED_GIT_ENTRY');
    }
  }
  async function privateIndex(
    call: PluginCall,
    repo: Awaited<ReturnType<typeof required>>,
    path: string,
    add: boolean,
  ) {
    await mkdir(previews, { recursive: true, mode: 0o700 });
    if (await exists(repo.index)) await copyFile(repo.index, path);
    else await git(call, ['read-tree', '--empty'], { GIT_INDEX_FILE: path });
    const env = { GIT_INDEX_FILE: path };
    const originalTree = await git(call, ['write-tree'], env);
    if (add) await git(call, ['add', '--all', '--', '.'], env);
    await validateIndex(call, env);
    return { originalTree, tree: await git(call, ['write-tree'], env) };
  }
  type Preview = {
    owner: string;
    root: string;
    binding: number;
    branch: string;
    head: string | null;
    indexHash: string;
    indexTree: string;
    tree: string;
    message: string;
    expiresAt: number;
    index: string;
  };
  async function cleanPreviews() {
    for (const row of ctx.storage.entries<Preview>('preview.'))
      if (row.value.expiresAt <= Date.now()) {
        await rm(row.value.index, { force: true });
        ctx.storage.delete(row.key);
      }
  }
  async function currentIndexTree(call: PluginCall, repo: Awaited<ReturnType<typeof required>>) {
    const path = join(previews, 'check-' + randomBytes(16).toString('hex'));
    try {
      return (await privateIndex(call, repo, path, false)).tree;
    } finally {
      await rm(path, { force: true });
    }
  }
  async function finishPublished(call: PluginCall, id: string, details: any) {
    let aligned = false;
    try {
      const repo = await required(call, false);
      if (repo.branch === details.preview.branch && repo.head === details.commit) {
        if ((await currentIndexTree(call, repo)) === details.preview.tree) aligned = true;
        else if ((await indexHash(repo.index)) === details.preview.indexHash) {
          const lockPath = repo.index + '.lock',
            lock = await open(lockPath, 'wx', 0o600).catch(() => undefined);
          if (lock) {
            const identity = await lock.stat(),
              stage = join(previews, 'align-' + randomBytes(16).toString('hex'));
            try {
              if ((await indexHash(repo.index)) !== details.preview.indexHash)
                error('GIT_INDEX_CHANGED');
              await privateIndex(call, repo, stage, false);
              const result = await raw(
                call,
                ['read-tree', '-m', '-i', details.preview.indexTree, details.preview.tree],
                { GIT_INDEX_FILE: stage },
              );
              if (
                result.code === 0 &&
                (await indexHash(repo.index)) === details.preview.indexHash &&
                (await required(call, false)).head === details.commit
              ) {
                const actual = await lstat(lockPath);
                if (actual.ino !== identity.ino || actual.dev !== identity.dev)
                  error('GIT_INDEX_LOCK_CHANGED');
                await lock.writeFile(await readFile(stage));
                await lock.sync();
                const { rename } = await import('node:fs/promises');
                await rename(lockPath, repo.index);
                aligned = true;
              }
            } finally {
              await lock.close();
              await rm(stage, { force: true });
              const actual = await exists(lockPath);
              if (actual?.ino === identity.ino && actual.dev === identity.dev)
                await rm(lockPath, { force: true });
            }
          }
        }
      }
    } catch {
      aligned = false;
    }
    const result = { commit: details.commit, published: true, needsReconciliation: !aligned };
    call.services.operations.finish(id, result);
    call.services.operations.stage(id, {
      ...details,
      phase: aligned ? 'finished' : 'needs_reconciliation',
    });
    return result;
  }
  async function recover(call: PluginCall, exclude?: string) {
    for (const pending of call.services.operations.pending()) {
      if (pending.operationId === exclude) continue;
      const d = pending.details;
      if (d.phase === 'needs_reconciliation') error('GIT_RECONCILIATION_REQUIRED');
      const repo = await required(call, false);
      if (
        d.commit &&
        (repo.head === d.commit || ['refPublished', 'indexAligned'].includes(d.phase))
      ) {
        const result = await finishPublished(call, pending.operationId, d);
        if (result.needsReconciliation) error('GIT_RECONCILIATION_REQUIRED');
      } else error('GIT_PENDING_OPERATION_REQUIRES_RETRY');
    }
  }
  const exclusive = <T>(call: PluginCall, work: () => Promise<T>) =>
    workspace(call).exclusive(work);
  const reading = <T>(call: PluginCall, work: () => Promise<T>) => workspace(call).read(work);
  ctx.registerProvider('git.status', (call) =>
    reading(call, async () => {
      try {
        const repo = await repository(call, true);
        if (!repo) return { repository: 'missing', changes: [], pending: [] };
        return {
          repository: 'ready',
          branch: repo.branch?.slice(11),
          head: repo.head,
          changes: await status(call),
          pending: call.services.operations.pending().map((p) => ({
            operationId: p.operationId,
            requestId: p.requestId,
            commit: p.details.commit,
            phase: p.details.phase,
          })),
        };
      } catch (e) {
        const code = (e as any).code || 'GIT_UNAVAILABLE';
        return {
          repository: code === 'GIT_DEPENDENCY_MISSING' ? 'dependency_missing' : 'blocked',
          code,
          changes: [],
          pending: [],
        };
      }
    }),
  );
  ctx.registerCommand('git.initialize', (call) =>
    exclusive(call, async () => {
      const op = call.services.operations.begin('initialize', call.input?.requestId, {
        root: workspace(call).root,
        binding: workspace(call).bindingVersion,
      });
      if (op.operation.status === 'succeeded') return JSON.parse(op.operation.result);
      const repo = await repository(call);
      if (!repo) await git(call, ['init', '--initial-branch=main']);
      else await required(call);
      const result = { initialized: true, branch: (await required(call)).branch!.slice(11) };
      call.services.operations.finish(op.operation.id, result);
      return result;
    }),
  );
  ctx.registerCommand('git.preview', (call) =>
    exclusive(call, async () => {
      await cleanPreviews();
      await recover(call);
      const repo = await required(call);
      const { authorName, authorEmail } = ctx.config();
      if (
        !authorName ||
        /[\x00-\x1f<>]/.test(authorName) ||
        !/^([^\s<>@]+)@([^\s<>@]+)$/.test(authorEmail)
      )
        error('GIT_AUTHOR_REQUIRED', 400);
      const message = call.input?.message;
      if (
        typeof message !== 'string' ||
        !message.trim() ||
        Buffer.byteLength(message) > 8192 ||
        message.includes('\0')
      )
        error('INVALID_COMMIT_MESSAGE', 400);
      const count = ctx.storage
        .entries<Preview>('preview.')
        .filter((p) => p.value.owner === call.ownerId).length;
      if (count >= 16) error('TOO_MANY_GIT_PREVIEWS', 429);
      const beforeHash = await indexHash(repo.index),
        changes = await status(call),
        token = randomBytes(32).toString('base64url'),
        index = join(previews, hash(token));
      try {
        const candidate = await privateIndex(call, repo, index, true),
          now = await required(call, false);
        if (
          now.head !== repo.head ||
          now.branch !== repo.branch ||
          (await indexHash(repo.index)) !== beforeHash
        )
          error('PREVIEW_STALE');
        const base = repo.head
          ? await git(call, ['rev-parse', repo.head + '^{tree}'])
          : await git(call, ['mktree'], {}, '');
        const diff = await git(call, [
          'diff-tree',
          '--no-commit-id',
          '--no-renames',
          '--name-status',
          '-r',
          '-z',
          base,
          candidate.tree,
        ]);
        const parts = diff.split('\0'),
          candidateChanges = [];
        for (let i = 0; i + 1 < parts.length; i += 2)
          candidateChanges.push({ code: parts[i], path: parts[i + 1] });
        if (!candidateChanges.length) error('GIT_NOTHING_TO_COMMIT');
        if (candidateChanges.length > 2000) error('GIT_TOO_MANY_CHANGES');
        const preview: Preview = {
          owner: call.ownerId,
          root: repo.root,
          binding: workspace(call).bindingVersion,
          branch: repo.branch!,
          head: repo.head,
          indexHash: beforeHash,
          indexTree: candidate.originalTree,
          tree: candidate.tree,
          message: message.trim(),
          expiresAt: Date.now() + 300000,
          index,
        };
        ctx.storage.set('preview.' + hash(token), preview);
        return {
          token,
          expiresAt: preview.expiresAt,
          message: preview.message,
          head: repo.head,
          changes: candidateChanges,
          partialStaging: changes.filter((c) => c.staged && c.unstaged).map((c) => c.path),
        };
      } catch (e) {
        await rm(index, { force: true });
        throw e;
      }
    }),
  );
  ctx.registerCommand('git.cancelPreview', async (call) => {
    const key = 'preview.' + hash(String(call.input?.token));
    const p = ctx.storage.get<Preview>(key);
    if (p?.owner !== call.ownerId) error('GIT_PREVIEW_NOT_FOUND', 404);
    await rm(p.index, { force: true });
    ctx.storage.delete(key);
    return { cancelled: true };
  });
  ctx.registerCommand('git.commit', (call) =>
    exclusive(call, async () => {
      const token = call.input?.token;
      if (typeof token !== 'string' || token.length > 128) error('INVALID_GIT_PREVIEW', 400);
      const op = call.services.operations.begin('commit', call.input?.requestId, {
          preview: hash(token),
        }),
        id = op.operation.id;
      if (op.operation.status === 'succeeded') return JSON.parse(op.operation.result);
      if (op.operation.status === 'failed') error(op.operation.error || 'GIT_COMMIT_FAILED');
      const intent = call.services.operations.intent<any>(id);
      if (intent?.commit) {
        const now = await required(call, false);
        if (now.head === intent.commit || intent.phase === 'refPublished') {
          call.services.operations.committing(id);
          return finishPublished(call, id, intent);
        }
      }
      await recover(call, id);
      const p = intent?.preview || ctx.storage.get<Preview>('preview.' + hash(token));
      if (!p || p.owner !== call.ownerId) error('GIT_PREVIEW_NOT_FOUND', 404);
      const repo = await required(call),
        check = join(previews, 'confirm-' + randomBytes(16).toString('hex'));
      try {
        if (
          p.expiresAt <= Date.now() ||
          p.binding !== workspace(call).bindingVersion ||
          p.root !== repo.root ||
          p.head !== repo.head ||
          p.branch !== repo.branch ||
          p.indexHash !== (await indexHash(repo.index))
        )
          error('PREVIEW_STALE');
        const candidate = await privateIndex(call, repo, check, true);
        if (
          candidate.tree !== p.tree ||
          p.indexHash !== (await indexHash(repo.index)) ||
          (await required(call, false)).head !== p.head
        )
          error('PREVIEW_STALE');
        let details = intent;
        if (!details) {
          const c = ctx.config();
          const env = {
            GIT_AUTHOR_NAME: c.authorName,
            GIT_AUTHOR_EMAIL: c.authorEmail,
            GIT_COMMITTER_NAME: c.authorName,
            GIT_COMMITTER_EMAIL: c.authorEmail,
          };
          const commit = await git(
            call,
            ['commit-tree', p.tree, ...(p.head ? ['-p', p.head] : [])],
            env,
            p.message + '\n',
          );
          if (!oid(commit)) error('GIT_COMMIT_FAILED');
          details = { phase: 'prepared', commit, preview: p };
          call.services.operations.stage(id, details);
        }
        call.services.operations.committing(id);
        const published = await raw(call, [
          'update-ref',
          '-m',
          'DooKnow: ' + id,
          p.branch,
          details.commit,
          p.head || repo.zero,
        ]);
        if (published.code !== 0) error('GIT_REFERENCE_CHANGED');
        details = { ...details, phase: 'refPublished' };
        call.services.operations.stage(id, details);
        return await finishPublished(call, id, details);
      } catch (e) {
        const code = (e as any).code || 'GIT_COMMIT_FAILED';
        if (!call.services.operations.intent(id)) {
          call.services.operations.fail(id, code);
          Object.assign(e as object, { publication: 'not_published' });
        }
        throw e;
      } finally {
        await rm(check, { force: true });
      }
    }),
  );
  ctx.registerCommand('git.acknowledge', (call) =>
    exclusive(call, async () => {
      const row = call.services.operations
        .pending()
        .find((p) => p.operationId === call.input?.operationId);
      if (!row || call.input?.confirm !== true) error('INVALID_RECONCILIATION', 400);
      const repo = await required(call, false);
      const result = row.result || {
        commit: row.details.commit,
        published: repo.head === row.details.commit,
        needsReconciliation: true,
      };
      call.services.operations.finish(row.operationId, result);
      call.services.operations.stage(row.operationId, { ...row.details, phase: 'acknowledged' });
      return { acknowledged: true, commit: row.details.commit };
    }),
  );
  ctx.registerProvider('git.noteInfo', (call) =>
    call.services.knowledge.info({ noteId: call.input?.noteId }),
  );
  ctx.registerProvider('git.history', (call) =>
    reading(call, async () => {
      for (const cursor of ctx.storage.entries<any>('history.'))
        if (cursor.value.expiresAt <= Date.now()) ctx.storage.delete(cursor.key);
      const activeCursors = ctx.storage.entries<any>('history.');
      if (activeCursors.length >= 256) ctx.storage.delete(activeCursors[0].key);
      const repo = await required(call, false);
      if (!repo.head) return { items: [] };
      const info = await call.services.knowledge.info({ noteId: call.input?.noteId });
      const limit = Number.isInteger(call.input?.limit)
        ? Math.min(50, Math.max(1, call.input.limit))
        : 20;
      let anchor = repo.head,
        skip = 0;
      if (call.input?.cursor) {
        const cursor = ctx.storage.get<any>('history.' + call.input.cursor);
        if (
          !cursor ||
          cursor.owner !== call.ownerId ||
          cursor.noteId !== info.id ||
          cursor.expiresAt <= Date.now()
        )
          error('CURSOR_EXPIRED');
        anchor = cursor.anchor;
        skip = cursor.skip;
      }
      const ids = (
        await git(call, [
          'rev-list',
          `--max-count=${limit + 1}`,
          `--skip=${skip}`,
          anchor,
          '--',
          info.relativePath,
        ])
      )
        .split('\n')
        .filter(Boolean);
      const items = [];
      for (const commit of ids.slice(0, limit)) {
        const data = (await git(call, ['show', '-s', '--format=%aI%x00%an%x00%s', commit])).split(
          '\0',
        );
        items.push({ commit, at: data[0], author: data[1], message: data[2] });
      }
      let nextCursor;
      if (ids.length > limit) {
        nextCursor = randomBytes(24).toString('hex');
        ctx.storage.set('history.' + nextCursor, {
          owner: call.ownerId,
          noteId: info.id,
          anchor,
          skip: skip + limit,
          expiresAt: Date.now() + 300000,
        });
      }
      return { items, ...(nextCursor ? { nextCursor } : {}) };
    }),
  );
  ctx.registerProvider('git.diff', (call) =>
    reading(call, async () => {
      const repo = await required(call, false),
        commit = call.input?.commit;
      if (!oid(commit)) error('INVALID_GIT_COMMIT', 400);
      const info = await call.services.knowledge.info({ noteId: call.input?.noteId });
      try {
        return {
          diff: await git(
            call,
            [
              'show',
              '--format=fuller',
              '--no-ext-diff',
              '--no-textconv',
              '--no-renames',
              commit,
              '--',
              info.relativePath,
            ],
            {},
            undefined,
            256 * 1024,
          ),
          maxBytes: 256 * 1024,
        };
      } catch (e) {
        if ((e as any).code === 'GIT_OUTPUT_TOO_LARGE')
          return { diff: '', truncated: true, maxBytes: 256 * 1024 };
        throw e;
      }
    }),
  );
  ctx.registerCommand('git.restore', (call) =>
    exclusive(call, async () => {
      await recover(call);
      await required(call);
      const commit = call.input?.commit;
      if (!oid(commit)) error('INVALID_GIT_COMMIT', 400);
      const info = await call.services.knowledge.info({ noteId: call.input?.noteId });
      if (
        info.sizeBytes > 1024 * 1024 ||
        info.editorMode === 'metadata' ||
        !info.relativePath.toLowerCase().endsWith('.md')
      )
        error('GIT_RESTORE_UNSUPPORTED');
      const blob = await raw(
        call,
        ['cat-file', 'blob', commit + ':' + info.relativePath],
        {},
        undefined,
        1024 * 1024,
      );
      if (blob.code !== 0) error('GIT_VERSION_NOT_FOUND', 404);
      const content = text(blob.stdout);
      return call.services.knowledge.update({
        noteId: info.id,
        content,
        expectedModifiedAt: call.input?.expectedModifiedAt,
        requestId: call.input?.requestId,
      });
    }),
  );
}
