import { createServer as createHTTPServer } from 'node:http';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { localGitTransport } from './git-remote-fixture.js';
import { appendFile, mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createServer } from 'vite';
import { createApp } from '../../apps/server/app.js';
import { initializeOwner } from '../../apps/server/auth.js';
import { testPassword } from './credentials.js';
import { pathToFileURL } from 'node:url';
// @ts-expect-error build tool is plain ESM
import { buildPlugins } from '../../scripts/build-plugins.mjs';
import { pluginFixture } from './plugin-fixture.js';
// @ts-expect-error native build tool is plain ESM
import { buildProcessRunner } from '../../scripts/build-process-runner.mjs';
buildProcessRunner();
const root = await mkdtemp(join(tmpdir(), 'dooknow-browser-'));
let searchSource: ReturnType<typeof createHTTPServer> | undefined;
let frontend: ReturnType<typeof createHTTPServer> | undefined;
let shutdownRequested = false;
let initializationFinished = false;
let app: Awaited<ReturnType<typeof createApp>> | undefined;
let vite: Awaited<ReturnType<typeof createServer>> | undefined;
let teardownPromise: Promise<void> | undefined;
function teardown() {
  return (teardownPromise ??= (async () => {
    searchSource?.closeAllConnections();
    frontend?.closeAllConnections();
    const results = await Promise.allSettled([
      new Promise<void>((resolve, reject) => {
        if (!searchSource?.listening) return resolve();
        searchSource.close((error) => (error ? reject(error) : resolve()));
      }),
      new Promise<void>((resolve, reject) => {
        if (!frontend?.listening) return resolve();
        frontend.close((error) => (error ? reject(error) : resolve()));
      }),
      vite?.close(),
      app?.close(),
    ]);
    await rm(root, { recursive: true, force: true });
    const errors = results
      .filter((result) => result.status === 'rejected')
      .map((result) => result.reason);
    if (errors.length) throw new AggregateError(errors, 'Browser fixture teardown failed');
  })());
}
function shutdown() {
  return teardown().then(
    () => process.exit(0),
    (error) => {
      console.error(error);
      process.exit(1);
    },
  );
}
for (const signal of ['SIGINT', 'SIGTERM'])
  process.on(signal, () => {
    shutdownRequested = true;
    // Initialization owns its current operation until it settles. Closing early
    // could race a database, plugin or HTTP server that is still being created.
    if (initializationFinished) void shutdown();
  });
