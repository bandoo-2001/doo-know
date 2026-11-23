import { execFileSync } from 'node:child_process';
import {
  existsSync,
  readFileSync,
  writeSync,
  mkdirSync,
  lstatSync,
  realpathSync,
  openSync,
  closeSync,
  ftruncateSync,
  fchmodSync,
  constants,
} from 'node:fs';
import { join, dirname, resolve, isAbsolute } from 'node:path';
import { homedir } from 'node:os';
import type { HostConfig, PlatformStatus } from '../../../shared/platform-contracts.js';
import { activeDatabaseProcesses, readInstance } from './instance.js';
import Database from 'better-sqlite3';
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
const ownershipError = '用户服务不属于此配置，拒绝控制';
function configuredUnitFile(config: HostConfig) {
  return resolve(
    process.env.XDG_CONFIG_HOME || join(homedir(), '.config'),
    'systemd/user',
    unitName(config),
  );
}
function unitEntryExists(file: string) {
  try {
    lstatSync(file);
    return true;
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw cause;
  }
}
function assertMarkedUnit(config: HostConfig, file: string) {
  if (!config.profileFile) throw Error(ownershipError);
  try {
    if (
      !readFileSync(file, 'utf8')
        .split(/\r?\n/)
        .includes('# DooKnow profile: ' + config.profileFile)
    )
      throw Error(ownershipError);
    return realpathSync(file);
  } catch {
    throw Error(ownershipError);
  }
}
/** Query the running manager, whose unit search path may differ from this CLI's XDG environment. */
function loadedUnitFile(config: HostConfig) {
  let output: string;
  try {
    output = systemctl([
      'show',
      unitName(config),
      '--property=LoadState',
      '--property=FragmentPath',
      '--all',
    ]);
  } catch (cause) {
    // systemctl can return a non-zero status for a missing unit while still
    // supplying its machine-readable LoadState. Other failures are not absence.
    const stdout = (cause as { stdout?: string | Buffer }).stdout;
    output = stdout?.toString() || '';
    if (!output.split(/\r?\n/).includes('LoadState=not-found'))
      throw Error('无法核对用户服务信息，拒绝控制');
  }
  const fields = new Map<string, string>();
  for (const line of output.split(/\r?\n/).filter(Boolean)) {
    const separator = line.indexOf('='),
      key = line.slice(0, separator);
    if (separator < 1 || !['LoadState', 'FragmentPath'].includes(key) || fields.has(key))
      throw Error('无法核对用户服务信息，拒绝控制');
    fields.set(key, line.slice(separator + 1));
  }
  const state = fields.get('LoadState'),
    file = fields.get('FragmentPath');
  if (state === 'not-found' && file === '') return;
  if (state !== 'loaded' || !file || !isAbsolute(file))
    throw Error('无法核对用户服务信息，拒绝控制');
  return file;
}
export function assertServiceOwnership(config: HostConfig) {
  const configured = configuredUnitFile(config);
  // Also guard the CLI path: uninstall must never unlink a foreign local file,
  // even if the manager currently resolves the name to a different owned unit.
  if (unitEntryExists(configured)) assertMarkedUnit(config, configured);
  const loaded = loadedUnitFile(config);
  if (!loaded) throw Error(ownershipError);
  return assertMarkedUnit(config, loaded);
}
export function serviceActive(config: HostConfig) {
  let active: boolean;
  try {
    active = systemctl(['is-active', unitName(config)]).trim() === 'active';
  } catch {
    return false;
  }
  if (active) assertServiceOwnership(config);
  return active;
}
export function writeService(config: HostConfig, root: string, node: string) {
  if (!config.profileFile) throw Error(ownershipError);
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
  const configured = configuredUnitFile(config),
    marker = '# DooKnow profile: ' + config.profileFile;
  if (
    unitEntryExists(configured) &&
    !readFileSync(configured, 'utf8').split(/\r?\n/).includes(marker)
  )
    throw Error('用户服务已属于其他安装，拒绝覆盖；请指定独立的 --service-name');
  const loaded = loadedUnitFile(config);
  const file = loaded ? assertMarkedUnit(config, loaded) : configured;
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const source = `${marker}\n[Unit]\nDescription=DooKnow personal knowledge platform\nAfter=network.target\n\n[Service]\nType=simple\nWorkingDirectory=/\nEnvironment=${quote('DOOKNOW_PROFILE=' + config.profileFile)}\nEnvironment=${quote('DOOKNOW_INSTALL_ROOT=' + config.installRoot)}\nExecStart=${quote(node)} ${quote(join(root, 'dist/server/scripts/manage.js'))} serve\nRestart=on-failure\nRestartSec=3\nTimeoutStopSec=120\nUMask=0077\nNoNewPrivileges=true\n\n[Install]\nWantedBy=default.target\n`;
  const exists = unitEntryExists(file);
  // New installations may race for the same name. Never truncate a file that
  // appeared after the ownership check, or follow a replacement symlink.
  const descriptor = openSync(
    file,
    exists
      ? constants.O_RDWR | constants.O_NOFOLLOW
      : constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
    0o600,
  );
  try {
    if (exists && !readFileSync(descriptor, 'utf8').split(/\r?\n/).includes(marker))
      throw Error(ownershipError);
    if (exists) ftruncateSync(descriptor, 0);
    const bytes = Buffer.from(source);
    for (let offset = 0; offset < bytes.length; ) {
      const written = writeSync(descriptor, bytes, offset, bytes.length - offset, offset);
      if (!written) throw Error('用户服务文件未完整写入');
      offset += written;
    }
    fchmodSync(descriptor, 0o600);
  } finally {
    closeSync(descriptor);
  }
  let linkError: unknown;
  // Register an absolute external unit before enable/start. Never use --force:
  // a conflicting manager-side unit belongs to its existing installation.
  try {
    systemctl(['link', file]);
  } catch (cause) {
    linkError = cause;
  }
  systemctl(['daemon-reload']);
  const effective = loadedUnitFile(config);
  if (!effective || assertMarkedUnit(config, effective) !== realpathSync(file)) {
    if (linkError) throw linkError;
    throw Error('用户服务未正确注册，拒绝继续安装');
  }
  return file;
}
export function assertManagedDatabaseOwnership(config: HostConfig) {
  const instance = readInstance(config.dataRoot),
    others = activeDatabaseProcesses(config.dataRoot).filter((p) => p.pid !== instance?.pid);
  if (others.length)
    throw Error(
      '存在独立的数据进程；请先停止相关 worker 后重试：' +
        [...new Set(others.map((p) => p.role + ':' + p.pid))].join(', '),
    );
  if (!instance && serviceActive(config))
    throw Error('服务正在启动或来自旧版本；请先正常停止后重试');
  if (instance) {
    assertServiceOwnership(config);
    if (instance.profile_file !== resolve(config.profileFile || ''))
      throw Error('数据库由另一个配置的服务使用，拒绝停机');
    let main = 0;
    try {
      main = Number(systemctl(['show', unitName(config), '--property=MainPID', '--value']).trim());
    } catch {}
    if (main !== instance.pid) throw Error('前台运行中的应用需要先正常停止，再执行备份或升级');
  }
  return !!instance;
}
export async function withQuiesced<T>(
  config: HostConfig,
  work: () => Promise<T>,
  options: { resume?: boolean; keepMaintenanceOnError?: boolean } = {},
) {
  const managed = assertManagedDatabaseOwnership(config);
  let restart = false,
    previous = 0,
    maintenanceSet = false,
    succeeded = false;
  try {
    if (managed) {
      systemctl(['stop', unitName(config)]);
      restart = true;
    }
    const db = new Database(join(config.dataRoot, 'app.sqlite'), { fileMustExist: true });
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
        const current = new Database(join(config.dataRoot, 'app.sqlite'), { fileMustExist: true });
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
type HealthObservation =
  | { kind: 'unreachable' }
  | { kind: 'invalid_response'; httpStatus: number }
  | {
      kind: 'phase';
      phase: PlatformStatus['phase'];
      version?: string;
      httpStatus: number;
    };

const healthPhases = new Set<PlatformStatus['phase']>([
  'owner_required',
  'setup_required',
  'initializing',
  'ready',
  'source_unavailable',
  'configuration_error',
]);

export class ServiceHealthError extends Error {
  constructor(
    readonly url: string,
    readonly expectedVersion: string,
    readonly observation: HealthObservation,
  ) {
    const detail =
      observation.kind === 'phase'
        ? observation.phase
        : observation.kind === 'invalid_response'
          ? `无效的健康响应（HTTP ${observation.httpStatus}）`
          : 'UNREACHABLE';
    super('服务健康检查失败：' + detail + '；未恢复写入');
  }
}

export async function waitHealthy(
  config: HostConfig,
  version: string,
  { allowUnavailableSource = false } = {},
) {
  const url = healthURL(config) + '/healthz';
  const until = Date.now() + 30000;
  let last: HealthObservation = { kind: 'unreachable' };
  do {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(2000) });
      const body = await response.json().catch(() => undefined);
      if (healthPhases.has(body?.phase)) {
        if (
          response.ok &&
          body.version === version &&
          (['ready', 'setup_required'].includes(body.phase) ||
            (allowUnavailableSource &&
              body.phase === 'source_unavailable' &&
              body.status === 'alive' &&
              body.maintenance === false))
        )
          return body;
        last = {
          kind: 'phase',
          phase: body.phase,
          version:
            typeof body.version === 'string' && /^[0-9][a-zA-Z0-9.+-]{0,79}$/.test(body.version)
              ? body.version
              : undefined,
          httpStatus: response.status,
        };
      } else if (last.kind !== 'phase') {
        last = { kind: 'invalid_response', httpStatus: response.status };
      }
    } catch {}
    await new Promise((r) => setTimeout(r, 200));
  } while (Date.now() < until);
  throw new ServiceHealthError(url, version, last);
}
