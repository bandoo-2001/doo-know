import { build } from 'vite';
import { thirdPartyNotices } from './third-party-notices.mjs';
import { readFile, mkdir, rm, writeFile } from 'node:fs/promises';
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export async function buildPlugins({
  output,
  ids = ['mcp', 'git'],
  baseURL = pathToFileURL(resolve(output) + '/').href,
}) {
  const entries = [];
  await mkdir(output, { recursive: true });
  for (const id of ids) {
    const source = join(repo, 'plugins', id),
      stage = join(output, '.build-' + id);
    await rm(stage, { force: true, recursive: true });
    await mkdir(stage, { recursive: true });
    const manifest = JSON.parse(await readFile(join(source, 'manifest.json'), 'utf8'));
    await build({
      configFile: false,
      root: repo,
      logLevel: 'error',
      build: {
        outDir: join(stage, 'server'),
        emptyOutDir: true,
        ssr: join(source, 'server/index.ts'),
        rollupOptions: { output: { entryFileNames: 'index.mjs' } },
      },
      ssr: { noExternal: true, resolve: { conditions: ['node', 'import'] } },
    });
    await build({
      configFile: false,
      root: repo,
      logLevel: 'error',
      build: {
        outDir: join(stage, 'web'),
        emptyOutDir: true,
        lib: { entry: join(source, 'web/index.ts'), formats: ['es'], fileName: () => 'index.js' },
        rollupOptions: { external: ['vue', '@dooknow/plugin-ui'] },
      },
    });
    await writeFile(join(stage, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
    await writeFile(
      join(stage, 'THIRD_PARTY_NOTICES.txt'),
      await thirdPartyNotices(join(repo, 'node_modules')),
    );
    const name = `dooknow-plugin-${id}-${manifest.version}.tar.gz`,
      artifact = join(output, name);
    execFileSync('tar', [
      '--format=ustar',
      '--sort=name',
      '--mtime=@0',
      '--owner=0',
      '--group=0',
      '--numeric-owner',
      '-czf',
      artifact,
      '-C',
      stage,
      '.',
    ]);
    entries.push({
      ...manifest,
      artifact: {
        url: new URL(name, baseURL.endsWith('/') ? baseURL : baseURL + '/').href,
        sha256: createHash('sha256')
          .update(await readFile(artifact))
          .digest('hex'),
      },
    });
    await rm(stage, { force: true, recursive: true });
  }
  await writeFile(join(output, 'catalog.json'), JSON.stringify(entries, null, 2) + '\n');
  return entries;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  await buildPlugins({
    output: resolve(process.argv[2] || '.local/plugin-artifacts'),
    ...(process.env.DOOKNOW_ARTIFACT_ORIGIN
      ? { baseURL: process.env.DOOKNOW_ARTIFACT_ORIGIN }
      : {}),
  });