async function initialize() {
  const webPort = Number(process.env.DOOKNOW_E2E_WEB_PORT || 4179);
  const apiPort = Number(process.env.DOOKNOW_E2E_API_PORT || 4180);
  const origin = `http://127.0.0.1:${webPort}`;
  const gitOnboarding = process.env.DOOKNOW_E2E_GIT_ONBOARDING === '1';
  const gitImportParent = join(root, 'imported-libraries');
  const gitImportContent = '# 从隔离远端克隆的原文\n\n这份资料只存在于浏览器测试夹具中。\n';
  const knowledgeRoot = join(root, 'knowledge'),
    dataRoot = join(root, 'data');
  await mkdir(join(knowledgeRoot, '30-Knowledge/个人知识管理/方法'), { recursive: true });
  await mkdir(join(knowledgeRoot, '00-Inbox'), { recursive: true });
  await writeFile(
    join(knowledgeRoot, '30-Knowledge/个人知识管理/方法/入门指南.md'),
    '# 搭建自己的知识库\n\n## 整理方法\n\n- 收集值得保留的想法\n- 按主题整理笔记\n\n> 让知识慢慢积累。\n\n| 步骤 | 内容 |\n| --- | --- |\n| 收集 | 记录想法 |',
  );
  await mkdir('.local', { recursive: true });
  const gitRemoteURL = 'https://github.com/browser-fixture/notes.git';
  const gitRemoteRoot = join(root, 'remote.git');
  const gitExternalRoot = join(root, 'external');
  execFileSync('git', ['init', '--bare', '--initial-branch=main', gitRemoteRoot], {
    stdio: 'pipe',
  });
  if (gitOnboarding) {
    await mkdir(gitImportParent);
    const seed = join(root, 'remote-seed');
    await mkdir(join(seed, '00-Inbox'), { recursive: true });
    await writeFile(join(seed, '00-Inbox/远端导入示例.md'), gitImportContent);
    const git = (...args: string[]) => execFileSync('git', args, { stdio: 'pipe' });
    git('-C', seed, 'init', '--initial-branch=main');
    git('-C', seed, 'config', 'user.name', 'Isolated Clone Fixture');
    git('-C', seed, 'config', 'user.email', 'clone-fixture@example.invalid');
    git('-C', seed, 'add', '--', '00-Inbox/远端导入示例.md');
    git('-C', seed, 'commit', '-m', 'Seed isolated onboarding repository');
    git('-C', seed, 'push', '--', gitRemoteRoot, 'main');
  }
  await writeFile(
    '.local/e2e-config.json',
    JSON.stringify({
      origin,
      knowledgeRoot,
      dataRoot,
      gitRemoteURL,
      gitRemoteRoot,
      gitExternalRoot,
      gitOnboarding,
      gitImportParent,
      gitImportContent,
    }),
  );
  if (shutdownRequested) return;
  let searchDistribution: any;
  if (process.env.DOOKNOW_E2E_SEARCH_RUNTIME === '1') {
    const bytes = Buffer.alloc(2 * 1024 * 1024, 65);
    searchSource = createHTTPServer((_request, response) => {
      response.writeHead(200, { 'content-length': bytes.length });
      response.write(bytes.subarray(0, 1024 * 1024 + 1));
    });
    await new Promise<void>((r) => searchSource!.listen(0, '127.0.0.1', () => r()));
    searchDistribution = {
      version: 'bge-zh-cpu-20261015',
      pythonVersion: '3.14.4',
      platform: 'linux-x64',
      spaceId: '6fabd979756dff4dc79f1430da4cdff500badfb47db0eb8c0d4b07b02770faf5',
      modelRevision: '7999e1d3359715c523056ef9478215996d62a620',
      url: 'http://127.0.0.1:' + (searchSource.address() as any).port + '/search.tar.gz',
      bytes: bytes.length,
      sha256: createHash('sha256').update(bytes).digest('hex'),
    };
  }
  const config = {
    ...(gitOnboarding ? { allowedKnowledgeBases: [gitImportParent] } : { knowledgeRoot }),
    dataRoot,
    ...(searchDistribution
      ? {
          searchDistribution,
          searchCacheRoot: join(root, 'cache'),
          searchRuntimeRoot: join(root, 'runtime'),
          searchModelsRoot: join(root, 'models'),
        }
      : {}),
    secret: 'e2e-only-at-least-thirty-two-character-secret',
    origin,
    pluginCatalog: [
      await pluginFixture(root),
      ...(await buildPlugins({
        output: join(root, 'plugins'),
        ids: ['mcp', 'git'],
        baseURL: pathToFileURL(join(root, 'plugins') + '/').href,
      })),
    ],
    ...(process.env.DOOKNOW_E2E_PRODUCTION === '1'
      ? { staticRoot: resolve(process.env.DOOKNOW_E2E_STATIC_ROOT || 'dist/web') }
      : {}),
  };
  if (shutdownRequested) return;
  await initializeOwner(config, 'owner', testPassword);
  if (shutdownRequested) return;
  app = await createApp(config, {
    gitExec: (db) => localGitTransport(db, { [gitRemoteURL]: gitRemoteRoot }),
  });
  if (shutdownRequested) return;
  // Optional fixture-only diagnostics: keep request bodies, cookies and credentials
  // out of the log while retaining the underlying exception hidden by the API.
  if (process.env.DOOKNOW_E2E_ERROR_LOG) {
    const errorLog = resolve(process.env.DOOKNOW_E2E_ERROR_LOG);
    app.addHook('onError', async (request, _reply, error) => {
      if (error.statusCode && error.statusCode < 500) return;
      const body = request.body as { requestId?: unknown } | undefined;
      await appendFile(
        errorLog,
        JSON.stringify({
          time: new Date().toISOString(),
          method: request.method,
          route: request.routeOptions.url,
          requestId: typeof body?.requestId === 'string' ? body.requestId : undefined,
          name: error.name,
          code: error.code,
          message: error.message,
          stack: error.stack,
        }) + '\n',
        { mode: 0o600 },
      ).catch(() => undefined);
    });
  }
  await app.listen({
    host: '127.0.0.1',
    port: process.env.DOOKNOW_E2E_PRODUCTION === '1' ? webPort : apiPort,
  });
  if (shutdownRequested) return;
  const login = await app.inject({
    method: 'POST',
    url: '/api/auth/sign-in/username',
    headers: { origin: config.origin },
    payload: { username: 'owner', password: testPassword },
  });
  if (login.statusCode !== 200) throw new Error('e2e session initialization failed');
  // The reusable authenticated context already completed its initial CSRF exchange.
  // This prevents fixture-side API seeding from racing the app's first exchange.
  const sessionCookie = login.cookies.map((cookie) => `${cookie.name}=${cookie.value}`).join('; ');
  const initialCsrf = await app.inject({
    url: '/api/security/csrf',
    headers: { cookie: sessionCookie },
  });
  if (initialCsrf.statusCode !== 200) throw new Error('e2e CSRF initialization failed');
  await writeFile(
    '.local/e2e-cookies.json',
    JSON.stringify(
      [...login.cookies, ...initialCsrf.cookies].map((c) => ({
        name: c.name,
        value: c.value,
        domain: '127.0.0.1',
        path: '/',
        httpOnly: true,
        secure: false,
        sameSite: 'Lax',
      })),
    ),
    { mode: 0o600 },
  );
  if (shutdownRequested || process.env.DOOKNOW_E2E_PRODUCTION === '1') return;
  frontend = createHTTPServer();
  vite = await createServer({
    configFile: 'vite.config.ts',
    cacheDir: join(root, 'vite-cache'),
    server: {
      middlewareMode: { server: frontend },
      port: webPort,
      host: '127.0.0.1',
      ws: { server: frontend },
      proxy: { '/api/': `http://127.0.0.1:${apiPort}`, '/plugins/': `http://127.0.0.1:${apiPort}`, '^/blog(?:/|\\?|$)': `http://127.0.0.1:${apiPort}` },
    },
  });
  if (shutdownRequested) return;
  frontend.on('request', vite.middlewares);
  await new Promise<void>((resolve, reject) => {
    frontend!.once('error', reject);
    frontend!.listen(webPort, '127.0.0.1', () => {
      frontend!.off('error', reject);
      resolve();
    });
  });
}
try {
  await initialize();
} catch (error) {
  try {
    await teardown();
  } catch (cleanupError) {
    throw new AggregateError([error, cleanupError], 'Browser fixture startup and teardown failed');
  }
  throw error;
} finally {
  initializationFinished = true;
}
if (shutdownRequested) await shutdown();
