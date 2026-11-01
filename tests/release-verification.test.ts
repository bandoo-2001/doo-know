import { it, expect } from 'vitest';
import { mkdtemp, writeFile, readFile, rm, symlink, mkdir } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { verifyReleaseEvidence, releaseArtifactSnapshot } from '../scripts/release-verification.js';
import { writeTestReleaseEvidence } from './support/release-evidence.js';

it('binds successful recent checks to the exact source commit and artifact bytes', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'release-verification-'));
  const commit = 'a'.repeat(40),
    evidence = directory + '.verification.json';
  try {
    await writeFile(join(directory, 'application.tar.gz'), 'approved application bytes');
    await writeTestReleaseEvidence(directory, commit);
    await expect(verifyReleaseEvidence(directory, evidence, commit)).resolves.toMatchObject({
      sourceCommit: commit,
    });
    await expect(verifyReleaseEvidence(directory, undefined, commit)).rejects.toThrow(
      'RELEASE_VERIFICATION_REQUIRED',
    );
    await expect(verifyReleaseEvidence(directory, evidence, 'b'.repeat(40))).rejects.toThrow(
      'STALE_RELEASE_VERIFICATION',
    );
    const report = JSON.parse(await readFile(evidence, 'utf8'));
    for (const change of [
      { verifiedAt: new Date(Date.now() - 86_400_001).toISOString() },
      { verifiedAt: new Date(Date.now() + 600_000).toISOString() },
      { checks: report.checks.map((check: any) => ({ ...check, passed: false })) },
      { checks: report.checks.slice(1) },
    ]) {
      await writeFile(evidence, JSON.stringify({ ...report, ...change }));
      await expect(verifyReleaseEvidence(directory, evidence, commit)).rejects.toThrow(
        'STALE_RELEASE_VERIFICATION',
      );
    }
    await writeFile(evidence, JSON.stringify(report));
    await writeFile(join(directory, 'application.tar.gz'), 'unverified changed bytes');
    await expect(verifyReleaseEvidence(directory, evidence, commit)).rejects.toThrow(
      'RELEASE_VERIFICATION_ARTIFACT_MISMATCH',
    );
    await expect(
      verifyReleaseEvidence(directory, join(directory, 'proof.json'), commit),
    ).rejects.toThrow('RELEASE_VERIFICATION_MUST_BE_EXTERNAL');
  } finally {
    await rm(directory, { recursive: true, force: true });
    await rm(evidence, { force: true });
  }
});

it('refuses symlinked files in release evidence snapshots', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'release-verification-links-'));
  try {
    await writeFile(join(directory, 'original'), 'bytes');
    await symlink('original', join(directory, 'linked'));
    await expect(releaseArtifactSnapshot(directory)).rejects.toThrow(
      'INVALID_VERIFICATION_ARTIFACT',
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

it('rejects a release receipt without browser regression evidence', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'release-browser-evidence-'));
  const commit = 'c'.repeat(40);
  const evidence = directory + '.verification.json';
  try {
    await writeFile(join(directory, 'application.tar.gz'), 'application bytes');
    await writeTestReleaseEvidence(directory, commit);
    const report = JSON.parse(await readFile(evidence, 'utf8'));
    report.checks = report.checks.filter((check: { name: string }) => check.name !== 'browser-regressions');
    await writeFile(evidence, JSON.stringify(report));
    await expect(verifyReleaseEvidence(directory, evidence, commit)).rejects.toThrow(
      'STALE_RELEASE_VERIFICATION',
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
    await rm(evidence, { force: true });
  }
});

