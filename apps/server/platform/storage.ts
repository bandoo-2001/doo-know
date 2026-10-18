import { constants } from 'node:fs';
import { lstat, open, opendir, type FileHandle } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import type { FastifyInstance } from 'fastify';
import type {
  HostConfig,
  MaintenanceStorage,
  StorageUsage,
} from '../../../shared/platform-contracts.js';

const ENTRY_LIMIT = 5000,
  DEPTH_LIMIT = 4;
const directoryFlags = constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW;
const descriptorPath = (directory: FileHandle) => `/proc/self/fd/${directory.fd}`;

// Pin every directory through an open parent. Neither a root symlink nor a renamed
// ancestor can redirect this metadata-only scan into a different directory tree.
async function openDirectory(path: string) {
  let directory = await open(sep, directoryFlags);
  try {
    for (const part of resolve(path).split(sep).filter(Boolean)) {
      const next = await open(join(descriptorPath(directory), part), directoryFlags);
      await directory.close();
      directory = next;
    }
    return directory;
  } catch (error) {
    await directory.close();
    throw error;
  }
}

export async function directoryUsage(
  path: string | undefined,
  label: string,
  warnings: Set<string>,
  accept: (name: string) => boolean = () => true,
  descend: (name: string) => boolean = () => true,
) {
  const usage: StorageUsage & { latest: number } = {
    count: 0,
    bytes: 0,
    truncated: false,
    latest: 0,
  };
  if (!path) return usage;
  let visited = 0;
  async function walk(directory: FileHandle, depth: number): Promise<void> {
    const entries = await opendir(descriptorPath(directory));
    for await (const entry of entries) {
      if (visited++ >= ENTRY_LIMIT) {
        usage.truncated = true;
        break;
      }
      try {
        const childPath = join(descriptorPath(directory), entry.name),
          info = await lstat(childPath);
        if (info.isDirectory()) {
          if (!descend(entry.name)) continue;
          if (depth >= DEPTH_LIMIT) {
            usage.truncated = true;
            continue;
          }
          const child = await open(childPath, directoryFlags);
          try {
            const pinned = await child.stat();
            if (pinned.dev !== info.dev || pinned.ino !== info.ino)
              throw Error('DIRECTORY_CHANGED');
            await walk(child, depth + 1);
          } finally {
            await child.close();
          }
        } else if (info.isFile() && info.nlink === 1) {
          if (accept(entry.name)) {
            usage.count++;
            usage.bytes += info.size;
            usage.latest = Math.max(usage.latest, info.mtimeMs);
          }
        } else warnings.add(`${label}中有链接或非普通文件，已跳过。`);
      } catch {
        warnings.add(`${label}中有无法读取或正在变化的条目，本次统计可能不完整。`);
        usage.truncated = true;
      }
      if (visited > ENTRY_LIMIT) break;
    }
  }
  let directory: FileHandle | undefined;
  try {
    directory = await openDirectory(path);
    await walk(directory, 0);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      warnings.add(`${label}目录不可安全读取，未统计链接目录或无权访问的内容。`);
      usage.truncated = true;
    }
  } finally {
    await directory?.close();
  }
  if (usage.truncated)
    warnings.add(`${label}只显示本次可安全统计的部分；每项最多检查 ${ENTRY_LIMIT} 个条目。`);
  return usage;
}

export function registerStorageRoutes(
  app: FastifyInstance,
  config: HostConfig,
  knowledgeRoot: () => string | undefined,
) {
  app.get('/api/maintenance/storage', async (): Promise<MaintenanceStorage> => {
    const warnings = new Set<string>();
    let root: string | undefined;
    try {
      root = knowledgeRoot();
    } catch {
      warnings.add('知识库配置暂不可用，回收站用量尚未统计。');
    }
    if (!root) warnings.add('尚未绑定可用知识库，回收站用量尚未统计。');
    const [history, trash, backups] = await Promise.all([
      directoryUsage(join(config.dataRoot, 'history'), '历史版本', warnings),
      directoryUsage(root && join(root, '90-Archive/.trash'), '回收站', warnings),
      directoryUsage(
        config.installRoot && join(config.installRoot, 'backups'),
        '升级备份',
        warnings,
        (name) => name.endsWith('.dooknow'),
      ),
    ]);
    warnings.add(
      '备份用量仅包含安装目录内的升级备份，自选位置的备份未计入；同盘备份不能代替独立设备备份。',
    );
    if (backups.count)
      warnings.add('最近备份时间取自文件修改时间；文件存在不表示已验证完整性或完成恢复演练。');
    else warnings.add('当前统计范围内没有备份；请在本机终端创建备份，并另存恢复私钥。');
    const summary = ({ count, bytes, truncated }: StorageUsage): StorageUsage => ({
      count,
      bytes,
      truncated,
    });
    return {
      history: summary(history),
      trash: summary(trash),
      backups: {
        ...summary(backups),
        lastCreatedAt: backups.latest ? new Date(backups.latest).toISOString() : null,
      },
      warnings: [...warnings],
    };
  });
}
