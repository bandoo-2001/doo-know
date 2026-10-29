import { shallowRef } from 'vue';
import type { PluginCatalogEntry, PluginView, Contribution, PluginDataDependency } from '../../packages/plugin-contracts';
import { createPluginUI } from '../../packages/plugin-ui/host';
import { api } from './api';
export const pluginRegistry = shallowRef<{
  catalog: PluginCatalogEntry[];
  installed: PluginView[];
  contributions: (Contribution & { pluginId: string })[];
  dataDependencies?: PluginDataDependency[];
}>({ catalog: [], installed: [], contributions: [] });
export const pluginUIErrors = shallowRef<Record<string, string>>({});
const loaded = new Map<string, { url: string; dispose: () => void | Promise<void> }>();
let refreshTail = Promise.resolve();
let sessionEpoch = 0;
function queue(work: () => Promise<void>) {
  const task = refreshTail.then(work);
  refreshTail = task.catch(() => {});
  return task;
}
export function refreshPlugins() {
  const epoch = sessionEpoch;
  const current = () => epoch === sessionEpoch;
  return queue(async () => {
    if (!current()) return;
    const registry = await api<typeof pluginRegistry.value>('/api/platform/plugins');
    if (!current()) return;
    pluginRegistry.value = registry;
    for (const [id, entry] of loaded)
      if (
        !registry.installed.some(
          (p) => p.id === id && p.state === 'enabled' && p.webUrl === entry.url,
        )
      ) {
        try {
          await entry.dispose();
        } catch {
          if (current())
            pluginUIErrors.value = {
              ...pluginUIErrors.value,
              [id]: '插件界面清理失败，请刷新页面',
            };
        }
        loaded.delete(id);
        if (!current()) return;
      }
    for (const plugin of registry.installed) {
      if (!current()) return;
      if (plugin.state !== 'enabled' || !plugin.webUrl || loaded.has(plugin.id)) continue;
      const binding = createPluginUI(plugin.id, (kind, id, input, requestId) => {
        if (!current()) return Promise.reject(new Error('插件会话已结束，请重新打开功能。'));
        return api(`/api/plugins/${plugin.id}/call`, 'POST', { kind, id, input, requestId });
      });
      const styles: HTMLLinkElement[] = [];
      let release: unknown,
        disposed = false;
      const dispose = async () => {
        if (disposed) return;
        disposed = true;
        try {
          if (typeof release === 'function') await release();
        } finally {
          binding.dispose();
          for (const style of styles) style.remove();
        }
      };
      try {
        if (!/^\/plugins\/[a-z][a-z0-9-]*\/[a-zA-Z0-9.+-]+\/[a-f0-9]{64}\//.test(plugin.webUrl))
          throw new Error('无效界面地址');
        const manifest = plugin.activeManifest || plugin.manifest;
        const base = plugin.webUrl.slice(0, -manifest.web!.length);
        for (const file of manifest.styles || []) {
          const link = document.createElement('link');
          link.rel = 'stylesheet';
          link.href = base + file;
          styles.push(link);
          await new Promise<void>((yes, no) => {
            const timeout = setTimeout(() => no(new Error('插件样式加载超时')), 8000);
            link.onload = () => {
              clearTimeout(timeout);
              yes();
            };
            link.onerror = () => {
              clearTimeout(timeout);
              no(new Error('插件样式加载失败'));
            };
            document.head.appendChild(link);
          });
          if (!current()) {
            await dispose();
            return;
          }
        }
        const code = await import(/* @vite-ignore */ plugin.webUrl);
        if (!current()) {
          await dispose();
          return;
        }
        if (typeof code.activate !== 'function') throw new Error('缺少界面入口');
        release = await code.activate(binding.api);
        if (!current()) {
          await dispose();
          return;
        }
        loaded.set(plugin.id, { url: plugin.webUrl, dispose });
        const errors = { ...pluginUIErrors.value };
        delete errors[plugin.id];
        pluginUIErrors.value = errors;
      } catch {
        try {
          await dispose();
        } catch {}
        if (current())
          pluginUIErrors.value = {
            ...pluginUIErrors.value,
            [plugin.id]: '插件界面暂时无法加载，可重试或停用插件',
          };
      }
    }
  });
}
export function contributionVisible(item: Contribution, context: Record<string, any>) {
  return (item.when || []).every((rule) => {
    let value: any = context;
    for (const key of rule.key.split('.')) {
      if (!value || !Object.hasOwn(value, key)) return false;
      value = value[key];
    }
    return value === rule.equals;
  });
}
export function disposePluginUIs() {
  sessionEpoch++;
  pluginRegistry.value = { catalog: [], installed: [], contributions: [] };
  pluginUIErrors.value = {};
  return queue(async () => {
    for (const [id, entry] of loaded) {
      try {
        await entry.dispose();
      } catch {
      } finally {
        loaded.delete(id);
      }
    }
  });
}
