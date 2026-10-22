import { describe, expect, it, vi } from 'vitest';
import { existsSync } from 'node:fs';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolve } from 'node:path';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { cp, appendFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { openDatabase } from '../packages/core/db.js';
import { TokenizerClient } from '../packages/core/indexing/tokenizer-client.js';
import {
  processIsAlive,
  workspaceExclusive,
  workspaceProcess,
} from '../packages/core/workspace/gate.js';
import { createApp } from '../apps/server/app.js';
import { initializeOwner } from '../apps/server/auth.js';
import { testPassword } from './support/credentials.js';
import { processRunner } from '../packages/core/processes/runner.js';

type Identity = { pid: number; start: string; pgid?: number; sid?: number };

async function closedWithin(closing: Promise<void>, timeout = 5500) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      closing.then(() => true),
      new Promise<boolean>((yes) => (timer = setTimeout(() => yes(false), timeout))),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function fixture(
  mode:
    | 'absent'
    | 'cooperative'
    | 'stubborn'
    | 'inherited-pipes'
    | 'stubborn-tree'
    | 'escape'
    | 'fast-failure'
    | 'slow-response'
    | 'blocked-input-once'
    | 'reply-exit',
  assertion: typeof expect = expect,
) {
  const root = await mkdtemp(join(tmpdir(), 'dooknow-tokenizer-lifecycle-'));
  const python = join(root, 'synthetic-python.cjs'),
    ready = join(root, 'tokenizer.json');
  const holderReady = join(root, 'holder.json'),
    events = join(root, 'events.jsonl');
  const escape = join(root, 'escape.json');
  const clients: TokenizerClient[] = [],
    supervisors: Identity[] = [];
  const config = {
    knowledgeRoot: join(root, 'knowledge'),
    dataRoot: join(root, 'data'),
    origin: 'http://localhost:3010',
    secret: 'synthetic-tokenizer-lifecycle-secret-at-least-thirty-two-characters',
    tokenizerPython: python,
    vectorRuntimeRoot: root,
    modelDir: join(root, 'models'),
    indexing: { enabled: false, watch: false, embedded: false },
    fileTasks: { embedded: false },
  };
  await mkdir(join(config.knowledgeRoot, '00-Inbox'), { recursive: true });
  const stamp = `
    const stat = fs.readFileSync('/proc/self/stat', 'utf8');
    const start = fs.readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim() + ':' +
      stat.slice(stat.lastIndexOf(')') + 2).trim().split(/\\s+/)[19];
    const fields = stat.slice(stat.lastIndexOf(')') + 2).trim().split(/\\s+/);
    fs.writeFileSync(ready, JSON.stringify({ pid: process.pid, start, pgid: Number(fields[2]), sid: Number(fields[3]), cwd: process.cwd(), args: process.argv.slice(2), ipc: typeof process.send === 'function' }));
  `;
  if (mode !== 'absent') {
    const holder = join(root, 'pipe-holder.cjs');
    const tree = ['inherited-pipes', 'stubborn-tree', 'escape'].includes(mode);
    if (tree) {
      await writeFile(
        holder,
        `
        const fs = require('node:fs'), ready = ${JSON.stringify(holderReady)};
        ${stamp}
        ${mode === 'stubborn-tree' ? "process.on('SIGTERM', () => {});" : ''}
        setInterval(() => {}, 1000);
      `,
      );
    }
    await writeFile(
      python,
      `#!${process.execPath}\n` +
        `
      const fs = require('node:fs'), readline = require('node:readline');
      const ready = ${JSON.stringify(ready)}, events = ${JSON.stringify(events)};
      ${stamp}
      ${
        mode === 'blocked-input-once'
          ? `
        const blocked = ${JSON.stringify(join(root, 'blocked-once'))};
        if (!fs.existsSync(blocked)) {
          fs.writeFileSync(blocked, 'synthetic first workload does not read stdin');
          process.on('SIGTERM', () => {});
          setInterval(() => {}, 1000);
          return;
        }
      `
          : ''
      }
      ${mode === 'fast-failure' ? 'process.exit(7);' : ''}
      const event = name => fs.appendFileSync(events, JSON.stringify({ event: name }) + '\\n');
      process.on('SIGTERM', () => event('SIGTERM'));
      ${
        tree
          ? `
        const launch = detached => {
          const child = require('node:child_process').spawn(process.execPath, [${JSON.stringify(holder)}], { detached, stdio: ['ignore', process.stdout, process.stderr] });
          if (detached) child.once('spawn', () => fs.writeFileSync(${JSON.stringify(escape)}, JSON.stringify({ code: 'SPAWNED', pid: child.pid })));
          child.once('error', error => {
            fs.writeFileSync(${JSON.stringify(escape)}, JSON.stringify({ code: error.code }));
            if (detached && error.code === 'EPERM') launch(false);
          });
        };
        launch(${mode === 'escape'});
      `
          : ''
      }
      const input = readline.createInterface({ input: process.stdin, terminal: false });
      input.on('line', line => {
        const request = JSON.parse(line);
        if (request.method !== 'count') throw Error('unexpected synthetic method');
        const reply = () => process.stdout.write(JSON.stringify({ id: request.id, data: request.texts.map(() => 1) }) + '\\n'${mode === 'reply-exit' ? ', () => process.exit(0)' : ''});
        ${mode === 'slow-response' ? 'setTimeout(reply, 100);' : 'reply();'}
      });
      input.on('close', () => {
        event('stdinEOF');
        ${['stubborn', 'stubborn-tree'].includes(mode) ? '' : 'process.exit(0);'}
      });
      setInterval(() => {}, 1000);
    `,
      { mode: 0o700 },
    );
  }
  const identity = async (path = ready): Promise<Identity> =>
    JSON.parse(await readFile(path, 'utf8'));
  return {
    root,
    config,
    holderReady,
    identity,
    escape,
    client: () => {
      const client = new TokenizerClient({ python, runtimeRoot: root, modelDir: config.modelDir });
      clients.push(client);
      return client;
    },
    track: (owned: Identity) => supervisors.push(owned),
    events: async () =>
      (await readFile(events, 'utf8'))
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line)),
    close: async () => {
      const receipt: { pid: number; start: string; fallbackKill: boolean; alive: boolean }[] = [];
      try {
        for (const client of clients) {
          const child = (client as unknown as { child?: ReturnType<typeof spawn> }).child;
          if (child?.pid) {
            try {
              supervisors.push(workspaceProcess(child.pid));
            } catch {}
          }
        }
        for (const path of [holderReady, ready]) {
          if (!existsSync(path)) continue;
          supervisors.unshift(await identity(path));
        }
        for (const owned of supervisors) {
          const fallbackKill = processIsAlive(owned.pid, owned.start);
          if (fallbackKill) process.kill(owned.pid, 'SIGKILL');
          await assertion
            .poll(() => processIsAlive(owned.pid, owned.start), { timeout: 2000 })
            .toBe(false);
          receipt.push({ ...owned, fallbackKill, alive: processIsAlive(owned.pid, owned.start) });
        }
        for (const client of clients) await closedWithin(client.close().catch(() => {}));
      } finally {
        await rm(root, { recursive: true, force: true });
      }
      assertion(existsSync(root)).toBe(false);
      if (process.env.DOOKNOW_TEST_OWNERSHIP_RECEIPT)
        await appendFile(
          process.env.DOOKNOW_TEST_OWNERSHIP_RECEIPT,
          JSON.stringify({ mode, root, removed: true, processes: receipt }) + '\n',
        );
    },
  };
}

