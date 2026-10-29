import type { SettingsSection } from '../../shared/settings-contracts';
export const settingsSections: {
  key: SettingsSection;
  label: string;
  icon: string;
  description: string;
}[] = [
  {
    key: 'editor',
    label: '通用与编辑',
    icon: 'file',
    description: '设置当前设备上的阅读与编辑习惯。',
  },
  {
    key: 'library',
    label: '知识库与存储',
    icon: 'book',
    description: '查看资料位置、空间用量与分享，导入或导出文件。',
  },
  {
    key: 'search',
    label: '搜索与索引',
    icon: 'search',
    description: '查看当前可用的搜索能力及索引状态。',
  },
  {
    key: 'backup',
    label: '备份与恢复',
    icon: 'shield',
    description: '创建加密备份、恢复独立副本并处理异常写入。',
  },
  {
    key: 'status',
    label: '后台状态',
    icon: 'task',
    description: '查看后台任务、搜索准备、索引更新与写入状态。',
  },
  {
    key: 'plugins',
    label: '插件与连接',
    icon: 'plug',
    description: '管理已安装功能和外部应用连接。',
  },
  { key: 'account', label: '账号与安全', icon: 'lock', description: '管理密码和登录设备。' },
  {
    key: 'about',
    label: '关于与诊断',
    icon: 'help',
    description: '查看版本、使用帮助和脱敏诊断。',
  },
];
export function normalizeSettingsSection(value?: string): SettingsSection {
  if (value === 'maintenance') return 'backup';
  return settingsSections.some((item) => item.key === value)
    ? (value as SettingsSection)
    : 'editor';
}
