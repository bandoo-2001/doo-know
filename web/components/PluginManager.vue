<script setup lang="ts">
import { ref, computed, watch, onMounted } from 'vue';
import { NButton, NInput, NSwitch, NInputNumber, NSelect, NAlert } from 'naive-ui';
import { pluginRegistry, pluginUIErrors, refreshPlugins } from '../plugins';
import { pluginComponents } from '../../packages/plugin-ui/host';
import PluginBoundary from './PluginBoundary.vue';
import { api } from '../api';
const selected = ref(''), busy = ref(false), error = ref(''), values = ref<Record<string, any>>({});
const installed = computed(() => pluginRegistry.value.installed.find(p => p.id === selected.value));
const settingsPages = computed(() => pluginRegistry.value.contributions.filter(c => c.pluginId === selected.value && c.slot === 'settingsPage' && c.component));
watch([() => installed.value?.id, () => installed.value?.configVersion], () => {
  const plugin = installed.value; values.value = { ...(plugin?.config || {}) };
  for (const [key, schema] of Object.entries(plugin?.manifest.configSchema.properties || {})) {
    const field = schema as any;
    if (field.writeOnly) values.value[key] = '';
    else if (field.type === 'object' || field.type === 'array') values.value[key] = JSON.stringify(values.value[key] ?? field.default ?? (field.type === 'array' ? [] : {}), null, 2);
    else if (values.value[key] === undefined && field.default !== undefined) values.value[key] = field.default;
  }
});
async function run(work: () => Promise<unknown>) { busy.value = true; error.value = ''; try { await work(); await refreshPlugins(); } catch (e) { error.value = (e as Error).message; } finally { busy.value = false; } }
async function action(id: string, command: string) {
  await run(async () => { await api(`/api/platform/plugins/${id}/${command}`, 'POST', {}); selected.value = id; });
}
async function save() {
  const plugin = installed.value; if (!plugin) return;
  await run(async () => {
    const config = { ...values.value };
    for (const [key, schema] of Object.entries(plugin.manifest.configSchema.properties || {})) {
      const field = schema as any;
      if (field.writeOnly && config[key] === '') delete config[key];
      else if (field.type === 'object' || field.type === 'array') config[key] = JSON.parse(config[key]);
    }
    await api(`/api/platform/plugins/${plugin.id}/config`, 'PUT', { values: config, configVersion: plugin.configVersion });
  });
}
const pendingUninstall = ref('');
onMounted(() => { void run(refreshPlugins); });
</script>
<template>
  <section class="plugin-manager">
    <h2>插件市场</h2><p class="muted">安装官方插件，为知识库添加功能。</p>
    <NAlert v-if="error" type="error">{{ error }}</NAlert>
    <p v-if="!pluginRegistry.catalog.length" class="muted">当前安装源尚未提供可安装的官方插件。</p>
    <article v-for="entry in pluginRegistry.catalog" :key="entry.id" class="plugin-card">
      <h3>{{ entry.title }} <small>{{ entry.version }}</small></h3><p>{{ entry.description }}</p>
      <template v-if="pluginRegistry.installed.find(p => p.id === entry.id)">
        <span>{{ pluginRegistry.installed.find(p => p.id === entry.id)?.state === 'enabled' ? '已启用' : '未启用' }}</span>
        <NButton @click="selected = entry.id">配置</NButton>
        <NButton v-if="pluginRegistry.installed.find(p => p.id === entry.id)?.state === 'enabled'" :aria-label="'停用' + entry.title" :loading="busy" @click="action(entry.id, 'disable')">停用</NButton>
        <NButton v-else :aria-label="'启用' + entry.title" :loading="busy" @click="action(entry.id, 'enable')">启用</NButton>
        <NButton v-if="pluginRegistry.installed.find(p => p.id === entry.id)?.installedVersion !== entry.version" :loading="busy" @click="action(entry.id, 'upgrade')">升级</NButton>
        <NButton @click="pendingUninstall = entry.id">卸载</NButton>
      </template>
      <NButton v-else :aria-label="'安装' + entry.title" :loading="busy" @click="action(entry.id, 'install')">安装</NButton>
    </article>
    <div v-if="pendingUninstall" class="plugin-card"><p>卸载后保留插件配置与数据。</p><NButton @click="action(pendingUninstall, 'uninstall'); pendingUninstall = ''">确认卸载</NButton><NButton @click="pendingUninstall = ''">取消</NButton></div>
    <div v-if="installed" class="plugin-card">
      <h3>{{ installed.manifest.title }}设置</h3>
      <NAlert v-if="installed.error" type="error">插件状态：{{ installed.error }}</NAlert>
      <NAlert v-if="installed.restartRequired" type="warning">配置或版本需要重启生效，请在服务器运行 dooknow restart。</NAlert>
      <form @submit.prevent="save">
        <div v-for="(field, key) in (installed.manifest.configSchema.properties as Record<string, any>)" :key="key" class="plugin-field">
          <label :for="'plugin-field-' + key">{{ field.title || key }}</label>
          <NSwitch v-if="field.type === 'boolean'" v-model:value="values[key]" :aria-label="field.title || key" />
          <NInputNumber v-else-if="field.type === 'integer' || field.type === 'number'" v-model:value="values[key]" :input-props="{ id: 'plugin-field-' + key }" />
          <NSelect v-else-if="field.enum" v-model:value="values[key]" :options="field.enum.map((v: any) => ({ label: String(v), value: v }))" />
          <NInput v-else v-model:value="values[key]" :type="field.writeOnly ? 'password' : ['array','object'].includes(field.type) ? 'textarea' : 'text'" :placeholder="field.writeOnly && installed.configuredSecrets.includes(String(key)) ? '已配置；留空保留' : field.description || ''" :input-props="{ id: 'plugin-field-' + key, 'aria-label': field.title || String(key) }" />
          <NButton v-if="field.writeOnly && installed.configuredSecrets.includes(String(key))" size="small" @click="values[key] = null">清除已配置值</NButton>
          <p v-if="field.description" class="muted">{{ field.description }}</p>
        </div>
        <NButton attr-type="submit" type="primary" :loading="busy">保存插件配置</NButton>
      </form>
      <NAlert v-if="pluginUIErrors[installed.id]" type="error">{{ pluginUIErrors[installed.id] }}</NAlert>
      <PluginBoundary v-for="page in settingsPages" :key="page.id"><component v-if="page.component && pluginComponents[page.component]" :is="pluginComponents[page.component]" :context="{}" /></PluginBoundary>
    </div>
    <NButton :loading="busy" @click="run(refreshPlugins)">刷新插件状态</NButton>
  </section>
</template>
<style scoped>
.plugin-manager { margin-top: 36px; }.plugin-card { border: 1px solid #d0e3f5; border-radius: 8px; padding: 16px; margin: 14px 0; }
.plugin-card .n-button { margin: 4px 8px 4px 0; }.plugin-field { margin: 16px 0; }.plugin-field label { display: block; margin-bottom: 6px; }small { color: #71879b; font-weight: normal; }
</style>
