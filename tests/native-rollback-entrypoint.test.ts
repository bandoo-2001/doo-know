import { beforeAll, afterAll, describe, it, expect } from 'vitest';
import { mkdtemp, mkdir, readFile, writeFile, symlink, readlink, rm, copyFile, lstat, chmod } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { createServer } from 'node:http';
import ts from 'typescript';
import { openDatabase } from '../packages/core/db.js';
import { acquireInstance } from '../apps/server/platform/instance.js';

const exec = promisify(execFile);
const legacyArchive = resolve(process.env.DOOKNOW_RECOVERY_LEGACY_ARCHIVE || '.local/share-release-20261026/artifacts-rc48/dooknow-1.1.0-rc.48-linux-x64.tar.gz');
const candidateArchive = resolve(process.env.DOOKNOW_RECOVERY_CANDIDATE_ARCHIVE || '.local/optimization-fixes-20261026/artifacts-rc49/dooknow-1.1.0-rc.49-linux-x64.tar.gz');
const oldVersion = '1.1.0-rc.48', newVersion = process.env.DOOKNOW_RECOVERY_CANDIDATE_VERSION || '1.1.0-rc.49';
const nativeRequested = !!(process.env.DOOKNOW_RECOVERY_LEGACY_ARCHIVE || process.env.DOOKNOW_RECOVERY_CANDIDATE_ARCHIVE);
// The published prior-version artifact is deliberately external to Git. Release
// verification supplies both archives; ordinary source-only CI skips this native gate.
describe.skipIf(!nativeRequested && (!existsSync(legacyArchive) || !existsSync(candidateArchive)))('native legacy CLI recovery', () => {
 let staging: string;
 beforeAll(async () => {
  staging = await mkdtemp(join(tmpdir(), 'dooknow-native-recovery-artifacts-'));
  for (const [version, archive] of [[oldVersion, legacyArchive], [newVersion, candidateArchive]]) {
   const release = join(staging, version); await mkdir(release);
   await exec('tar', ['-xzf', archive, '-C', release, './package.json', './release.json', './dist/server', './node_modules', './runtime/node/bin/node'], { maxBuffer: 1024 * 1024 });
   await writeFile(join(release, 'package.sha256'), createHash('sha256').update(await readFile(archive)).digest('hex') + '\n');
  }
  // Compile only the changed manager modules into this disposable unpublished
  // candidate fixture. Explicit release-gate archives run their shipped bytes
  // unchanged. Neither source archive nor the rc.48 manager bytes change.
  for (const file of process.env.DOOKNOW_RECOVERY_CANDIDATE_ARCHIVE ? [] : ['apps/server/platform/updates.ts', 'apps/server/platform/recovery-launcher.ts']) {
   if (!existsSync(resolve(file))) continue;
   const compiled = ts.transpileModule(await readFile(resolve(file), 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText;
   await writeFile(join(staging, newVersion, 'dist/server', file.replace(/\.ts$/, '.js')), compiled);
  }
 }, 90000);
 afterAll(async () => { if (staging) await rm(staging, { recursive: true, force: true }); });
 async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "native recovery ' spaces-"));
  const installRoot = join(root, 'installed app'), binDir = join(root, 'command bin'), configHome = join(root, 'config home');
  const profileFile = join(configHome, 'profile file.json'), dataRoot = join(root, 'data'), knowledgeRoot = join(root, 'knowledge'), secretFile = join(configHome, 'auth.key');
  await mkdir(join(installRoot, 'releases'), { recursive: true }); await mkdir(binDir); await symlink('/bin/bash', join(binDir, 'bash')); await symlink('/usr/bin/readlink', join(binDir, 'readlink')); await mkdir(join(configHome, 'systemd/user'), { recursive: true });
  for (const version of [oldVersion, newVersion]) await exec('cp', ['-al', join(staging, version), join(installRoot, 'releases', version)]);
  await symlink('releases/' + newVersion, join(installRoot, 'current'));
  await writeFile(join(installRoot, 'installation.json'), JSON.stringify({ current: newVersion, previous: oldVersion, databaseCompatibility: 3 }));
  await writeFile(join(installRoot, 'profile.path'), profileFile + '\n', { mode: 0o600 });
  await writeFile(secretFile, 'disposable-native-recovery-secret-at-least-thirty-two', { mode: 0o600 });
  const stateFile = join(root, 'service-state'), triggerFile = join(root, 'kill-action'), killedFile = join(root, 'killed.json');
  await writeFile(stateFile, 'active'); await mkdir(knowledgeRoot);
  const health = createServer(async (_, response) => {
   response.setHeader('content-type', 'application/json');
   if ((await readFile(stateFile, 'utf8')) !== 'active') response.statusCode = 503;
   response.end(JSON.stringify({ version: (await readlink(join(installRoot, 'current'))).split('/').pop(), phase: 'ready' }));
  });
  await new Promise<void>(yes => health.listen(0, '127.0.0.1', yes));
  const port = (health.address() as { port: number }).port;
  const config = { installRoot, profileFile, secretFile, dataRoot, knowledgeRoot, serviceName: 'dooknow-native-recovery-fixture.service', serviceManaged: true, host: '127.0.0.1', port, origin: 'http://127.0.0.1:' + port, indexing: { enabled: false, watch: false }, fileTasks: { embedded: false } };
  await writeFile(profileFile, JSON.stringify(config), { mode: 0o600 });
  await writeFile(join(configHome, 'systemd/user', config.serviceName), '# DooKnow profile: ' + profileFile + '\n');
  const db = openDatabase(dataRoot); db.prepare('INSERT INTO notes(id,path) VALUES(?,?)').run('retained', '00-Inbox/latest.md'); db.close();
  const releaseInstance = acquireInstance({ ...config, secret: 'disposable-native-recovery-secret-at-least-thirty-two' }, newVersion);
  const instanceDb = openDatabase(dataRoot); const instanceRow = instanceDb.prepare('SELECT * FROM platform_instance').get(); instanceDb.close();
  const node = join(installRoot, 'releases', newVersion, 'runtime/node/bin/node');
  // Use a shell launcher here because shebang paths cannot contain spaces.
  const fakeService = join(root, 'fake-service.cjs');
  await writeFile(fakeService, `const fs=require('node:fs'); const action=process.argv[3],state=${JSON.stringify(stateFile)};
   if(action==='is-active'){const active=fs.readFileSync(state,'utf8');console.log(active);process.exit(active==='active'?0:3);}
   if(action==='show')console.log(${process.pid});
   if(action==='stop'){fs.writeFileSync(state,'inactive');const DB=require(${JSON.stringify(join(installRoot, 'releases', newVersion, 'node_modules/better-sqlite3'))});const db=new DB(${JSON.stringify(join(dataRoot, 'app.sqlite'))});db.prepare('DELETE FROM platform_instance').run();db.close();}
   if(action==='start'){fs.writeFileSync(state,'active');const DB=require(${JSON.stringify(join(installRoot, 'releases', newVersion, 'node_modules/better-sqlite3'))});const db=new DB(${JSON.stringify(join(dataRoot, 'app.sqlite'))});db.prepare('INSERT OR REPLACE INTO platform_instance(id,pid,process_start,token,profile_file,version) VALUES(@id,@pid,@process_start,@token,@profile_file,@version)').run(${JSON.stringify(instanceRow)});db.close();}
   fs.appendFileSync(${JSON.stringify(join(root, 'service-actions'))},action+'\\n');
   if(fs.existsSync(${JSON.stringify(triggerFile)})&&fs.readFileSync(${JSON.stringify(triggerFile)},'utf8')===action){fs.unlinkSync(${JSON.stringify(triggerFile)});fs.writeFileSync(${JSON.stringify(killedFile)},JSON.stringify({pid:process.ppid,action}));process.kill(process.ppid,'SIGKILL');}
  `);
  const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";
  await writeFile(join(binDir, 'systemctl'), '#!/bin/bash\nexec ' + quote(node) + ' ' + quote(fakeService) + ' "$@"\n', { mode: 0o700 });
  // Exact legacy installer template, not the new helper's rendering function.
  const { stdout: wrapper } = await exec('/bin/bash', ['-c', `printf '#!/usr/bin/env bash\n# DooKnow install: %s\nset -euo pipefail\nexport DOOKNOW_INSTALL_ROOT=%q\n' "$1" "$2"; printf 'export DOOKNOW_PROFILE=%q\nexport XDG_CONFIG_HOME=%q\nexport DOOKNOW_BIN_DIR=%q\n' "$3" "$4" "$5"; printf '%s\n' 'release_root="$(readlink -f "$DOOKNOW_INSTALL_ROOT/current")"' 'exec "$release_root/runtime/node/bin/node" "$release_root/dist/server/scripts/manage.js" "$@"'`, 'fixture', createHash('sha256').update(installRoot).digest('hex'), installRoot, profileFile, configHome, binDir]);
  const launcher = join(binDir, 'dooknow'); await writeFile(launcher, wrapper, { mode: 0o700 });
  const env = { ...process.env, PATH: binDir, DOOKNOW_INSTALL_ROOT: '', DOOKNOW_PROFILE: '', DOOKNOW_BIN_DIR: '', NODE_OPTIONS: '', HTTP_PROXY: '', HTTPS_PROXY: '', http_proxy: '', https_proxy: '', ALL_PROXY: '', all_proxy: '', DATA_ROOT: '', KNOWLEDGE_ROOT: '', XDG_CONFIG_HOME: '' };
  const run = async (...args: string[]) => {
   const child = spawn(launcher, args, { env, stdio: ['ignore', 'pipe', 'pipe'] });
   let stdout = '', stderr = ''; child.stdout.on('data', value => stdout += value); child.stderr.on('data', value => stderr += value);
   const outcome = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((yes, no) => { child.on('error', no); child.on('close', (code, signal) => yes({ code, signal })); });
   return { ...outcome, stdout, stderr, pid: child.pid };
  };
  return { root, config, launcher, wrapper, run, direct: (...args: string[]) => exec(node, [join(installRoot, 'releases', newVersion, 'dist/server/scripts/manage.js'), ...args], { env: { ...env, XDG_CONFIG_HOME: configHome } }), triggerFile, killedFile, stateFile, journal: join(installRoot, 'update-transaction.json'),
   close: async () => { releaseInstance(); health.closeAllConnections(); await new Promise<void>(yes => health.close(() => yes())); await rm(root, { recursive: true, force: true }); } };
 }

 it.each(['stop', 'daemon-reload', 'start'])('recovers through the installed legacy wrapper after SIGKILL at %s', async action => {
  const f = await fixture();
  try {
   const legacyHash = createHash('sha256').update(await readFile(join(f.config.installRoot, 'releases', oldVersion, 'dist/server/apps/server/platform/updates.js'))).digest('hex');
   await writeFile(f.triggerFile, action);
   const killed = await f.run('--profile', f.config.profileFile, 'rollback');
   expect(killed, killed.stderr).toMatchObject({ code: null, signal: 'SIGKILL' });
   expect(JSON.parse(await readFile(f.killedFile, 'utf8')).pid).toBe(killed.pid);
   const status = await f.run('--profile=' + f.config.profileFile, 'status');
   expect(status.code, status.stderr).toBe(0);
   expect(JSON.parse(status.stdout).installedVersion).toBe(action === 'stop' ? newVersion : oldVersion);
   const retried = await f.run('--no-service', '--profile', f.config.profileFile, 'rollback');
   expect(retried.code, retried.stderr).toBe(0);
   expect(JSON.parse(retried.stdout)).toMatchObject({ version: oldVersion, dataPreserved: true });
   expect(await readlink(join(f.config.installRoot, 'current'))).toBe('releases/' + oldVersion);
   const check = openDatabase(f.config.dataRoot); try { expect(check.prepare('SELECT active FROM maintenance').get()).toEqual({ active: 0 }); expect(check.prepare('SELECT id FROM notes').all()).toEqual([{ id: 'retained' }]); } finally { check.close(); }
   expect(JSON.parse(await readFile(f.journal, 'utf8')).phase).toBe('complete');
   expect(createHash('sha256').update(await readFile(join(f.config.installRoot, 'releases', oldVersion, 'dist/server/apps/server/platform/updates.js'))).digest('hex')).toBe(legacyHash);
  } finally { await f.close(); }
 }, 60000);

 it('routes an ordinary update through recovery after selecting the old release', async () => {
  const f = await fixture();
  try {
   await writeFile(f.triggerFile, 'daemon-reload');
   expect((await f.run('rollback')).signal).toBe('SIGKILL');
   const source = join(f.root, 'release source'); await mkdir(source);
   await writeFile(join(source, 'release.json'), JSON.stringify({ version: newVersion, databaseCompatibility: 3, platform: 'linux-x64', file: `dooknow-${newVersion}-linux-x64.tar.gz`, sha256: '0'.repeat(64) }));
   const { pathToFileURL } = await import('node:url');
   const recovered = await f.run('--source', pathToFileURL(source + '/').href, '--profile', f.config.profileFile, 'update');
   expect(recovered.code, recovered.stderr).toBe(0);
   expect(JSON.parse(recovered.stdout)).toEqual({ version: newVersion, unchanged: true });
   expect(await readlink(join(f.config.installRoot, 'current'))).toBe('releases/' + newVersion);
   expect(JSON.parse(await readFile(f.journal, 'utf8')).phase).toBe('recovered');
  } finally { await f.close(); }
 }, 60000);

 it.each(['accepted', 'recoveryAccepted'])('finishes %s via ordinary rollback without reversing its accepted outcome', async phase => {
  const f = await fixture();
  try {
   await writeFile(f.triggerFile, phase === 'accepted' ? 'start' : 'stop');
   const killed = await f.run('rollback'); expect(killed.signal, killed.stderr).toBe('SIGKILL');
   const state = JSON.parse(await readFile(f.journal, 'utf8'));
   await writeFile(f.journal, JSON.stringify({ ...state, phase }));
   if (phase === 'accepted') await writeFile(join(f.config.installRoot, 'installation.json'), JSON.stringify({ current: oldVersion, previous: newVersion, databaseCompatibility: 3 }));
   const started = await f.run('start'); expect(started.code, started.stderr).toBe(0);
   const db = openDatabase(f.config.dataRoot); db.prepare('UPDATE maintenance SET active=0').run(); db.prepare('INSERT INTO notes(id,path) VALUES(?,?)').run('accepted', '00-Inbox/accepted.md'); db.close();
   const completed = await f.run('--profile', f.config.profileFile, 'rollback');
   expect(completed.code, completed.stderr).toBe(0);
   const expected = phase === 'accepted' ? oldVersion : newVersion;
   expect(JSON.parse(completed.stdout)).toMatchObject({ version: expected, dataPreserved: true, recovered: true });
   expect(await readlink(join(f.config.installRoot, 'current'))).toBe('releases/' + expected);
   const check = openDatabase(f.config.dataRoot); try { expect(check.prepare('SELECT id FROM notes ORDER BY id').all()).toEqual([{ id: 'accepted' }, { id: 'retained' }]); } finally { check.close(); }
   expect((await f.run('status')).code).toBe(0);
   // Once terminal, a separate new rollback remains an intentional code switch.
   const next = await f.run('rollback'); expect(next.code, next.stderr).toBe(0);
   expect(JSON.parse(next.stdout).version).toBe(phase === 'accepted' ? newVersion : oldVersion);
  } finally { await f.close(); }
 }, 60000);

 it.each(['kind', 'candidate'])('routes malformed pending %s to validation without executing transaction-selected code', async field => {
  const f = await fixture();
  try {
   await writeFile(f.triggerFile, 'daemon-reload'); expect((await f.run('rollback')).signal).toBe('SIGKILL');
   const state = JSON.parse(await readFile(f.journal, 'utf8'));
   state[field] = field === 'kind' ? 'unknown-manager' : '../unowned';
   const malformed = JSON.stringify(state); await writeFile(f.journal, malformed);
   const result = await f.run('rollback'); expect(result.code).toBe(1);
   expect(result.stderr).toMatch(/类型不正确|记录不完整/);
   expect(await readFile(f.journal, 'utf8')).toBe(malformed);
   expect(await readlink(join(f.config.installRoot, 'current'))).toBe('releases/' + oldVersion);
   const db = openDatabase(f.config.dataRoot); try { expect(db.prepare('SELECT active FROM maintenance').get()).toEqual({ active: 1 }); expect(db.prepare('SELECT id FROM notes').all()).toEqual([{ id: 'retained' }]); } finally { db.close(); }
  } finally { await f.close(); }
 }, 60000);

 it('refuses an unbound native installation even when invoked without launcher environment', async () => {
  const f = await fixture();
  try {
   await rm(join(f.config.installRoot, 'profile.path'));
   await expect(f.direct('--profile', f.config.profileFile, '--install-root', f.config.installRoot, 'rollback')).rejects.toThrow(/入口.*归属/);
   expect(await readFile(f.stateFile, 'utf8')).toBe('active');
   expect(existsSync(f.journal)).toBe(false);
  } finally { await f.close(); }
 }, 60000);

 it('refuses malformed manager provenance before changing the legacy wrapper or stopping', async () => {
  const f = await fixture();
  try {
   const provenance = join(f.config.installRoot, 'releases', newVersion, 'package.sha256');
   await rm(provenance); await writeFile(provenance, 'unqualified');
   const result = await f.run('rollback'); expect(result.code).toBe(1); expect(result.stderr).toMatch(/入口/);
   expect(await readFile(f.launcher, 'utf8')).toBe(f.wrapper);
   expect(await readFile(f.stateFile, 'utf8')).toBe('active');
   expect(existsSync(f.journal)).toBe(false);
  } finally { await f.close(); }
 }, 60000);

 it('refuses generation three to two rollback before bootstrap and service disruption', async () => {
  const f = await fixture();
  try {
   const unsupported = join(f.config.installRoot, 'releases/1.0.0-fixture'); await mkdir(unsupported);
   await writeFile(join(unsupported, 'release.json'), JSON.stringify({ version: '1.0.0-fixture', databaseCompatibility: 2 }));
   await writeFile(join(f.config.installRoot, 'installation.json'), JSON.stringify({ current: newVersion, previous: '1.0.0-fixture', databaseCompatibility: 3 }));
   const result = await f.run('rollback'); expect(result.code).toBe(1); expect(result.stderr).toMatch(/不支持普通代码回退/);
   expect(await readFile(f.launcher, 'utf8')).toBe(f.wrapper);
   expect(await readFile(f.stateFile, 'utf8')).toBe('active');
   expect(existsSync(f.journal)).toBe(false);
  } finally { await f.close(); }
 }, 60000);

 it('supports an installer-owned private launcher in the user-owned primary-group writable bin directory', async () => {
  const f = await fixture();
  try {
   await chmod(dirname(f.launcher), 0o775);
   expect((await lstat(f.launcher)).mode & 0o777).toBe(0o700);
   const result = await f.run('rollback');
   expect(result.code, result.stderr).toBe(0);
   expect(JSON.parse(result.stdout).version).toBe(oldVersion);
   expect((await lstat(dirname(f.launcher))).mode & 0o777).toBe(0o775);
   expect((await lstat(f.launcher)).mode & 0o777).toBe(0o700);
  } finally { await f.close(); }
 }, 60000);

 it('refuses a world-writable bin directory before touching its launcher or service', async () => {
  const f = await fixture();
  try {
   await chmod(dirname(f.launcher), 0o777);
   const result = await f.run('rollback'); expect(result.code).toBe(1); expect(result.stderr).toMatch(/入口/);
   expect(await readFile(f.launcher, 'utf8')).toBe(f.wrapper);
   expect(await readFile(f.stateFile, 'utf8')).toBe('active');
   expect(existsSync(f.journal)).toBe(false);
  } finally { await f.close(); }
 }, 60000);

 it.each(['unknown-body', 'symlink'])('refuses an unowned launcher before stopping a service: %s', async mode => {
  const f = await fixture();
  try {
   if (mode === 'unknown-body') await writeFile(f.launcher, f.wrapper + '# user customization\n');
   else { await copyFile(f.launcher, f.launcher + '.other'); await rm(f.launcher); await symlink(f.launcher + '.other', f.launcher); }
   const before = await readFile(f.launcher, 'utf8');
   const result = await f.run('rollback');
   expect(result.code).not.toBe(0); expect(result.stderr).toMatch(/入口|管理命令/);
   expect(await readFile(f.launcher, 'utf8')).toBe(before);
   expect((await lstat(f.launcher)).isSymbolicLink()).toBe(mode === 'symlink');
   expect(await readlink(join(f.config.installRoot, 'current'))).toBe('releases/' + newVersion);
   expect(await readFile(f.stateFile, 'utf8')).toBe('active');
   const db = openDatabase(f.config.dataRoot); try { expect(db.prepare('SELECT active FROM maintenance').get()).toEqual({ active: 0 }); } finally { db.close(); }
  } finally { await f.close(); }
 }, 60000);
});
