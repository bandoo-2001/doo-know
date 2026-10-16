import { it, expect } from 'vitest';
import { readFile, writeFile, mkdtemp, rm } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { resolve, join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
it('embeds the real Bash downloader without interpreting its dollar quotes as JavaScript replacement directives', async () => {
  const { renderInstaller } = await import(pathToFileURL(resolve('scripts/install-template.mjs')).href);
  const root = await mkdtemp(join(tmpdir(), 'installer-template-'));
  try {
    const helper = await readFile('deploy/github-fetch.sh', 'utf8');
    const options = { source: 'https://github.com/owner/private/releases/download/v1.2.3', version: '1.2.3', nodeSha256: 'a'.repeat(64) };
    const probe = renderInstaller('#!/bin/bash\nmain() {\n# __DOOKNOW_GITHUB_FETCH_FUNCTION__\nprintf "ready\\n"\n}\nmain "$@"\n', helper, options);
    await writeFile(join(root, 'probe.sh'), probe);
    expect((await promisify(execFile)('bash', [join(root, 'probe.sh')])).stdout).toBe('ready\n');
    const actual = renderInstaller(await readFile('deploy/install.sh', 'utf8'), helper, options);
    await writeFile(join(root, 'install.sh'), actual);
    await promisify(execFile)('bash', ['-n', join(root, 'install.sh')]);
  } finally { await rm(root, { recursive: true, force: true }); }
});
