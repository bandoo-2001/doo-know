import { build as buildTool } from 'vite';
import { buildPlugins } from './build-plugins.mjs';
import { thirdPartyNotices } from './third-party-notices.mjs';
import {
  mkdirSync,
  readFileSync,
  writeFileSync,
  existsSync,
  cpSync,
  rmSync,
  renameSync,
  readdirSync,
} from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { parseArgs } from 'node:util';
const { values } = parseArgs({
  options: {
    output: { type: 'string' },
    'base-url': { type: 'string' },
    version: { type: 'string' },
    'skip-build': { type: 'boolean' },
  },
});
const source = values['base-url'] || 'http://127.0.0.1:18761';
const url = new URL(source);
if (
  url.protocol !== 'https:' &&
  !(url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname))
)
  throw Error('发行源必须为HTTPS或本机受控测试源');
if (url.username || url.password || url.search || url.hash)
  throw Error('发行源不能包含凭据或查询参数');
const version = values.version || '1.1.0-alpha.1';
if (!/^[0-9][a-zA-Z0-9.+-]{0,79}$/.test(version)) throw Error('非法发行版本');
if (process.platform !== 'linux' || process.arch !== 'x64')
  throw Error('首版构建仅支持Linux x86_64');
const output = resolve(values.output || '.local/releases');
mkdirSync(output, { recursive: true });
if (!values['skip-build']) execFileSync('npm', ['run', 'build'], { stdio: 'inherit' });
const cache = resolve('.local/release-inputs');
mkdirSync(cache, { recursive: true });
const nodeVersion = '22.22.1',
  nodeName = `node-v${nodeVersion}-linux-x64.tar.xz`;
