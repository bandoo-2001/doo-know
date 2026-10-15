import { shallowRef, markRaw, type Component } from 'vue';
import type { PluginUIApi } from './index';
export const pluginComponents = shallowRef<Record<string, Component>>({});
export const pluginPanel = shallowRef<{ id: string; context: Record<string, unknown> }>();
export function createPluginUI(pluginId: string, invoke: PluginUIApi['call']) {
  const disposers: (() => void)[] = [];
  const own = (id: string) => { if (!id.startsWith(pluginId + '.')) throw new Error('插件贡献必须使用自己的命名空间'); };
  const api: PluginUIApi = { pluginId, apiVersion: '1.0.0',
    registerComponent(id, component) {
      own(id); if (pluginComponents.value[id]) throw new Error('重复的插件界面贡献');
      const registered = markRaw(component);
      pluginComponents.value = { ...pluginComponents.value, [id]: registered };
      const dispose = () => { if (pluginComponents.value[id] !== registered) return; const next = { ...pluginComponents.value }; delete next[id]; pluginComponents.value = next; };
      disposers.push(dispose); return dispose;
    },
    call: (kind, id, input, requestId) => { own(id); return invoke(kind, id, input, requestId); },
    openPanel(id, context = {}) { own(id); pluginPanel.value = { id, context }; },
    notifyChanged(noteId) { window.dispatchEvent(new CustomEvent('dooknow-workspace-changed', { detail: { noteId } })); },
    notify(message) { window.dispatchEvent(new CustomEvent('dooknow-notice', { detail: { message } })); },
  };
  return { api, dispose: () => {
    for (const dispose of disposers.reverse()) dispose();
    if (pluginPanel.value?.id.startsWith(pluginId + '.')) pluginPanel.value = undefined;
  } };
}
