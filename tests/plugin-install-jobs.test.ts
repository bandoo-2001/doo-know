import { it, expect } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase } from '../packages/core/db.js';
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
