import { parseArgs } from 'node:util';
import { createInterface } from 'node:readline/promises';
import { Writable } from 'node:stream';
import { createServer } from 'node:net';
import {
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
  renameSync,
  lstatSync,
  unlinkSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { randomBytes, createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { loadHostConfig, applicationRoot } from '../apps/server/platform/config.js';
import { openDatabase } from '../packages/core/db.js';
import { initializeOwner, resetOwnerPassword } from '../apps/server/auth.js';
import { createApp } from '../apps/server/app.js';
import { createAuth } from '../apps/server/auth.js';
import {
  acquireInstance,
  readInstance,
  activeDatabaseProcesses,
} from '../apps/server/platform/instance.js';
import { releaseInfo } from '../apps/server/platform/release.js';
import {
  systemctl,
  unitName,
  serviceActive,
  assertServiceOwnership,
  writeService,
  withQuiesced,
  waitHealthy,
  healthURL,
} from '../apps/server/platform/service.js';
import { createPlatformBackup, restorePlatformBackup } from '../apps/server/platform/backups.js';
import {
  managementLock,
  updatePlatform,
  rollbackPlatform,
} from '../apps/server/platform/updates.js';
import { platformSettings } from '../apps/server/platform/settings.js';
import { pluginHost } from '../apps/server/plugins/host.js';
import { satisfies } from 'semver';
import { HOST_PLUGIN_API } from '../packages/plugin-contracts/index.js';
import { rmSync } from 'node:fs';
import { privateFile } from '../packages/core/agent/config.js';
import Database from 'better-sqlite3';
import { assertDistributionOutsideKnowledge } from '../apps/server/platform/distribution.js';

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    profile: { type: 'string' },
    'data-root': { type: 'string' },
    origin: { type: 'string' },
    port: { type: 'string' },
    host: { type: 'string' },
    'allow-root': { type: 'string', multiple: true },
    'no-service': { type: 'boolean', default: false },
    destination: { type: 'string' },
    source: { type: 'string' },
    version: { type: 'string' },
    'knowledge-root': { type: 'string' },
    'key-file': { type: 'string' },
    'plugin-root': { type: 'string' },
    'service-name': { type: 'string' },
    'install-root': { type: 'string' },
    'auth-secret-file': { type: 'string' },
    'github-repository': { type: 'string' },
    'github-token-file': { type: 'string' },
    help: { type: 'boolean' },
  },
});
const command = positionals[0] || 'status';
const configDir = join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'doo-know');
const profileFile = resolve(
  values.profile || process.env.DOOKNOW_PROFILE || join(configDir, 'profile.json'),
);
function atomicJson(path: string, value: unknown) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, JSON.stringify(value, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
  renameSync(temporary, path);
}
function configureDistribution(profile: Record<string, any>) {
  if (!values['github-repository'] && !values['github-token-file']) return false;
  if (!values['github-repository'] || !values['github-token-file'] ||
      !/^[A-Za-z0-9-]+\/[A-Za-z0-9_.-]+$/.test(values['github-repository']))
    throw Error('GitHub 分发需要仓库名与私有凭据文件');
  if (profile.distribution && profile.distribution.repository.toLowerCase() !== values['github-repository'].toLowerCase())
    throw Error('拒绝改变现有 GitHub 分发仓库');
  const tokenFile = resolve(values['github-token-file']);
  try {
    if (lstatSync(tokenFile).uid !== process.getuid?.() || !/^[A-Za-z0-9_-]{20,4096}$/.test(privateFile(tokenFile, 8192).trim())) throw Error();
  } catch { throw Error('GitHub 下载凭据不可用或权限不正确'); }
  const distribution = { repository: values['github-repository'], tokenFile };
  const roots = [profile.knowledgeRoot, process.env.KNOWLEDGE_ROOT].filter(Boolean) as string[];
  if (profile.dataRoot && existsSync(join(profile.dataRoot, 'app.sqlite'))) {
    const db = new Database(join(profile.dataRoot, 'app.sqlite'), { readonly: true, fileMustExist: true });
    try {
      if (db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='platform_settings'").get()) {
        const binding = db.prepare('SELECT knowledge_root FROM platform_settings WHERE id=1').get() as any;
        if (binding?.knowledge_root) roots.push(binding.knowledge_root);
      }
      if (db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='index_meta'").get()) {
        const identity = db.prepare("SELECT value FROM index_meta WHERE key='root_identity'").get() as any;
        if (identity) { const path = JSON.parse(identity.value).path; if (typeof path !== 'string') throw Error('INVALID_ROOT_IDENTITY'); roots.push(path); }
      }
    } finally { db.close(); }
  }
  for (const root of roots) assertDistributionOutsideKnowledge({ distribution }, root);
  profile.distribution = distribution;
  return true;
}
async function promptAccount(reset = false) {
  if (!process.stdin.isTTY)
    throw new Error('账号初始化需要本机终端，请运行 dooknow install；密码不能通过命令参数传入');
  let muted = false;
  const output = new Writable({
    write(chunk, _encoding, next) {
      if (!muted) process.stdout.write(chunk);
      next();
    },
  });
  const rl = createInterface({ input: process.stdin, output, terminal: true });
  const password = async (prompt: string) => {
    process.stdout.write(prompt);
    muted = true;
    try {
      return await rl.question('');
    } finally {
      muted = false;
      process.stdout.write('\n');
    }
  };
  try {
    const username = reset
      ? ''
      : await rl.question('初始用户名（3–30 个字母、数字、点或下划线）：');
    const first = await password('密码（至少12位，输入隐藏）：');
    if (first !== (await password('再次输入密码：'))) throw new Error('两次密码不同');
    return { username, password: first };
  } finally {
    rl.close();
  }
}
async function availablePort(host: string, port: number) {
  const probe = createServer();
  await new Promise<void>((yes, no) => {
    probe.once('error', no);
    probe.listen(port, host, () => probe.close(() => yes()));
  });
}
async function install() {
  const existing = existsSync(profileFile)
    ? JSON.parse(readFileSync(profileFile, 'utf8'))
    : undefined;
  const profile = existing || {
    dataRoot: resolve(
      values['data-root'] ||
        join(process.env.XDG_DATA_HOME || join(homedir(), '.local/share'), 'doo-know/data'),
    ),
    secretFile: resolve(
      values['auth-secret-file'] || join(dirname(profileFile), 'secrets/auth.key'),
    ),
    installRoot: values['install-root'] || process.env.DOOKNOW_INSTALL_ROOT,
    serviceName: values['service-name'] || 'doo-know.service',
    serviceManaged: !values['no-service'],
    origin: values.origin || `http://127.0.0.1:${values.port || 5173}`,
    port: Number(values.port || 5173),
    host: values.host || '127.0.0.1',
    allowedKnowledgeBases: values['allow-root'] || [homedir()],
  };
  if (
    existing &&
    values['data-root'] &&
    resolve(values['data-root']) !== resolve(existing.dataRoot)
  )
    throw new Error('拒绝改变现有数据目录；独立安装请使用新的 --profile');
  if (!existsSync(profile.secretFile)) {
    if (existsSync(join(profile.dataRoot, 'app.sqlite')))
      throw new Error('已有数据库的认证密钥缺失，请恢复密钥，不能重新生成');
    mkdirSync(dirname(profile.secretFile), { recursive: true, mode: 0o700 });
    writeFileSync(profile.secretFile, randomBytes(48).toString('base64url'), {
      mode: 0o600,
      flag: 'wx',
    });
  }
  const distributionChanged = configureDistribution(profile);
  if (!existing || distributionChanged) atomicJson(profileFile, profile);
  const config = effectiveConfig();
  const instance = readInstance(config.dataRoot);
  if (!instance) await availablePort(config.host!, config.port!);
  if (!values['no-service']) systemctl(['show-environment']);
  const db = openDatabase(config.dataRoot);
  let hasOwner = false;
  try {
    hasOwner =
      !!db.prepare("SELECT 1 FROM sqlite_master WHERE name='user'").get() &&
      !!db.prepare('SELECT id FROM user LIMIT 1').get();
    if (
      !hasOwner &&
      (db.prepare('SELECT 1 FROM notes LIMIT 1').get() ||
        db.prepare("SELECT 1 FROM index_meta WHERE key='root_identity'").get())
    )
      throw new Error('已有知识库数据但账号缺失，请恢复原账号');
  } finally {
    db.close();
  }
  if (!hasOwner) {
    const input = await promptAccount();
    await initializeOwner(config, input.username, input.password);
    console.log('初始账号已创建。');
  } else console.log('账号已存在，保留原有账号、密钥与配置。');
  if (!values['no-service']) {
    writeService(config, applicationRoot(), process.execPath);
    systemctl(['enable', unitName(config)]);
    systemctl([instance ? 'restart' : 'start', unitName(config)]);
    await waitHealthy(config, releaseInfo().version);
    if (existing)
      atomicJson(profileFile, {
        ...existing,
        serviceManaged: true,
        serviceName: config.serviceName || 'doo-know.service',
        ...(config.installRoot ? { installRoot: config.installRoot } : {}),
      });
    let linger = 'unknown';
    try {
      linger = execFileSync(
        'loginctl',
        ['show-user', String(process.getuid!()), '--property=Linger', '--value'],
        { encoding: 'utf8' },
      ).trim();
    } catch {}
    if (linger !== 'yes') console.log('用户服务已启用；无人登录时常驻需管理员启用 linger。');
  }
  console.log(
    `DooKnow：${config.origin}\n登录后选择服务器知识库目录。\n管理：dooknow status / start / stop / restart / doctor`,
  );
}
function effectiveConfig() {
  return loadHostConfig({
    profileFile,
    ...(values['data-root'] ? { dataRoot: resolve(values['data-root']) } : {}),
    ...(values['service-name'] ? { serviceName: values['service-name'] } : {}),
    ...(values['install-root'] || process.env.DOOKNOW_INSTALL_ROOT
      ? { installRoot: resolve(values['install-root'] || process.env.DOOKNOW_INSTALL_ROOT!) }
      : {}),
    ...(values['no-service'] ? { serviceManaged: false } : {}),
  });
}
async function main() {
  if (values.help) {
    console.log(
      'dooknow install | start | stop | restart | status | doctor | update | rollback | backup | restore | reset-password | uninstall\n备份：backup --destination <文件> [--key-file <私钥文件>]\n恢复到空目录：restore --source <备份> --key-file <私钥文件> --profile <新配置> --data-root <空目录> --knowledge-root <空目录>\n更新：update [--source <受控发行源>] [--version <版本>]',
    );
    return;
  }
  if (command === 'restore') {
    if (!values.source || !values['key-file'] || !values['data-root'])
      throw Error('恢复需要 --source、--key-file、--data-root 和新的 --profile');
    const result = await restorePlatformBackup({
      source: values.source,
      keyFile: values['key-file'],
      target: {
        dataRoot: values['data-root'],
        knowledgeRoot: values['knowledge-root'],
        profileFile,
        pluginRoot: values['plugin-root'],
      },
      origin: values.origin,
    });
    console.log(JSON.stringify(result, null, 2));
    console.log(
      '已恢复到新目录；旧会话、分享及远程授权已撤销。运行 install 接管此配置后重新启用插件。',
    );
    return;
  }
  if (command === 'install') return install();
  if (command === 'update' && (values['github-repository'] || values['github-token-file'])) {
    const profile = JSON.parse(readFileSync(profileFile, 'utf8'));
    if (configureDistribution(profile)) atomicJson(profileFile, profile);
  }
  const config = effectiveConfig(),
    version = releaseInfo().version;
  if (command === 'serve') {
    const release = acquireInstance(config, version);
    let app: Awaited<ReturnType<typeof createApp>> | undefined;
    try {
      app = await createApp(config);
      await app.listen({ host: config.host, port: config.port });
    } catch (e) {
      await app?.close();
      release();
      throw e;
    }
    console.log(`DooKnow ${version}: ${config.origin}`);
    let closing = false;
    for (const signal of ['SIGINT', 'SIGTERM'] as const)
      process.once(signal, async () => {
        if (closing) return;
        closing = true;
        try {
          await app!.close();
          release();
          process.exit(0);
        } catch {
          process.exit(1);
        }
      });
    return;
  }
  if (['self-check', 'migrate'].includes(command)) {
    if (command === 'self-check' && !values['data-root']) throw Error('自检必须使用独立数据库副本');
    if (
      command === 'migrate' &&
      (readInstance(config.dataRoot) || activeDatabaseProcesses(config.dataRoot).length)
    )
      throw Error('迁移前必须停止所有数据进程');
    const db = openDatabase(config.dataRoot);
    try {
      await createAuth(config, db);
      platformSettings(config, db).configured();
      pluginHost(config, db);
      for (const row of db
        .prepare('SELECT manifest_json FROM platform_plugins WHERE installed=1')
        .all() as any[]) {
        const manifest = JSON.parse(row.manifest_json);
        if (!satisfies(HOST_PLUGIN_API, manifest.apiVersion))
          throw Error('已安装插件与此宿主版本不兼容');
      }
      if (
        db.pragma('integrity_check', { simple: true }) !== 'ok' ||
        (db.pragma('foreign_key_check') as any[]).length
      )
        throw Error('数据库一致性检查失败');
      console.log(
        JSON.stringify({
          version,
          databaseCompatibility: releaseInfo().databaseCompatibility,
          check: 'ok',
        }),
      );
    } finally {
      db.close();
    }
    return;
  }
  if (['start', 'stop', 'restart'].includes(command)) {
    assertServiceOwnership(config);
    const instance = readInstance(config.dataRoot);
    if (instance && instance.profile_file !== profileFile) throw Error('服务属于另一配置');
    systemctl([command, unitName(config)]);
    if (command !== 'stop') await waitHealthy(config, version);
    return;
  }
  if (command === 'update') {
    console.log(
      JSON.stringify(
        await updatePlatform(config, { source: values.source, version: values.version }),
        null,
        2,
      ),
    );
    return;
  }
  if (command === 'rollback') {
    console.log(JSON.stringify(await rollbackPlatform(config), null, 2));
    return;
  }
  if (command === 'backup') {
    if (!values.destination) throw Error('备份需要 --destination <文件>');
    const result = await managementLock(config, () =>
      withQuiesced(config, () =>
        createPlatformBackup(config, {
          destination: values.destination!,
          keyFile: values['key-file'],
        }),
      ),
    );
    console.log(JSON.stringify(result, null, 2));
    console.log('恢复私钥须另行受控保存；备份不包含该私钥。');
    return;
  }
  if (command === 'reset-password') {
    const input = await promptAccount(true);
    await managementLock(config, () =>
      withQuiesced(config, () => resetOwnerPassword(config, input.password)),
    );
    console.log('密码已重置，旧会话及远程授权已撤销。');
    return;
  }
  if (command === 'uninstall') {
    await managementLock(config, async () => {
      const unit = join(
        process.env.XDG_CONFIG_HOME || join(homedir(), '.config'),
        'systemd/user',
        unitName(config),
      );
      const ownsUnit = existsSync(unit);
      if (ownsUnit) assertServiceOwnership(config);
      const instance = readInstance(config.dataRoot);
      if (instance && instance.profile_file !== profileFile) throw Error('数据库属于另一配置');
      if (activeDatabaseProcesses(config.dataRoot).some((p) => p.pid !== instance?.pid))
        throw Error('请先停止独立的数据进程再卸载');
      if (instance && !ownsUnit) throw Error('请先正常停止前台应用再卸载');
      if (ownsUnit) {
        if (instance || serviceActive(config)) systemctl(['stop', unitName(config)]);
        systemctl(['disable', unitName(config)]);
        unlinkSync(unit);
        systemctl(['daemon-reload']);
      }
      if (config.installRoot) {
        rmSync(join(config.installRoot, 'current'), { force: true });
        rmSync(join(config.installRoot, 'releases'), { recursive: true, force: true });
      }
      const launcher = join(
        process.env.DOOKNOW_BIN_DIR || join(homedir(), '.local/bin'),
        'dooknow',
      );
      if (existsSync(launcher) && config.installRoot) {
        const lines = readFileSync(launcher, 'utf8').split(/\r?\n/),
          id = createHash('sha256').update(config.installRoot).digest('hex');
        const legacySafe =
          /^[A-Za-z0-9_./@+-]+$/.test(config.installRoot) &&
          lines.some(
            (line) =>
              line === 'export DOOKNOW_INSTALL_ROOT=' + config.installRoot ||
              line === 'DOOKNOW_INSTALL_ROOT=' + config.installRoot,
          );
        if (lines.includes('# DooKnow install: ' + id) || legacySafe) unlinkSync(launcher);
      }
    });
    console.log('已卸载程序与用户服务；知识库、数据、插件、模型、配置及备份均已保留。');
    return;
  }
  if (command === 'status' || command === 'doctor') {
    let health: any = { status: 'unreachable' };
    try {
      const response = await fetch(healthURL(config) + '/healthz', {
        signal: AbortSignal.timeout(3000),
      });
      health = await response.json();
    } catch {}
    console.log(
      JSON.stringify(
        {
          installedVersion: version,
          runningVersion: readInstance(config.dataRoot)?.version,
          health,
          origin: config.origin,
          profileFile,
          dataRoot: config.dataRoot,
          platform: process.platform,
          arch: process.arch,
          node: process.version,
          ...(command === 'doctor'
            ? {
                glibc: (process.report.getReport() as any).header.glibcVersionRuntime,
                service: unitName(config),
                serviceActive: serviceActive(config),
                databaseProcesses: activeDatabaseProcesses(config.dataRoot),
              }
            : {}),
        },
        null,
        2,
      ),
    );
    return;
  }
  throw new Error('未知命令：' + command);
}
main().catch((e: Error) => {
  console.error(e.message);
  process.exitCode = 1;
});
