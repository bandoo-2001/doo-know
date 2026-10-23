import { expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { openDatabase } from '../packages/core/db.js';
import { guardedProcess } from '../packages/core/processes/guarded.js';
import { workspaceExclusive, workspacePermit } from '../packages/core/workspace/gate.js';

function alive(pid: number) {
  try {
    const stat = readFileSync('/proc/' + pid + '/stat', 'utf8');
    return !['Z', 'X'].includes(stat.slice(stat.lastIndexOf(')') + 2).split(/\s+/)[0]);
  } catch (error) {
    if (['ENOENT', 'ESRCH'].includes((error as NodeJS.ErrnoException).code || '')) return false;
    throw error;
  }
}

it.each(['abort', 'timeout', 'normal-exit'])(
  'reaps TERM-ignoring descendants before releasing the workspace after %s', async (mode) => {
    const root = await mkdtemp(join(tmpdir(), 'guarded-lifecycle-'));
    const db = openDatabase(join(root, 'data')), ready = join(root, 'ready');
    const controller = new AbortController();
    let handle: ReturnType<typeof guardedProcess> | undefined;
    let running: Promise<{ result?: { code: number }; error?: string }> | undefined;
    try {
      const descendant = `const fs=require('node:fs');process.on('SIGTERM',()=>{});fs.writeFileSync(${JSON.stringify(ready)},String(process.pid));setInterval(()=>{},100);`;
      const parent = `const fs=require('node:fs'),{spawn}=require('node:child_process');spawn(process.execPath,['-e',${JSON.stringify(descendant)}],{stdio:'ignore'});setInterval(()=>{if(${JSON.stringify(mode)}==='normal-exit'&&fs.existsSync(${JSON.stringify(ready)}))process.exit(0)},10);`;
      running = workspaceExclusive(db, { kind: 'fixture-child-lifecycle' }, async () => {
        handle = guardedProcess(db, { kind: 'workspace', token: workspacePermit(db) },
          process.execPath, ['-e', parent], root,
          { signal: controller.signal, timeoutMs: mode === 'timeout' ? 1500 : 5000 });
        return handle.wait;
      }).then(result => ({ result }), error => ({ error: error.code || error.message }));
      await expect.poll(() => existsSync(ready), { timeout: 4000 }).toBe(true);
      const child = Number(readFileSync(ready, 'utf8'));
      expect(child).toBeGreaterThan(0);
      if (mode === 'abort') controller.abort();
      const outcome = await running;
      expect(alive(child)).toBe(false);
      expect(db.prepare('SELECT * FROM workspace_guards').all()).toEqual([]);
      expect(db.prepare('SELECT * FROM workspace_gate').all()).toEqual([]);
      await expect(workspaceExclusive(db, { kind: 'fixture-next-operation', waitMs: 50 }, async () => 'available'))
        .resolves.toBe('available');
      if (mode === 'timeout') expect(outcome.error).toBe('PROCESS_TIMEOUT');
      else {
        expect(outcome.error).toBeUndefined();
        if (mode === 'abort') expect(outcome.result?.code).not.toBe(0);
        else expect(outcome.result?.code).toBe(0);
      }
    } finally {
      if (handle?.child.pid) { try { process.kill(-handle.child.pid, 'SIGKILL'); } catch {} }
      await running;
      db.close(); await rm(root, { recursive: true, force: true });
    }
  },
);