const nodeHash = '9a6bc82f9b491279147219f6a18add1e18424dce90d41d2a5fcd69d4924ba3aa';
const nodeArchive = join(cache, nodeName);
const digest = (p) => createHash('sha256').update(readFileSync(p)).digest('hex');
if (!existsSync(nodeArchive)) {
  execFileSync(
    'curl',
    [
      '--fail',
      '--location',
      '--retry',
      '2',
      '--connect-timeout',
      '20',
      '--max-time',
      '300',
      '-o',
      nodeArchive + '.part',
      `https://nodejs.org/download/release/v${nodeVersion}/${nodeName}`,
    ],
    { stdio: 'inherit' },
  );
  renameSync(nodeArchive + '.part', nodeArchive);
}
if (digest(nodeArchive) !== nodeHash) throw Error('官方Node运行时校验失败');
const stage = join(output, `.stage-${process.pid}`);
mkdirSync(stage, { recursive: false, mode: 0o700 });
try {
  for (const name of ['dist', 'bin', 'package.json', 'package-lock.json'])
    cpSync(resolve(name), join(stage, name), { recursive: true });
  // Keep the lock manifest used by npm ci unchanged; release metadata carries the version.
  mkdirSync(join(stage, 'runtime/node'), { recursive: true });
  mkdirSync(join(stage, 'runtime/node/bin'), { recursive: true });
  execFileSync('tar', [
    '-xJf',
    nodeArchive,
    '--strip-components=1',
    '-C',
    join(stage, 'runtime/node'),
    `node-v${nodeVersion}-linux-x64/bin/node`,
    `node-v${nodeVersion}-linux-x64/LICENSE`,
  ]);
  const files = execFileSync('git', ['ls-files', '-z', 'runtime/vector-service'], {
    encoding: 'utf8',
  })
    .split('\0')
    .filter(Boolean);
  for (const file of files) {
    if (file.includes('/tests/') || !/\.(py|toml|txt|md|json)$/.test(file)) continue;
    cpSync(resolve(file), join(stage, file), { recursive: true });
  }
  execFileSync(
    'npm',
    ['ci', '--offline', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund'],
    { cwd: stage, stdio: 'inherit' },
  );
  execFileSync(
    join(stage, 'runtime/node/bin/node'),
    [
      '--input-type=module',
      '-e',
      "import Database from 'better-sqlite3'; const db=new Database(':memory:'); if(db.prepare('select 1 n').get().n!==1)process.exit(1);db.close()",
    ],
    { cwd: stage },
  );
  await buildPlugins({ output, ids: ['mcp', 'git'], baseURL: source });
  cpSync(join(output, 'catalog.json'), join(stage, 'catalog.json'));
  const searchMetadata = resolve('.local/platform-execution/search-artifacts/search-runtime.json');
  if (!existsSync(searchMetadata)) throw Error('请先构建独立检索包');
  const search = JSON.parse(readFileSync(searchMetadata, 'utf8'));
  const searchName = new URL(search.url).pathname.split('/').at(-1);
  const searchArchive = join(dirname(searchMetadata), searchName);
  if (digest(searchArchive) !== search.sha256) throw Error('检索包校验失败');
  if (resolve(searchArchive) !== resolve(output, searchName))
    cpSync(searchArchive, join(output, searchName));
  writeFileSync(
    join(stage, 'search-runtime.json'),
    JSON.stringify({ ...search, url: source.replace(/\/$/, '') + '/' + searchName }, null, 2) +
      '\n',
  );
  mkdirSync(join(stage, 'deploy'), { recursive: true });
  await buildTool({
    configFile: false,
    logLevel: 'error',
    build: {
      ssr: resolve('deploy/check-archive.ts'),
      outDir: join(stage, 'deploy'),
      emptyOutDir: true,
      rollupOptions: { output: { entryFileNames: 'check-archive.mjs' } },
    },
    ssr: { noExternal: true },
  });
  const removeBins = (path) => {
    for (const entry of readdirSync(path, { withFileTypes: true })) {
      const file = join(path, entry.name);
      if (entry.name === '.bin') rmSync(file, { recursive: true, force: true });
      else if (entry.isDirectory()) removeBins(file);
      else if (entry.isSymbolicLink()) throw Error('发行依赖含未批准软链接：' + entry.name);
    }
  };
  removeBins(join(stage, 'node_modules'));
  writeFileSync(join(stage, 'THIRD_PARTY_NOTICES.txt'), await thirdPartyNotices());
  const release = {
    version,
    platform: 'linux-x64',
    nodeVersion,
    nodeSha256: nodeHash,
    source,
    builtAt: new Date().toISOString(),
    sourceCommit: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
    dirty: !!execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8' }).trim(),
    databaseCompatibility: 1,
  };
  writeFileSync(join(stage, 'release.json'), JSON.stringify(release, null, 2) + '\n');
  const name = `dooknow-${version}-linux-x64.tar.gz`;
  execFileSync('tar', ['-czf', join(output, name + '.part'), '-C', stage, '.']);
  renameSync(join(output, name + '.part'), join(output, name));
  const sha256 = digest(join(output, name));
  writeFileSync(join(output, 'release.txt'), `${version} ${name} ${sha256}\n`);
  const script = readFileSync('deploy/install.sh', 'utf8')
    .replace('# __DOOKNOW_GITHUB_FETCH_FUNCTION__', readFileSync('deploy/github-fetch.sh', 'utf8'))
    .replace('__DOOKNOW_RELEASE_SOURCE__', source.replace(/\/$/, ''))
    .replaceAll('__DOOKNOW_RELEASE_VERSION__', version)
    .replace('__DOOKNOW_NODE_BINARY_SHA__', digest(join(stage, 'runtime/node/bin/node')));
  writeFileSync(join(output, 'install.sh'), script, { mode: 0o700 });
  writeFileSync(
    join(output, `release-${version}.json`),
    JSON.stringify({ ...release, file: name, sha256 }, null, 2) + '\n',
  );
  writeFileSync(
    join(output, 'release.json'),
    JSON.stringify({ ...release, file: name, sha256 }, null, 2) + '\n',
  );
  console.log(JSON.stringify({ output, version, file: name, sha256 }));
} finally {
  rmSync(stage, { recursive: true, force: true });
}
