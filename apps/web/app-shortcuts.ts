import { readonly, ref } from 'vue';

export const workspaceApps = [
  { id: 'graph', name: '知识图谱', icon: 'share', description: '从原文发现概念与关系，沿着证据探索知识。', summary: '自动分析 · 关系证据 · 局部探索' },
  { id: 'blog', name: '博客', icon: 'book', description: '把值得分享的笔记，变成你的个人博客。', summary: '选稿 · 预览 · 手动发布' },
  { id: 'to-doo', name: 'To Doo', icon: 'task', description: '带着资料做事，把每一步成果留下来。', summary: '目标 · 任务 · 日程 · 专注' },
] as const;
export type WorkspaceAppId = (typeof workspaceApps)[number]['id'];
type PreferenceStorage = Pick<Storage, 'getItem' | 'setItem'>;
const mutable = ref<WorkspaceAppId[]>([]);
export const pinnedApps = readonly(mutable);
let storage: PreferenceStorage | undefined;
let accountKey = '';
function knownApp(value: unknown): value is WorkspaceAppId {
  return workspaceApps.some(app => app.id === value);
}
export function initializeAppShortcuts(accountId: string, selectedStorage?: PreferenceStorage) {
  accountKey = 'dooknow.app-shortcuts.v1:' + encodeURIComponent(accountId || 'guest');
  storage = undefined;
  mutable.value = [];
  try {
    storage = selectedStorage || globalThis.localStorage;
    const saved: unknown = JSON.parse(storage?.getItem(accountKey) || 'null');
    if (Array.isArray(saved)) mutable.value = [...new Set(saved.filter(knownApp))];
  } catch {}
}
/** Returns false when only the current session can retain the change. */
export function setAppPinned(id: WorkspaceAppId, pinned: boolean): boolean {
  if (!knownApp(id)) return false;
  if (pinned) {
    if (!mutable.value.includes(id)) mutable.value = [...mutable.value, id];
  } else mutable.value = mutable.value.filter(app => app !== id);
  try {
    if (!storage) return false;
    storage.setItem(accountKey, JSON.stringify(mutable.value));
    return true;
  } catch {
    return false;
  }
}
