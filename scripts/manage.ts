import { parseArgs } from 'node:util';
import { createInterface } from 'node:readline/promises';
import { Writable } from 'node:stream';
import { createServer } from 'node:net';
import { mkdirSync, writeFileSync, readFileSync, existsSync, renameSync, lstatSync, unlinkSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { loadHostConfig, applicationRoot } from '../server/platform/config.js';
import { openDatabase } from '../server/db.js';
import { initializeOwner, resetOwnerPassword } from '../server/auth.js';
import { createApp } from '../server/app.js';

const { values, positionals } = parseArgs({ allowPositionals: true, options: {
  profile: { type: 'string' }, 'data-root': { type: 'string' }, origin: { type: 'string' },
  port: { type: 'string' }, host: { type: 'string' }, 'allow-root': { type: 'string', multiple: true },
  'no-service': { type: 'boolean', default: false }, destination: { type: 'string' },
  source: { type: 'string' }, version: { type: 'string' },
} });
const command = positionals[0] || 'status';
const configDir = join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'doo-know');
const profileFile = resolve(values.profile || process.env.DOOKNOW_PROFILE || join(configDir, 'profile.json'));
function atomicJson(path: string, value: unknown) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, JSON.stringify(value, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
  renameSync(temporary, path);
}
async function promptAccount(reset = false) {
  if (!process.stdin.isTTY) throw new Error('账号初始化需要本机终端，请运行 dooknow install；密码不能通过命令参数传入');
  let muted = false;
  const output = new Writable({ write(chunk, _encoding, next) { if (!muted) process.stdout.write(chunk); next(); } });
  const rl = createInterface({ input: process.stdin, output, terminal: true });
  const password = async (prompt: string) => {
    process.stdout.write(prompt); muted = true;
    try { return await rl.question(''); }
    finally { muted = false; process.stdout.write('\n'); }
  };
  try {
    const username = reset ? '' : await rl.question('初始用户名（3–30 个字母、数字、点或下划线）：');
    const first = await password('密码（至少12位，输入隐藏）：');
    if (first !== await password('再次输入密码：')) throw new Error('两次密码不同');
    return { username, password: first };
  } finally { rl.close(); }
}
function systemctl(args: string[]) { return execFileSync('systemctl', ['--user', ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }); }
async function availablePort(host: string, port: number) {
  const probe = createServer();
  await new Promise<void>((yes, no) => { probe.once('error', no); probe.listen(port, host, () => probe.close(() => yes())); });
}
async function install() {
  const existing = existsSync(profileFile) ? JSON.parse(readFileSync(profileFile, 'utf8')) : undefined;
  const profile = existing || {
    dataRoot: resolve(values['data-root'] || join(process.env.XDG_DATA_HOME || join(homedir(), '.local/share'), 'doo-know/data')),
    secretFile: join(dirname(profileFile), 'secrets/auth.key'),
    origin: values.origin || `http://127.0.0.1:${values.port || 5173}`,
    port: Number(values.port || 5173), host: values.host || '127.0.0.1',
    allowedKnowledgeBases: values['allow-root'] || [homedir()],
  };
  if (existing && values['data-root'] && resolve(values['data-root']) !== resolve(existing.dataRoot))
    throw new Error('拒绝改变现有数据目录；独立安装请使用新的 --profile');
  if (!existsSync(profile.secretFile)) {
    if (existsSync(join(profile.dataRoot, 'app.sqlite'))) throw new Error('已有数据库的认证密钥缺失，请恢复密钥，不能重新生成');
    mkdirSync(dirname(profile.secretFile), { recursive: true, mode: 0o700 });
    writeFileSync(profile.secretFile, randomBytes(48).toString('base64url'), { mode: 0o600, flag: 'wx' });
  }
  if (!existing) atomicJson(profileFile, profile);
  const config = loadHostConfig({ profileFile });
  const db = openDatabase(config.dataRoot);
  let hasOwner = false;
  try {
    hasOwner = !!db.prepare("SELECT 1 FROM sqlite_master WHERE name='user'").get()
      && !!db.prepare('SELECT id FROM user LIMIT 1').get();
    if (!hasOwner && (db.prepare('SELECT 1 FROM notes LIMIT 1').get() || db.prepare("SELECT 1 FROM index_meta WHERE key='root_identity'").get()))
      throw new Error('已有知识库数据但账号缺失，请恢复原账号');
  } finally { db.close(); }
  if (!hasOwner) {
    await availablePort(config.host!, config.port!);
    const input = await promptAccount();
    await initializeOwner(config, input.username, input.password);
    console.log('初始账号已创建。');
  } else console.log('账号已存在，保留原有账号、密钥与配置。');
  if (!values['no-service']) {
    const unitDir = join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'systemd/user');
    mkdirSync(unitDir, { recursive: true, mode: 0o700 });
    const quote = (s: string) => '"' + s.replaceAll('\\', '\\\\').replaceAll('"', '\\"').replaceAll('%', '%%') + '"';
    const root = applicationRoot();
    writeFileSync(join(unitDir, 'doo-know.service'), `[Unit]\nDescription=DooKnow personal knowledge platform\nAfter=network.target\n\n[Service]\nType=simple\nWorkingDirectory=${quote(root)}\nEnvironment=${quote('DOOKNOW_PROFILE=' + profileFile)}\nExecStart=${quote(process.execPath)} ${quote(join(root, 'dist/server/scripts/manage.js'))} serve\nRestart=on-failure\nRestartSec=3\nUMask=0077\nNoNewPrivileges=true\n\n[Install]\nWantedBy=default.target\n`, { mode: 0o600 });
    systemctl(['daemon-reload']); systemctl(['enable', '--now', 'doo-know.service']);
    const linger = execFileSync('loginctl', ['show-user', String(process.getuid!()), '--property=Linger', '--value'], { encoding: 'utf8' }).trim();
    if (linger !== 'yes') console.log('用户服务已启用；无人登录时常驻需管理员启用 linger。');
  }
  console.log(`DooKnow：${config.origin}\n登录后选择服务器知识库目录。\n管理：dooknow status / start / stop / restart / doctor`);
}
async function main() {
  if (command === 'install') return install();
  if (['start', 'stop', 'restart'].includes(command)) { systemctl([command, 'doo-know.service']); return; }
  const config = loadHostConfig({ profileFile });
  if (command === 'serve') {
    const app = await createApp(config);
    await app.listen({ host: config.host, port: config.port });
    console.log(`DooKnow: ${config.origin}`);
    for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, async () => { await app.close(); process.exit(0); });
    return;
  }
  if (command === 'reset-password') {
    const input = await promptAccount(true); await resetOwnerPassword(config, input.password);
    console.log('密码已重置，旧会话已撤销。'); return;
  }
  if (command === 'status' || command === 'doctor') {
    let health = 'unreachable';
    try { const r = await fetch(`http://${config.host}:${config.port}/healthz`, { signal: AbortSignal.timeout(3000) }); health = r.ok ? 'alive' : 'unhealthy'; } catch {}
    console.log(JSON.stringify({ version: '1.0.0-platform', health, origin: config.origin,
      profileFile, platform: process.platform, arch: process.arch, node: process.version }, null, 2)); return;
  }
  throw new Error('未知命令：' + command);
}
main().catch((e: Error) => { console.error(e.message); process.exitCode = 1; });
