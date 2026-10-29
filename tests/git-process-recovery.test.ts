import { it, expect } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { initializeOwner } from '../apps/server/auth.js';
import { openDatabase } from '../packages/core/db.js';
import { testPassword } from './support/credentials.js';
// @ts-expect-error build tool is plain ESM
import { buildPlugins } from '../scripts/build-plugins.mjs';
it('restarts after SIGKILL immediately after ref publication and replays exactly the original commit', async () => {
  const root = await mkdtemp(join(tmpdir(), 'git-process-recovery-')),
    output = join(root, 'artifacts');
  let port = 0;
  const catalog = await buildPlugins({
    output,
    ids: ['git'],
    baseURL: pathToFileURL(output + '/').href,
  });
  const config = {
    knowledgeRoot: join(root, 'knowledge'),
    dataRoot: join(root, 'data'),
    origin: `http://127.0.0.1:${port}`,
    secret: 'process-recovery-fixture-secret-at-least-thirty-two-characters',
    indexing: { enabled: false, watch: false },
    fileTasks: { embedded: false },
    pluginCatalog: catalog,
  };
  await mkdir(join(config.knowledgeRoot, '00-Inbox'), { recursive: true });
  await initializeOwner(config, 'owner', testPassword);
  let child: ChildProcess | undefined, db: ReturnType<typeof openDatabase> | undefined;
  // Bind before creating auth so its trusted origin is the actual, continuously owned endpoint.
  const source = `
    import {createServer} from 'node:http';
    import {createApp} from ${JSON.stringify(pathToFileURL(process.cwd() + '/apps/server/app.ts').href)};
    let app;
    const server = createServer((request, response) => {
      if (app) app.routing(request, response);
      else { response.statusCode = 503; response.end(); }
    });
    process.once('message', async ({config, port}) => {
      try {
        await new Promise((resolve, reject) => {
          server.once('error', reject);
          server.listen({host: '127.0.0.1', port}, resolve);
        });
        const actualPort = server.address().port;
        config.origin = 'http://127.0.0.1:' + actualPort;
        app = await createApp(config);
        await app.ready();
        process.send({ready: true, port: actualPort, origin: config.origin, pid: process.pid});
      } catch (error) {
        process.send({failed: true, error: String(error?.stack ?? error)}, () => process.exit(1));
      }
    });
    process.once('SIGTERM', async () => {
      await new Promise(resolve => server.close(resolve));
      await app?.close();
      process.exit(0);
    });
  `;
  async function start() {
    const started = (child = spawn(
      process.execPath,
      ['--import', 'tsx', '--input-type=module', '-e', source],
      {
        cwd: process.cwd(),
        stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
      },
    ));
    let stderr = '';
    started.stderr!.on('data', (chunk) => {
      stderr = (stderr + chunk).slice(-8192);
    });
    await new Promise<void>((resolve, reject) => {
      const cleanup = () => {
        clearTimeout(timer);
        started.off('message', onMessage);
        started.off('exit', onExit);
        started.off('error', onError);
      };
      const fail = (message: string) => {
        cleanup();
        reject(Error(message + (stderr ? '\n' + stderr : '')));
      };
      const onError = (error: Error) => fail(`child startup error: ${error.message}`);
      const onExit = (code: number | null, signal: NodeJS.Signals | null) =>
        fail(`child exited before ready (code=${code}, signal=${signal})`);
      const onMessage = (message: any) => {
        if (!message.ready)
          return fail(`child startup failed: ${message.error ?? 'no diagnostic'}`);
        if (
          message.pid !== started.pid ||
          !Number.isInteger(message.port) ||
          message.port < 1 ||
          message.port > 65535 ||
          message.origin !== `http://127.0.0.1:${message.port}` ||
          (port !== 0 && message.port !== port)
        )
          return fail('invalid child readiness endpoint');
        port = message.port;
        config.origin = message.origin;
        cleanup();
        resolve();
      };
      const timer = setTimeout(() => fail('child startup timeout'), 10000);
      started.once('message', onMessage);
      started.once('exit', onExit);
      started.once('error', onError);
      started.send({ config, port }, (error) => {
        if (error) onError(error);
      });
    });
  }
  async function stop(signal: NodeJS.Signals) {
    const p = child;
    if (!p || p.exitCode !== null || p.signalCode !== null) return;
    await new Promise<void>((resolve, reject) => {
      const force = setTimeout(() => p.kill('SIGKILL'), 5000);
      const deadline = setTimeout(() => {
        p.off('close', onClose);
        reject(Error(`child ${p.pid} did not close after ${signal} and SIGKILL`));
      }, 10000);
      const onClose = () => {
        clearTimeout(force);
        clearTimeout(deadline);
        resolve();
      };
      p.once('close', onClose);
      p.kill(signal);
    });
  }
  let cookie = '',
    csrf = '';
  async function request(path: string, body?: any, method = body === undefined ? 'GET' : 'POST') {
    const response = await fetch(config.origin + path, {
      method,
      headers: {
        origin: config.origin,
        cookie,
        'x-csrf-token': csrf,
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    return { response, value: await response.json() };
  }
  const command = (id: string, input: any) =>
    request('/api/plugins/git/call', { kind: 'command', id, input });
  try {
    await start();
    const login = await request('/api/auth/sign-in/username', {
      username: 'owner',
      password: testPassword,
    });
    expect(login.response.status).toBe(200);
    cookie = login.response.headers
      .getSetCookie()
      .map((c) => c.split(';')[0])
      .join('; ');
    const security = await request('/api/security/csrf');
    csrf = security.value.token;
    cookie +=
      '; ' +
      security.response.headers
        .getSetCookie()
        .map((c) => c.split(';')[0])
        .join('; ');
    expect((await request('/api/platform/plugins/git/install', {})).response.status).toBe(200);
    expect(
      (
        await request(
          '/api/platform/plugins/git/config',
          {
            configVersion: 0,
            values: { authorName: 'Process Fixture', authorEmail: 'process@example.invalid' },
          },
          'PUT',
        )
      ).response.status,
    ).toBe(200);
    await request('/api/platform/plugins/git/enable', {});
    await command('git.initialize', { requestId: 'init' });
    await request('/api/notes', {
      folderPath: '00-Inbox',
      fileName: 'crash.md',
      content: '# persist through crash\n',
      requestId: 'crash-seed',
    });
    const preview = (await command('git.preview', { message: 'Exactly one published commit' }))
      .value;
    expect(preview.token).toBeTruthy();
    db = openDatabase(config.dataRoot);
    const outstanding = command('git.commit', {
      token: preview.token,
      requestId: 'actual-process-loss',
    }).catch(() => undefined);
    let target: string | undefined;
    const deadline = Date.now() + 20000;
    while (Date.now() < deadline) {
      const row = db
        .prepare(
          "SELECT details FROM plugin_operation_intents WHERE json_extract(details,'$.phase')='refPublished'",
        )
        .get() as any;
      if (row) {
        target = JSON.parse(row.details).commit;
        await stop('SIGKILL');
        break;
      }
      await new Promise((r) => setTimeout(r, 1));
    }
    expect(target).toMatch(/^[a-f0-9]{40}$/);
    await outstanding;
    await start();
    const retried = await command('git.commit', {
      token: preview.token,
      requestId: 'actual-process-loss',
    });
    expect(retried.response.status).toBe(200);
    expect(retried.value).toMatchObject({
      commit: target,
      published: true,
      needsReconciliation: false,
    });
    const { execFileSync } = await import('node:child_process');
    expect(
      execFileSync('git', ['-C', config.knowledgeRoot, 'rev-list', '--count', 'HEAD'], {
        encoding: 'utf8',
      }).trim(),
    ).toBe('1');
  } finally {
    await stop('SIGTERM');
    db?.close();
    await rm(root, { force: true, recursive: true });
  }
}, 60000);
