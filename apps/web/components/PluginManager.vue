<script setup lang="ts">
import { ref, computed, watch, onMounted, nextTick } from 'vue';
import {
  Button as AButton,
  Input as AInput,
  InputNumber as AInputNumber,
  Select as ASelect,
  Switch as ASwitch,
  Alert as AAlert,
  Empty as AEmpty,
  Tabs as ATabs,
  TabPane as ATabPane,
} from 'ant-design-vue';
import { pluginRegistry, pluginUIErrors, refreshPlugins } from '../plugins';
import { pluginComponents } from '../../../packages/plugin-ui/host';
import PluginBoundary from './PluginBoundary.vue';
import { api } from '../api';
const props = defineProps<{ focusPlugin?: string }>();
const tab = ref('installed'),
  advancedOpen = ref(false);
const selected = ref(props.focusPlugin || ''),
  busy = ref(false),
  pendingAction = ref(''),
  error = ref(''),
  notice = ref(''),
  invalidField = ref(''),
  values = ref<Record<string, any>>({});
const catalog = computed(() =>
  [
    ...pluginRegistry.value.catalog,
    ...pluginRegistry.value.installed
      .filter((plugin) => !pluginRegistry.value.catalog.some((entry) => entry.id === plugin.id))
      .map((plugin) => ({ ...plugin.manifest, description: '已安装的扩展功能。' })),
  ].filter((entry) => {
    if (props.focusPlugin) return entry.id === props.focusPlugin;
    if (selected.value) return false;
    return tab.value === 'installed'
      ? installedById.value.has(entry.id)
      : !installedById.value.has(entry.id);
  }),
);
const installedById = computed(
  () => new Map(pluginRegistry.value.installed.map((plugin) => [plugin.id, plugin])),
);
const installed = computed(() =>
  pluginRegistry.value.installed.find((p) => p.id === selected.value),
);
const standardFields = computed(() =>
  Object.fromEntries(
    Object.entries(installed.value?.manifest.configSchema.properties || {}).filter(
      ([, field]) => !['object', 'array'].includes((field as any).type),
    ),
  ),
);
const advancedFields = computed(() =>
  Object.fromEntries(
    Object.entries(installed.value?.manifest.configSchema.properties || {}).filter(([, field]) =>
      ['object', 'array'].includes((field as any).type),
    ),
  ),
);
const capabilityLabels: Record<string, string> = {
  'knowledge:read': '读取知识库',
  'knowledge:write': '写入知识库',
  'knowledge:index': '维护搜索索引',
  'protocol:mcp': '连接 AI 应用',
  'workspace:git': 'Git 同步',
  'network:listen': '提供网络服务',
  'network:request': '访问网络',
};
function capability(value: string) {
  return capabilityLabels[value] || '扩展能力';
}
const stateLabels: Record<string, string> = {
  enabled: '已启用',
  disabled: '已停用',
  starting: '正在启动',
  stopping: '正在停用',
  failed: '运行异常',
};
const settingsPages = computed(() =>
  pluginRegistry.value.contributions.filter(
    (c) => c.pluginId === selected.value && c.slot === 'settingsPage' && c.component,
  ),
);
watch(
  [() => installed.value?.id, () => installed.value?.configVersion],
  () => {
    const plugin = installed.value;
    invalidField.value = '';
    error.value = '';
    notice.value = '';
    values.value = { ...(plugin?.config || {}) };
    for (const [key, schema] of Object.entries(plugin?.manifest.configSchema.properties || {})) {
      const field = schema as any;
      if (field.writeOnly) values.value[key] = '';
      else if (field.type === 'object' || field.type === 'array')
        values.value[key] = JSON.stringify(
          values.value[key] ?? field.default ?? (field.type === 'array' ? [] : {}),
          null,
          2,
        );
      else if (values.value[key] === undefined && field.default !== undefined)
        values.value[key] = field.default;
    }
  },
  { immediate: true },
);
async function run(work: () => Promise<unknown>, action = 'refresh') {
  if (busy.value) return false;
  busy.value = true;
  pendingAction.value = action;
  error.value = '';
  notice.value = '';
  invalidField.value = '';
  try {
    await work();
    await refreshPlugins();
    return true;
  } catch (e) {
    error.value = (e as Error).message;
    return false;
  } finally {
    busy.value = false;
    pendingAction.value = '';
    if (invalidField.value) {
      advancedOpen.value = true;
      await nextTick();
      document.getElementById('plugin-field-' + invalidField.value)?.focus();
    }
  }
}
async function action(id: string, command: string) {
  await run(
    async () => {
      await api(`/api/platform/plugins/${id}/${command}`, 'POST', {});
      selected.value = command === 'uninstall' ? '' : id;
      tab.value = 'installed';
    },
    id + ':' + command,
  );
}
async function save() {
  const plugin = installed.value;
  if (!plugin) return;
  const saved = await run(async () => {
    const config = { ...values.value };
    for (const [key, schema] of Object.entries(plugin.manifest.configSchema.properties || {})) {
      const field = schema as any;
      if (field.writeOnly && config[key] === '') delete config[key];
      else if (field.type === 'object' || field.type === 'array') {
        try {
          const value = JSON.parse(config[key]);
          if (
            field.type === 'array'
              ? !Array.isArray(value)
              : !value || typeof value !== 'object' || Array.isArray(value)
          )
            throw Error();
          config[key] = value;
        } catch {
          invalidField.value = key;
          throw Error(
            `${field.title || key}格式不正确，请填写有效的 JSON ${field.type === 'array' ? '数组' : '对象'}。`,
          );
        }
      }
    }
    await api(`/api/platform/plugins/${plugin.id}/config`, 'PUT', {
      values: config,
      configVersion: plugin.configVersion,
    });
  }, 'save');
  if (saved) {
    await nextTick();
    notice.value = '插件配置已保存';
  }
}
watch(
  values,
  () => {
    notice.value = '';
    invalidField.value = '';
  },
  { deep: true },
);
const pendingUninstall = ref('');
onMounted(() => {
  void run(async () => {});
});
</script>
<template>
  <section class="plugin-manager">
    <header class="section-heading">
      <div>
        <h2>{{ focusPlugin ? '功能设置' : '扩展功能' }}</h2>
        <p class="muted">安装官方插件，为知识库添加功能。</p>
      </div>
      <AButton :loading="pendingAction === 'refresh'" :disabled="busy" @click="run(async () => {})">
        刷新插件状态
      </AButton>
    </header>
    <div v-if="selected && !focusPlugin" class="plugin-actions">
      <AButton
        :disabled="busy"
        @click="
          selected = '';
          advancedOpen = false;
        "
        >返回插件列表</AButton
      >
    </div>
    <ATabs v-if="!focusPlugin && !selected" v-model:active-key="tab"
      ><ATabPane key="installed" tab="已安装" /><ATabPane key="add" tab="添加插件"
    /></ATabs>
    <AAlert v-if="error" type="error" show-icon :message="error" class="plugin-feedback" />
    <AEmpty
      v-if="!catalog.length && !selected && !busy"
      class="plugin-empty"
      :image="AEmpty.PRESENTED_IMAGE_SIMPLE"
      :description="
        focusPlugin
          ? '当前安装源尚未提供此功能插件。'
          : tab === 'installed'
            ? '尚未安装插件，可在「添加插件」中查看。'
            : '当前没有其他可安装的官方插件。'
      "
    />
    <article v-for="entry in catalog" :key="entry.id" class="plugin-card">
      <div class="plugin-card-heading">
        <h3>
          {{ entry.title }} <small>v{{ entry.version }}</small>
        </h3>
        <span
          v-if="installedById.has(entry.id)"
          class="plugin-state"
          :class="{
            enabled: installedById.get(entry.id)?.state === 'enabled',
          }"
          >{{ stateLabels[installedById.get(entry.id)?.state || 'disabled'] }}</span
        >
        <span v-else class="plugin-state">未安装</span>
      </div>
      <p class="plugin-description">{{ entry.description }}</p>
      <p class="muted" style="font-size: 12px">
        {{ [...new Set(entry.capabilities.map(capability))].join(' · ') }}
      </p>
      <div class="plugin-actions">
        <template v-if="installedById.has(entry.id)">
          <AButton
            :class="{ 'is-selected': selected === entry.id }"
            :aria-pressed="selected === entry.id"
            :disabled="busy"
            @click="selected = entry.id"
            >配置</AButton
          >
          <AButton
            v-if="installedById.get(entry.id)?.state === 'enabled'"
            :aria-label="'停用' + entry.title"
            :loading="pendingAction === entry.id + ':disable'"
            :disabled="busy"
            @click="action(entry.id, 'disable')"
            >停用</AButton
          >
          <AButton
            v-else
            :aria-label="'启用' + entry.title"
            :loading="pendingAction === entry.id + ':enable'"
            :disabled="busy"
            @click="action(entry.id, 'enable')"
            >启用</AButton
          >
          <AButton
            v-if="installedById.get(entry.id)?.installedVersion !== entry.version"
            :loading="pendingAction === entry.id + ':upgrade'"
            :disabled="busy"
            @click="action(entry.id, 'upgrade')"
            >升级</AButton
          >
          <AButton type="text" :disabled="busy" @click="pendingUninstall = entry.id">卸载</AButton>
        </template>
        <AButton
          v-else
          type="primary"
          :aria-label="'安装' + entry.title"
          :loading="pendingAction === entry.id + ':install'"
          :disabled="busy"
          @click="action(entry.id, 'install')"
          >安装</AButton
        >
      </div>
    </article>
    <div v-if="pendingUninstall" class="plugin-confirm">
      <p>卸载后保留插件配置与数据。</p>
      <div class="plugin-actions">
        <AButton
          danger
          :disabled="busy"
          @click="
            action(pendingUninstall, 'uninstall');
            pendingUninstall = '';
          "
          >确认卸载</AButton
        ><AButton :disabled="busy" @click="pendingUninstall = ''">取消</AButton>
      </div>
    </div>
    <div v-if="installed" class="plugin-settings">
      <header class="settings-heading">
        <h3>{{ installed.manifest.title }}设置</h3>
        <p class="muted">调整插件参数，管理运行状态。 · {{ stateLabels[installed.state] }}</p>
        <div class="plugin-actions" style="margin-top: 12px">
          <AButton
            v-if="installed.state === 'enabled'"
            :disabled="busy"
            :loading="pendingAction === installed.id + ':disable'"
            @click="action(installed.id, 'disable')"
            >停用插件</AButton
          ><AButton
            v-else
            :disabled="busy"
            :loading="pendingAction === installed.id + ':enable'"
            @click="action(installed.id, 'enable')"
            >启用插件</AButton
          ><AButton type="text" :disabled="busy" @click="pendingUninstall = installed.id"
            >卸载插件</AButton
          >
        </div>
        <details>
          <summary>插件能力与版本</summary>
          <p>版本 {{ installed.installedVersion }}</p>
          <ul>
            <li v-for="cap in installed.manifest.capabilities" :key="cap">
              {{ capability(cap) }} <code>{{ cap }}</code>
            </li>
          </ul>
        </details>
      </header>
      <AAlert
        v-if="installed.error"
        type="error"
        show-icon
        :message="'插件状态：' + installed.error"
      />
      <AAlert
        v-if="installed.restartRequired"
        type="warning"
        show-icon
        message="配置或版本需要重启生效"
        description="请在服务器运行 dooknow restart。"
      />
      <form class="plugin-form" @submit.prevent="save">
        <div
          v-for="(field, key) in standardFields as Record<string, any>"
          :key="key"
          class="plugin-field"
          :class="{
            'field-wide': ['array', 'object'].includes(field.type),
            'field-toggle': field.type === 'boolean',
          }"
        >
          <div class="field-heading">
            <label :for="'plugin-field-' + key">{{ field.title || key }}</label>
            <span v-if="['array', 'object'].includes(field.type)" class="field-format">JSON</span>
          </div>
          <ASwitch
            v-if="field.type === 'boolean'"
            v-model:checked="values[key]"
            :id="'plugin-field-' + key"
            :aria-label="field.title || key"
            :disabled="busy"
          />
          <AInputNumber
            v-else-if="field.type === 'integer' || field.type === 'number'"
            v-model:value="values[key]"
            :id="'plugin-field-' + key"
            :aria-label="field.title || String(key)"
            :disabled="busy"
          />
          <ASelect
            v-else-if="field.enum"
            v-model:value="values[key]"
            :id="'plugin-field-' + key"
            :options="field.enum.map((v: any) => ({ label: String(v), value: v }))"
            :aria-label="field.title || String(key)"
            :disabled="busy"
          />
          <AInput.Password
            v-else-if="field.writeOnly"
            v-model:value="values[key]"
            :id="'plugin-field-' + key"
            :aria-label="field.title || String(key)"
            :disabled="busy"
            :placeholder="
              installed.configuredSecrets.includes(String(key))
                ? '已配置；留空保留'
                : field.description || ''
            "
            autocomplete="new-password"
          />
          <AInput.TextArea
            v-else-if="['array', 'object'].includes(field.type)"
            v-model:value="values[key]"
            :id="'plugin-field-' + key"
            :aria-label="field.title || String(key)"
            :aria-invalid="invalidField === String(key)"
            :status="invalidField === String(key) ? 'error' : undefined"
            :disabled="busy"
            :auto-size="{ minRows: 3, maxRows: 8 }"
            :placeholder="field.description || ''"
            spellcheck="false"
          />
          <AInput
            v-else
            v-model:value="values[key]"
            :id="'plugin-field-' + key"
            :aria-label="field.title || String(key)"
            :disabled="busy"
            :placeholder="field.description || ''"
          />
          <AButton
            v-if="field.writeOnly && installed.configuredSecrets.includes(String(key))"
            size="small"
            type="text"
            :disabled="busy"
            class="clear-secret"
            @click="values[key] = null"
            >清除已配置值</AButton
          >
          <p v-if="field.description" class="muted">{{ field.description }}</p>
          <p v-else-if="['array', 'object'].includes(field.type)" class="muted">
            {{
              field.type === 'array'
                ? '请填写有效的 JSON 数组，保留方括号与原有数据格式。'
                : '使用 JSON 对象填写配置，保留键名与数据格式。'
            }}
          </p>
        </div>
        <details
          v-if="Object.keys(advancedFields).length"
          :open="advancedOpen"
          class="field-wide plugin-advanced"
          @toggle="advancedOpen = ($event.target as HTMLDetailsElement).open"
        >
          <summary>高级配置</summary>
          <p class="muted">用于需要完整结构的参数。填写有效的 JSON 后保存。</p>
          <div
            v-for="(field, key) in advancedFields as Record<string, any>"
            :key="key"
            class="plugin-field field-wide"
            style="margin-top: 16px"
          >
            <label :for="'plugin-field-' + key">{{ field.title || key }}</label>
            <AInput.TextArea
              v-model:value="values[key]"
              :id="'plugin-field-' + key"
              :aria-label="field.title || String(key)"
              :aria-invalid="invalidField === String(key)"
              :status="invalidField === String(key) ? 'error' : undefined"
              :disabled="busy"
              :auto-size="{ minRows: 3, maxRows: 8 }"
              spellcheck="false"
            />
            <p v-if="invalidField === String(key)" class="plugin-field-error" role="alert">
              {{ error }}
            </p>
            <p v-else class="muted">{{ field.description }}</p>
          </div>
        </details>
        <footer class="plugin-form-footer">
          <AButton
            html-type="submit"
            type="primary"
            :loading="pendingAction === 'save'"
            :disabled="busy"
            >保存插件配置</AButton
          >
          <span v-if="notice" class="form-success" role="status">{{ notice }}</span>
        </footer>
      </form>
      <AAlert
        v-if="pluginUIErrors[installed.id]"
        type="error"
        show-icon
        :message="pluginUIErrors[installed.id]"
      />
      <div v-if="settingsPages.length" class="plugin-live-settings">
        <PluginBoundary v-for="page in settingsPages" :key="page.id"
          ><component
            v-if="page.component && pluginComponents[page.component]"
            :is="pluginComponents[page.component]"
            :context="{}"
        /></PluginBoundary>
      </div>
    </div>
  </section>
