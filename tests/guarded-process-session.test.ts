import { expect, it } from 'vitest';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { openDatabase } from '../packages/core/db.js';
import { guardedProcess } from '../packages/core/processes/guarded.js';
import {
  workspaceExclusive,
  workspacePermit,
  workspaceProcess,
  processIsAlive,
} from '../packages/core/workspace/gate.js';

const sleep = (ms: number) => new Promise<void>((yes) => setTimeout(yes, ms));

it('executes the workload with its registered PID and permits a normal child write', async () => {
  const root = await mkdtemp(join(tmpdir(), 'guarded-normal-child-'));
  const db = openDatabase(join(root, 'data')),
    file = join(root, 'retained.md');
  const original = '# 合法子任务\r\n原文字节与尾随空格  \r\n';
  let handle: ReturnType<typeof guardedProcess> | undefined;
  try {
    const child = `require('node:fs').writeFileSync(${JSON.stringify(file)},${JSON.stringify(original)});`;
    const parent = `const c=require('node:child_process').spawnSync(process.execPath,['-e',${JSON.stringify(child)}],{stdio:'inherit'});if(c.status!==0)process.exit(1);process.stdout.write(JSON.stringify({pid:process.pid}));`;
    const reply = await workspaceExclusive(db, { kind: 'normal-child-control' }, async () => {
      handle = guardedProcess(
        db,
        { kind: 'workspace', token: workspacePermit(db) },
        process.execPath,
        ['-e', parent],
        root,
      );
      return handle.wait;
    });
    expect(reply.code).toBe(0);
    expect(JSON.parse(reply.stdout.toString()).pid).toBe(handle!.child.pid);
    expect(await readFile(file, 'utf8')).toBe(original);
    expect(db.prepare('SELECT * FROM workspace_gate').all()).toEqual([]);
    expect(db.prepare('SELECT * FROM workspace_guards').all()).toEqual([]);
  } finally {
    db.close();
    await rm(root, { recursive: true, force: true });
  }
});

it.each([
  [true, 'normal-exit'],
  [false, 'normal-exit'],
  [false, 'abort'],
  [false, 'timeout'],
] as const)(
  'contains a detached descendant and preserves original content: inheritedPipes=%s, completion=%s',
  async (inherited, mode) => {
    const root = await mkdtemp(join(tmpdir(), 'guarded-new-session-'));
    const db = openDatabase(join(root, 'data'));
    const ready = join(root, 'ready.json'),
      go = join(root, 'go'),
      started = join(root, 'started'),
      refused = join(root, 'refused'),
      file = join(root, 'retained.md');
    const original = '# 需要保全的原文\r\n保留尾随空格  \r\n';
    const controller = new AbortController();
    let handle: ReturnType<typeof guardedProcess> | undefined,
      identity: ReturnType<typeof workspaceProcess> | undefined;
    type Outcome = { result?: { code: number }; error?: { code?: string }; pending?: boolean };
    let running: Promise<Outcome> | undefined, deadline: ReturnType<typeof setTimeout> | undefined;
    try {
      await writeFile(file, original);
      const child = `const fs=require('node:fs');const s=fs.readFileSync('/proc/self/stat','utf8'),f=s.slice(s.lastIndexOf(')')+2).trim().split(/\\s+/);process.on('SIGTERM',()=>{});fs.writeFileSync(${JSON.stringify(ready)},JSON.stringify({pid:process.pid,start:fs.readFileSync('/proc/sys/kernel/random/boot_id','utf8').trim()+':'+f[19]}));setInterval(()=>{if(fs.existsSync(${JSON.stringify(go)}))fs.writeFileSync(${JSON.stringify(file)},'# escaped late write\\n')},20);`;
      const parent = `const fs=require('node:fs');fs.writeFileSync(${JSON.stringify(started)},'started');function launch(detached){const c=require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(child)}],{detached,stdio:${inherited ? "['ignore',process.stdout,process.stderr]" : "'ignore'"}});c.once('error',e=>{if(detached&&e.code==='EPERM'){fs.writeFileSync(${JSON.stringify(refused)},e.code);launch(false)}else throw e;});}launch(true);setInterval(()=>{if(${JSON.stringify(mode)}==='normal-exit'&&fs.existsSync(${JSON.stringify(ready)}))process.exit(0)},10);`;
      running = workspaceExclusive(db, { kind: 'detached-descendant-fixture' }, async () => {
        handle = guardedProcess(
          db,
          { kind: 'workspace', token: workspacePermit(db) },
          process.execPath,
          ['-e', parent],
          root,
          { signal: controller.signal, timeoutMs: mode === 'timeout' ? 1500 : 5000 },
        );
        identity = workspaceProcess(handle.child.pid!);
        return handle.wait;
      }).then(
        (result) => ({ result }),
        (error) => ({ error }),
      );
      await expect.poll(() => existsSync(ready), { timeout: 4000 }).toBe(true);
      if (mode === 'abort') controller.abort();
      const outcome = await Promise.race<Outcome>([
        running,
        new Promise((yes) => (deadline = setTimeout(() => yes({ pending: true }), 6000))),
      ]);
      expect(outcome.pending).toBeUndefined();
      if (mode === 'timeout') expect(outcome.error).toMatchObject({ code: 'PROCESS_TIMEOUT' });
      else {
        expect(outcome.error).toBeUndefined();
        if (mode === 'abort') expect(outcome.result?.code).not.toBe(0);
        else expect(outcome.result?.code).toBe(0);
      }
      expect(existsSync(started)).toBe(true);
      if (!existsSync(ready)) expect(await readFile(refused, 'utf8')).toBe('EPERM');
      await writeFile(go, 'go');
      await sleep(120);
      expect(await readFile(file, 'utf8')).toBe(original);
      if (existsSync(ready)) {
        const escaped = JSON.parse(await readFile(ready, 'utf8'));
        expect(processIsAlive(escaped.pid, escaped.start)).toBe(false);
      }
      expect(db.prepare('SELECT * FROM workspace_guards').all()).toEqual([]);
      await expect(
        workspaceExclusive(db, { kind: 'next-legitimate-write', waitMs: 50 }, async () =>
          readFile(file, 'utf8'),
        ),
      ).resolves.toBe(original);
    } finally {
      clearTimeout(deadline);
      if (existsSync(ready)) {
        const escaped = JSON.parse(await readFile(ready, 'utf8'));
        if (processIsAlive(escaped.pid, escaped.start)) process.kill(escaped.pid, 'SIGKILL');
      }
      if (identity && processIsAlive(identity.pid, identity.start)) {
        try {
          process.kill(-identity.pid, 'SIGKILL');
        } catch {}
      }
      await running;
      await workspaceExclusive(db, { kind: 'owned-fixture-cleanup', waitMs: 1000 }, async () => {});
      db.close();
      await rm(root, { recursive: true, force: true });
    }
  },
);
