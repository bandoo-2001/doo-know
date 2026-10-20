import { expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { openDatabase } from '../packages/core/db.js';
import { workspaceWriteSync, workspaceWrite, workspaceExclusive, workspacePermit, workspaceProcess } from '../packages/core/workspace/gate.js';

async function fixture(mode: string) {
  const root = await mkdtemp(join(tmpdir(), 'workspace-error-'));
  const db = openDatabase(join(root, 'data'));
  const worker = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'ignore' });
  await new Promise<void>((yes, no) => { worker.once('spawn', yes); worker.once('error', no); });
  const identity = workspaceProcess(worker.pid!);
  const register = () => db.prepare('INSERT INTO workspace_guards(token,pid,process_start,process_group) VALUES(?,?,?,0)')
    .run(workspacePermit(db, false), identity.pid, identity.start);
  const run = async (work: () => void) => mode === 'sync'
    ? workspaceWriteSync(db, { kind: 'fixture-error' }, work)
    : mode === 'shared' ? workspaceWrite(db, { kind: 'fixture-error' }, async () => work())
    : workspaceExclusive(db, { kind: 'fixture-error' }, async () => work());
  const retained = async () => {
    expect(db.prepare('SELECT pid,process_start FROM workspace_gate').get()).toEqual({ pid: 0, process_start: 'abandoned' });
    expect((db.prepare('SELECT count(*) n FROM workspace_guards').get() as { n: number }).n).toBe(1);
    await expect(workspaceExclusive(db, { kind: 'fixture-blocked', waitMs: 30 }, async () => {}))
      .rejects.toMatchObject({ code: 'WORKSPACE_BUSY' });
  };
  return { run, register, retained, close: async () => {
    await new Promise<void>(yes => { worker.once('close', () => yes()); worker.kill('SIGKILL'); });
    await workspaceExclusive(db, { kind: 'fixture-recovered', waitMs: 100 }, async () => {});
    expect(db.prepare('SELECT * FROM workspace_guards').all()).toEqual([]);
    db.close(); await rm(root, { recursive: true, force: true });
  } };
}

it.each(['sync', 'shared', 'exclusive'])('preserves the primary error and retained cleanup failure in %s work', async mode => {
  const f = await fixture(mode);
  const primary = Object.assign(Error('GIT_COMMAND_TIMEOUT'), { code: 'GIT_COMMAND_TIMEOUT' });
  try {
    await expect(f.run(() => { f.register(); throw primary; })).rejects.toBe(primary);
    expect((primary as Error & { workspaceReleaseError?: unknown }).workspaceReleaseError)
      .toMatchObject({ code: 'WORKSPACE_PROCESS_RUNNING' });
    expect(Object.keys(primary)).not.toContain('workspaceReleaseError');
    await f.retained();
  } finally { await f.close(); }
});

it.each(['sync', 'shared', 'exclusive'])('still refuses successful %s work when its resource remains alive', async mode => {
  const f = await fixture(mode);
  try {
    await expect(f.run(() => { f.register(); })).rejects.toMatchObject({ code: 'WORKSPACE_PROCESS_RUNNING' });
    await f.retained();
  } finally { await f.close(); }
});

it('preserves a frozen primary error while retaining the abandoned resource record', async () => {
  const f = await fixture('exclusive'), primary = Object.freeze(Error('primary failure'));
  try {
    await expect(f.run(() => { f.register(); throw primary; })).rejects.toBe(primary);
    await f.retained();
  } finally { await f.close(); }
});
