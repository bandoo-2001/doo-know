import { join } from 'node:path';
import Database from 'better-sqlite3';
import { healthURL, ServiceHealthError } from '../apps/server/platform/service.js';
import {
  KnowledgeRootTypeError,
  readKnowledgeRootIdentity,
} from '../packages/core/indexing/root-identity.js';
import type { HostConfig } from '../shared/platform-contracts.js';

export interface InstallProgress {
  step: string;
  profileFile?: string;
  dataRoot?: string;
  config?: HostConfig;
  serviceStarted?: boolean;
  serviceName?: string;
  hint?: string;
}

const pathLabel = (path: string) => JSON.stringify(path);
const shellArg = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";

function rootPaths(config: HostConfig) {
  let db: Database.Database | undefined;
  try {
    db = new Database(join(config.dataRoot, 'app.sqlite'), { readonly: true, fileMustExist: true });
    const saved = db.prepare('SELECT knowledge_root FROM platform_settings WHERE id=1').get() as
      | { knowledge_root: string }
      | undefined;
    const identity = db.prepare("SELECT value FROM index_meta WHERE key='root_identity'").get() as
      | { value: string }
      | undefined;
    return {
      configured: config.knowledgeRoot,
      saved: saved?.knowledge_root,
      identity: identity?.value,
    };
  } catch {
    return { configured: config.knowledgeRoot };
  } finally {
    db?.close();
  }
}

function rootFailure(config: HostConfig, phase: 'source_unavailable' | 'configuration_error') {
  const { configured, saved, identity } = rootPaths(config);
  const root = configured || saved;
  const context = [
    ...(root ? ['知识库目录 ' + pathLabel(root)] : []),
    ...(configured && saved && configured !== saved
      ? ['数据库绑定的目录 ' + pathLabel(saved)]
      : []),
  ];
  if (phase === 'configuration_error') {
    if (!root)
      return [
        '该实例已有知识库状态，但当前配置缺少可用的原文目录。请核对配置和数据库是否来自同一实例。',
      ];
    return [
      ...context,
      '原有知识库绑定与当前配置冲突。请核对哪一个目录属于此实例，以及知识库目录是否与安装目录、数据目录或密钥路径重叠。',
    ];
  }
  if (!root)
    return ['无法读取原有知识库绑定。请查看服务日志，并核对配置及数据库是否来自同一实例。'];

  let reason =
    '这里可以读取原文目录，但服务仍无法完成知识库初始化。请核对服务日志及用户服务实际加载的配置。';
  try {
    const current = readKnowledgeRootIdentity(root);
    if (configured && saved && configured !== saved) readKnowledgeRootIdentity(saved);
    if (identity && current !== identity)
      reason =
        '此处的目录与数据库记录的原目录身份不同。请核对磁盘挂载，或找到原目录并将它恢复到原路径。';
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (error instanceof KnowledgeRootTypeError) {
      reason =
        error.kind === 'symlink'
          ? '知识库路径是符号链接。请将原来的实际目录恢复到绑定路径。'
          : '知识库路径指向的内容不是目录。请核对该路径，并恢复原目录。';
    } else if (code === 'ENOENT' || code === 'ENOTDIR') {
      reason =
        '原知识库路径不存在或上级路径不可用。请检查磁盘挂载，以及目录是否已改名、移动或进入回收站。';
    } else if (code === 'EACCES' || code === 'EPERM') {
      reason = '当前服务用户无法访问知识库目录。请核对原目录和各级父目录的访问权限。';
    } else if (code === 'ELOOP') {
      reason = '路径含循环符号链接。请核对父目录及原目录的实际位置。';
    } else if (code === 'EIO' || code === 'ESTALE' || code === 'ENODEV') {
      reason = `无法读取知识库所在的文件系统（${code}）。请核对磁盘和挂载状态。`;
    } else {
      reason = '无法读取已绑定的知识库目录。请核对挂载及服务日志。';
    }
  }
  return [
    ...context,
    reason,
    '继续使用旧实例时，恢复原目录或挂载后重跑安装。全新安装时，请分别指定新实例的 DOOKNOW_PROFILE、DOOKNOW_INSTALL_ROOT、XDG_DATA_HOME 和 DOOKNOW_BIN_DIR。实例同时运行时，还需使用不同的服务名和端口。',
  ];
}

function healthFailure(error: ServiceHealthError, config?: HostConfig) {
  const { observation, expectedVersion } = error;
  const lines = ['健康检查地址 ' + error.url];
  if (observation.kind === 'unreachable') {
    lines.push(
      '健康检查等待超时（UNREACHABLE）。请查看服务是否退出、监听地址和端口是否可用，以及 NO_PROXY 是否包含本机检查地址。',
    );
  } else if (observation.kind === 'invalid_response') {
    lines.push(
      `端口返回了 HTTP ${observation.httpStatus}，响应无法识别为 DooKnow 健康状态。请检查端口是否属于其他程序、旧实例或代理。`,
    );
  } else if (observation.version && observation.version !== expectedVersion) {
    lines.push(
      `端口上的 DooKnow 版本为 ${observation.version}，本次安装需要 ${expectedVersion}。请核对监听进程和服务的实际运行版本。`,
    );
  } else {
    lines.push(`服务返回 ${observation.phase}（HTTP ${observation.httpStatus}）。`);
    if (
      config &&
      (observation.phase === 'source_unavailable' || observation.phase === 'configuration_error')
    )
      lines.push(...rootFailure(config, observation.phase));
    else if (observation.phase === 'owner_required')
      lines.push(
        '正在响应的实例未读取到管理员账号。请核对服务使用的配置和数据目录，再在本机交互终端重跑原安装命令。',
      );
    else if (observation.phase === 'initializing')
      lines.push('服务在检查时限内仍在初始化。请查看日志，确认数据库和知识库能否正常打开。');
    else
      lines.push(`服务需返回本次安装版本 ${expectedVersion} 及可用的健康状态，才能继续完成安装。`);
  }
  lines.push(
    '手动检查可运行 curl --noproxy ' +
      shellArg('*') +
      ' --max-time 5 -sS -- ' +
      shellArg(error.url),
  );
  return lines;
}

