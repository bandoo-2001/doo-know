import { expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { openDatabase } from '../packages/core/db.js';
import { workspaceProcess, processIsAlive } from '../packages/core/workspace/gate.js';
import { searchRuntimeManager } from '../apps/server/platform/search-runtime.js';

it.each([
  ['prior boot', 'recover'],
  ['reused group leader', 'recover'],
  ['prior boot', 'cancel'],
  ['reused group leader', 'cancel'],
])(
  'does not retain or signal a replacement group during search %s %s',
  async (scenario, action) => {
    const root = await mkdtemp(join(tmpdir(), 'search-identity-')),
      dataRoot = join(root, 'data');
    const db = openDatabase(dataRoot),
      id = randomUUID();
    const child = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], {
      detached: true,
      stdio: 'ignore',
    });
    await new Promise<void>((yes, no) => {
      child.once('spawn', yes);
      child.once('error', no);
    });
    const identity = workspaceProcess(child.pid!),
      [boot, ticks] = identity.start.split(':');
    const prior =
      scenario === 'prior boot'
        ? '11111111-1111-4111-8111-111111111111:' + ticks
        : boot + ':' + String(BigInt(ticks) - 1n);
    const platform: any = {
      status: () => ({ components: { knowledge: false } }),
      get: () => ({
        knowledge: {
          worker: { capabilities: async () => ({ tokenizerReady: false, vectorReady: false }) },
        },
      }),
    };
    const manager = searchRuntimeManager(
      {
        dataRoot,
        secret: 'fixture-only-process-identity-secret',
        origin: 'http://localhost',
      } as any,
      db,
      platform,
    );
    try {
      db.prepare(
        "INSERT INTO operations(id,principal,client_id,kind,request_id,params_hash,status,created_at,updated_at) VALUES(?,?,?,?,?,?,'running',?,?)",
      ).run(id, 'owner', 'fixture', 'search_prepare', id, 'fixture', Date.now(), Date.now());
      db.prepare(
        "INSERT INTO search_preparations(id,owner_id,distribution_json,state,phase,total_bytes,runner_pid,runner_start,updated_at) VALUES(?,?,'{}','running','installing',0,0,?,?)",
      ).run(id, 'owner', prior, Date.now());
      db.prepare('INSERT INTO search_processes VALUES(?,?,?,?,?)').run(
        id,
        'preparation',
        identity.pid,
        prior,
        identity.pid,
      );
      if (action === 'recover') {
        const status = await manager.status();
        expect(status.task).toMatchObject({
          state: 'failed',
          phase: 'interrupted',
          error: 'PREPARATION_INTERRUPTED',
        });
        expect(db.prepare('SELECT * FROM search_processes').all()).toEqual([]);
      } else {
        await expect(manager.cancel('owner', id)).resolves.toMatchObject({ state: 'cancelled' });
      }
      expect(processIsAlive(identity.pid, identity.start)).toBe(true);
    } finally {
      await manager.close();
      if (child.exitCode === null && child.signalCode === null)
        await new Promise<void>((yes) => {
          child.once('close', () => yes());
          child.kill('SIGKILL');
        });
      db.close();
      await rm(root, { recursive: true, force: true });
    }
  },
);
