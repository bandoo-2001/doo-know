import { it, expect } from 'vitest';
import { mkdtemp, writeFile, readFile, rm, symlink, mkdir } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join } from 'node:path';
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