function failureReason(error: unknown, config?: HostConfig) {
  if (error instanceof Error && error.message === 'GITHUB_CREDENTIAL_INSIDE_KNOWLEDGE_ROOT')
    return 'GitHub 下载凭据位于知识库目录内（GITHUB_CREDENTIAL_INSIDE_KNOWLEDGE_ROOT）。请将凭据放到知识库之外的私有文件，再更新 DOOKNOW_GITHUB_TOKEN_FILE。';
  if (error instanceof Error && error.message === 'INVALID_ROOT_IDENTITY')
    return '数据库中的知识库目录身份记录无效（INVALID_ROOT_IDENTITY）。请核对实例配置，保留数据库及备份供恢复。';
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  if (code === 'EADDRINUSE' || code === 'EADDRNOTAVAIL') {
    const endpoint = config ? `（${healthURL(config)}）` : '';
    return code === 'EADDRINUSE'
      ? `监听端口已被占用${endpoint}。请用 ss -ltnp 查看监听进程。新实例可用 DOOKNOW_PORT 指定空闲端口。`
      : `监听地址在当前主机不可用${endpoint}。请检查 DOOKNOW_HOST 是否为本机地址。`;
  }
  if (code === 'EACCES' || code === 'EPERM' || code === 'EROFS')
    return `路径或监听权限不足（${code}）。请核对路径、所有权、端口权限及挂载是否为只读。`;
  if (code === 'ENOSPC' || code === 'EDQUOT' || code === 'SQLITE_FULL')
    return `存储空间或配额不足（${code}）。请检查安装及数据路径所在磁盘的空间和 inode。`;
  if (code === 'ENOENT' || code === 'ENOTDIR')
    return `所需路径不存在或不是目录（${code}）。请检查配置路径、挂载和命令是否可用。`;
  if (code === 'SQLITE_BUSY' || code === 'SQLITE_LOCKED')
    return `数据库正被占用（${code}）。请确认同一数据目录没有其他管理操作正在运行。`;
  if (code && /^SQLITE_(?:NOTADB|CORRUPT|CANTOPEN|IOERR|READONLY)(?:_|$)/.test(code))
    return `无法正常打开或读取数据库（${code}）。请检查数据目录权限、挂载及数据库状态，并保留原数据库和备份。`;
  if (code === 'ERR_INVALID_URL')
    return '访问地址格式无效。请检查 DOOKNOW_APP_ORIGIN 的协议、主机和端口。';
  if (code === 'ERR_INVALID_ARG_TYPE')
    return '现有配置的字段类型无效。请核对路径、端口及配置格式。';
  if (error instanceof SyntaxError)
    return '配置或本地状态文件不是有效的 JSON。请核对文件格式，或从已知有效的备份恢复配置。';
  const status = (error as { status?: number } | undefined)?.status;
  if (
    error instanceof Error &&
    error.message.startsWith('Command failed: systemctl ') &&
    Number.isInteger(status)
  )
    return `systemd 用户服务命令执行失败（退出码 ${status}）。请按下方提示核对服务状态和日志。`;
  // Installer-owned messages provide actionable context. Do not forward raw
  // systemctl output, file contents, or URLs/credentials embedded in other errors.
  if (
    error instanceof Error &&
    /^[\u3400-\u9fff]/.test(error.message) &&
    !error.message.includes('\n')
  )
    return error.message;
  return '该步骤未完成。请按下方提示核对当前安装状态后重试。';
}

export function installError(error: unknown, progress: InstallProgress) {
  const { config, profileFile, dataRoot } = progress;
  const isHealthFailure = error instanceof ServiceHealthError;
  const lines = [`安装失败（${progress.step}）`];
  lines.push(
    ...(isHealthFailure ? healthFailure(error, config) : [failureReason(error, config)]),
    ...(profileFile ? ['配置文件 ' + pathLabel(profileFile)] : []),
    ...(dataRoot ? ['数据目录 ' + pathLabel(dataRoot)] : []),
    ...(progress.hint ? [progress.hint] : []),
  );
  if (progress.serviceName) {
    const unit = progress.serviceName;
    lines.push(
      '查看服务状态可运行 systemctl --user status ' + unit + ' --no-pager',
      '查看近期日志可运行 journalctl --user -u ' + unit + ' -n 80 --no-pager',
    );
  }
  if (progress.serviceStarted)
    lines.push(
      '安装已请求启动用户服务，管理命令可能还未生成。账号、配置和数据库保留在本实例中。修复后请重跑原安装命令。',
    );
  return Error(lines.join('\n'));
}
