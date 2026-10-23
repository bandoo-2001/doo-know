import { expect, it, vi } from 'vitest';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { openDatabase } from '../packages/core/db.js';
import { guardedProcess } from '../packages/core/processes/guarded.js';
import { workspaceExclusive, workspacePermit } from '../packages/core/workspace/gate.js';

it.each([false, true])('finishes after leader exit with inherited worker pipes and no execution timeout: killDenied=%s', async killDenied => {
  const root = await mkdtemp(join(tmpdir(), 'guarded-streams-'));
  const db = openDatabase(join(root, 'data')), ready = join(root, 'ready');
  const realKill = process.kill.bind(process);
  let handle: ReturnType<typeof guardedProcess> | undefined, restore: (() => void) | undefined;
  let deadline: ReturnType<typeof setTimeout> | undefined;
  type Outcome = { result?: { code: number }; error?: Error & { code?: string; workspaceReleaseError?: unknown }; pending?: boolean };
  let running: Promise<Outcome> | undefined;
  try {
    const descendant = `const fs=require('node:fs');process.on('SIGTERM',()=>{});fs.writeFileSync(${JSON.stringify(ready)},'ready');setInterval(()=>{},100);`;
    const parent = `const fs=require('node:fs'),{spawn}=require('node:child_process');spawn(process.execPath,['-e',${JSON.stringify(descendant)}],{stdio:'inherit'});setInterval(()=>{if(fs.existsSync(${JSON.stringify(ready)}))process.exit(0)},10);`;
    running = workspaceExclusive(db, { kind: 'fixture-inherited-pipes' }, async () => {
      handle = guardedProcess(db, { kind: 'workspace', token: workspacePermit(db) }, process.execPath,
        ['-e', parent], root, { timeoutMs: 0 });
      return handle.wait;
    }).then(result => ({ result }), error => ({ error }));
    if (killDenied) {
      // Safely model an OS refusal only for this fixture's own process group.
      // Restore the boundary and reap that group before leaving the test.
      const spy = vi.spyOn(process, 'kill').mockImplementation((pid, signal) => {
        if (pid === -handle!.child.pid!) throw Object.assign(Error('fixture kill refused'), { code: 'EPERM' });
        return realKill(pid, signal);
      });
      restore = () => spy.mockRestore();
    }
    await expect.poll(() => existsSync(ready), { timeout: 4000 }).toBe(true);
    const outcome = await Promise.race<Outcome>([running, new Promise(yes => deadline = setTimeout(() => yes({ pending: true }), 6000))]);
    expect(handle!.child.exitCode).toBe(0);
    expect(outcome.pending).toBeUndefined();
    if (killDenied) {
      expect(outcome.error).toMatchObject({ code: 'PROCESS_TIMEOUT' });
      expect(outcome.error?.workspaceReleaseError).toMatchObject({ code: 'WORKSPACE_PROCESS_RUNNING' });
      expect((db.prepare('SELECT count(*) n FROM workspace_guards').get() as { n: number }).n).toBe(1);
      await expect(workspaceExclusive(db, { kind: 'fixture-next-blocked', waitMs: 30 }, async () => {}))
        .rejects.toMatchObject({ code: 'WORKSPACE_BUSY' });
    } else {
      expect(outcome.result?.code).toBe(0);
      expect(db.prepare('SELECT * FROM workspace_guards').all()).toEqual([]);
      await expect(workspaceExclusive(db, { kind: 'fixture-next-ready', waitMs: 50 }, async () => 'ready')).resolves.toBe('ready');
    }
  } finally {
    clearTimeout(deadline);restore?.();
    if (handle?.child.pid) { try { realKill(-handle.child.pid, 'SIGKILL'); } catch {} }
    await running;
    await workspaceExclusive(db, { kind: 'fixture-cleanup', waitMs: 1000 }, async () => {});
    db.close();await rm(root, { recursive: true, force: true });
  }
});