// The ownership checks use Linux process start identities; no real model is required.
describe.skipIf(process.platform !== 'linux')('tokenizer lifecycle', () => {
  it('closes when a request immediately encounters an absent Python executable', async () => {
    const f = await fixture('absent'),
      client = f.client();
    try {
      const count = client.count(['synthetic']).then(
        () => undefined,
        (error) => error.code,
      );
      const closing = client.close();
      expect(await count).toBe('TOKENIZER_UNAVAILABLE');
      expect(await closedWithin(closing)).toBe(true);
    } finally {
      await f.close();
    }
  });

  it('closes after an absent Python request has already rejected', async () => {
    const f = await fixture('absent'),
      client = f.client();
    try {
      await expect(client.count(['synthetic'])).rejects.toMatchObject({
        code: 'TOKENIZER_UNAVAILABLE',
      });
      expect(await closedWithin(client.close())).toBe(true);
    } finally {
      await f.close();
    }
  });

  it.each(['cooperative', 'stubborn'] as const)(
    'terminates a %s tokenizer after a valid response',
    async (mode) => {
      const f = await fixture(mode),
        client = f.client();
      try {
        expect(await client.count(['synthetic'])).toEqual([1]);
        const owned = await f.identity();
        expect(await closedWithin(client.close())).toBe(true);
        expect(processIsAlive(owned.pid, owned.start)).toBe(false);
        const events = (await f.events()).map((event) => event.event);
        expect(events).toContain('stdinEOF');
        if (mode === 'stubborn') expect(events).toContain('SIGTERM');
        else expect(events).not.toContain('SIGTERM');
      } finally {
        await f.close();
      }
    },
  );

  it('drains inherited output holders before reporting tokenizer closure', async () => {
    const f = await fixture('inherited-pipes'),
      client = f.client();
    try {
      expect(await client.count(['synthetic'])).toEqual([1]);
      await expect.poll(() => existsSync(f.holderReady), { timeout: 2000 }).toBe(true);
      const holder = await f.identity(f.holderReady),
        owned = await f.identity();
      expect(await closedWithin(client.close())).toBe(true);
      expect(processIsAlive(owned.pid, owned.start)).toBe(false);
      expect(processIsAlive(holder.pid, holder.start)).toBe(false);
    } finally {
      await f.close();
    }
  });

  it.each(['stubborn', 'inherited-pipes', 'stubborn-tree'] as const)(
    'closes the app and owned %s tree after a capability request',
    async (mode) => {
      const f = await fixture(mode);
      let app: Awaited<ReturnType<typeof createApp>> | undefined;
      try {
        await initializeOwner(f.config, 'synthetic_owner', testPassword);
        app = await createApp(f.config);
        const login = await app.inject({
          method: 'POST',
          url: '/api/auth/sign-in/username',
          headers: { origin: f.config.origin },
          payload: { username: 'synthetic_owner', password: testPassword },
        });
        expect(login.statusCode).toBe(200);
        const response = await app.inject({
          url: '/api/platform/search-runtime',
          headers: { cookie: login.cookies.map((c) => `${c.name}=${c.value}`).join('; ') },
        });
        expect(response.statusCode).toBe(200);
        expect(response.json().components.tokenizerReady).toBe(true);
        const owned = await f.identity();
        if (mode !== 'stubborn')
          await expect.poll(() => existsSync(f.holderReady), { timeout: 2000 }).toBe(true);
        const db = openDatabase(f.config.dataRoot);
        try {
          await expect(
            workspaceExclusive(
              db,
              { kind: 'idle-tokenizer-control', waitMs: 100 },
              async () => 'available',
            ),
          ).resolves.toBe('available');
        } finally {
          db.close();
        }
        expect(await closedWithin(app.close())).toBe(true);
        expect(processIsAlive(owned.pid, owned.start)).toBe(false);
        if (mode !== 'inherited-pipes')
          expect((await f.events()).map((event) => event.event)).toContain('SIGTERM');
        if (mode !== 'stubborn') {
          const holder = await f.identity(f.holderReady);
          expect(processIsAlive(holder.pid, holder.start)).toBe(false);
        }
      } finally {
        await f.close();
        await app?.close();
      }
    },
  );

  it('drains the tokenizer tree when its client process crashes', async () => {
    const f = await fixture('stubborn-tree'),
      ready = join(f.root, 'client-ready');
    const main = join(f.root, 'client.mjs');
    let parent: ReturnType<typeof spawn> | undefined;
    try {
      await writeFile(
        main,
        `
        import { TokenizerClient } from ${JSON.stringify(pathToFileURL(resolve('packages/core/indexing/tokenizer-client.ts')).href)};
        import { writeFile } from 'node:fs/promises';
        import { workspaceProcess } from ${JSON.stringify(pathToFileURL(resolve('packages/core/workspace/gate.ts')).href)};
        const client = new TokenizerClient(${JSON.stringify({ python: f.config.tokenizerPython, runtimeRoot: f.root })});
        await client.count(['synthetic']);
        await writeFile(${JSON.stringify(ready)}, JSON.stringify(workspaceProcess(client.child.pid)));
        setInterval(() => {}, 1000);
      `,
      );
      parent = spawn(process.execPath, ['--import', 'tsx', main], {
        cwd: resolve('.'),
        stdio: 'ignore',
      });
      await expect
        .poll(() => existsSync(ready) && existsSync(f.holderReady), { timeout: 4000 })
        .toBe(true);
      const owned = await f.identity(),
        holder = await f.identity(f.holderReady);
      f.track(JSON.parse(await readFile(ready, 'utf8')));
      parent.kill('SIGKILL');
      await expect
        .poll(
          () => processIsAlive(owned.pid, owned.start) || processIsAlive(holder.pid, holder.start),
          { timeout: 5500 },
        )
        .toBe(false);
    } finally {
      parent?.kill('SIGKILL');
      await f.close();
    }
  });

  it('drains surviving members after abnormal supervisor death', async () => {
    const f = await fixture('stubborn-tree'),
      client = f.client();
    try {
      expect(await client.count(['synthetic'])).toEqual([1]);
      await expect.poll(() => existsSync(f.holderReady), { timeout: 2000 }).toBe(true);
      const child = (client as unknown as { child: ReturnType<typeof spawn> }).child;
      const supervisor = workspaceProcess(child.pid!);
      f.track(supervisor);
      expect(processIsAlive(supervisor.pid, supervisor.start)).toBe(true);
      child.kill('SIGKILL');
      expect(await closedWithin(client.close())).toBe(true);
      for (const owned of [await f.identity(), await f.identity(f.holderReady)]) {
        expect(processIsAlive(owned.pid, owned.start)).toBe(false);
      }
    } finally {
      await f.close();
    }
  });

  it('denies process-group escape while keeping the line protocol usable', async () => {
    const f = await fixture('escape'),
      client = f.client();
    try {
      expect(await client.count(['synthetic'])).toEqual([1]);
      await expect.poll(() => existsSync(f.escape), { timeout: 2000 }).toBe(true);
      await expect.poll(() => existsSync(f.holderReady), { timeout: 2000 }).toBe(true);
      // Some spawn implementations ignore setsid()'s EPERM, so inspect the
      // actual process group/session rather than treating 'spawn' as escape.
      const supervisor = (client as unknown as { child: ReturnType<typeof spawn> }).child;
      const holder = await f.identity(f.holderReady);
      expect(holder.pgid).toBe(supervisor.pid);
      expect(holder.sid).toBe(supervisor.pid);
      expect(holder.pgid).not.toBe(holder.pid);
      expect(await closedWithin(client.close())).toBe(true);
      expect(processIsAlive(holder.pid, holder.start)).toBe(false);
    } finally {
      await f.close();
      await client.close();
    }
  });

  it('fails closed before launching a tokenizer when the native runtime is missing', async () => {
    const f = await fixture('cooperative'),
      copied = join(f.root, 'isolated/core');
    try {
      await cp(resolve('packages/core'), copied, {
        recursive: true,
        filter: (path) => !path.includes('/.build'),
      });
      await writeFile(join(f.root, 'isolated/package.json'), '{"type":"module"}');
      const main = join(f.root, 'missing-runtime.mjs');
      await writeFile(
        main,
        `
        import { TokenizerClient } from ${JSON.stringify(pathToFileURL(join(copied, 'indexing/tokenizer-client.ts')).href)};
        const client = new TokenizerClient(${JSON.stringify({ python: f.config.tokenizerPython, runtimeRoot: f.root })});
        const result = await client.count(['synthetic']).then(value => ({ value }), error => ({ code: error.code }));
        await client.close();
        console.log(JSON.stringify(result));
      `,
      );
      const result = await promisify(execFile)(process.execPath, ['--import', 'tsx', main], {
        cwd: resolve('.'),
        timeout: 7000,
      });
      expect(JSON.parse(result.stdout)).toMatchObject({ code: 'PROCESS_CONTAINMENT_UNAVAILABLE' });
      expect(existsSync(join(f.root, 'tokenizer.json'))).toBe(false);
    } finally {
      await f.close();
    }
  });

  it('preserves executable PATH, cwd, arguments and keeps the IPC lease private', async () => {
    const f = await fixture('cooperative');
    let client: TokenizerClient | undefined;
    try {
      vi.stubEnv('PATH', f.root + ':' + process.env.PATH);
      client = new TokenizerClient({ python: 'synthetic-python.cjs', runtimeRoot: f.root });
      expect(await client.count(['synthetic'])).toEqual([1]);
      const launch = JSON.parse(await readFile(join(f.root, 'tokenizer.json'), 'utf8'));
      expect(launch).toMatchObject({
        cwd: process.cwd(),
        args: [join(f.root, 'tokenizer_cli.py')],
        ipc: false,
      });
      expect(await closedWithin(client.close())).toBe(true);
    } finally {
      vi.unstubAllEnvs();
      await f.close();
      await client?.close();
    }
  });

  it('reopens cleanly after closure without old generation callbacks affecting new requests', async () => {
    const f = await fixture('cooperative'),
      client = f.client();
    try {
      for (let i = 0; i < 3; i++) {
        expect(await client.count(['synthetic'])).toEqual([1]);
        expect(await closedWithin(client.close())).toBe(true);
      }
    } finally {
      await f.close();
    }
  });

  it('settles fast workload failures and permits a fresh retry', async () => {
    const f = await fixture('fast-failure'),
      client = f.client();
    try {
      for (let i = 0; i < 2; i++) {
        await expect(client.count(['synthetic'])).rejects.toMatchObject({
          code: 'TOKENIZER_UNAVAILABLE',
        });
        expect(await closedWithin(client.close())).toBe(true);
      }
    } finally {
      await f.close();
    }
  });

  it('retires timed-out unread input before admitting more work and retries on a fresh process', async ({ expect }) => {
    const f = await fixture('blocked-input-once', expect),
      client = f.client(),
      payload = 'x'.repeat(512 * 1024);
    try {
      const first = client.count([payload]).then(
        (value) => ({ value }),
        (error) => ({ code: error.code }),
      );
      const child = (client as unknown as { child: ReturnType<typeof spawn> }).child;
      await expect.poll(() => existsSync(join(f.root, 'tokenizer.json'))).toBe(true);
      const workload = await f.identity();
      f.track(workload);
      expect(await first).toEqual({ code: 'TOKENIZER_TIMEOUT' });
      const firstQueuedBytes = child.stdin!.writableLength;
      const duringRetirement = await client.count([payload]).then(
        (value) => ({ value }),
        (error) => ({ code: error.code }),
      );
      if (process.env.DOOKNOW_TEST_BACKPRESSURE_RECEIPT)
        await appendFile(
          process.env.DOOKNOW_TEST_BACKPRESSURE_RECEIPT,
          JSON.stringify({
            firstQueuedBytes,
            afterRetryQueuedBytes: child.stdin!.writableLength,
            firstWorkloadStillAlive: processIsAlive(workload.pid, workload.start),
            duringRetirement,
          }) + '\n',
        );
      expect(duringRetirement).toEqual({ code: 'TOKENIZER_UNAVAILABLE' });
      await expect
        .poll(() => processIsAlive(workload.pid, workload.start), { timeout: 3000 })
        .toBe(false);
      expect(await closedWithin(client.close())).toBe(true);
      if (process.env.DOOKNOW_TEST_BACKPRESSURE_RECEIPT)
        await appendFile(
          process.env.DOOKNOW_TEST_BACKPRESSURE_RECEIPT,
          JSON.stringify({
            phase: 'retirement-complete',
            oldQueuedBytes: child.stdin!.writableLength,
            oldInputDestroyed: child.stdin!.destroyed,
            oldWorkloadAlive: processIsAlive(workload.pid, workload.start),
          }) + '\n',
        );
      expect(await client.count(['fresh request'])).toEqual([1]);
      expect((await f.identity()).pid).not.toBe(workload.pid);
      expect(await closedWithin(client.close())).toBe(true);
    } finally {
      await f.close();
    }
  });

  it('rejects other outstanding requests when a timed-out tokenizer is retired', async ({ expect }) => {
    const f = await fixture('blocked-input-once', expect),
      client = f.client();
    try {
      const result = (texts: string[]) =>
        client.count(texts).then(
          (value) => ({ value }),
          (error) => ({ code: error.code }),
        );
      expect(await Promise.all([result(['first']), result(['peer'])])).toEqual([
        { code: 'TOKENIZER_TIMEOUT' },
        { code: 'TOKENIZER_UNAVAILABLE' },
      ]);
      expect(await closedWithin(client.close())).toBe(true);
    } finally {
      await f.close();
    }
  });

  it('keeps a pending close request separate from a reopened generation', async () => {
    const f = await fixture('slow-response'),
      client = f.client();
    try {
      const first = client.count(['synthetic']).then(
        (value) => ({ value }),
        (error) => ({ code: error.code }),
      );
      const closing = client.close();
      expect(await first).toMatchObject({ code: 'TOKENIZER_UNAVAILABLE' });
      expect(await closedWithin(closing)).toBe(true);
      expect(await client.count(['synthetic'])).toEqual([1]);
      expect(await closedWithin(client.close())).toBe(true);
    } finally {
      await f.close();
    }
  });

  it('delivers a final buffered response when the workload exits immediately afterward', async () => {
    const f = await fixture('reply-exit'),
      client = f.client();
    try {
      expect(await client.count(['synthetic'])).toEqual([1]);
      expect(await closedWithin(client.close())).toBe(true);
    } finally {
      await f.close();
    }
  });

  it('refuses launch when inherited containment prevents a private guardian group', async () => {
    const f = await fixture('cooperative');
    let outer: ReturnType<typeof spawn> | undefined;
    try {
      const main = join(f.root, 'nested-containment.mjs');
      await writeFile(
        main,
        `
        import { TokenizerClient } from ${JSON.stringify(pathToFileURL(resolve('packages/core/indexing/tokenizer-client.ts')).href)};
        const client = new TokenizerClient(${JSON.stringify({ python: f.config.tokenizerPython, runtimeRoot: f.root })});
        const result = await client.count(['synthetic']).then(value => ({ value }), error => ({ code: error.code }));
        await client.close();
        console.log(JSON.stringify(result));
      `,
      );
      outer = spawn(processRunner(), ['--', process.execPath, '--import', 'tsx', main], {
        detached: true,
        cwd: resolve('.'),
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      f.track(workspaceProcess(outer.pid!));
      let output = '',
        code: number | null = null;
      outer.stdout!.on('data', (bytes) => {
        output += bytes;
      });
      outer.stderr!.resume();
      const done = new Promise<void>((yes, no) => {
        outer!.once('error', no);
        outer!.once('close', (status) => {
          code = status;
          yes();
        });
      });
      expect(await closedWithin(done, 7000)).toBe(true);
      expect(code).toBe(0);
      expect(JSON.parse(output)).toMatchObject({ code: 'TOKENIZER_UNAVAILABLE' });
      expect(existsSync(join(f.root, 'tokenizer.json'))).toBe(false);
    } finally {
      outer?.kill('SIGKILL');
      await f.close();
    }
  });
});
