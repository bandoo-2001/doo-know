import { createReadStream } from 'node:fs';
import { lstat, readFile, readdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join, relative, resolve, sep } from 'node:path';

export const REQUIRED_RELEASE_CHECKS = [
  'typecheck',
  'platform-tests',
  'artifact-install-smoke',
] as const;
export type ArtifactSnapshot = Record<string, { sha256: string; bytes: number }>;

export async function releaseArtifactSnapshot(directory: string): Promise<ArtifactSnapshot> {
  const snapshot: ArtifactSnapshot = {};
  for (const name of (await readdir(directory)).sort()) {
    const path = join(directory, name),
      info = await lstat(path);
    if (!info.isFile() || info.nlink !== 1) throw Error('INVALID_VERIFICATION_ARTIFACT');
    const hash = createHash('sha256');
    for await (const bytes of createReadStream(path)) hash.update(bytes);
    snapshot[name] = { sha256: hash.digest('hex'), bytes: info.size };
  }
  return snapshot;
}

export async function verifyReleaseEvidence(
  directory: string,
  file: string | undefined,
  commit: string,
) {
  if (!file) throw Error('RELEASE_VERIFICATION_REQUIRED');
  const inside = relative(resolve(directory), resolve(file));
  if (!inside || (!inside.startsWith('..' + sep) && inside !== '..' && !inside.startsWith(sep)))
    throw Error('RELEASE_VERIFICATION_MUST_BE_EXTERNAL');
  let report: any;
  try {
    report = JSON.parse(await readFile(file, 'utf8'));
  } catch {
    throw Error('INVALID_RELEASE_VERIFICATION');
  }
  const time = Date.parse(report.verifiedAt),
    age = Date.now() - time;
  if (
    report.schema !== 1 ||
    report.sourceCommit !== commit ||
    !Number.isFinite(time) ||
    age < -300_000 ||
    age > 86_400_000 ||
    !Array.isArray(report.checks) ||
    report.checks.length !== REQUIRED_RELEASE_CHECKS.length ||
    REQUIRED_RELEASE_CHECKS.some(
      (name) =>
        report.checks.filter((check: any) => check?.name === name && check.passed === true)
          .length !== 1,
    )
  )
    throw Error('STALE_RELEASE_VERIFICATION');
  const current = await releaseArtifactSnapshot(directory);
  if (JSON.stringify(current) !== JSON.stringify(report.artifacts))
    throw Error('RELEASE_VERIFICATION_ARTIFACT_MISMATCH');
  return report;
}
