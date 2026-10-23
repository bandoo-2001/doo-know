import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { guardIsAlive } from '../workspace/gate.js';
import { fail } from '../knowledge/errors.js';
import { processRunner } from './runner.js';

// The native runner retains this guardian's PID/group and denies session/group
// escape to every descendant. Only the guardian owns the parent's IPC lease.
const guardian = String.raw`
import { spawn } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
function identity() {
  const stat = readFileSync('/proc/self/stat', 'utf8');
  const fields = stat.slice(stat.lastIndexOf(')') + 2).trim().split(/\s+/);
  return { start: readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim() + ':' +
    fields[19], pgid: Number(fields[2]), sid: Number(fields[3]) };
}
const initial = identity();
if (initial.pgid !== process.pid || initial.sid !== process.pid) process.exit(1);
function members() {
  return readdirSync('/proc').some(pid => {
    if (!/^\d+$/.test(pid) || Number(pid) === process.pid) return false;
    try {
      const stat = readFileSync('/proc/' + pid + '/stat', 'utf8');
      const fields = stat.slice(stat.lastIndexOf(')') + 2).trim().split(/\s+/);
      return Number(fields[2]) === process.pid && !['Z', 'X'].includes(fields[0]);
    } catch (error) {
      return !['ENOENT', 'ESRCH'].includes(error.code);
    }
  });
}
let started = false, stopping = false;
async function stop() {
  if (stopping) return;
  stopping = true;
  // This signal includes us: the stopping guard prevents recursive shutdown.
  process.kill(-process.pid, 'SIGTERM');
  const until = Date.now() + 2000;
  while (members() && Date.now() < until)
    await new Promise(done => setTimeout(done, 25));
  if (members()) process.kill(-process.pid, 'SIGKILL');
  else process.exit(0);
}
const stopSafely = () => { void stop().catch(() => process.exit(1)); };
process.on('SIGTERM', stopSafely);
process.on('SIGINT', stopSafely);
process.once('disconnect', stopSafely);
process.once('message', message => {
  if (started || stopping) return;
  started = true;
  const self = identity();
  // Refused authorization cannot signal an inherited, unowned process group.
  if (message.pid !== process.pid || message.start !== self.start ||
      self.pgid !== process.pid || self.sid !== process.pid) process.exit(1);
  try {
    const workload = spawn(message.binary, message.args, {
      cwd: message.cwd, env: message.env, stdio: [0, 1, 2],
    });
    workload.once('error', stopSafely);
    workload.once('exit', stopSafely);
  } catch { stopSafely(); }
});
`;

/** Own an interactive process tree without holding a workspace transaction. */
export function interactiveProcess(binary: string, args: string[], env: NodeJS.ProcessEnv) {
  const nativeRunner = processRunner(),
    guardianEnv = { ...process.env };
  for (const key of Object.keys(guardianEnv))
    if (key.startsWith('NODE_') || key === 'LD_PRELOAD') delete guardianEnv[key];
  guardianEnv.NODE_NO_WARNINGS = '1';
  const child = spawn(
    nativeRunner,
    ['--', process.execPath, '--input-type=module', '-e', guardian],
    {
      cwd: process.cwd(),
      env: guardianEnv,
      detached: true,
      stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
    },
  ) as ChildProcessWithoutNullStreams;
  let owner: { pid: number; start: string } | undefined;
  let ended = false,
    draining: Promise<void> | undefined;
  let terminateTimer: ReturnType<typeof setTimeout> | undefined;
  let killTimer: ReturnType<typeof setTimeout> | undefined;
  let resolveWait!: () => void, rejectWait!: (error: unknown) => void;
  const wait = new Promise<void>((yes, no) => {
    resolveWait = yes;
    rejectWait = no;
  });
  // Consumers attach their own handler; keep failed startup safe in the meantime.
  void wait.catch(() => {});
  const closed = new Promise<void>((yes) => child.once('close', () => yes()));
  const alive = () =>
    !!owner &&
    guardIsAlive({ pid: owner.pid, process_start: owner.start, process_group: owner.pid });
  const signal = (name: NodeJS.Signals) => {
    if (!alive()) return;
    try {
      process.kill(-owner!.pid, name);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
    }
  };
  const terminate = () => {
    signal('SIGTERM');
    killTimer ||= setTimeout(() => signal('SIGKILL'), 2000);
    killTimer.unref();
  };
  const finish = () => {
    if (draining) return;
    draining = (async () => {
      // A killed guardian cannot drain its descendants. The recorded boot/start
      // identity prevents a replacement group from becoming a fallback target.
      if (alive()) {
        signal('SIGTERM');
        const until = Date.now() + 2000;
        while (alive() && Date.now() < until) await new Promise((yes) => setTimeout(yes, 25));
        if (alive()) signal('SIGKILL');
        const forcedUntil = Date.now() + 1000;
        while (alive() && Date.now() < forcedUntil) await new Promise((yes) => setTimeout(yes, 25));
      }
      if (alive()) fail(503, 'PROCESS_CLEANUP_FAILED');
      // With the owned group gone, no descendant can retain these protocol pipes.
      // Let buffered replies arrive before reporting process completion.
      await closed;
    })();
    const complete = () => {
      ended = true;
      clearTimeout(terminateTimer);
      clearTimeout(killTimer);
      child.removeListener('error', finish);
      child.removeListener('exit', finish);
      child.removeListener('close', finish);
      if (child.connected) child.disconnect();
    };
    void draining.then(
      () => {
        complete();
        resolveWait();
      },
      (error) => {
        complete();
        rejectWait(error);
      },
    );
  };
  child.once('error', finish);
  child.once('exit', finish);
  child.once('close', finish);
  child.stdin.on('error', () => {});
  if (child.pid) {
    try {
      const stat = readFileSync(`/proc/${child.pid}/stat`, 'utf8');
      const fields = stat
        .slice(stat.lastIndexOf(')') + 2)
        .trim()
        .split(/\s+/);
      const start =
        readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim() + ':' + fields[19];
      // A detached spawn can succeed even when setsid() is denied. Authorize
      // only an actual new leader, using identity/group data from the same stat.
      if (Number(fields[2]) !== child.pid || Number(fields[3]) !== child.pid) throw Error();
      owner = { pid: child.pid, start };
      child.send!(
        { pid: owner.pid, start: owner.start, binary, args, cwd: process.cwd(), env },
        (error) => {
          if (error) terminate();
        },
      );
    } catch {
      // No authorization was sent, so there cannot yet be a workload descendant.
      child.kill('SIGKILL');
    }
  }
  return {
    child,
    wait,
    alive,
    terminate,
    close: () => {
      if (!ended && !terminateTimer) {
        child.stdin.end();
        terminateTimer = setTimeout(terminate, 2000);
        terminateTimer.unref();
      }
      return wait;
    },
  };
}
