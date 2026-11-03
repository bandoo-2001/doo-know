import { readFile, writeFile } from 'node:fs/promises';
import { gzipSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
const projectRoot = fileURLToPath(new URL('../../../../../', import.meta.url));
const manifest = JSON.parse(
  await readFile(resolve(projectRoot, 'dist/web/.vite/manifest.json'), 'utf8'),
);
const [stage = 'current', filename = 'build-' + stage + '.json'] = process.argv.slice(2);
const entries = ['components/ToDooWorkspace.vue', 'index.html'];
async function measure(keys) {
  const chunks = [];
  for (const source of [...keys].sort()) {
    const file = manifest[source]?.file;
    if (!file?.endsWith('.js')) continue;
    const content = await readFile(resolve(projectRoot, 'dist/web', file));
    chunks.push({ source, file, bytes: content.length, gzipBytes: gzipSync(content).length });
  }
  return {
    bytes: chunks.reduce((n, c) => n + c.bytes, 0),
    gzipBytes: chunks.reduce((n, c) => n + c.gzipBytes, 0),
    chunks,
  };
}
function staticKeys(entry, keys = new Set()) {
  if (!manifest[entry]) throw Error('Missing manifest entry: ' + entry);
  if (keys.has(entry)) return keys;
  keys.add(entry);
  for (const dependency of manifest[entry].imports || []) staticKeys(dependency, keys);
  return keys;
}
const graphs = {};
for (const entry of entries) graphs[entry] = await measure(staticKeys(entry));
const all = await measure(Object.keys(manifest));
const result = {
  stage,
  command: 'npm run build',
  description:
    'JS bytes and per-file gzip sums; static imports only, no dynamic preloading, no network/cache estimate',
  entry: entries[0],
  entryBytes: graphs[entries[0]].chunks.find((c) => c.source === entries[0]).bytes,
  staticGraphBytes: graphs[entries[0]].bytes,
  staticGraphGzipBytes: graphs[entries[0]].gzipBytes,
  allJavaScriptBytes: all.bytes,
  allJavaScriptGzipBytes: all.gzipBytes,
  graphs,
};
await writeFile(new URL('./' + filename, import.meta.url), JSON.stringify(result, null, 2) + '\n');
console.log(
  JSON.stringify({
    stage,
    entryBytes: result.entryBytes,
    staticGraphBytes: result.staticGraphBytes,
    staticGraphGzipBytes: result.staticGraphGzipBytes,
    allJavaScriptBytes: all.bytes,
    allJavaScriptGzipBytes: all.gzipBytes,
  }),
);
