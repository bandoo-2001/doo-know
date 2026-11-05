/** Root-controlled isolated setup fixture factory. Never imported by capture/plan. */
import { createServer as createHTTPServer, request as httpRequest, type IncomingMessage, type ServerResponse } from 'node:http';
import { mkdtemp, mkdir, writeFile, rm, realpath } from 'node:fs/promises';
import { join, resolve, dirname, basename } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { createServer as createViteServer } from 'vite';
import { createApp } from '../../apps/server/app';
import { initializeOwner } from '../../apps/server/auth';
import { testPassword } from '../../tests/support/credentials';
import { localGitTransport } from '../../tests/support/git-remote-fixture';
import type { HostConfig } from '../../shared/platform-contracts';

const args = process.argv.slice(2);
const option = (name: string, fallback: string) => { const index = args.indexOf('--' + name); return index < 0 ? fallback : args[index + 1] ?? ''; };
const webPort = Number(option('web-port', '4491')), apiPort = Number(option('api-port', '4492'));
for (const port of [webPort, apiPort]) if (!Number.isInteger(port) || port < 1024 || port > 65535) throw Error('Dedicated unprivileged setup fixture ports required');
if (webPort === apiPort) throw Error('Setup web/API ports must differ');
const configPath = resolve(option('config', '.local/platform-ui-setup-config.json'));
const sourceCommit = option('source-commit', '');
if (!/^[a-f0-9]{40}$/.test(sourceCommit) || execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim() !== sourceCommit)
  throw Error('Setup factory requires --source-commit matching the final checkout HEAD');
execFileSync('git', ['diff', '--quiet', sourceCommit, '--', 'apps', 'packages', 'plugins', 'shared', 'package.json', 'package-lock.json', 'vite.config.ts']);
const root = await mkdtemp(join(tmpdir(), 'dooknow-browser-setup-'));
const realRoot = await realpath(root);
if (dirname(realRoot) !== await realpath(tmpdir()) || !basename(realRoot).startsWith('dooknow-browser-setup-')) throw Error('Setup temporary-root guard failed');
const origin = 'http://127.0.0.1:' + webPort;
const controlToken = randomBytes(32).toString('hex');
const fixtureHeader = 'x-dooknow-setup-fixture';
const slots = new Map<string, { app: Awaited<ReturnType<typeof createApp>>; root: string; port: number; releaseGit: () => void }>();
let shuttingDown = false;
await mkdir(join(root, 'data'), { recursive: true });
await mkdir(join(root, 'knowledge'), { recursive: true });
await mkdir(join(root, 'instances'), { recursive: true });
const buildModule = '../build-process-runner.mjs';
await (await import(buildModule)).buildProcessRunner();
const pluginModule = '../build-plugins.mjs';
const pluginCatalog = await (await import(pluginModule)).buildPlugins({ output: join(root, 'plugins'),
  ids: ['mcp', 'git'], baseURL: pathToFileURL(join(root, 'plugins') + '/').href });
const gitRemoteURL = 'https://github.com/runtime-setup-fixture/notes.git';
const gitRemoteRoot = join(root, 'remote.git'), seed = join(root, 'remote-seed');
await mkdir(join(seed, '00-Inbox'), { recursive: true });
await writeFile(join(seed, '00-Inbox', '远端示例.md'), '# 真实隔离远端\n\n仅用于首次设置运行核验。\n');
for (const command of [
  ['init', '--bare', '--initial-branch=main', gitRemoteRoot],
  ['-C', seed, 'init', '--initial-branch=main'], ['-C', seed, 'config', 'user.name', 'Setup Fixture'],
  ['-C', seed, 'config', 'user.email', 'setup@example.invalid'], ['-C', seed, 'add', '--', '00-Inbox/远端示例.md'],
  ['-C', seed, 'commit', '-m', 'Isolated setup seed'], ['-C', seed, 'push', '--', gitRemoteRoot, 'main'],
]) execFileSync('git', command, { stdio: 'pipe' });