</template>
<style scoped>
.plugin-manager {
  min-width: 0;
  margin-top: 28px;
  color: var(--text, #262b36);
}
.section-heading,
.plugin-card-heading,
.field-heading {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}
.section-heading {
  margin-bottom: 16px;
}
.section-heading > div,
.plugin-card-heading h3 {
  min-width: 0;
  overflow-wrap: anywhere;
}
.section-heading h2 {
  margin: 0 0 5px;
  font-size: 18px;
}
.section-heading p,
.settings-heading p {
  margin: 0;
  font-size: 13px;
  line-height: 1.6;
}
.section-heading > .ant-btn {
  flex-shrink: 0;
}
.plugin-card,
.plugin-settings {
  min-width: 0;
  border: 1px solid var(--border, #e3e6ec);
  border-radius: 8px;
  padding: 16px;
  margin: 12px 0;
  background: var(--panel, #fff);
}
.plugin-card h3,
.settings-heading h3 {
  margin: 0;
  font-size: 15px;
  font-weight: 600;
}
.plugin-card small {
  margin-left: 5px;
  font-size: 11px;
  color: var(--muted, #7a8190);
  font-weight: 400;
}
.plugin-state {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  flex-shrink: 0;
  font-size: 12px;
  color: var(--muted, #7a8190);
}
.plugin-state::before {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  content: '';
  background: #bec4cf;
}
.plugin-state.enabled {
  color: var(--blue, #4566c6);
}
.plugin-state.enabled::before {
  background: var(--blue, #4566c6);
}
.plugin-description {
  margin: 8px 0 13px;
  color: var(--muted, #7a8190);
  font-size: 13px;
  line-height: 1.65;
  overflow-wrap: anywhere;
}
.plugin-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}
.plugin-actions .is-selected {
  border-color: #c7d1ec;
  background: #f0f3fb;
  color: var(--blue, #4566c6);
}
.plugin-feedback {
  margin-bottom: 14px;
  overflow-wrap: anywhere;
}
.plugin-confirm {
  margin: 12px 0;
  padding: 13px 16px;
  background: var(--surface, #f5f6f8);
  border: 1px solid var(--border, #e3e6ec);
  border-radius: 8px;
}
.plugin-confirm p {
  margin: 0 0 10px;
  font-size: 13px;
}
.settings-heading {
  margin-bottom: 18px;
}
.settings-heading p {
  margin-top: 5px;
}
.plugin-settings > .ant-alert {
  margin-bottom: 14px;
}
.plugin-form {
  display: grid;
  width: 100%;
  max-width: none;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 16px;
}
.plugin-form :deep(.ant-btn) {
  margin: 0;
}
.plugin-field {
  min-width: 0;
}
.plugin-field > .ant-select,
.plugin-field > .ant-input-number {
  width: 100%;
}
.field-wide,
.plugin-form-footer {
  grid-column: 1 / -1;
}
.field-heading {
  margin-bottom: 7px;
}
.plugin-field label {
  font-size: 13px;
  font-weight: 500;
  line-height: 1.5;
}
.field-format {
  padding: 1px 5px;
  background: var(--surface, #f5f6f8);
  border-radius: 4px;
  color: var(--muted, #7a8190);
  font-size: 10px;
  letter-spacing: 0.04em;
}
.plugin-field .plugin-advanced {
  font-size: 13px;
  line-height: 1.75;
}
.plugin-advanced summary {
  cursor: pointer;
  color: var(--blue, #4566c6);
}
.plugin-field-error {
  color: var(--danger, #b43e3e);
  font-size: 12px;
}
.muted {
  margin: 6px 0 0;
  font-size: 12px;
  line-height: 1.6;
  overflow-wrap: anywhere;
}
.field-wide :deep(textarea) {
  font-family: ui-monospace, SFMono-Regular, Consolas, monospace;
  font-size: 12px;
  line-height: 1.65;
}
.field-toggle {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  align-content: center;
  align-items: center;
  column-gap: 12px;
  padding: 11px 12px;
  border-radius: 6px;
  background: var(--surface-soft, #fafbfc);
  border: 1px solid var(--border, #e3e6ec);
}
.field-toggle .field-heading {
  margin: 0;
}
.field-toggle .plugin-advanced {
  font-size: 13px;
  line-height: 1.75;
}
.plugin-advanced summary {
  cursor: pointer;
  color: var(--blue, #4566c6);
}
.plugin-field-error {
  color: var(--danger, #b43e3e);
  font-size: 12px;
}
.muted {
  grid-column: 1 / -1;
}
.plugin-form :deep(.clear-secret) {
  margin: 4px 0 0;
}
.plugin-form-footer {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 10px 14px;
  padding-top: 2px;
}
.plugin-form-footer .form-success {
  margin: 0;
}
.plugin-live-settings {
  min-width: 0;
  margin-top: 22px;
  padding-top: 20px;
  border-top: 1px solid var(--border, #e3e6ec);
}
.plugin-empty {
  margin: 12px 0;
  padding: 24px 16px;
  border: 1px dashed var(--border, #e3e6ec);
  border-radius: 8px;
  color: var(--muted, #7a8190);
  font-size: 13px;
  text-align: center;
}
.plugin-advanced {
  font-size: 13px;
  line-height: 1.75;
}
.plugin-advanced summary {
  cursor: pointer;
  color: var(--blue, #4566c6);
}
.plugin-field-error {
  color: var(--danger, #b43e3e);
  font-size: 12px;
}
.muted {
  color: var(--muted, #7a8190);
}
@media (max-width: 600px) {
  .section-heading {
    align-items: flex-start;
    flex-direction: column;
    gap: 10px;
  }
  .plugin-card,
  .plugin-settings {
    padding: 14px;
  }
  .plugin-form {
    grid-template-columns: minmax(0, 1fr);
    gap: 14px;
  }
  .plugin-card-heading {
    align-items: flex-start;
  }
  .plugin-card h3 {
    display: flex;
    flex-wrap: wrap;
    gap: 3px 6px;
  }
  .plugin-card small {
    margin-left: 0;
  }
}
</style>
