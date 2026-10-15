import { it, expect } from 'vitest';
import { pluginRuntimeFixture } from './support/plugin-runtime.js';
import {
  workspaceWrite,
  workspaceWriteSync,
  workspaceExclusive,
  operationHasLiveWorkspaceWriter,
  workspaceProcess,
} from '../server/workspace/gate.js';
import { openDatabase } from '../server/db.js';
it('blocks all synchronous mutations while exclusive, waits for an active asynchronous writer, and supports nested core writes', async () => {
  const f = await pluginRuntimeFixture();
  const db2 = openDatabase(f.config.dataRoot);
  try {
    let release!: () => void;
    let started!: () => void;
    const entered = new Promise<void>((r) => (started = r));
    const pending = workspaceWrite(
      f.db,
      { kind: 'file.patch', operationId: 'fixture-op' },
      async () => {
        started();
        await new Promise<void>((r) => (release = r));
      },
    );
    await entered;
    expect(operationHasLiveWorkspaceWriter(db2, 'fixture-op')).toBe(true);
    f.db.prepare('UPDATE workspace_gate SET lease_until=0').run();
    await expect(
      workspaceExclusive(db2, { kind: 'git.commit', waitMs: 50 }, async () => {}),
    ).rejects.toMatchObject({ code: 'WORKSPACE_BUSY' });
    release();
    await pending;
    await workspaceExclusive(f.db, { kind: 'git.commit' }, async () => {
      expect(() => workspaceWriteSync(db2, { kind: 'folder' }, () => {})).toThrowError(
        /WORKSPACE_BUSY/,
      );
      const note = await f.services.knowledge.create({
        directory: '00-Inbox',
        fileName: 'nested.md',
        content: '# nested',
        requestId: 'nested-write',
      });
      expect(note.id).toBeTruthy();
    });
    expect(f.db.prepare('SELECT 1 FROM workspace_gate').get()).toBeUndefined();
  } finally {
    db2.close();
    await f.close();
  }
});
it('keeps an exclusive gate while its registered exec process is alive even after the original owner dies', async () => {
  const f = await pluginRuntimeFixture();
  try {
    // A dead original owner does not establish that its executing Git process died.
    await workspaceWrite(f.db, { kind: 'fixture' }, async () => {});
    const live = workspaceProcess();
    f.db
      .prepare(
        'INSERT INTO workspace_gate(token,mode,pid,process_start,kind,heartbeat_at,lease_until) VALUES(?,?,?,?,?,?,?)',
      )
      .run('dead-parent', 'exclusive', 2147483000, 'absent', 'git.commit', 0, 0);
    f.db
      .prepare('INSERT INTO workspace_guards(token,pid,process_start) VALUES(?,?,?)')
      .run('dead-parent', live.pid, live.start);
    expect(() => workspaceWriteSync(f.db, { kind: 'file.write' }, () => {})).toThrowError(
      /WORKSPACE_BUSY/,
    );
    f.db.prepare('DELETE FROM workspace_guards WHERE token=?').run('dead-parent');
    workspaceWriteSync(f.db, { kind: 'file.write' }, () => {});
  } finally {
    await f.close();
  }
});
it('does not steal a stopped registered Git process after its Web parent dies and its lease expires', async () => {
  const { spawn } = await import('node:child_process');
  const { pathToFileURL } = await import('node:url');
  const f = await pluginRuntimeFixture();
  let guardPid: number | undefined;
  const source = `import {openDatabase} from ${JSON.stringify(pathToFileURL(process.cwd() + '/server/db.ts').href)};
    import {workspaceExclusive} from ${JSON.stringify(pathToFileURL(process.cwd() + '/server/workspace/gate.ts').href)};
    import {workspaceExec} from ${JSON.stringify(pathToFileURL(process.cwd() + '/server/workspace/exec.ts').href)};
    const db=openDatabase(${JSON.stringify(f.config.dataRoot)});
    await workspaceExclusive(db,{kind:'git.fault-test'},()=>workspaceExec(db,${JSON.stringify(f.config.knowledgeRoot)},['hash-object','--stdin'],{input:Buffer.alloc(80*1024*1024)}));db.close();`;
  const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', source], {
    cwd: process.cwd(),
    stdio: 'ignore',
  });
  const exited = new Promise<void>((r) => child.once('close', () => r()));
  try {
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      const row = f.db.prepare('SELECT pid FROM workspace_guards LIMIT 1').get() as any;
      if (row) {
        guardPid = row.pid;
        process.kill(guardPid!, 'SIGSTOP');
        break;
      }
      await new Promise((r) => setTimeout(r, 1));
    }
    expect(guardPid).toBeTruthy();
    child.kill('SIGKILL');
    await exited;
    f.db.prepare('UPDATE workspace_gate SET lease_until=0').run();
    await expect(
      workspaceExclusive(f.db, { kind: 'git.second', waitMs: 50 }, async () => {}),
    ).rejects.toMatchObject({ code: 'WORKSPACE_BUSY' });
    process.kill(guardPid!, 'SIGKILL');
    guardPid = undefined;
    await new Promise((r) => setTimeout(r, 50));
    await workspaceExclusive(f.db, { kind: 'git.recovered' }, async () => {});
  } finally {
    child.kill('SIGKILL');
    if (guardPid) {
      try {
        process.kill(guardPid, 'SIGKILL');
      } catch {}
    }
    await exited;
    await f.close();
  }
}, 15000);
it('does not treat an expired per-note lease as permission to overwrite a live file worker', async () => {
  const f = await pluginRuntimeFixture(),
    second = openDatabase(f.config.dataRoot);
  try {
    const note = await f.services.knowledge.create({
      directory: '00-Inbox',
      fileName: 'leased.md',
      content: '# original',
      requestId: 'lease-seed',
    });
    second
      .prepare('INSERT INTO note_write_leases(note_id,owner,lease_until) VALUES(?,?,0)')
      .run(note.id, 'worker-operation:1');
    await workspaceWrite(
      second,
      { kind: 'file.patch', operationId: 'worker-operation' },
      async () => {
        await expect(
          f.services.knowledge.update({
            noteId: note.id,
            content: '# competing',
            expectedModifiedAt: note.modifiedAt,
            requestId: 'competing-write',
          }),
        ).rejects.toMatchObject({ code: 'OPERATION_IN_PROGRESS' });
      },
    );
    expect(f.platform.get().notes.getNote(note.id).content).toBe('# original');
  } finally {
    second.close();
    await f.close();
  }
});
it('rejects a process bookkeeping failure instead of leaving the command promise pending', async () => {
  const f = await pluginRuntimeFixture();
  const { workspaceExec } = await import('../server/workspace/exec.js');
  try {
    await workspaceWrite(f.db, { kind: 'init-schema' }, async () => {});
    f.db.exec(
      "CREATE TRIGGER reject_guard_cleanup BEFORE DELETE ON workspace_guards BEGIN SELECT RAISE(ABORT,'fixture storage unavailable'); END;",
    );
    await expect(
      Promise.race([
        workspaceExclusive(f.db, { kind: 'git.failure' }, () =>
          workspaceExec(f.db, f.config.knowledgeRoot, ['--version']),
        ),
        new Promise((_, reject) => setTimeout(() => reject(Error('command never settled')), 2000)),
      ]),
    ).rejects.toMatchObject({ code: 'SQLITE_CONSTRAINT_TRIGGER' });
  } finally {
    f.db.exec(
      'DROP TRIGGER IF EXISTS reject_guard_cleanup;DELETE FROM workspace_guards;DELETE FROM workspace_gate;',
    );
    await f.close();
  }
});
