import { writeFile } from 'node:fs/promises';
import {
  releaseArtifactSnapshot,
  REQUIRED_RELEASE_CHECKS,
} from '../../scripts/release-verification.js';

/** Test fixture receipts stand in for the verifier's command execution, never for release validation. */
export async function writeTestReleaseEvidence(directory: string, commit: string) {
  const file = directory + '.verification.json';
  await writeFile(
    file,
    JSON.stringify({
      schema: 1,
      sourceCommit: commit,
      verifiedAt: new Date().toISOString(),
      artifacts: await releaseArtifactSnapshot(directory),
      checks: REQUIRED_RELEASE_CHECKS.map((name) => ({ name, passed: true })),
    }),
  );
  return file;
}
