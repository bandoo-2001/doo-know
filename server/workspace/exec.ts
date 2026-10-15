import { spawn } from 'node:child_process';
import { accessSync, constants } from 'node:fs';
import { delimiter, join, isAbsolute } from 'node:path';
import type { AppDatabase } from '../db.js';
import { workspacePermit, workspaceProcess, processGroupIsAlive } from './gate.js';
import { fail } from '../knowledge/errors.js';
// Register the very process that becomes Git, before it may perform any work.
// execve keeps its PID/start identity, including when the Web process dies.
const runner = String.raw`
import {readFileSync} from 'node:fs';
function identity(pid){const s=readFileSync('/proc/'+pid+'/stat','utf8'),f=s.slice(s.lastIndexOf(')')+2).trim().split(/\s+/);return {start:readFileSync('/proc/sys/kernel/random/boot_id','utf8').trim()+':'+f[19],dead:f[0]==='Z'||f[0]==='X'};}
process.once('disconnect',()=>process.exit(1));
process.once('message',async m=>{
 try{
  if(typeof process.execve!=='function')throw Error();
  const {default:Database}=await import(m.databaseModule),db=new Database(m.databaseFile,{fileMustExist:true});db.pragma('busy_timeout=5000');
  const self=identity(process.pid);
  db.transaction(()=>{const row=db.prepare('SELECT * FROM workspace_gate WHERE token=?').get(m.token);if(!row||!['shared','exclusive'].includes(row.mode)||row.pid!==m.owner.pid||row.process_start!==m.owner.start)throw Error();const p=identity(row.pid);if(p.dead||p.start!==row.process_start)throw Error();db.prepare('INSERT INTO workspace_guards(token,pid,process_start,process_group) VALUES(?,?,?,?)').run(m.token,process.pid,self.start,process.pid);}).immediate();
  db.close();process.chdir(m.cwd);
  process.execve(m.binary,[m.binary,...m.args],m.env);
 }catch{process.stderr.write('WORKSPACE_EXEC_FAILED\n');process.exit(1);}
});`;
export type ExecOptions = {
  env?: Record<string, string>;
  input?: string | Buffer;
  maxBytes?: number;
  timeoutMs?: number;
};
function systemGit() {
  for (const path of [
    '/usr/bin/git',
    '/usr/local/bin/git',
    ...String(process.env.PATH || '')
      .split(delimiter)
      .filter(isAbsolute)
      .map((p) => join(p, 'git')),
  ]) {
    try {
      accessSync(path, constants.X_OK);
      return path;
    } catch {}
  }
  fail(503, 'GIT_DEPENDENCY_MISSING');
}
export function workspaceExec(
  db: AppDatabase,
  root: string,
  args: string[],
  options: ExecOptions = {},
) {
  const token = workspacePermit(db, false),
    owner = workspaceProcess(),
    binary = systemGit();
  if (!Array.isArray(args) || args.some((a) => typeof a !== 'string' || a.includes('\0')))
    fail(400, 'INVALID_GIT_ARGUMENT');
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env))
    if (
      v !== undefined &&
      !k.startsWith('GIT_') &&
      !k.startsWith('NODE_') &&
      !['LD_PRELOAD', 'LD_LIBRARY_PATH', 'BASH_ENV', 'ENV'].includes(k)
    )
      env[k] = v;
  Object.assign(
    env,
    {
      GIT_TERMINAL_PROMPT: '0',
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_PAGER: 'cat',
      GIT_ATTR_NOSYSTEM: '1',
      LC_ALL: 'C.UTF-8',
    },
    options.env || {},
  );
  return new Promise<{ stdout: Buffer; stderr: Buffer; code: number }>((resolve, reject) => {
    const runnerEnv = { ...process.env };
    for (const key of Object.keys(runnerEnv))
      if (key.startsWith('NODE_') || key === 'LD_PRELOAD') delete runnerEnv[key];
    runnerEnv.NODE_NO_WARNINGS = '1';
    const child = spawn(process.execPath, ['--input-type=module', '-e', runner], {
      stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
      env: runnerEnv,
      detached: true,
    });
    const chunks: Buffer[] = [],
      errors: Buffer[] = [];
    let bytes = 0,
      exceeded = false,
      timedOut = false;
    const cap = options.maxBytes ?? 2 * 1024 * 1024;
    const signal = (name: NodeJS.Signals) => {
      try {
        if (child.pid) process.kill(-child.pid, name);
      } catch {
        child.kill(name);
      }
    };
    const stop = () => {
      signal('SIGTERM');
      const force = setTimeout(() => signal('SIGKILL'), 1000);
      force.unref();
    };
    const timer = setTimeout(() => {
      timedOut = true;
      stop();
    }, options.timeoutMs ?? 30000);
    timer.unref();
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
    // execve normally closes IPC. Only process close proves Git has stopped.
    child.once('error', () => {});
    child.once('close', (code) => {
      clearTimeout(timer);
      if (db.open && !processGroupIsAlive(child.pid ?? 0))
        db.prepare('DELETE FROM workspace_guards WHERE token=? AND pid=?').run(
          token,
          child.pid ?? -1,
        );
      if (exceeded)
        return reject(
          Object.assign(Error('GIT_OUTPUT_TOO_LARGE'), {
            code: 'GIT_OUTPUT_TOO_LARGE',
            statusCode: 413,
          }),
        );
      if (timedOut)
        return reject(
          Object.assign(Error('GIT_COMMAND_TIMEOUT'), {
            code: 'GIT_COMMAND_TIMEOUT',
            statusCode: 504,
          }),
        );
      resolve({ stdout: Buffer.concat(chunks), stderr: Buffer.concat(errors), code: code ?? -1 });
    });
    child.stdin!.on('error', () => {});
    child.stdin!.end(options.input);
    child.send(
      {
        databaseModule: import.meta.resolve('better-sqlite3'),
        databaseFile: db.name,
        token,
        owner,
        cwd: root,
        binary,
        args,
        env,
      },
      (error) => {
        if (error) stop();
      },
    );
  });
}
