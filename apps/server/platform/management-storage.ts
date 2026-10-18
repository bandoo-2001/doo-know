import { join } from 'node:path';
import type { HostConfig, StorageUsage } from '../../../shared/platform-contracts.js';
import type { ManagementStorage } from '../../../shared/management-contracts.js';
import { directoryUsage } from './storage.js';

export async function managementStorage(
  config: HostConfig,
  root: string | undefined,
): Promise<ManagementStorage> {
  const warnings = new Set<string>();
  const visible = (name: string) => !name.startsWith('.');
  const usage = async (
    path: string | undefined,
    label: string,
    accept?: (name: string) => boolean,
    descend?: (name: string) => boolean,
  ): Promise<StorageUsage> => {
    const { count, bytes, truncated } = await directoryUsage(
      path,
      label,
      warnings,
      accept,
      descend,
    );
    return { count, bytes, truncated };
  };
  const [notes, assets, history, trash, index, models, upgradeBackups] = await Promise.all([
    usage(root, '笔记', (name) => visible(name) && name.toLowerCase().endsWith('.md'), visible),
    usage(
      root,
      '附件及其他源文件',
      (name) => visible(name) && !name.toLowerCase().endsWith('.md'),
      visible,
    ),
    usage(join(config.dataRoot, 'history'), '历史版本'),
    usage(root && join(root, '90-Archive/.trash'), '回收站'),
    usage(join(config.dataRoot, 'indexes'), '搜索索引文件'),
    usage(config.searchModelsRoot || config.modelDir, '模型'),
    usage(config.installRoot && join(config.installRoot, 'backups'), '升级备份', (name) =>
      name.endsWith('.dooknow'),
    ),
  ]);
  if (!root) warnings.add('知识库未就绪，笔记、附件和回收站尚未统计。');
  if (!config.searchModelsRoot && !config.modelDir)
    warnings.add('未配置本地模型目录，模型用量不包含远程服务。');
  warnings.add('元数据统计最多递归 4 层、每项检查 5000 个条目；链接和非普通文件不计入。');
  warnings.add(
    '笔记为非隐藏目录中的 Markdown；附件包含其他非隐藏源文件。SQLite 数据库、隐藏源文件、缓存及目录开销未计入，分类合计不代表磁盘总用量。',
  );
  warnings.add(
    '升级备份仅统计安装目录内 .dooknow 文件，不代表完整备份；文件存在不表示已验证恢复。',
  );
  return {
    categories: { notes, assets, history, trash, index, models, upgradeBackups },
    scannedAt: new Date().toISOString(),
    limits: { entriesPerCategory: 5000, depth: 4 },
    warnings: [...warnings],
  };
}
