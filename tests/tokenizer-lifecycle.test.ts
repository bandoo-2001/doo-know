import { describe, expect, it } from 'vitest';
import { existsSync } from 'node:fs';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TokenizerClient } from '../packages/core/indexing/tokenizer-client.js';
import { processIsAlive } from '../packages/core/workspace/gate.js';
import { createApp } from '../apps/server/app.js';
import { initializeOwner } from '../apps/server/auth.js';
import { testPassword } from './support/credentials.js';

type Identity = { pid: number; start: string };

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

async function fixture(mode: 'absent' | 'cooperative' | 'stubborn' | 'inherited-pipes') {
  const root = await mkdtemp(join(tmpdir(), 'dooknow-tokenizer-lifecycle-'));
  const python = join(root, 'synthetic-python.cjs'), ready = join(root, 'tokenizer.json');
  const holderReady = join(root, 'holder.json'), events = join(root, 'events.jsonl');
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
    fs.writeFileSync(ready, JSON.stringify({ pid: process.pid, start }));
  `;
  if (mode !== 'absent') {
    const holder = join(root, 'pipe-holder.cjs');
    if (mode === 'inherited-pipes') {
      await writeFile(holder, `
        const fs = require('node:fs'), ready = ${JSON.stringify(holderReady)};
        ${stamp}
        setInterval(() => {}, 1000);
      `);
    }
    await writeFile(python, `#!${process.execPath}\n` + `
      const fs = require('node:fs'), readline = require('node:readline');
      const ready = ${JSON.stringify(ready)}, events = ${JSON.stringify(events)};
      ${stamp}
      const event = name => fs.appendFileSync(events, JSON.stringify({ event: name }) + '\\n');
      process.on('SIGTERM', () => event('SIGTERM'));
      ${mode === 'inherited-pipes' ? `require('node:child_process').spawn(process.execPath, [${JSON.stringify(holder)}], { stdio: ['ignore', process.stdout, process.stderr] });` : ''}
      const input = readline.createInterface({ input: process.stdin, terminal: false });
      input.on('line', line => {
        const request = JSON.parse(line);
        if (request.method !== 'count') throw Error('unexpected synthetic method');
        process.stdout.write(JSON.stringify({ id: request.id, data: request.texts.map(() => 1) }) + '\\n');
      });
      input.on('close', () => {
        event('stdinEOF');
        ${mode === 'stubborn' ? '' : 'process.exit(0);'}
      });
      setInterval(() => {}, 1000);
    `, { mode: 0o700 });
  }
  const identity = async (path = ready): Promise<Identity> => JSON.parse(await readFile(path, 'utf8'));
  return {
    root, config, holderReady, identity,
    client: () => new TokenizerClient({ python, runtimeRoot: root, modelDir: config.modelDir }),
    events: async () => (await readFile(events, 'utf8')).trim().split('\n').map(line => JSON.parse(line)),
    close: async () => {
      try {
        for (const path of [holderReady, ready]) {
          if (!existsSync(path)) continue;
          const owned = await identity(path);
          if (processIsAlive(owned.pid, owned.start)) process.kill(owned.pid, 'SIGKILL');
          await expect.poll(() => processIsAlive(owned.pid, owned.start), { timeout: 2000 }).toBe(false);
        }
      } finally {
        await rm(root, { recursive: true, force: true });
      }
      expect(existsSync(root)).toBe(false);
    },
  };
}

// The ownership checks use Linux process start identities; no real model is required.
describe.skipIf(process.platform !== 'linux')('tokenizer lifecycle', () => {
  it('closes when a request immediately encounters an absent Python executable', async () => {
    const f = await fixture('absent'), client = f.client();
    try {
      const count = client.count(['synthetic']).then(() => undefined, error => error.code);
      const closing = client.close();
      expect(await count).toBe('TOKENIZER_UNAVAILABLE');
      expect(await closedWithin(closing)).toBe(true);
    } finally {
      await f.close();
    }
  });

  it('closes after an absent Python request has already rejected', async () => {
    const f = await fixture('absent'), client = f.client();
    try {
      await expect(client.count(['synthetic'])).rejects.toMatchObject({ code: 'TOKENIZER_UNAVAILABLE' });
      expect(await closedWithin(client.close())).toBe(true);
    } finally {
      await f.close();
    }
  });

  it.each(['cooperative', 'stubborn'] as const)(
    'terminates a %s tokenizer after a valid response', async (mode) => {
      const f = await fixture(mode), client = f.client();
      try {
        expect(await client.count(['synthetic'])).toEqual([1]);
        const owned = await f.identity();
        expect(await closedWithin(client.close())).toBe(true);
        expect(processIsAlive(owned.pid, owned.start)).toBe(false);
        const events = (await f.events()).map(event => event.event);
        expect(events).toContain('stdinEOF');
        if (mode === 'stubborn') expect(events).toContain('SIGTERM');
        else expect(events).not.toContain('SIGTERM');
      } finally {
        await f.close();
      }
    },
  );

  it('completes on tokenizer exit while an owned descendant still holds its output pipes', async () => {
    const f = await fixture('inherited-pipes'), client = f.client();
    try {
      expect(await client.count(['synthetic'])).toEqual([1]);
      await expect.poll(() => existsSync(f.holderReady), { timeout: 2000 }).toBe(true);
      const holder = await f.identity(f.holderReady), owned = await f.identity();
      expect(await closedWithin(client.close(), 1000)).toBe(true);
      expect(processIsAlive(owned.pid, owned.start)).toBe(false);
      expect(processIsAlive(holder.pid, holder.start)).toBe(true);
    } finally {
      await f.close();
    }
  });

  it('closes the app after a capability request started a TERM-ignoring tokenizer', async () => {
    const f = await fixture('stubborn');
    let app: Awaited<ReturnType<typeof createApp>> | undefined;
    try {
      await initializeOwner(f.config, 'synthetic_owner', testPassword);
      app = await createApp(f.config);
      const login = await app.inject({
        method: 'POST', url: '/api/auth/sign-in/username',
        headers: { origin: f.config.origin },
        payload: { username: 'synthetic_owner', password: testPassword },
      });
      expect(login.statusCode).toBe(200);
      const response = await app.inject({
        url: '/api/platform/search-runtime',
        headers: { cookie: login.cookies.map(c => `${c.name}=${c.value}`).join('; ') },
      });
      expect(response.statusCode).toBe(200);
      expect(response.json().components.tokenizerReady).toBe(true);
      const owned = await f.identity();
      expect(await closedWithin(app.close())).toBe(true);
      expect(processIsAlive(owned.pid, owned.start)).toBe(false);
      expect((await f.events()).map(event => event.event)).toContain('SIGTERM');
    } finally {
      await f.close();
      await app?.close();
    }
  });
});
