import { it, expect } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import { once } from 'node:events';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { initializeOwner } from '../apps/server/auth.js';
import { testPassword } from './support/credentials.js';
import { resolveConfig } from 'vite';
import viteConfig from '../vite.config';

it('isolates Vite serve caches by the final inline port while respecting explicit cache paths', async () => {
  const configure = (command: 'serve' | 'build', port: number, cacheDir?: string) =>
    resolveConfig(
      {
        ...viteConfig,
        configFile: false,
        server: { ...viteConfig.server, port },
        ...(cacheDir === undefined ? {} : { cacheDir }),
      },
      command,
    );
  const [first, second, built, explicit] = await Promise.all([
    configure('serve', 44179),
    configure('serve', 45180),
    configure('build', 44179),
    configure('serve', 44179, resolve(tmpdir(), 'dooknow-explicit-vite-cache')),
  ]);
  expect(first.cacheDir).not.toBe(second.cacheDir);
  expect(first.cacheDir).not.toBe(built.cacheDir);
  expect(first.cacheDir).toContain('44179');
  expect(second.cacheDir).toContain('45180');
  expect(explicit.cacheDir).toBe(resolve(tmpdir(), 'dooknow-explicit-vite-cache'));
});

it('starts the official plugin catalog and authenticated API on isolated developer ports', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dooknow-dev-bootstrap-'));
  const reservations = [createServer(), createServer()];
  let child: ChildProcess | undefined;
  let optimizerCache: string | undefined;
  let output = '';
  try {
    for (const server of reservations) server.listen(0, '127.0.0.1');
    await Promise.all(reservations.map((server) => once(server, 'listening')));
    const [apiPort, vitePort] = reservations.map(
      (server) => (server.address() as { port: number }).port,
    );
    const origin = 'http://127.0.0.1:' + vitePort;
    optimizerCache = resolve(`node_modules/.vite-dooknow-${vitePort}`);
    const knowledgeRoot = join(root, 'knowledge'),
      dataRoot = join(root, 'data');
    const secret = 'development-bootstrap-fixture-secret-at-least-thirty-two-characters';
    const secretFile = join(root, 'auth.key');
    await mkdir(join(knowledgeRoot, '00-Inbox'), { recursive: true });
    await writeFile(join(knowledgeRoot, '00-Inbox/bootstrap.md'), '# Isolated developer workspace');
    await writeFile(secretFile, secret, { mode: 0o600 });
    await initializeOwner({ knowledgeRoot, dataRoot, origin, secret }, 'dev_fixture', testPassword);

    // Protect the running host even while the regression is red: child processes
    // may bind and connect only to these two fresh ports, including Vite's proxy.
    const guard = join(root, 'isolated-ports.mjs');
    await writeFile(
      guard,
      `import net from 'node:net';
const allowed = new Set([${apiPort}, ${vitePort}]);
function check(args) {
  const first = Array.isArray(args[0]) ? args[0][0] : args[0];
  const port = first && typeof first === 'object' ? first.port : first;
  if (port !== undefined && /^\\d+$/.test(String(port)) && !allowed.has(Number(port)))
    throw Error('DEV_TEST_BLOCKED_UNISOLATED_PORT: ' + port);
}
const listen = net.Server.prototype.listen;
net.Server.prototype.listen = function (...args) { check(args); return listen.apply(this, args); };
const connect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function (...args) { check(args); return connect.apply(this, args); };
`,
    );
    const env = { ...process.env };
    for (const key of [
      'APP_ORIGIN',
      'AGENT_CONFIG_FILE',
      'VECTOR_SERVICE_TOKEN_FILE',
      'VECTOR_SERVICE_URL',
      'VECTOR_RUNTIME_ROOT',
      'MODEL_DIR',
      'TOKENIZER_PYTHON',
      'EMBEDDING_SPACE_ID',
    ])
      delete env[key];
    Object.assign(env, {
      NODE_ENV: 'test',
      NODE_OPTIONS: '--import=' + pathToFileURL(guard).href,
      DOTENV_CONFIG_PATH: join(root, 'unused.env'),
      DOOKNOW_DEMO_ROOT: root,
      KNOWLEDGE_ROOT: knowledgeRoot,
      DATA_ROOT: dataRoot,
      AUTH_SECRET_FILE: secretFile,
      PORT: String(apiPort),
      VITE_PORT: String(vitePort),
      INDEXING_ENABLED: '0',
      INDEX_WATCH: '0',
      EMBEDDED_INDEX_WORKER: '0',
      EMBEDDED_FILE_WORKER: '0',
    });
    await Promise.all(
      reservations.map(
        (server) =>
          new Promise<void>((done, reject) =>
            server.close((error) => (error ? reject(error) : done())),
          ),
      ),
    );
    child = spawn(process.execPath, ['--import', 'tsx', resolve('scripts/dev.ts')], {
      cwd: process.cwd(),
      env,
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const record = (data: Buffer) => {
      output = (output + data.toString()).slice(-16000);
    };
    child.stdout!.on('data', record);
    child.stderr!.on('data', record);
    const deadline = Date.now() + 60000;
    for (;;) {
      if (child.exitCode !== null)
        throw Error('Developer startup exited before becoming ready:\n' + output);
      try {
        const response = await fetch(origin + '/', { signal: AbortSignal.timeout(500) });
        if (response.ok) break;
      } catch {}
      if (Date.now() >= deadline) throw Error('Developer startup did not become ready:\n' + output);
      await new Promise((done) => setTimeout(done, 100));
    }
    const entry = await fetch(origin + '/main.ts');
    expect(entry.status, 'the development entry module loads').toBe(200);
    const vueImport = (await entry.text()).match(/from\s*["']([^"']+\/deps\/vue\.js[^"']*)/);
    expect(vueImport, 'Vue loads through a private optimizer cache').not.toBeNull();
    const dependency = new URL(vueImport![1], origin);
    expect(dependency.pathname).toContain(String(vitePort));
    const optimized = await fetch(dependency, { signal: AbortSignal.timeout(15000) });
    expect(optimized.status, 'optimized dependencies stay usable for this instance').toBe(200);
    const login = await fetch(origin + '/api/auth/sign-in/username', {
      method: 'POST',
      headers: { origin, 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'dev_fixture', password: testPassword }),
    });
    expect(login.status, 'owner login uses the chosen Vite origin and API proxy').toBe(200);
    const cookie = login.headers
      .getSetCookie()
      .map((value) => value.split(';')[0])
      .join('; ');
    const registry = await fetch(origin + '/api/platform/plugins', { headers: { cookie } });
    expect(registry.status).toBe(200);
    const plugins = (await registry.json()) as any;
    expect(plugins.catalog.map((entry: any) => entry.id).sort()).toEqual(['git', 'mcp']);
    expect(plugins.installed).toEqual([]);
    expect(plugins.contributions).toEqual([]);
    const tree = await fetch(origin + '/api/tree', { headers: { cookie } });
    expect(tree.status).toBe(200);
    expect(JSON.stringify(await tree.json())).toContain('00-Inbox/bootstrap.md');
  } finally {
    if (child?.pid) {
      try {
        process.kill(-child.pid, 'SIGTERM');
      } catch {}
      await Promise.race([once(child, 'close'), new Promise((done) => setTimeout(done, 5000))]);
      try {
        process.kill(-child.pid, 'SIGKILL');
      } catch {}
    }
    for (const server of reservations) if (server.listening) server.close();
    if (optimizerCache) await rm(optimizerCache, { recursive: true, force: true });
    await rm(root, { recursive: true, force: true });
  }
}, 90000);
