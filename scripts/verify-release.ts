import { execFileSync } from 'node:child_process';
import { readFile, mkdir, writeFile, rm, mkdtemp, lstat } from 'node:fs/promises';
import { dirname, join, relative, resolve, sep, delimiter } from 'node:path';
import { tmpdir } from 'node:os';
import { parseArgs } from 'node:util';
import { releaseArtifactSnapshot, REQUIRED_RELEASE_CHECKS } from './release-verification.js';

const { values } = parseArgs({
  options: { directory: { type: 'string' }, output: { type: 'string' } },
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
const before = await releaseArtifactSnapshot(directory);
const commands: [string, string[]][] = [
  ['npm', ['run', 'typecheck']],
  [
    'npm',
    [
      'exec',
      '--',
      'vitest',
      'run',
      'tests/install-launcher.test.ts',
      'tests/install-template.test.ts',
      'tests/account-prompt.test.ts',
      'tests/auth.test.ts',
      'tests/platform-cli.test.ts',
      'tests/platform-backup-service.test.ts',
      'tests/backup-plugin-consistency.test.ts',
      'tests/platform-config.test.ts',
      'tests/platform-update.test.ts',
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
      'tests/knowledge/snapshot-lifecycle.test.ts',
      'tests/knowledge/reconcile-source-race.test.ts',
      'tests/knowledge/note-read-permissions.test.ts',
      'tests/update-command.test.ts',
      'tests/download-proxy.test.ts',
      'tests/download-proxy-process.test.ts',
      'tests/download-proxy-cli.test.ts',
    ],
  ],
  [process.execPath, ['tests/install-smoke.mjs', '--directory', directory, '--skip-build']],
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
      env: { ...process.env, PATH: isolatedBin + delimiter + process.env.PATH },
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
      artifacts: before,
      checks,
    },
    null,
    2,
  ) + '\n',
  { mode: 0o600, flag: 'wx' },
);
console.log(`发布验证通过，证据：${output}`);
