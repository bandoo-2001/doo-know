import { it, expect } from 'vitest';
import { spawn } from 'node:child_process';
import { link, mkdir, mkdtemp, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createRun, projectRoot } from './support.js';
import { syntheticFixture } from './fixtures.js';

async function fixture() {
  const run = await createRun('guard-contract');
  const protectedRoot = await mkdtemp(join(projectRoot, '.local/guard-protected-'));
  await mkdir(run.knowledgeRoot);
  await mkdir(run.dataRoot);
  await writeFile(join(protectedRoot, 'sentinel.txt'), 'DO_NOT_CHANGE');
  await writeFile(
    join(run.root, 'result.json'),
    JSON.stringify({
      chunks: 128,
      semanticVectorsAreReal: true,
      model: { spaceId: 'unused-guard-space' },
    }),
  );
  await writeFile(join(run.root, 'labels.json'), JSON.stringify(syntheticFixture()));
  return { ...run, protectedRoot };
}
async function execute(root: string) {
  const child = spawn(
    process.execPath,
    [
      '--import',
      'tsx',
      'scripts/search-benchmark.ts',
      '--reuse',
      root,
      '--counts',
      '128',
      '--queries',
      '1',
      '--warmup',
      '0',
      '--no-background',
    ],
    { cwd: projectRoot },
  );
  let errors = '';
  child.stderr.on('data', (bytes) => (errors += bytes));
  child.stdout.resume();
  const code = await new Promise<number | null>((yes, no) => {
    child.once('error', no);
    child.once('exit', yes);
  });
  return { code, errors };
}

it.each(['knowledge', 'data'] as const)(
  'rejects a nested %s directory symlink before any runtime or DB writes',
  async (name) => {
    const f = await fixture();
    try {
      await rm(join(f.root, name), { recursive: true });
      await symlink(f.protectedRoot, join(f.root, name));
      const result = await execute(f.root);
      expect(result.code).toBe(1);
      expect(await readdir(f.protectedRoot)).toEqual(['sentinel.txt']);
      if (name === 'knowledge') expect(await readdir(f.dataRoot)).toEqual([]);
      expect(result.errors).toMatch(/link|directory/i);
    } finally {
      await rm(f.root, { recursive: true, force: true });
      await rm(f.protectedRoot, { recursive: true, force: true });
    }
  },
);

it.each([
  ['result.json', 'symlink'],
  ['labels.json', 'symlink'],
  ['result.json', 'hardlink'],
  ['labels.json', 'hardlink'],
] as const)(
  'rejects %s %s before loading any artifact contents or starting runtime',
  async (name, kind) => {
    const f = await fixture();
    try {
      const external = join(f.protectedRoot, name),
        target = join(f.root, name);
      await writeFile(
        external,
        name === 'result.json'
          ? JSON.stringify({
              chunks: 128,
              semanticVectorsAreReal: true,
              model: { spaceId: 'unused-guard-space' },
            })
          : JSON.stringify(syntheticFixture()),
      );
      await rm(target);
      if (kind === 'symlink') await symlink(external, target);
      else await link(external, target);
      const result = await execute(f.root);
      expect(result.code).toBe(1);
      expect(await readdir(f.dataRoot)).toEqual([]);
      expect(result.errors).toMatch(/link/i);
    } finally {
      await rm(f.root, { recursive: true, force: true });
      await rm(f.protectedRoot, { recursive: true, force: true });
    }
  },
);

it.each(['app.sqlite', 'app.sqlite-wal', 'app.sqlite-shm'])(
  'rejects a hardlinked %s DB target before runtime starts',
  async (name) => {
    const f = await fixture();
    try {
      const external = join(f.protectedRoot, name);
      await writeFile(external, 'PROTECTED_DB_TARGET');
      await link(external, join(f.dataRoot, name));
      const result = await execute(f.root);
      expect(result.code).toBe(1);
      expect(await readdir(f.dataRoot)).toEqual([name]);
      expect(result.errors).toMatch(/link/i);
    } finally {
      await rm(f.root, { recursive: true, force: true });
      await rm(f.protectedRoot, { recursive: true, force: true });
    }
  },
);

it.each([
  ['result.json', 8 * 1024 * 1024],
  ['labels.json', 1024 * 1024],
] as const)('rejects oversized %s before starting runtime', async (name, budget) => {
  const f = await fixture();
  try {
    await writeFile(join(f.root, name), Buffer.alloc(budget + 1, 32));
    const result = await execute(f.root);
    expect(result.code).toBe(1);
    expect(await readdir(f.dataRoot)).toEqual([]);
    expect(result.errors).toMatch(/ARTIFACT_TOO_LARGE/);
  } finally {
    await rm(f.root, { recursive: true, force: true });
    await rm(f.protectedRoot, { recursive: true, force: true });
  }
});
