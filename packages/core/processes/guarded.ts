import { spawn, type ChildProcess } from 'node:child_process';
import type { AppDatabase } from '../db.js';
import { workspaceProcess, processGroupIsAlive } from '../workspace/gate.js';
export type ProcessPermit =
  | { kind: 'workspace'; token: string }
  | { kind: 'search'; taskId: string; role: 'preparation' | 'runtime' };
export type ProcessOptions = {
  env?: Record<string, string>;
  input?: string | Buffer;
  maxBytes?: number;
  timeoutMs?: number;
  signal?: AbortSignal;
};
// The registered Node process becomes the executable without changing identity.
const runner = String.raw`
import {readFileSync} from 'node:fs';
function identity(pid){const s=readFileSync('/proc/'+pid+'/stat','utf8'),f=s.slice(s.lastIndexOf(')')+2).trim().split(/\s+/);return {start:readFileSync('/proc/sys/kernel/random/boot_id','utf8').trim()+':'+f[19],dead:f[0]==='Z'||f[0]==='X'};}
process.once('disconnect',()=>process.exit(1));
process.once('message',async m=>{
 try{
  if(typeof process.execve!=='function')throw Error();
  const {default:Database}=await import(m.databaseModule),db=new Database(m.databaseFile,{fileMustExist:true});db.pragma('busy_timeout=5000');
  const self=identity(process.pid);
  db.transaction(()=>{
   let row;
   if(m.permit.kind==='workspace'){
    row=db.prepare('SELECT pid,process_start,mode FROM workspace_gate WHERE token=?').get(m.permit.token);
    if(!row||!['shared','exclusive'].includes(row.mode))throw Error();
   }else if(m.permit.kind==='search'){
    row=m.permit.role==='runtime'?db.prepare('SELECT parent_pid AS pid,parent_start AS process_start FROM search_runtime WHERE id=1 AND task_id=?').get(m.permit.taskId):db.prepare("SELECT runner_pid AS pid,runner_start AS process_start FROM search_preparations WHERE id=? AND state='running' AND cancel_requested=0").get(m.permit.taskId);
   }
   if(!row||row.pid!==m.owner.pid||row.process_start!==m.owner.start)throw Error();
   const p=identity(row.pid);if(p.dead||p.start!==row.process_start)throw Error();
   if(m.permit.kind==='workspace')db.prepare('INSERT INTO workspace_guards(token,pid,process_start,process_group) VALUES(?,?,?,?)').run(m.permit.token,process.pid,self.start,process.pid);
   else db.prepare('INSERT INTO search_processes VALUES(?,?,?,?,?)').run(m.permit.taskId,m.permit.role,process.pid,self.start,process.pid);
  }).immediate();
  db.close();process.chdir(m.cwd);
  process.execve(m.binary,[m.binary,...m.args],m.env);
 }catch{process.stderr.write('PROCESS_START_FAILED\n');process.exit(1);}
});`;

