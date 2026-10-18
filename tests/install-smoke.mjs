import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import assert from 'node:assert/strict';
import { parseArgs } from 'node:util';
const { values } = parseArgs({ options: { directory: { type: 'string' }, 'skip-build': { type: 'boolean' } } });
const root = await mkdtemp(join(tmpdir(), 'dooknow-install-smoke-'));
const artifactRoot = resolve(values.directory || '.local/platform-execution/artifacts');
const children = new Set();
async function run(command, args, env = process.env) {
  return new Promise((yes, no) => {
    const child = spawn(command, args, { env, stdio: ['ignore', 'pipe', 'pipe'] }); children.add(child);
    let output = ''; child.stdout.on('data', b => output += b); child.stderr.on('data', b => output += b);
    child.on('error', no); child.on('exit', code => { children.delete(child); code === 0 ? yes(output) : no(new Error(`${command} exit ${code}: ${output.slice(-2500)}`)); });
  });
}
const server = createServer(async (req, res) => {
  try { const name = new URL(req.url, 'http://localhost').pathname.slice(1);
    if (!/^[a-zA-Z0-9._-]+$/.test(name)) throw Error();
    res.end(await readFile(join(artifactRoot, name)));
  } catch { res.writeHead(404); res.end(); }
});
await new Promise(yes => server.listen(0, '127.0.0.1', yes));
const source = `http://127.0.0.1:${server.address().port}`;
const env = { ...process.env, XDG_CONFIG_HOME: join(root, 'config'), XDG_DATA_HOME: join(root, 'share'), XDG_CACHE_HOME: join(root, 'cache'),
  DOOKNOW_BIN_DIR: join(root, 'bin'), DOOKNOW_SOURCE: source, DOOKNOW_NO_SERVICE: '1', DOOKNOW_PORT: '15178', DOOKNOW_ALLOW_ROOT: join(root, 'libraries') };
try {
  if (!values['skip-build']) await run(process.execPath, ['scripts/release.mjs', '--output', artifactRoot, '--base-url', source]);
  await mkdir(join(root, 'libraries', 'personal', '00-Inbox'), { recursive: true });
  const ptyScript = join(root, 'account-pty-check.py');
  await writeFile(ptyScript, `import os,pty,select,time,sys\npid,fd=pty.fork()\nif pid==0: os.execvp('bash',['bash','-c','curl -fsSL "$DOOKNOW_SOURCE/install.sh" | bash'])\nbuf=b''; sent=set(); start=time.time()\nwhile time.time()-start<90:\n if select.select([fd],[],[],1)[0]:\n  try: data=os.read(fd,65536)\n  except OSError: break\n  if not data: break\n  buf+=data\n  for key,prompt,value in [('user','初始用户名','owner\\n'),('first','密码（输入隐藏','release-fixture-password-2026\\n'),('confirm','再次输入密码','release-fixture-password-2026\\n')]:\n   if key not in sent and prompt.encode() in buf: os.write(fd,value.encode()); sent.add(key)\n else:\n  ended,status=os.waitpid(pid,os.WNOHANG)\n  if ended: sys.exit(os.waitstatus_to_exitcode(status))\nended,status=os.waitpid(pid,0)\nif b'release-fixture-password-2026' in buf: raise RuntimeError('PASSWORD_ECHOED')\nif os.waitstatus_to_exitcode(status)!=0: sys.stderr.buffer.write(buf); sys.exit(1)\nprint('TTY account initialized without password echo')\n`);
  await run('python3', [ptyScript], env);
  const profileFile = join(root, 'config', 'doo-know', 'profile.json');
  const before = await readFile(profileFile, 'utf8');
  const repeated = await run('bash', ['-c', 'wget -qO- "$DOOKNOW_SOURCE/install.sh" | bash'], env);
  assert.match(repeated, /账号已存在/);
  assert.equal(await readFile(profileFile, 'utf8'), before);
  const launcher = join(root, 'bin', 'dooknow');
  const freshEnv = { HOME: root, PATH: process.env.PATH, TMPDIR: tmpdir(), INDEXING_ENABLED: '0' };
  const status = JSON.parse(await run(launcher, ['status'], freshEnv));
  assert.equal(status.profileFile, profileFile);
  assert.equal(status.dataRoot, join(root, 'share', 'doo-know', 'data'));
  const service = spawn(launcher, ['serve'], { env: freshEnv, cwd: root, stdio: ['ignore', 'pipe', 'pipe'] }); children.add(service);
  let online = false;
  for (let i = 0; i < 80; i++) {
    try { online = (await fetch('http://127.0.0.1:15178/healthz')).ok; } catch {}
    if (online) break;
    await new Promise(yes => setTimeout(yes, 100));
  }
  assert.equal(online, true);
  assert.equal((await fetch('http://127.0.0.1:15178/readyz')).status, 503);
  const origin = 'http://127.0.0.1:15178';
  const login = await fetch(origin + '/api/auth/sign-in/username', { method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: JSON.stringify({ username: 'owner', password: 'release-fixture-password-2026' }) });
  assert.equal(login.status, 200);
  let cookie = login.headers.getSetCookie().map(v => v.split(';')[0]).join('; ');
  const csrf = await fetch(origin + '/api/security/csrf', { headers: { cookie } });
  cookie += '; ' + csrf.headers.getSetCookie().map(v => v.split(';')[0]).join('; ');
  const headers = { cookie, origin, 'content-type': 'application/json', 'x-csrf-token': (await csrf.json()).token };
  const knowledgeRoot = join(root, 'libraries', 'personal');
  const proof = await (await fetch(origin + '/api/platform/setup/validate', { method: 'POST', headers, body: JSON.stringify({ knowledgeRoot }) })).json();
  const saved = await fetch(origin + '/api/platform/setup/complete', { method: 'POST', headers, body: JSON.stringify({ knowledgeRoot, timeZone: 'Asia/Shanghai', validationId: proof.validationId, requestId: 'release-setup' }) });
  assert.equal(saved.status, 200);
  for (let i = 0; i < 80; i++) {
    if ((await fetch(origin + '/readyz')).ok) break;
    await new Promise(yes => setTimeout(yes, 100));
  }
  assert.equal((await fetch(origin + '/readyz')).status, 200);
  assert.equal((await fetch(origin + '/')).status, 200);
  console.log('PASS curl TTY install, hidden password, wget idempotence, bundled runtime, arbitrary cwd, login and root binding');
} finally {
  for (const child of children) { child.kill('SIGTERM'); await new Promise(yes => { child.once('exit', yes); setTimeout(yes, 3000).unref(); }); }
  server.closeAllConnections(); await new Promise(yes => server.close(yes));
  await rm(root, { recursive: true, force: true });
}
