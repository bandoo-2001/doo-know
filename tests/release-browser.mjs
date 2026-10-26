import { mkdtemp, readFile, rm, access } from 'node:fs/promises';
import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve, isAbsolute } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import { parseArgs } from 'node:util';
import { extract } from 'tar';

const { values } = parseArgs({ options: { directory: { type: 'string' } } });
if (!values.directory) throw Error('Release browser checks require --directory');
const directory = resolve(values.directory);
const info = JSON.parse(await readFile(join(directory, 'release.json'), 'utf8'));
if (typeof info.file !== 'string' || !/^dooknow-[A-Za-z0-9.+-]+-linux-x64\.tar\.gz$/.test(info.file))
  throw Error('Invalid release application filename');
const root = await mkdtemp(join(tmpdir(), 'dooknow-release-browser-'));
let ownedGroup;
let interrupted = false;
let interruptedSignal;
let wakeInterrupted;
const interruption = new Promise((done) => { wakeInterrupted = done; });
function processStat(pid) {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    const fields = stat.slice(stat.lastIndexOf(')') + 2).trim().split(/\s+/);
    return { state: fields[0], group: Number(fields[2]), session: Number(fields[3]), start: fields[19] };
  } catch (error) {
    if (['ENOENT', 'ESRCH'].includes(error.code)) return;
    throw error;
  }
}
function groupIsAlive() {
  if (!ownedGroup) return false;
  const leader = processStat(ownedGroup.pid);
  // A reused leader PID is never authority to signal a replacement group.
  if (leader && leader.start !== ownedGroup.start) {
    ownedGroup = undefined;
    return false;
  }
  for (const pid of readdirSync('/proc').filter((entry) => /^\d+$/.test(entry))) {
    const member = processStat(pid);
    if (member?.group === ownedGroup.pid && member.session === ownedGroup.pid &&
        !['Z', 'X'].includes(member.state)) return true;
  }
  // Relinquish the numeric group permanently once it has no live members.
  ownedGroup = undefined;
  return false;
}
function signalGroup(signal) {
  if (!groupIsAlive()) return;
  try { process.kill(-ownedGroup.pid, signal); } catch (error) {
    if (error.code !== 'ESRCH') throw error;
  }
}
function stop(signal) {
  if (interrupted) return;
  interrupted = true;
  interruptedSignal = signal;
  wakeInterrupted(1);
}
async function drainGroup() {
  signalGroup(interruptedSignal || 'SIGTERM');
  // Playwright closes browsers in separate groups during its normal signal
  // cleanup. Keep the static files available and allow that cleanup to finish.
  const gracefulUntil = Date.now() + 5000;
  while (groupIsAlive() && Date.now() < gracefulUntil)
    await new Promise((done) => setTimeout(done, 25));
  if (groupIsAlive()) {
    signalGroup('SIGKILL');
    const forcedUntil = Date.now() + 1000;
    while (groupIsAlive() && Date.now() < forcedUntil)
      await new Promise((done) => setTimeout(done, 25));
  }
  if (groupIsAlive()) throw Error(`Release browser process group did not stop; retained ${root}`);
}
const onTerm = () => stop('SIGTERM');
const onInt = () => stop('SIGINT');
process.on('SIGTERM', onTerm);
process.on('SIGINT', onInt);
try {
  // Read only the compiled browser files from the exact verified application archive.
  await extract({
    file: join(directory, info.file), cwd: root, strict: true, preservePaths: false,
    filter(path, entry) {
      const normalized = path.replace(/^\.\//, '');
      if (normalized !== 'dist/web' && !normalized.startsWith('dist/web/')) return false;
      if (isAbsolute(path) || normalized.split('/').includes('..') || path.includes('\\') ||
          !['File', 'Directory'].includes(entry.type))
        throw Error('Unsafe compiled browser archive member');
      return true;
    },
  });
  const staticRoot = join(root, 'dist/web');
  await access(join(staticRoot, 'index.html'));
  if (interrupted) throw Error('Release browser checks interrupted');
  const childExit = new Promise((resolveExit, reject) => {
    const child = spawn(process.execPath, [
      '--import', 'tsx', 'scripts/e2e.ts',
      'tests/e2e/sharing-permissions.spec.ts',
      'tests/e2e/share-management-expiry.spec.ts',
      'tests/e2e/reader-feedback.spec.ts',
      'tests/e2e/markdown-navigation.spec.ts',
      'tests/e2e/blog.spec.ts',
      'tests/e2e/blog-polish.spec.ts',
      'tests/e2e/blog-public-polish.spec.ts',
      '--output', '.local/release-browser-results',
    ], {
      stdio: 'inherit', detached: true,
      env: {
        ...process.env,
        DOOKNOW_E2E_PRODUCTION: '1',
        DOOKNOW_E2E_STATIC_ROOT: staticRoot,
        VITE_DOCUMENT_EDITOR_ENABLED: '1',
      },
    });
    child.once('error', reject);
    child.once('exit', (status) => resolveExit(status ?? 1));
    if (child.pid) ownedGroup = { pid: child.pid, start: processStat(child.pid)?.start };
  });
  // Cancellation enters cleanup even if the leader itself ignores the signal.
  const code = await Promise.race([childExit, interruption]);
  if (code !== 0 || interrupted) throw Error('Release browser regressions failed');
} finally {
  try {
    await drainGroup();
    await rm(root, { recursive: true, force: true });
  } finally {
    process.removeListener('SIGTERM', onTerm);
    process.removeListener('SIGINT', onInt);
  }
}
// An interrupt can also arrive while a successful leader's leftovers drain.
if (interrupted) throw Error('Release browser checks interrupted');
