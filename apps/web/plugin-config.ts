import type { PluginView } from '../../packages/plugin-contracts';

export interface PluginConfigDraft {
  pluginId: string;
  configVersion: number;
  values: Record<string, any>;
  savedValues: string;
  conflicted: boolean;
}

export class PluginConfigError extends Error {
  constructor(
    public field: string,
    message: string,
  ) {
    super(message);
  }
}

export function createPluginDraft(plugin: PluginView): PluginConfigDraft {
  const values: Record<string, any> = { ...plugin.config };
  for (const [key, schema] of Object.entries(plugin.manifest.configSchema.properties || {})) {
    const field = schema as any;
    if (field.writeOnly) values[key] = '';
    else if (plugin.id === 'mcp' && key === 'allowedPrefixes' && field.type === 'array')
      values[key] = (values[key] ?? field.default ?? []).join('\n');
    else if (field.type === 'object' || field.type === 'array')
      values[key] = JSON.stringify(
        values[key] ?? field.default ?? (field.type === 'array' ? [] : {}),
        null,
        2,
      );
    else if (values[key] === undefined && field.default !== undefined) values[key] = field.default;
  }
  return {
    pluginId: plugin.id,
    configVersion: plugin.configVersion,
    values,
    savedValues: JSON.stringify(values),
    conflicted: false,
  };
}

export function pluginDraftDirty(draft: PluginConfigDraft) {
  return JSON.stringify(draft.values) !== draft.savedValues;
}

export function refreshPluginDraft(
  draft: PluginConfigDraft,
  plugin: PluginView,
): PluginConfigDraft {
  if (draft.pluginId !== plugin.id) return createPluginDraft(plugin);
  if (draft.configVersion === plugin.configVersion) return draft;
  return { ...draft, conflicted: true };
}

export function pluginFieldVisible(pluginId: string, key: string, mode: unknown) {
  return !(
    pluginId === 'mcp' &&
    ['compatPort', 'tunnelToken', 'tunnelOrigin'].includes(key) &&
    mode !== 'tunnel' &&
    mode !== 'both'
  );
}

export function serializePluginDraft(draft: PluginConfigDraft, plugin: PluginView) {
  if (
    draft.conflicted ||
    draft.pluginId !== plugin.id ||
    draft.configVersion !== plugin.configVersion
  )
    throw new PluginConfigError('', '远端配置已经变化，请先重新载入已保存配置，再检查并保存。');
  const values = { ...draft.values };
  for (const [key, schema] of Object.entries(plugin.manifest.configSchema.properties || {})) {
    const field = schema as any;
    if (field.writeOnly && values[key] === '') delete values[key];
    else if (plugin.id === 'mcp' && key === 'allowedPrefixes' && field.type === 'array') {
      const entries = String(values[key]).split(/\r?\n/);
      if (entries.at(-1) === '') entries.pop();
      if (
        entries.length < (field.minItems ?? 1) ||
        entries.length > (field.maxItems ?? 64) ||
        entries.some(
          (entry) =>
            entry.startsWith('/') ||
            /[\\\x00-\x1f]/.test(entry) ||
            entry
              .split('/')
              .some((part) => !part || part === '.' || part === '..' || part.startsWith('.')),
        )
      )
        throw new PluginConfigError(
          key,
          '允许访问的目录格式不正确。每行填写一个知识库内的相对目录或文件，不能包含空行、隐藏目录、上级目录或绝对路径，最多 64 项。',
        );
      values[key] = entries;
    } else if (field.type === 'object' || field.type === 'array') {
      try {
        const value = JSON.parse(values[key]);
        if (
          field.type === 'array'
            ? !Array.isArray(value)
            : !value || typeof value !== 'object' || Array.isArray(value)
        )
          throw Error();
        values[key] = value;
      } catch {
        throw new PluginConfigError(
          key,
          `${field.title || key}格式不正确，请填写有效的 JSON ${field.type === 'array' ? '数组' : '对象'}。`,
        );
      }
    }
  }
  return { values, configVersion: draft.configVersion };
}