export function guardedProcess(
  db: AppDatabase,
  permit: ProcessPermit,
  binary: string,
  args: string[],
  cwd: string,
  options: ProcessOptions = {},
) {
  const owner = workspaceProcess(),
    env = options.env || {};
  let child!: ChildProcess;
  const wait = new Promise<{ stdout: Buffer; stderr: Buffer; code: number }>((resolve, reject) => {
    const runnerEnv = { ...process.env };
    for (const key of Object.keys(runnerEnv))
      if (key.startsWith('NODE_') || key === 'LD_PRELOAD') delete runnerEnv[key];
    runnerEnv.NODE_NO_WARNINGS = '1';
    child = spawn(process.execPath, ['--input-type=module', '-e', runner], {
      stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
      env: runnerEnv,
      detached: true,
    });
    const chunks: Buffer[] = [],
      errors: Buffer[] = [];
    let bytes = 0,
      exceeded = false,
      timedOut = false;
    let finished = false,
      forceTimer: ReturnType<typeof setTimeout> | undefined;
    const cap = options.maxBytes ?? 2 * 1024 * 1024;
    const signal = (name: NodeJS.Signals) => {
      if (finished) return;
      try {
        if (child.pid) process.kill(-child.pid, name);
      } catch {
        child.kill(name);
      }
    };
    const stop = () => {
      signal('SIGTERM');
      forceTimer ||= setTimeout(() => signal('SIGKILL'), 1000);
      forceTimer.unref();
    };
    options.signal?.addEventListener('abort', stop, { once: true });
    const timer =
      options.timeoutMs === 0
        ? undefined
        : setTimeout(() => {
            timedOut = true;
            stop();
          }, options.timeoutMs ?? 30000);
    timer?.unref();
    for (const [stream, output] of [
      [child.stdout, chunks],
      [child.stderr, errors],
    ] as const)
      stream!.on('data', (b: Buffer) => {
        bytes += b.length;
        if (bytes > cap) {
          exceeded = true;
          stop();
        } else output.push(b);
      });
    let draining: Promise<boolean> | undefined;
    const closeReaders = () => {
      child.stdout!.destroy();
      child.stderr!.destroy();
    };
    const drain = () => {
      draining ||= (async () => {
        if (timer) clearTimeout(timer);
        const group = child.pid ?? 0;
        // Workers can keep inherited pipes open after the leader exits, so
        // initiate cleanup on exit rather than waiting for stream closure.
        if (processGroupIsAlive(group)) {
          stop();
          const gracefulUntil = Date.now() + 1000;
          while (processGroupIsAlive(group) && Date.now() < gracefulUntil)
            await new Promise((done) => setTimeout(done, 25));
          if (processGroupIsAlive(group)) {
            signal('SIGKILL');
            const forcedUntil = Date.now() + 1000;
            while (processGroupIsAlive(group) && Date.now() < forcedUntil)
              await new Promise((done) => setTimeout(done, 25));
          }
        }
        const groupStopped = !processGroupIsAlive(group);
        // If the kernel cannot reap it, retain the guard and report a timeout.
        if (!groupStopped) {
          timedOut = true;
          closeReaders();
        }
        return groupStopped;
      })();
      return draining;
    };
    // execve normally closes IPC. Stream closure and group drain are both needed.
    child.once('error', () => {});
    child.once('exit', () => {
      void drain().catch(closeReaders);
    });
    child.once('close', async (code) => {
      try {
        const groupStopped = await drain();
        if (db.open && groupStopped) {
          if (permit.kind === 'workspace')
            db.prepare('DELETE FROM workspace_guards WHERE token=? AND pid=?').run(
              permit.token,
              child.pid ?? -1,
            );
          else
            db.prepare('DELETE FROM search_processes WHERE task_id=? AND role=? AND pid=?').run(
              permit.taskId,
              permit.role,
              child.pid ?? -1,
            );
        }
      } catch (error) {
        reject(error);
        return;
      } finally {
        finished = true;
        if (forceTimer) clearTimeout(forceTimer);
        options.signal?.removeEventListener('abort', stop);
      }
      if (exceeded)
        return reject(
          Object.assign(Error('PROCESS_OUTPUT_TOO_LARGE'), {
            code: 'PROCESS_OUTPUT_TOO_LARGE',
            statusCode: 413,
          }),
        );
      if (timedOut)
        return reject(
          Object.assign(Error('PROCESS_TIMEOUT'), {
            code: 'PROCESS_TIMEOUT',
            statusCode: 504,
          }),
        );
      resolve({ stdout: Buffer.concat(chunks), stderr: Buffer.concat(errors), code: code ?? -1 });
    });
    child.stdin!.on('error', () => {});
    child.stdin!.end(options.input);
    // An abort that predates the listener must never authorize the workload.
    if (options.signal?.aborted) {
      stop();
      return;
    }
    child.send!(
      {
        databaseModule: import.meta.resolve('better-sqlite3'),
        databaseFile: db.name,
        permit,
        owner,
        cwd,
        binary,
        args,
        env,
      },
      (error) => {
        if (error) stop();
      },
    );
  });
  return { child, wait };
}
