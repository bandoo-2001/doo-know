import { expect, it, vi } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { openDatabase } from '../packages/core/db.js';
import {
  guardIsAlive,
  workspaceProcess,
  workspaceExclusive,
  initializeWorkspaceGate,
} from '../packages/core/workspace/gate.js';

const oldBoot = '11111111-1111-4111-8111-111111111111';
async function worker() {
  const child = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], {
    detached: true,
    stdio: 'ignore',
  });
  await new Promise<void>((yes, no) => {
    child.once('spawn', yes);
    child.once('error', no);
  });
  const identity = workspaceProcess(child.pid!);
  return { child, identity, close: () => stop(child) };
}
async function stop(child: ChildProcess) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>((yes) => {
    child.once('close', () => yes());
    child.kill('SIGKILL');
  });
}
function staleStart(start: string, scenario: string) {
  const [boot, ticks] = start.split(':');
  expect(boot).not.toBe(oldBoot);
  return scenario === 'prior boot'
    ? oldBoot + ':' + ticks
    : boot + ':' + String(BigInt(ticks) - 1n);
}

it('recognizes the current process group identity', async () => {
  const w = await worker();
  try {
    expect(
      guardIsAlive({
        pid: w.identity.pid,
        process_start: w.identity.start,
        process_group: w.identity.pid,
      }),
    ).toBe(true);
  } finally {
    await w.close();
  }
});

it.each([null, 17, Buffer.from('legacy-value')])(
  'retains an active group conservatively for nonstandard legacy identity %s',
  async (value) => {
    const w = await worker();
    try {
      expect(
        guardIsAlive({
          pid: w.identity.pid,
          process_start: value as any,
          process_group: w.identity.pid,
        }),
      ).toBe(true);
    } finally {
      await w.close();
    }
  },
);

it.each(['EACCES', 'ENOENT'])(
  'keeps a live group protected when the boot ID cannot be read: %s',
  async (code) => {
    const w = await worker();
    try {
      vi.resetModules();
      vi.doMock('node:fs', async () => {
        const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
        return {
          ...actual,
          readFileSync: (...args: any[]) => {
            if (args[0] === '/proc/sys/kernel/random/boot_id')
              throw Object.assign(new Error('fixture boot ID unavailable'), { code });
            return (actual.readFileSync as any)(...args);
          },
        };
      });
      const isolated = await import('../packages/core/workspace/gate.js');
      expect(
        isolated.guardIsAlive({
          pid: w.identity.pid,
          process_start: w.identity.start,
          process_group: w.identity.pid,
        }),
      ).toBe(true);
      expect(workspaceProcess(w.identity.pid).start).toBe(w.identity.start);
    } finally {
      vi.doUnmock('node:fs');
      vi.resetModules();
      await w.close();
    }
  },
);

it.each(['prior boot', 'reused group leader'])(
  'does not treat an unrelated current group as an old owned resource: %s',
  async (scenario) => {
    const w = await worker();
    try {
      expect(
        guardIsAlive({
          pid: w.identity.pid,
          process_start: staleStart(w.identity.start, scenario),
          process_group: w.identity.pid,
        }),
      ).toBe(false);
      expect(workspaceProcess(w.identity.pid).start).toBe(w.identity.start);
    } finally {
      await w.close();
    }
  },
);

it.each(['prior boot', 'reused group leader'])(
  'reopens and recovers an abandoned gate without disturbing a replacement group: %s',
  async (scenario) => {
    const root = await mkdtemp(join(tmpdir(), 'workspace-identity-')),
      w = await worker();
    const dataRoot = join(root, 'data'),
      retained = join(root, 'retained.md'),
      token = randomUUID();
    let db = openDatabase(dataRoot);
    try {
      await writeFile(retained, '# 合法原文\r\n保留尾随空格  \r\n');
      initializeWorkspaceGate(db);
      db.prepare(
        'INSERT INTO workspace_gate(token,mode,pid,process_start,kind,heartbeat_at,lease_until) VALUES(?,?,?,?,?,?,?)',
      ).run(token, 'exclusive', 0, 'abandoned', 'prior-session-job', 0, 0);
      db.prepare(
        'INSERT INTO workspace_guards(token,pid,process_start,process_group) VALUES(?,?,?,?)',
      ).run(token, w.identity.pid, staleStart(w.identity.start, scenario), w.identity.pid);
      db.close();
      db = openDatabase(dataRoot);
      await expect(
        workspaceExclusive(
          db,
          { kind: 'next-session-operation', waitMs: 50 },
          async () => 'recovered',
        ),
      ).resolves.toBe('recovered');
      expect(db.prepare('SELECT * FROM workspace_guards').all()).toEqual([]);
      expect(db.prepare('SELECT * FROM workspace_gate').all()).toEqual([]);
      expect(await readFile(retained, 'utf8')).toBe('# 合法原文\r\n保留尾随空格  \r\n');
      expect(workspaceProcess(w.identity.pid).start).toBe(w.identity.start);
    } finally {
      db.close();
      await w.close();
      await rm(root, { recursive: true, force: true });
    }
  },
);

it('retains a real original descendant after its leader exits', async () => {
  const root = await mkdtemp(join(tmpdir(), 'workspace-orphan-')),
    ready = join(root, 'ready'),
    exit = join(root, 'exit');
  const descendant = `require('node:fs').writeFileSync(${JSON.stringify(ready)},'ready');setInterval(()=>{},1000);`;
  const parent = `const fs=require('node:fs');require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(descendant)}],{stdio:'ignore'});setInterval(()=>{if(fs.existsSync(${JSON.stringify(exit)}))process.exit(0)},10);`;
  const child = spawn(process.execPath, ['-e', parent], { detached: true, stdio: 'ignore' });
  try {
    await new Promise<void>((yes, no) => {
      child.once('spawn', yes);
      child.once('error', no);
    });
    const identity = workspaceProcess(child.pid!);
    await expect.poll(() => existsSync(ready), { timeout: 4000 }).toBe(true);
    const closed = new Promise<void>((yes) => child.once('close', () => yes()));
    await writeFile(exit, 'exit');
    await closed;
    expect(
      guardIsAlive({
        pid: identity.pid,
        process_start: identity.start,
        process_group: identity.pid,
      }),
    ).toBe(true);
  } finally {
    if (child.pid) {
      try {
        process.kill(-child.pid, 'SIGKILL');
      } catch {}
    }
    await stop(child);
    await rm(root, { recursive: true, force: true });
  }
});
