import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { homedir } from 'node:os';
import type { HostConfig } from '../../../shared/platform-contracts.js';
import { activeDatabaseProcesses, readInstance } from './instance.js';
import { openDatabase } from '../../../packages/core/db.js';
export function unitName(config: HostConfig) {
  const name = config.serviceName || 'doo-know.service';
  if (!/^[a-zA-Z0-9_.@-]+\.service$/.test(name)) throw Error('用户服务名称不正确');
  return name;
}
export function systemctl(args: string[]) {
  return execFileSync('systemctl', ['--user', ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}
export function assertServiceOwnership(config: HostConfig) {
  const file = join(
    process.env.XDG_CONFIG_HOME || join(homedir(), '.config'),
    'systemd/user',
    unitName(config),
  );
  if (
    !existsSync(file) ||
    !readFileSync(file, 'utf8').includes('# DooKnow profile: ' + config.profileFile)
  )
    throw Error('用户服务不属于此配置，拒绝控制');
}
export function serviceActive(config: HostConfig) {
  try {
    const active = systemctl(['is-active', unitName(config)]).trim() === 'active';
    if (active) assertServiceOwnership(config);
    return active;
  } catch (e) {
    if ((e as Error).message === '用户服务不属于此配置，拒绝控制') throw e;
    return false;
  }
}
export function writeService(config: HostConfig, root: string, node: string) {
  const quote = (value: string) => {
    if (/[\x00-\x1f]/.test(value)) throw Error('用户服务路径不能包含控制字符');
    return (
      '"' +
      value
        .replaceAll('\\', '\\\\')
        .replaceAll('"', '\\"')
        .replaceAll('%', '%%')
        .replaceAll('$', '$$') +
      '"'
    );
  };
  const unitDir = join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'systemd/user'),
    name = unitName(config);
  mkdirSync(unitDir, { recursive: true, mode: 0o700 });
  const file = join(unitDir, name),
    marker = '# DooKnow profile: ' + config.profileFile;
  if (existsSync(file) && !readFileSync(file, 'utf8').includes(marker))
    throw Error('用户服务已属于其他安装，拒绝覆盖；请指定独立的 --service-name');
  writeFileSync(
    file,
    `${marker}\n[Unit]\nDescription=DooKnow personal knowledge platform\nAfter=network.target\n\n[Service]\nType=simple\nWorkingDirectory=/\nEnvironment=${quote('DOOKNOW_PROFILE=' + config.profileFile)}\nEnvironment=${quote('DOOKNOW_INSTALL_ROOT=' + config.installRoot)}\nExecStart=${quote(node)} ${quote(join(root, 'dist/server/scripts/manage.js'))} serve\nRestart=on-failure\nRestartSec=3\nTimeoutStopSec=120\nUMask=0077\nNoNewPrivileges=true\n\n[Install]\nWantedBy=default.target\n`,
    { mode: 0o600 },
  );
  systemctl(['daemon-reload']);
  return file;
}
export async function withQuiesced<T>(
  config: HostConfig,
  work: () => Promise<T>,
  options: { resume?: boolean; keepMaintenanceOnError?: boolean } = {},
) {
  const instance = readInstance(config.dataRoot),
    others = activeDatabaseProcesses(config.dataRoot).filter((p) => p.pid !== instance?.pid);
  if (others.length)
    throw Error(
      '存在独立的数据进程；请先停止相关 worker 后重试：' +
        [...new Set(others.map((p) => p.role + ':' + p.pid))].join(', '),
    );
  let restart = false,
    previous = 0,
    maintenanceSet = false,
    succeeded = false;
  try {
    if (!instance && serviceActive(config))
      throw Error('服务正在启动或来自旧版本；请先正常停止后重试');
    if (instance) {
      assertServiceOwnership(config);
      if (instance.profile_file !== resolve(config.profileFile || ''))
        throw Error('数据库由另一个配置的服务使用，拒绝停机');
      let main = 0;
      try {
        main = Number(
          systemctl(['show', unitName(config), '--property=MainPID', '--value']).trim(),
        );
      } catch {}
      if (main !== instance.pid) throw Error('前台运行中的应用需要先正常停止，再执行备份或升级');
      systemctl(['stop', unitName(config)]);
      restart = true;
    }
    const db = openDatabase(config.dataRoot);
    try {
      previous = (db.prepare('SELECT active FROM maintenance WHERE id=1').get() as any).active;
      if (previous) throw Error('工作区已处于维护状态，请先核对未完成操作');
      db.prepare('UPDATE maintenance SET active=1 WHERE id=1').run();
      maintenanceSet = true;
    } finally {
      db.close();
    }
    const result = await work();
    succeeded = true;
    return result;
  } finally {
    let cleanupError: unknown;
    const keep = !succeeded && options.keepMaintenanceOnError;
    try {
      if (maintenanceSet && !keep) {
        const current = openDatabase(config.dataRoot);
        try {
          current.prepare('UPDATE maintenance SET active=? WHERE id=1').run(previous);
        } finally {
          current.close();
        }
      }
    } catch (e) {
      cleanupError = e;
    }
    try {
      if (restart && options.resume !== false && !keep) systemctl(['start', unitName(config)]);
    } catch (e) {
      cleanupError ||= e;
    }
    if (cleanupError) throw cleanupError;
  }
}
export function healthURL(config: HostConfig) {
  const host =
    !config.host || config.host === '0.0.0.0'
      ? '127.0.0.1'
      : config.host === '::'
        ? '::1'
        : config.host;
  return `http://${host.includes(':') ? '[' + host + ']' : host}:${config.port}`;
}
export async function waitHealthy(config: HostConfig, version: string) {
  const until = Date.now() + 30000;
  let last = 'UNREACHABLE';
  do {
    try {
      const response = await fetch(healthURL(config) + '/healthz', {
          signal: AbortSignal.timeout(2000),
        }),
        body = await response.json();
      last = body.phase || body.status;
      if (
        response.ok &&
        body.version === version &&
        ['ready', 'setup_required'].includes(body.phase)
      )
        return body;
    } catch {}
    await new Promise((r) => setTimeout(r, 200));
  } while (Date.now() < until);
  throw Error('服务健康检查失败：' + last + '；未恢复写入');
}
