import { expect, it } from 'vitest';
import { mkdtemp, mkdir, readFile, rm, writeFile, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

it('removes retired server outputs before rebuilding while preserving web artifacts and workspace data', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dooknow-clean-build-'));
  try {
    await mkdir(join(root, 'dist/server/removed-module'), { recursive: true });
    await mkdir(join(root, 'dist/web'), { recursive: true });
    await mkdir(join(root, 'data'), { recursive: true });
    await writeFile(join(root, 'dist/server/removed-module/retired.js'), 'old code');
    await writeFile(join(root, 'dist/web/index.html'), 'new web');
    await writeFile(join(root, 'data/keep'), 'workspace data');
    const run = spawnSync(process.execPath, [resolve('scripts/clean-server-build.mjs')], { cwd: root, encoding: 'utf8' });
    expect(run.status, run.stderr).toBe(0);
    await expect(access(join(root, 'dist/server'))).rejects.toThrow();
    expect(await readFile(join(root, 'dist/web/index.html'), 'utf8')).toBe('new web');
    expect(await readFile(join(root, 'data/keep'), 'utf8')).toBe('workspace data');
    const again = spawnSync(process.execPath, [resolve('scripts/clean-server-build.mjs')], { cwd: root });
    expect(again.status).toBe(0);
  } finally { await rm(root, { recursive: true, force: true }); }
});
