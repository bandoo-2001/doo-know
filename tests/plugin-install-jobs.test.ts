import { it, expect } from 'vitest';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase } from '../packages/core/db.js';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { createFixture, loginFixtureOwner } from './support/fixture.js';
import { pluginFixture } from './support/plugin-fixture.js';
import { pluginInstallJobs } from '../apps/server/plugins/install-jobs.js';

it('returns a job immediately for a slow download and reconciles a lost installation reply without repeating it', async () => {
  const root = await mkdtemp(join(tmpdir(), 'plugin-install-job-')),
    db = openDatabase(root);
  let release!: () => void,
    installs = 0,
    installed = false;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const host: any = {
    catalog: () => [{ id: 'mcp', version: '1.0.2' }],
    list: () => (installed ? [{ id: 'mcp', installedVersion: '1.0.2', state: 'disabled' }] : []),
    install: async (_id: string, options: any) => {
      installs++;
      options.onPhase('downloading');
      await gate;
      options.onPhase('verifying');
      installed = true;
      return host.list()[0];
    },
  };
  let jobs = pluginInstallJobs(db, host);
  try {
    const first = jobs.start('owner', { id: 'mcp', requestId: 'slow-install' });
    expect(first.status).toBe('queued');
    expect(jobs.start('owner', { id: 'mcp', requestId: 'slow-install' }).id).toBe(first.id);
    await expect.poll(() => jobs.get('owner', first.id).phase).toBe('downloading');
    expect(jobs.start('owner', { id: 'mcp', requestId: 'another-click' }).id).toBe(first.id);
    expect(() => jobs.get('other-owner', first.id)).toThrow();
    release();
    await expect.poll(() => jobs.get('owner', first.id).status).toBe('succeeded');
    expect(jobs.get('owner', first.id).result).toEqual({ pluginId: 'mcp', installedVersion: '1.0.2', installed: true });
    expect(installs).toBe(1);
    expect(jobs.start('owner', { id: 'mcp', requestId: 'another-click' }).id).toBe(first.id);
    expect(installs).toBe(1);
    await jobs.close();
    db.prepare("UPDATE plugin_install_jobs SET status='running',phase='installing' WHERE id=?").run(
      first.id,
    );
    jobs = pluginInstallJobs(db, host);
    expect(jobs.get('owner', first.id)).toMatchObject({ status: 'succeeded', phase: 'complete' });
    expect(jobs.start('owner', { id: 'mcp', requestId: 'another-click' }).id).toBe(first.id);
    expect(installs).toBe(1);
  } finally {
    release();
    await jobs.close();
    db.close();
    await rm(root, { recursive: true, force: true });
  }
});

it('returns HTTP202 while a real plugin download is waiting, then polls its durable receipt', async () => {
  const root = await mkdtemp(join(tmpdir(), 'plugin-install-http-'));
  const entry = await pluginFixture(root);
  const bytes = await readFile(fileURLToPath(entry.artifact.url));
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const server = createServer((_req, res) => { void gate.then(() => { res.writeHead(200); res.end(bytes); }); });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  entry.artifact.url = 'http://127.0.0.1:' + (server.address() as any).port + '/plugin.tar.gz';
  const f = await createFixture({ pluginCatalog: [entry] });
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    expect((await f.app.inject({ url: '/api/platform/plugin-installations' })).statusCode).toBe(401);
    const headers = await loginFixtureOwner(f);
    const accepted = await Promise.race([
      f.app.inject({ method: 'POST', url: '/api/platform/plugin-installations', headers, payload: { id: entry.id, requestId: 'slow-http-install' } }),
      new Promise<never>((_resolve, reject) => { timeout = setTimeout(() => reject(Error('Installation waited for the download before returning a receipt')), 3000); }),
    ]);
    clearTimeout(timeout);
    expect(accepted.statusCode).toBe(202);
    const id = accepted.json().id;
    await expect.poll(async () => (await f.app.inject({ url: '/api/platform/plugin-installations/' + id, headers })).json().phase).toBe('downloading');
    expect((await f.app.inject({ url: '/api/platform/plugins', headers })).json().installed).toEqual([]);
    release();
    await expect.poll(async () => (await f.app.inject({ url: '/api/platform/plugin-installations/' + id, headers })).json().status).toBe('succeeded');
    const receipt = (await f.app.inject({ url: '/api/platform/plugin-installations/' + id, headers })).json();
    expect(receipt.result).toEqual({ pluginId: entry.id, installedVersion: entry.version, installed: true });
    const replay = await f.app.inject({ method: 'POST', url: '/api/platform/plugin-installations', headers, payload: { id: entry.id, requestId: 'slow-http-install' } });
    expect(replay.json().id).toBe(id);
    expect((await f.app.inject({ url: '/api/platform/plugins', headers })).json().installed[0].state).toBe('disabled');
  } finally {
    clearTimeout(timeout); release(); await f.close();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    await rm(root, { recursive: true, force: true });
  }
});
