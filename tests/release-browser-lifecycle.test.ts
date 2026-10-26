import { expect, it } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { join, resolve, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { create } from 'tar';

const project = resolve(dirname(fileURLToPath(import.meta.url)), '..');
function alive(pid: number) {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    return !['Z', 'X'].includes(stat.slice(stat.lastIndexOf(')') + 2).split(/\s+/)[0]);
  } catch (error) {
    if (['ENOENT', 'ESRCH'].includes((error as NodeJS.ErrnoException).code || '')) return false;
    throw error;
  }
}
function kill(pid: number) {
  try { process.kill(pid, 'SIGKILL'); } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
  }
}
function exited(child: ChildProcess) {
  return new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((yes, no) => {
    child.once('error', no);
    child.once('exit', (code, signal) => yes({ code, signal }));
  });
}

// Executes the real release runner with an isolated e2e workload, without a server,
// browser installation, service port, or test-only switch in the release runner.
it.each([
  { signal: 'SIGTERM' as const, mode: 'stubborn', afterLeaderExit: false },
  { signal: 'SIGINT' as const, mode: 'slow', afterLeaderExit: false },
  { signal: 'SIGTERM' as const, mode: 'stubborn', afterLeaderExit: true },
])('drains owned descendants on $signal ($mode, leader already exited: $afterLeaderExit)', async ({ signal, mode, afterLeaderExit }) => {
  const root = await mkdtemp(join(tmpdir(), 'release-browser-lifecycle-'));
  const ready = join(root, 'ready.json'), graceful = join(root, 'graceful.json');
  let runner: ChildProcess | undefined, runnerExit: ReturnType<typeof exited> | undefined;
  let sentinel: ChildProcess | undefined, sentinelExit: ReturnType<typeof exited> | undefined;
  let owned: { leader: number; worker: number; descendant: number; staticRoot: string } | undefined;
  let output = '';
  try {
    await mkdir(join(root, 'scripts'));
    await mkdir(join(root, 'archive', 'dist', 'web'), { recursive: true });
    await mkdir(join(root, 'temporary'));
    const sentinelFile = join(root, 'temporary', 'dooknow-release-browser-unrelated', 'keep');
    await mkdir(dirname(sentinelFile));
    await writeFile(sentinelFile, 'unrelated data');
    sentinel = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { detached: true, stdio: 'ignore' });
    sentinelExit = exited(sentinel);
    await symlink(join(project, 'node_modules'), join(root, 'node_modules'), 'dir');
    await writeFile(join(root, 'archive', 'dist', 'web', 'index.html'), '<html>candidate</html>');
    const file = 'dooknow-lifecycle-linux-x64.tar.gz';
    await create({ file: join(root, file), gzip: true, cwd: join(root, 'archive') }, ['dist']);
    await writeFile(join(root, 'release.json'), JSON.stringify({ file }));

    // The e2e leader exits promptly on cancellation. Its worker either ignores
    // cancellation with an inherited-group descendant, or models Playwright's
    // graceful cleanup of a browser in a separate process group.
    const descendant = `
      const fs=require('node:fs');
      ${mode === 'stubborn' ? "process.on('SIGTERM',()=>{});process.on('SIGINT',()=>{});" : ''}
      fs.writeFileSync(${JSON.stringify(join(root, 'descendant'))}, String(process.pid));
      setInterval(()=>{},100);
    `;
    const worker = `
      const fs=require('node:fs'),{spawn}=require('node:child_process');
      const browser=spawn(process.execPath,['-e',${JSON.stringify(descendant)}],{stdio:'ignore',detached:${mode === 'slow'}});
      let stopping=false;
      function stop(){
        if(stopping)return;stopping=true;
        ${mode === 'slow' ? `setTimeout(()=>{
          browser.once('exit',()=>{
            fs.writeFileSync(${JSON.stringify(graceful)},JSON.stringify({staticPresent:fs.existsSync(process.env.DOOKNOW_E2E_STATIC_ROOT+'/index.html')}));
            process.exit(0);
          });browser.kill('SIGTERM');
        },600);` : ''}
      }
      process.on('SIGTERM',stop);process.on('SIGINT',stop);
      const timer=setInterval(()=>{
        if(!fs.existsSync(${JSON.stringify(join(root, 'descendant'))}))return;
        clearInterval(timer);
        fs.writeFileSync(${JSON.stringify(ready)},JSON.stringify({leader:process.ppid,worker:process.pid,descendant:Number(fs.readFileSync(${JSON.stringify(join(root, 'descendant'))},'utf8')),staticRoot:process.env.DOOKNOW_E2E_STATIC_ROOT}));
      },10);
      setInterval(()=>{},100);
    `;
    await writeFile(join(root, 'scripts', 'e2e.ts'), `
      import {spawn} from 'node:child_process';
      import {existsSync} from 'node:fs';
      spawn(process.execPath,['-e',${JSON.stringify(worker)}],{stdio:'ignore'});
      setInterval(()=>{if(existsSync(${JSON.stringify(join(root, 'exit-leader'))}))process.exit(0)},10);
    `);
    runner = spawn(process.execPath, [join(project, 'tests', 'release-browser.mjs'), '--directory', root], {
      cwd: root, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, TMPDIR: join(root, 'temporary') },
    });
    runnerExit = exited(runner);
    runner.stdout!.on('data', (chunk) => { output += chunk; });
    runner.stderr!.on('data', (chunk) => { output += chunk; });
    await expect.poll(() => existsSync(ready), { timeout: 5000, message: output }).toBe(true);
    owned = JSON.parse(await readFile(ready, 'utf8'));
    expect(existsSync(join(owned!.staticRoot, 'index.html'))).toBe(true);
    if (afterLeaderExit) {
      await writeFile(join(root, 'exit-leader'), 'exit');
      await expect.poll(() => alive(owned!.leader), { timeout: 2000 }).toBe(false);
    }
    const cancelled = Date.now();
    runner.kill(signal);
    // A second interrupt must not bypass or restart the bounded cleanup.
    setTimeout(() => { if (runner?.exitCode === null && runner.signalCode === null) runner.kill(signal); }, 75).unref();
    const outcome = await runnerExit;
    expect(outcome, output).toEqual({ code: 1, signal: null });
    expect(Date.now() - cancelled).toBeLessThan(8000);
    expect(alive(owned!.leader)).toBe(false);
    expect(alive(owned!.worker)).toBe(false);
    expect(alive(owned!.descendant)).toBe(false);
    expect(existsSync(dirname(dirname(owned!.staticRoot)))).toBe(false);
    expect(alive(sentinel.pid!)).toBe(true);
    expect(await readFile(sentinelFile, 'utf8')).toBe('unrelated data');
    if (mode === 'slow') expect(JSON.parse(await readFile(graceful, 'utf8'))).toEqual({ staticPresent: true });
  } finally {
    if (!owned && existsSync(ready)) owned = JSON.parse(await readFile(ready, 'utf8'));
    if (runner?.pid && alive(runner.pid)) kill(runner.pid);
    if (owned) { kill(-owned.leader); kill(owned.descendant); }
    if (sentinel?.pid) kill(-sentinel.pid);
    await runnerExit;
    await sentinelExit;
    await rm(root, { recursive: true, force: true });
  }
}, 15000);
