import { execFileSync } from 'node:child_process';
import { createReadStream } from 'node:fs';
import { createHash } from 'node:crypto';
import { readFile, mkdir, writeFile, rm, mkdtemp, lstat } from 'node:fs/promises';
import { dirname, join, relative, resolve, sep, delimiter } from 'node:path';
import { tmpdir } from 'node:os';
import { parseArgs } from 'node:util';
import { releaseArtifactSnapshot, REQUIRED_RELEASE_CHECKS } from './release-verification.js';

const { values } = parseArgs({
  options: { directory: { type: 'string' }, output: { type: 'string' }, 'legacy-archive': { type: 'string' }, 'rollback-archive': { type: 'string' }, 'rollback-version': { type: 'string' }, 'rollback-sha256': { type: 'string' } },
});
if (!values.directory || !values.output)
  throw Error('用法：npm run verify:release -- --directory <制品目录> --output <目录外的证据文件>');
const directory = resolve(values.directory),
  output = resolve(values.output);
const relativeOutput = relative(directory, output);
if (!relativeOutput || (!relativeOutput.startsWith('..' + sep) && relativeOutput !== '..'))
  throw Error('验证证据必须保存在制品目录外');
// Remove any previous report before beginning; an interrupted run cannot leave a success receipt.
try {
  const previous = await lstat(output);
  if (!previous.isFile() || previous.nlink !== 1 || previous.size > 1024 ** 2)
    throw Error('输出位置已有其他文件，拒绝覆盖');
  const report = JSON.parse(await readFile(output, 'utf8'));
  if (
    report.schema !== 1 ||
    typeof report.sourceCommit !== 'string' ||
    !/^[a-f0-9]{40}$/.test(report.sourceCommit) ||
    !Array.isArray(report.checks) ||
    !report.artifacts ||
    typeof report.artifacts !== 'object'
  )
    throw Error('输出位置已有其他文件，拒绝覆盖');
} catch (error) {
  if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
}
await rm(output, { force: true });
const git = (...args: string[]) => execFileSync('git', args, { encoding: 'utf8' }).trim();
const commit = git('rev-parse', 'HEAD');
if (git('status', '--porcelain')) throw Error('发布验证需要已提交的干净源码');
const info = JSON.parse(await readFile(join(directory, 'release.json'), 'utf8'));
if (info.sourceCommit !== commit || info.dirty !== false) throw Error('制品必须由当前干净提交构建');
if (typeof info.file !== 'string' || !/^dooknow-[A-Za-z0-9.+-]+-linux-x64\.tar\.gz$/.test(info.file))
  throw Error('应用制品名称不正确');
// Generation four cannot legitimately roll back to published generation-three code.
// Exercise recovery with a separately built clean, same-commit/same-generation package.
const rollbackInput = values['rollback-archive'] || process.env.DOOKNOW_RECOVERY_ROLLBACK_ARCHIVE;
const rollbackVersion = values['rollback-version'] || process.env.DOOKNOW_RECOVERY_ROLLBACK_VERSION;
const rollbackSha256 = values['rollback-sha256'] || process.env.DOOKNOW_RECOVERY_ROLLBACK_SHA256;
const rollbackArchive = rollbackInput ? resolve(rollbackInput) : undefined;
async function rollbackSnapshot() {
  if (!rollbackArchive && info.databaseCompatibility < 4) return undefined;
  if (!rollbackArchive || !rollbackVersion || !rollbackSha256)
    throw Error('同代次恢复验证需要 --rollback-archive、--rollback-version 和 --rollback-sha256');
  try {
    const inside = relative(directory, rollbackArchive);
    if (!inside || (!inside.startsWith('..' + sep) && inside !== '..')) throw Error('RECOVERY_INPUT_MUST_BE_EXTERNAL');
    if (!/^[0-9][A-Za-z0-9.+-]{0,79}$/.test(rollbackVersion) || rollbackVersion === info.version ||
        !/^[a-f0-9]{64}$/.test(rollbackSha256)) throw Error('INVALID_RECOVERY_INPUT');
    const st = await lstat(rollbackArchive);
    if (!st.isFile() || st.isSymbolicLink() || st.nlink !== 1 || st.size === 0) throw Error('INVALID_RECOVERY_FILE');
    const hash = createHash('sha256');
    for await (const bytes of createReadStream(rollbackArchive)) hash.update(bytes);
    const sha256 = hash.digest('hex');
    if (sha256 !== rollbackSha256) throw Error('INVALID_RECOVERY_DIGEST');
    const metadata = JSON.parse(execFileSync('tar', ['-xOzf', rollbackArchive, './release.json'], { encoding: 'utf8', maxBuffer: 65536 }));
    if (metadata.version !== rollbackVersion || metadata.databaseCompatibility !== info.databaseCompatibility ||
        metadata.sourceCommit !== commit || metadata.dirty !== false) throw Error('INVALID_RECOVERY_METADATA');
    return { version: rollbackVersion, bytes: st.size, sha256, databaseCompatibility: metadata.databaseCompatibility, sourceCommit: metadata.sourceCommit };
  } catch {
    throw Error('同代次恢复制品校验失败；请提供固定摘要、版本及当前干净提交构建的同代次原生包');
  }
}
const rollbackArtifact = await rollbackSnapshot();
const legacyInput = values['legacy-archive'] || process.env.DOOKNOW_RECOVERY_LEGACY_ARCHIVE;
if (!legacyInput)
  throw Error('跨版本回滚验证需要 --legacy-archive 或 DOOKNOW_RECOVERY_LEGACY_ARCHIVE 指向已发布的 rc.48 主程序包');
