import type { ToDooAppSection } from './navigation';

export type ToDooContextEntry = { id: string; label: string; icon: string };
const entries: Partial<Record<ToDooAppSection, ToDooContextEntry[]>> = {
  settings: [
    { id: 'preferences', label: '偏好', icon: 'settings' },
    { id: 'connections', label: '提醒与连接', icon: 'notifications' },
    { id: 'data', label: '数据与恢复', icon: 'archive' },
    { id: 'lists', label: '清单管理', icon: 'tasks' },
  ],
  focus: [
    { id: 'projects', label: '项目', icon: 'folder' },
    { id: 'history', label: '历史', icon: 'focus' },
  ],
  habits: [
    { id: 'today', label: '今天', icon: 'calendar' },
    { id: 'history', label: '历史', icon: 'focus' },
  ],
  anniversaries: [
    { id: 'all', label: '全部', icon: 'anniversaries' },
    { id: 'upcoming', label: '即将到来', icon: 'calendar' },
    { id: 'today', label: '今天', icon: 'today' },
    { id: 'past', label: '已过去', icon: 'focus' },
  ],
  stats: [
    { id: 'overview', label: '统计概览', icon: 'stats' },
    { id: 'goals', label: '目标进度', icon: 'overview' },
    { id: 'reviews', label: '历史复盘', icon: 'tasks' },
  ],
  notifications: [
    { id: 'all', label: '全部', icon: 'notifications' },
    { id: 'unread', label: '未读', icon: 'notifications' },
    { id: 'read', label: '已读', icon: 'check' },
    { id: 'acknowledged', label: '已确认', icon: 'check' },
    { id: 'snoozed', label: '稍后', icon: 'focus' },
    { id: 'dismissed', label: '忽略', icon: 'close' },
  ],
};

export function toDooContextEntries(section: ToDooAppSection): readonly ToDooContextEntry[] {
  return entries[section] ?? [];
}
export function resolveToDooContext(section: ToDooAppSection, value?: string): string | undefined {
  const options = toDooContextEntries(section);
  return options.find((entry) => entry.id === value)?.id ?? options[0]?.id;
}