function authorized(request: IncomingMessage) {
  const provided = Buffer.from(String(request.headers.authorization ?? '').replace(/^Bearer /, ''));
  const expected = Buffer.from(controlToken);
  return provided.length === expected.length && timingSafeEqual(provided, expected);
}
function json(response: ServerResponse, status: number, value: unknown) {
  response.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  response.end(JSON.stringify(value));
}
async function allocate(mode: string) {
  const id = randomUUID(), slotRoot = join(root, 'instances', id), libraryParent = join(slotRoot, 'libraries');
  const existingRoot = join(libraryParent, 'personal'), dataRoot = join(slotRoot, 'data');
  await mkdir(join(existingRoot, '00-Inbox'), { recursive: true });
  await writeFile(join(existingRoot, '00-Inbox', '已有资料.md'), '# 保留的已有资料\n\n真实首次设置夹具原文。\n');
  const unavailablePath = join(slotRoot, 'unavailable-root');
  if (mode === 'source-unavailable') await writeFile(unavailablePath, 'Fixture path deliberately is a regular file, not a knowledge directory.');
  const config: HostConfig = { dataRoot, secret: randomBytes(48).toString('hex'), origin,
    allowedKnowledgeBases: [libraryParent], indexing: { enabled: false, watch: false }, pluginCatalog,
    ...(mode === 'source-unavailable' ? { knowledgeRoot: unavailablePath } : {}),
  };
  await initializeOwner(config, 'owner', testPassword);
  let releaseGit = () => {};
  const pendingGit = new Promise<void>(done => { releaseGit = done; });
  const app = await createApp(config, { gitExec: db => {
    const actual = localGitTransport(db, { [gitRemoteURL]: gitRemoteRoot });
    return async (cwd, args, options) => {
      if (mode === 'git-delayed' && args.includes('clone')) {
        await Promise.race([pendingGit, new Promise<never>((_done, reject) => {
          if (options?.signal?.aborted) reject(Error('Fixture Git transport aborted'));
          else options?.signal?.addEventListener('abort', () => reject(Error('Fixture Git transport aborted')), { once: true });
        })]);
      }
      return actual(cwd, args, options);
    };
  } });
  try {
    await app.listen({ host: '127.0.0.1', port: 0 });
    const address = app.server.address();
    if (!address || typeof address === 'string') throw Error('Setup app did not obtain an isolated loopback port');
    slots.set(id, { app, root: slotRoot, port: address.port, releaseGit });
    const login = await app.inject({ method: 'POST', url: '/api/auth/sign-in/username', headers: { origin },
      payload: { username: 'owner', password: testPassword } });
    if (login.statusCode !== 200) throw Error('Actual setup owner sign-in failed');
    const csrf = await app.inject({ method: 'GET', url: '/api/security/csrf',
      headers: { cookie: login.cookies.map(cookie => cookie.name + '=' + cookie.value).join('; ') } });
    if (csrf.statusCode !== 200) throw Error('Actual setup CSRF exchange failed');
    const cookies = [...login.cookies, ...csrf.cookies].map(cookie => ({ name: cookie.name, value: cookie.value,
      domain: '127.0.0.1', path: '/', httpOnly: true, secure: false, sameSite: 'Lax' }));
    return { id, origin, dataRoot, knowledgeRoot: existingRoot, libraryParent, existingRoot, gitRemoteURL,
      headers: { [fixtureHeader]: id }, cookies };
  } catch (error) { slots.delete(id); await app.close(); await rm(slotRoot, { recursive: true, force: true }); throw error; }
}
const gateway = createHTTPServer(async (request, response) => {
  try {
    if (request.url?.startsWith('/__platform-ui-evidence/setup-fixtures')) {
      if (!authorized(request)) return json(response, 403, { error: 'FIXTURE_CONTROL_REQUIRED' });
      if (shuttingDown) return json(response, 503, { error: 'FIXTURE_STOPPING' });
      if (request.method === 'POST' && request.url === '/__platform-ui-evidence/setup-fixtures') {
        const chunks: Buffer[] = []; let size = 0;
        for await (const chunk of request) { size += chunk.length; if (size > 4096) return json(response, 413, { error: 'FIXTURE_REQUEST_TOO_LARGE' }); chunks.push(Buffer.from(chunk)); }
        const input = JSON.parse(Buffer.concat(chunks).toString() || '{}');
        if (!['empty', 'source-unavailable', 'git-delayed'].includes(input.mode ?? 'empty')) return json(response, 400, { error: 'UNKNOWN_SETUP_MODE' });
        return json(response, 201, await allocate(input.mode ?? 'empty'));
      }
      if (request.method === 'POST' && request.url.endsWith('/release-git')) {
        const id = request.url.split('/').at(-2)!; const slot = slots.get(id);
        if (!slot) return json(response, 404, { error: 'FIXTURE_NOT_FOUND' });
        slot.releaseGit(); return json(response, 200, { released: true });
      }
      if (request.method === 'DELETE') {
        const id = request.url.split('/').at(-1)!;
        const slot = slots.get(id);
        if (!slot) return json(response, 404, { error: 'FIXTURE_NOT_FOUND' });
        slot.releaseGit(); await slot.app.close(); await rm(slot.root, { recursive: true, force: true }); slots.delete(id);
        return json(response, 200, { closed: true });
      }
      return json(response, 405, { error: 'FIXTURE_METHOD_NOT_ALLOWED' });
    }
    const slot = slots.get(String(request.headers[fixtureHeader] ?? ''));
    if (!slot) return json(response, 400, { error: 'INDEPENDENT_SETUP_FIXTURE_REQUIRED' });
    const headers = { ...request.headers }; delete headers[fixtureHeader];
    const forwarded = httpRequest({ host: '127.0.0.1', port: slot.port, method: request.method, path: request.url, headers }, upstream => {
      response.writeHead(upstream.statusCode ?? 502, upstream.headers); upstream.pipe(response);
    });
    forwarded.on('error', () => { if (!response.headersSent) json(response, 502, { error: 'ISOLATED_SETUP_APP_UNAVAILABLE' }); else response.destroy(); });
    request.pipe(forwarded);
  } catch { if (!response.headersSent) json(response, 500, { error: 'SETUP_FIXTURE_CONTROL_FAILED' }); else response.destroy(); }
});
await new Promise<void>((done, reject) => { gateway.once('error', reject); gateway.listen(apiPort, '127.0.0.1', () => done()); });
const vite = await createViteServer({ configFile: 'vite.config.ts', cacheDir: join(root, 'vite-cache'),
  server: { host: '127.0.0.1', port: webPort, strictPort: true, proxy: Object.fromEntries([
    '/api/', '/plugins/', '/__platform-ui-evidence/',
  ].map(prefix => [prefix, { target: 'http://127.0.0.1:' + apiPort }])) } });
await vite.listen();
await mkdir(dirname(configPath), { recursive: true });
await writeFile(configPath, JSON.stringify({ origin, dataRoot: join(root, 'data'), knowledgeRoot: join(root, 'knowledge'),
  setupFixture: true, controlToken, controlPath: '/__platform-ui-evidence/setup-fixtures' }, null, 2) + '\n', { mode: 0o600 });
console.log(JSON.stringify({ kind: 'isolated-setup-fixture-factory-ready', origin, apiPort, pid: process.pid, configPath, sourceCommit }));
async function shutdown() {
  if (shuttingDown) return; shuttingDown = true;
  await vite.close();
  await Promise.allSettled([...slots.values()].map(slot => { slot.releaseGit(); return slot.app.close(); })); slots.clear();
  await new Promise<void>(done => gateway.close(() => done()));
  await rm(root, { recursive: true, force: true });
  process.exit(0);
}
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => { void shutdown(); });