it('keeps an unrelated existing file when it is accidentally selected as verification output', async () => {
  const root = await mkdtemp(join(tmpdir(), 'release-output-boundary-'));
  try {
    const directory = join(root, 'artifacts'),
      output = join(root, 'personal.json');
    await mkdir(directory);
    await writeFile(output, '{"personal":"keep"}');
    await expect(
      promisify(execFile)(process.execPath, [
        '--import',
        'tsx',
        'scripts/verify-release.ts',
        '--directory',
        directory,
        '--output',
        output,
      ]),
    ).rejects.toMatchObject({ code: 1 });
    expect(await readFile(output, 'utf8')).toBe('{"personal":"keep"}');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it.each(['missing', 'unverified'])('refuses %s legacy input before issuing a native recovery receipt', async (kind) => {
  const root = await mkdtemp(join(tmpdir(), 'release-legacy-input-'));
  const repository = join(root, 'checkout'), directory = join(root, 'artifacts');
  const output = join(root, 'proof.json'), run = promisify(execFile);
  try {
    await mkdir(repository); await mkdir(directory);
    await run('git', ['init', '--quiet', repository]);
    await run('git', ['-C', repository, '-c', 'user.name=Release fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'core.hooksPath=/dev/null', 'commit', '--quiet', '--allow-empty', '--no-gpg-sign', '-m', 'fixture']);
    const commit = (await run('git', ['-C', repository, 'rev-parse', 'HEAD'])).stdout.trim();
    await writeFile(join(directory, 'release.json'), JSON.stringify({sourceCommit:commit,dirty:false,databaseCompatibility:3,version:'1.1.0-rc.49',file:'dooknow-1.1.0-rc.49-linux-x64.tar.gz'}));
    const { DOOKNOW_RECOVERY_LEGACY_ARCHIVE: _legacy, ...env } = process.env;
    const args = ['--import', resolve('node_modules/tsx/dist/loader.mjs'), resolve('scripts/verify-release.ts'), '--directory', directory, '--output', output];
    if (kind === 'unverified') {
      const file = join(root, 'wrong-archive.tar.gz');
      await writeFile(file, 'not a verified release');
      args.push('--legacy-archive', file);
    }
    await expect(run(process.execPath, args, {cwd:repository,env})).rejects.toMatchObject({
      code:1, stderr:expect.stringContaining(kind === 'missing' ? '跨版本回滚验证需要' : '旧版本制品校验失败'),
    });
    await expect(readFile(output, 'utf8')).rejects.toMatchObject({code:'ENOENT'});
  } finally { await rm(root, {recursive:true,force:true}); }
});

it.each(['missing', 'version', 'generation', 'source', 'dirty', 'checksum', 'symlink', 'inside', 'valid'])(
  'checks the independent same-generation recovery archive before any release receipt: %s',
  async (kind) => {
    const { createHash } = await import('node:crypto');
    const { create } = await import('tar');
    const root = await mkdtemp(join(tmpdir(), 'release-rollback-input-'));
    const repository = join(root, 'checkout'), directory = join(root, 'artifacts');
    const output = join(root, 'proof.json'), run = promisify(execFile);
    try {
      await mkdir(repository); await mkdir(directory);
      await run('git', ['init', '--quiet', repository]);
      await run('git', ['-C', repository, '-c', 'user.name=Release fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'core.hooksPath=/dev/null', 'commit', '--quiet', '--allow-empty', '--no-gpg-sign', '-m', 'fixture']);
      const commit = (await run('git', ['-C', repository, 'rev-parse', 'HEAD'])).stdout.trim();
      await writeFile(join(directory, 'release.json'), JSON.stringify({ sourceCommit: commit, dirty: false, version: '1.1.0-rc.59', databaseCompatibility: 4, file: 'dooknow-1.1.0-rc.59-linux-x64.tar.gz' }));
      const env = { ...process.env };
      for (const key of ['DOOKNOW_RECOVERY_LEGACY_ARCHIVE', 'DOOKNOW_RECOVERY_ROLLBACK_ARCHIVE', 'DOOKNOW_RECOVERY_ROLLBACK_VERSION', 'DOOKNOW_RECOVERY_ROLLBACK_SHA256']) delete env[key];
      const args = ['--import', resolve('node_modules/tsx/dist/loader.mjs'), resolve('scripts/verify-release.ts'), '--directory', directory, '--output', output];
      if (kind !== 'missing') {
        const staged = join(root, 'staged'); await mkdir(staged);
        await writeFile(join(staged, 'release.json'), JSON.stringify({
          version: kind === 'version' ? '1.1.0-rc.57' : '1.1.0-rc.58.diagram-recovery.1',
          databaseCompatibility: kind === 'generation' ? 3 : 4,
          sourceCommit: kind === 'source' ? 'b'.repeat(40) : commit,
          dirty: kind === 'dirty',
        }));
        const archive = join(kind === 'inside' ? directory : root, 'recovery.tar.gz');
        await create({ file: archive, gzip: true, cwd: staged }, ['./release.json']);
        const hash = createHash('sha256').update(await readFile(archive)).digest('hex');
        const input = kind === 'symlink' ? archive + '.linked' : archive;
        if (kind === 'symlink') await symlink(archive, input);
        args.push('--rollback-archive', input, '--rollback-version', '1.1.0-rc.58.diagram-recovery.1', '--rollback-sha256', kind === 'checksum' ? '0'.repeat(64) : hash);
      }
      await expect(run(process.execPath, args, { cwd: repository, env })).rejects.toMatchObject({
        code: 1,
        stderr: expect.stringContaining(kind === 'missing' ? '同代次恢复验证需要' : kind === 'valid' ? '跨版本回滚验证需要' : '同代次恢复制品校验失败'),
      });
      await expect(readFile(output, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
    } finally { await rm(root, { recursive: true, force: true }); }
  },
);