const legacyArchive = resolve(legacyInput);
const legacyExpected = { version: '1.1.0-rc.48', bytes: 228478191, sha256: '24919355e880729645f46a23bc9aa4b035756fcdbc9dd7ebc29719a11fe035c6' };
const legacyStat = await lstat(legacyArchive);
if (!legacyStat.isFile() || legacyStat.isSymbolicLink() || legacyStat.size !== legacyExpected.bytes)
  throw Error('旧版本制品校验失败；请使用已发布的 rc.48 主程序包');
const legacyHash = createHash('sha256');
for await (const bytes of createReadStream(legacyArchive)) legacyHash.update(bytes);
if (legacyHash.digest('hex') !== legacyExpected.sha256)
  throw Error('旧版本制品校验失败；请使用已发布的 rc.48 主程序包');
const before = await releaseArtifactSnapshot(directory);
const candidateArchive = join(directory, info.file);
if (before[info.file]?.sha256 !== info.sha256) throw Error('应用制品与发行清单不一致');
const commands: [string, string[]][] = [
  ['npm', ['run', 'typecheck']],
  [
    'npm',
    [
      'exec',
      '--',
      'vitest',
      'run',
      'tests/collection-observation-permissions.test.ts',
      'tests/collection-hash-observation.test.ts',
      'tests/collection-lifecycle.test.ts',
      'tests/note-collections.test.ts',
      'tests/collection-api.test.ts',
      'tests/mcp-agent-errors.test.ts',
      'tests/mcp-agent-protocol.test.ts',
      'tests/mcp-agent-workflows.test.ts',
      'tests/indexing/chunks.test.ts',
      'tests/blog-core.test.ts',
      'tests/blog.test.ts',
      'tests/blog-security.test.ts',
      'tests/blog-workbench.test.ts',
      'tests/mcp-blog-tools.test.ts',
      'tests/mcp-blog-authorization.test.ts',
      'tests/mcp-blog-integration.test.ts',
      'tests/mcp-blog-packaged.test.ts',
      'tests/mcp-maintenance.test.ts',
      'tests/mcp-transport.test.ts',
      'tests/mcp-authorization-ui.test.ts',
      'tests/oauth-provider.test.ts',
      'tests/install-launcher.test.ts',
      'tests/install-template.test.ts',
      'tests/account-prompt.test.ts',
      'tests/auth.test.ts',
      'tests/platform-cli.test.ts',
      'tests/platform-backup-service.test.ts',
      'tests/backup-plugin-consistency.test.ts',
      'tests/platform-config.test.ts',
      'tests/platform-update.test.ts',
      'tests/release-compatibility.test.ts',
      'tests/current-format-routes.test.ts',
      'tests/storage-directories.test.ts',
      'tests/organization-plain-text-move.test.ts',
      'tests/note-trash-native-restore.test.ts',
      'tests/platform-rollback-service.test.ts',
      'tests/git-transport.test.ts',
      'tests/git-remote.test.ts',
      'tests/guarded-process-lifecycle.test.ts',
      'tests/guarded-process-cancellation.test.ts',
      'tests/guarded-process-streams.test.ts',
      'tests/guarded-process-session.test.ts',
      'tests/process-runner-unavailable.test.ts',
      'tests/git-containment-failure.test.ts',
      'tests/workspace-error-preservation.test.ts',
      'tests/workspace-process-identity.test.ts',
      'tests/search-runtime-process-identity.test.ts',
      'tests/tokenizer-lifecycle.test.ts',
      'tests/git-guarded-timeout.test.ts',
      'tests/github-publish.test.ts',
      'tests/release-verification.test.ts',
      'tests/release-browser-lifecycle.test.ts',
      'tests/maintenance-storage.test.ts',
      'tests/backup-reconciliation.test.ts',
      'tests/backup-wal.test.ts',
      'tests/workspace-save-recovery.test.ts',
      'tests/session-bootstrap-retry.test.ts',
      'tests/api-csrf-timeout.test.ts',
      'tests/static-asset-cache.test.ts',
      'tests/editor-view-transitions.test.ts',
      'tests/editor-image-navigation.test.ts',
      'tests/git-web-regressions.test.ts',
      'tests/git-remote-ui.test.ts',
      'tests/git-cancellation.test.ts',
      'tests/restore-folder-trash.test.ts',
      'tests/web-note-drafts.test.ts',
      'tests/web-drafts.test.ts',
      'tests/web-search-results.test.ts',
      'tests/search/recall-diversity.test.ts',
      'tests/search/filename.test.ts',
      'tests/search/text.test.ts',
      'tests/search/pagination.test.ts',
      'tests/search/fusion.test.ts',
      'tests/knowledge/snapshot-lifecycle.test.ts',
      'tests/knowledge/reconcile-source-race.test.ts',
      'tests/knowledge/note-read-permissions.test.ts',
      'tests/workspace-gate.test.ts',
      'tests/knowledge/note-write-concurrency.test.ts',
      'tests/knowledge/file-jobs.test.ts',
      'tests/knowledge/file-job-wal.test.ts',
      'tests/knowledge/lease-fencing.test.ts',
      'tests/knowledge/move-conflicts.test.ts',
      'tests/platform-rollback-recovery.test.ts',
      'tests/native-rollback-entrypoint.test.ts',
      'tests/indexing/jobs.test.ts',
      'tests/transfers.test.ts',
      'tests/markdown-links.test.ts',
      'tests/workspace-markdown-navigation.test.ts',
      'tests/shares.test.ts',
      'tests/share-options.test.ts',
      'tests/shares-permissions-security.test.ts',
      'tests/update-command.test.ts',
      'tests/download-proxy.test.ts',
      'tests/download-proxy-process.test.ts',
      'tests/download-proxy-cli.test.ts',
    ],
  ],
  [process.execPath, ['tests/install-smoke.mjs', '--directory', directory, '--skip-build']],
  [process.execPath, ['tests/release-browser.mjs', '--directory', directory]],
];
const checks = [];
const isolatedBin = await mkdtemp(join(tmpdir(), 'dooknow-verification-services-'));
try {
  await writeFile(
    join(isolatedBin, 'systemctl'),
    '#!/bin/sh\ncase "$*" in *is-active*) printf "inactive\\n"; exit 3;; esac\nprintf "Release verification blocks user-service control\\n" >&2\nexit 1\n',
    { mode: 0o700 },
  );
  for (const [index, [command, args]] of commands.entries()) {
    execFileSync(command, args, {
      stdio: 'inherit',
      env: {
        ...process.env, PATH: isolatedBin + delimiter + process.env.PATH,
        DOOKNOW_RECOVERY_LEGACY_ARCHIVE: legacyArchive,
        DOOKNOW_RECOVERY_CANDIDATE_ARCHIVE: candidateArchive,
        DOOKNOW_RECOVERY_CANDIDATE_VERSION: info.version,
        DOOKNOW_RECOVERY_ROLLBACK_ARCHIVE: rollbackArchive || '',
        DOOKNOW_RECOVERY_ROLLBACK_VERSION: rollbackArtifact?.version || '',
        DOOKNOW_RECOVERY_ROLLBACK_SHA256: rollbackArtifact?.sha256 || '',
      },
    });
    checks.push({
      name: REQUIRED_RELEASE_CHECKS[index],
      command: [command, ...args],
      passed: true,
    });
  }
} finally {
  await rm(isolatedBin, { recursive: true, force: true });
}
if (
  JSON.stringify(await rollbackSnapshot()) !== JSON.stringify(rollbackArtifact) ||
  git('rev-parse', 'HEAD') !== commit ||
  git('status', '--porcelain') ||
  JSON.stringify(await releaseArtifactSnapshot(directory)) !== JSON.stringify(before)
)
  throw Error('验证期间源码或制品发生变化，请重新构建与验证');
await mkdir(dirname(output), { recursive: true, mode: 0o700 });
await writeFile(
  output,
  JSON.stringify(
    {
      schema: 1,
      sourceCommit: commit,
      verifiedAt: new Date().toISOString(),
      legacyArtifact: legacyExpected,
      ...(rollbackArtifact ? { rollbackArtifact } : {}),
      artifacts: before,
      checks,
    },
    null,
    2,
  ) + '\n',
  { mode: 0o600, flag: 'wx' },
);
console.log(`发布验证通过，证据：${output}`);
