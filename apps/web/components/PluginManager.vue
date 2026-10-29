<script setup lang="ts">
import { ref, computed, watch, onMounted, onBeforeUnmount, nextTick } from 'vue';
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
  Popconfirm as APopconfirm,
} from 'ant-design-vue';
import type { PluginView, PluginDataDependency } from '../../../packages/plugin-contracts';
import { pluginRegistry, pluginUIErrors, refreshPlugins } from '../plugins';
import { pluginComponents } from '../../../packages/plugin-ui/host';
import PluginBoundary from './PluginBoundary.vue';
import Icon from './Icon.vue';
import MCPConnectionGuide from './MCPConnectionGuide.vue';
import MCPDomainPermissions from './MCPDomainPermissions.vue';
import GitRemotePanel from './GitRemotePanel.vue';
import SettingsOverlay from './settings/SettingsOverlay.vue';
import {
  installPlugin,
  jobPhases,
  gitError,
  jobPending,
  type PluginInstallation,
} from '../git-sync';
import { api, ApiError } from '../api';
import { pluginDrafts as drafts, pluginDraftSession, storePluginDraft } from '../plugin-drafts';
import {
  createPluginDraft,
  refreshPluginDraft,
  pluginDraftDirty,
  pluginFieldVisible,
  serializePluginDraft,
  PluginConfigError,
} from '../plugin-config';
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
const dataDependencies = computed(() =>
  (pluginRegistry.value.dataDependencies || []).filter(
    (dependency) => dependency.state !== 'enabled' && (!props.focusPlugin || dependency.id === props.focusPlugin),
  ),
);
function dependencyMessage(dependency: PluginDataDependency) {
  const messages: Record<PluginDataDependency['state'], string> = {
    missing: '用户资料已保留，安装插件后可继续使用。',
    unavailable: '用户资料已保留，当前安装源未提供此插件。',
    disabled: '用户资料已保留，插件当前未启用。',
    enabled: '用户资料已保留。',
    version_mismatch: `资料由 v${dependency.version} 保存，当前安装版本为 v${dependency.installedVersion}，请核对插件版本。`,
    incompatible: '用户资料需要其他版本的插件接口，请核对 DooKnow 与插件版本。',
    invalid: '用户资料暂时无法读取，请核对知识库中的插件数据文件与同步状态。',
  };
  return messages[dependency.state];
}
const installed = computed(() =>
  pluginRegistry.value.installed.find((p) => p.id === selected.value),
);
const installation = ref<PluginInstallation>();
const installationController = new AbortController();
const draftSession = pluginDraftSession();
let active = true;
const currentDraftSession = () => active && draftSession === pluginDraftSession();
onBeforeUnmount(() => {
  active = false;
  installationController.abort();
});
const draft = computed(() => installed.value && drafts[installed.value.id]);
const dirty = computed(() => !!draft.value && pluginDraftDirty(draft.value));
const remoteChanged = computed(
  () =>
    !!draft.value &&
    (draft.value.conflicted || draft.value.configVersion !== installed.value?.configVersion),
);
function prefixField(key: string | number) {
  return installed.value?.id === 'mcp' && key === 'allowedPrefixes';
}
function taskArrayField(key: string | number) {
  return installed.value?.id === 'mcp' && ['toDooListIds', 'toDooDomains'].includes(String(key));
}
function arrayValue(key: string | number): string[] {
  try { const value = JSON.parse(values.value[key] || '[]'); return Array.isArray(value) ? value : []; } catch { return []; }
}
const toDooListOptions = ref<{label:string;value:string}[]>([{ label: '收集箱', value: 'inbox' }]);
const taskDomainOptions = [ ['tasks','任务与目标'],['records','成果与进展记录'],['focus','专注记录'],['habits','习惯与打卡'],['anniversaries','纪念日'],['calendar','日历数据'],['statistics','统计摘要'],['settings','应用偏好'] ].map(([value,label]) => ({value,label}));
watch([() => installed.value?.id, () => values.value.allowToDoo], async ([id, allowed]) => {
  if (id !== 'mcp' || !allowed) return;
  try {
    const result = await api('/api/to-doo/state?kind=list&limit=1000');
    if (!currentDraftSession() || installed.value?.id !== 'mcp') return;
    toDooListOptions.value = [{ label: '收集箱', value: 'inbox' }, ...result.lists.filter((list:any) => !list.deletedAt).map((list:any) => ({label:list.name,value:list.id})), ...arrayValue('toDooListIds').filter(id => id !== 'inbox' && !result.lists.some((list:any) => list.id === id)).map(value => ({label:'已选择的清单（暂不可用）',value}))];
  } catch { /* Keep saved selections; application availability must not erase configuration. */ }
});
function requirement(key: string | number) {
  if (prefixField(key)) return '必填';
  if (installed.value?.id === 'mcp' && key === 'mode') return '必选';
  return installed.value?.manifest.configSchema.required?.includes(String(key)) ? '必填' : '选填';
}
function enumOptions(key: string | number, field: any) {
  const modes: Record<string, string> = {
    oauth: '网页授权（OAuth）',
    tunnel: '本地隧道（Tunnel）',
    both: '同时启用',
  };
  return field.enum.map((value: any) => ({
    label:
      installed.value?.id === 'mcp' && key === 'mode'
        ? modes[value] || String(value)
        : String(value),
    value,
  }));
}
const standardFields = computed(() =>
  Object.fromEntries(
    Object.entries(installed.value?.manifest.configSchema.properties || {}).filter(
      ([key, field]) =>
        !(installed.value?.id === 'mcp' && ['permissionPolicy','readOnly','allowIndex','allowPublish','allowToDoo','allowToDooWrite','allowedPrefixes'].includes(key)) &&
        (!['object', 'array'].includes((field as any).type) || prefixField(key) || taskArrayField(key)) &&
        pluginFieldVisible(installed.value?.id || '', key, values.value.mode),
    ),
  ),
);
const legacyOpen=ref(false);
const legacyFields=computed(()=>Object.fromEntries(Object.entries(installed.value?.manifest.configSchema.properties || {}).filter(([key])=>['readOnly','allowIndex','allowPublish','allowToDoo','allowToDooWrite','allowedPrefixes'].includes(key))));
const advancedFields = computed(() =>
  Object.fromEntries(
    Object.entries(installed.value?.manifest.configSchema.properties || {}).filter(
      ([key, field]) => key !== 'permissionPolicy' && ['object', 'array'].includes((field as any).type) && !prefixField(key) && !taskArrayField(key),
    ),
  ),
);
const capabilityLabels: Record<string, string> = {
  'knowledge:read': '读取知识库',
  'knowledge:write': '写入知识库',
  'knowledge:index': '维护搜索索引',
  'knowledge:organize': '整理知识库目录',
  'knowledge:archive': '归档资料',
  'knowledge:share': '管理资料分享',
  'knowledge:manage': '维护知识库资料',
  'blog:read': '查看博客状态',
  'blog:write': '编辑博客草稿',
  'blog:manage': '管理博客站点与文章',
  'to-doo:read': '读取 To Doo',
  'to-doo:write': '修改 To Doo',
  'to-doo:share': '导出与分享 To Doo',
  'to-doo:integrations': '管理日历与提醒设备',
  'blog:publish': '公开发布与撤下博客文章',
  'protocol:mcp': '连接 AI 应用',
  'workspace:git': '本地文件版本',
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
    if (!currentDraftSession()) return;
    const plugin = installed.value;
    invalidField.value = '';
    error.value = '';
    notice.value = '';
    if (!plugin) {
      values.value = {};
      return;
    }
    const next = drafts[plugin.id]
      ? refreshPluginDraft(drafts[plugin.id], plugin)
      : createPluginDraft(plugin);
    if (!storePluginDraft(next, draftSession)) return;
    values.value = drafts[plugin.id].values;
  },
  { immediate: true },
);
async function run(work: () => Promise<unknown>, action = 'refresh') {
  if (busy.value || !currentDraftSession()) return false;
  busy.value = true;
  pendingAction.value = action;
  error.value = '';
  notice.value = '';
  invalidField.value = '';
  let completed = false;
  try {
    await work();
    completed = true;
    if (!currentDraftSession()) return false;
    await refreshPlugins();
    return currentDraftSession();
  } catch (e) {
    if (!currentDraftSession()) return false;
    const readOnly = action === 'refresh' || action === 'reload';
    const uncertain =
      (e instanceof ApiError && e.status === 0) ||
      e instanceof TypeError ||
      (e instanceof Error && ['TimeoutError', 'AbortError'].includes(e.name));
    if (completed && !readOnly) error.value = '操作已完成，但未能读取最新状态，请刷新核对。';
    else if (uncertain && !readOnly) error.value = '操作结果尚未确认，请先刷新状态核对。';
    else if (readOnly && !(e instanceof PluginConfigError))
      error.value = '暂时无法读取插件状态，请检查连接后重试。';
    else if (e instanceof ApiError && e.data.code === 'PLUGIN_RESTART_REQUIRED')
      error.value = '配置或版本需要重启生效，请重启 DooKnow 后再启用插件。';
    else if (action.endsWith(':install') || action.endsWith(':upgrade')) error.value = gitError(e);
    else error.value = (e as Error).message;
    return false;
  } finally {
    busy.value = false;
    pendingAction.value = '';
    if (currentDraftSession() && invalidField.value) {
      advancedOpen.value = true;
      await nextTick();
      if (currentDraftSession())
        document.getElementById('plugin-field-' + invalidField.value)?.focus();
    }
  }
}
async function refreshStatus() {
  const refreshed = await run(async () => {});
  if (
    refreshed &&
    (installation.value?.status === 'failed' || installation.value?.status === 'succeeded')
  )
    installation.value = undefined;
}
async function action(id: string, command: string) {
  await run(
    async () => {
      if (command === 'install' || command === 'upgrade') {
        await installPlugin(id, {
          signal: installationController.signal,
          onUpdate: (job) => {
            if (currentDraftSession()) installation.value = job;
          },
        });
      } else await api(`/api/platform/plugins/${id}/${command}`, 'POST', {});
      selected.value = command === 'uninstall' ? '' : id;
      tab.value = 'installed';
    },
    id + ':' + command,
  );
}
async function save() {
  const plugin = installed.value;
  const currentDraft = draft.value;
  if (!plugin || !currentDraft || remoteChanged.value) return;
  const saved = await run(async () => {
    try {
      const updated = await api<PluginView>(
        `/api/platform/plugins/${plugin.id}/config`,
        'PUT',
        serializePluginDraft(currentDraft, plugin),
      );
      if (!currentDraftSession() || !storePluginDraft(createPluginDraft(updated), draftSession))
        return;
      if (selected.value === plugin.id) values.value = drafts[plugin.id].values;
    } catch (e) {
      if (!currentDraftSession()) return;
      if (e instanceof PluginConfigError) invalidField.value = e.field;
      if ((e as Error).message.includes('CONFIG_VERSION_CONFLICT')) {
        currentDraft.conflicted = true;
        await refreshPlugins().catch(() => {});
        throw Error('远端配置已经变化，未保存的输入已保留。请先重新载入已保存配置。');
      }
      throw e;
    }
  }, 'save');
  if (saved) {
    await nextTick();
    notice.value =
      installed.value?.state === 'enabled'
        ? '插件配置已保存。'
        : '插件配置已保存，请启用插件后使用连接功能。';
  }
}
async function reloadConfig() {
  const id = installed.value?.id;
  if (!id) return;
  const reloaded = await run(async () => {
    await refreshPlugins();
    const plugin = pluginRegistry.value.installed.find((entry) => entry.id === id);
    if (!plugin) throw Error('插件已经卸载，请刷新插件列表。');
    if (!currentDraftSession() || !storePluginDraft(createPluginDraft(plugin), draftSession))
      return;
    values.value = drafts[id].values;
  }, 'reload');
  if (reloaded) {
    await nextTick();
    notice.value = '已重新载入已保存配置。';
  }
}
async function generateConnectionKey() {
  values.value.tunnelToken = Array.from(crypto.getRandomValues(new Uint8Array(32)), (byte) =>
    byte.toString(16).padStart(2, '0'),
  ).join('');
  await nextTick();
  notice.value = '已在本浏览器生成连接密钥，请保存插件配置。';
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
function openUninstall(id: string) {
  error.value = '';
  pendingUninstall.value = id;
}
async function confirmUninstall() {
  const id = pendingUninstall.value;
  if (!id || busy.value) return;
  await action(id, 'uninstall');
  if (!error.value) pendingUninstall.value = '';
}
onMounted(() => {
  void run(async () => {
    const response = await api<{ items: PluginInstallation[] }>(
      '/api/platform/plugin-installations',
    );
    if (!currentDraftSession()) return;
    const pending = response.items.find(
      (entry) => (!props.focusPlugin || entry.pluginId === props.focusPlugin) && jobPending(entry),
    );
    installation.value =
      pending || response.items.find((entry) => entry.status === 'needs_reconciliation');
    if (pending)
      await installPlugin(pending.pluginId, {
        receiptId: pending.id,
        signal: installationController.signal,
        onUpdate: (job) => {
          if (currentDraftSession()) installation.value = job;
        },
      });
  });
});
</script>
<template>
  <section class="plugin-manager">
    <header class="section-heading">
      <div v-if="focusPlugin">
        <h2 class="settings-section-title"><Icon name="plug" :size="18" />功能设置</h2>
      </div>
      <AButton
        v-else-if="selected"
        :disabled="busy"
        @click="
          selected = '';
          advancedOpen = false;
        "
        ><template #icon><Icon class="settings-button-icon" name="back" :size="15" /></template
        >返回插件列表</AButton
      >
      <!-- Keep rc-tabs from capturing vertical page swipes. -->
      <ATabs v-else v-model:active-key="tab" @touchstart.capture.stop
        ><ATabPane key="installed"
          ><template #tab
            ><span class="plugin-tab"><Icon name="check" :size="15" />已安装</span></template
          ></ATabPane
        >
        <ATabPane key="add"
          ><template #tab
            ><span class="plugin-tab"><Icon name="plus" :size="15" />添加插件</span></template
          ></ATabPane
        >
      </ATabs>
      <AButton :loading="pendingAction === 'refresh'" :disabled="busy" @click="refreshStatus"
        ><template #icon><Icon class="settings-button-icon" name="refresh" :size="15" /></template>
        刷新插件状态
      </AButton>
    </header>
    <AAlert v-if="error" type="error" show-icon :message="error" class="plugin-feedback" />
    <AAlert
      v-for="dependency in dataDependencies"
      :key="'data-' + dependency.id"
      type="info"
      show-icon
      :message="dependency.title + ' · 用户资料'"
      :description="dependencyMessage(dependency)"
      class="plugin-feedback"
    >
      <template v-if="dependency.state === 'missing' && dependency.installAvailable" #action>
        <AButton
          size="small"
          :disabled="busy"
          :loading="pendingAction === dependency.id + ':install'"
          @click="action(dependency.id, 'install')"
          >安装插件</AButton
        >
      </template>
    </AAlert>
    <p v-if="installation" class="plugin-feedback" role="status">
      {{ jobPhases[installation.phase] || '准备安装' }} ·
      {{
        installation.status === 'needs_reconciliation'
          ? '结果待核对，请刷新安装状态后重试。'
          : jobPending(installation)
            ? '下载与安装在服务器上继续，离开后可以回来查看。'
            : installation.status === 'succeeded'
              ? '安装完成'
              : '安装未完成，请刷新核对后重试。'
      }}
    </p>
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
        <div class="plugin-identity">
          <span class="plugin-icon"
            ><Icon
              :name="entry.id === 'git' ? 'git-branch' : entry.id === 'mcp' ? 'link' : 'plug'"
              :size="20"
          /></span>
          <h3>
            {{ entry.title }} <small>v{{ entry.version }}</small>
          </h3>
        </div>
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
            ><template #icon
              ><Icon class="settings-button-icon" name="settings" :size="15" /></template
            >配置</AButton
          >
          <AButton
            v-if="installedById.get(entry.id)?.state === 'enabled'"
            :aria-label="'停用' + entry.title"
            :loading="pendingAction === entry.id + ':disable'"
            :disabled="busy"
            @click="action(entry.id, 'disable')"
            ><template #icon><Icon class="settings-button-icon" name="power" :size="15" /></template
            >停用</AButton
          >
          <AButton
            v-else
            :aria-label="'启用' + entry.title"
            :loading="pendingAction === entry.id + ':enable'"
            :disabled="busy"
            @click="action(entry.id, 'enable')"
            ><template #icon><Icon class="settings-button-icon" name="power" :size="15" /></template
            >启用</AButton
          >
          <AButton
            v-if="installedById.get(entry.id)?.installedVersion !== entry.version"
            :loading="pendingAction === entry.id + ':upgrade'"
            :disabled="busy"
            @click="action(entry.id, 'upgrade')"
            ><template #icon
              ><Icon class="settings-button-icon" name="arrow-up" :size="15" /></template
            >升级</AButton
          >
          <AButton type="text" :disabled="busy" @click="openUninstall(entry.id)"
            ><template #icon><Icon class="settings-button-icon" name="trash" :size="15" /></template
            >卸载</AButton
          >
        </template>
        <AButton
          v-else
          type="primary"
          :aria-label="'安装' + entry.title"
          :loading="pendingAction === entry.id + ':install'"
          :disabled="busy"
          @click="action(entry.id, 'install')"
          ><template #icon
            ><Icon class="settings-button-icon" name="download" :size="15" /></template
          >安装</AButton
        >
      </div>
    </article>
    <SettingsOverlay
      :show="!!pendingUninstall"
      title="卸载插件"
      description="卸载后保留插件配置与数据，可按需重新安装。"
      icon="trash"
      :busy="busy"
      @update:show="
        (value) => {
          if (!value) pendingUninstall = '';
        }
      "
    >
      <p>卸载后保留插件配置与数据。</p>
      <p v-if="pendingUninstall === 'mcp'">
        已有连接授权也会保留。如需撤销，请先在连接引导中撤销授权。
      </p>
      <AAlert v-if="error" type="error" show-icon :message="error" />
      <template #footer="{ close }"
        ><AButton :disabled="busy" @click="close">取消</AButton
        ><AButton danger :loading="busy" @click="confirmUninstall"
          ><template #icon><Icon class="settings-button-icon" name="trash" :size="15" /></template
          >确认卸载</AButton
        ></template
      >
    </SettingsOverlay>
    <div v-if="installed" class="plugin-settings">
      <header class="settings-heading">
        <h3 class="settings-section-title">
          <Icon
            :name="installed.id === 'git' ? 'git-branch' : installed.id === 'mcp' ? 'link' : 'plug'"
            :size="18"
          />{{ installed.manifest.title }}设置
        </h3>
        <p v-if="installed.id === 'git'" class="muted">
          版本记录保存在当前知识库。可在云端同步中关联
          GitHub／Gitee，手动推送或拉取；版本记录不能替代备份。
        </p>
        <p class="muted">调整插件参数，管理运行状态。 · {{ stateLabels[installed.state] }}</p>
        <p v-if="installed.state !== 'enabled'" class="muted">
          请先保存配置，再启用插件。保存本身不会启用连接。
        </p>
        <div class="plugin-actions" style="margin-top: 12px">
          <AButton
            v-if="installed.state === 'enabled'"
            :disabled="busy"
            :loading="pendingAction === installed.id + ':disable'"
            @click="action(installed.id, 'disable')"
            ><template #icon><Icon class="settings-button-icon" name="power" :size="15" /></template
            >停用插件</AButton
          ><AButton
            v-else
            :disabled="busy || dirty || remoteChanged"
            :loading="pendingAction === installed.id + ':enable'"
            @click="action(installed.id, 'enable')"
            ><template #icon><Icon class="settings-button-icon" name="power" :size="15" /></template
            >启用插件</AButton
          ><AButton type="text" :disabled="busy" @click="openUninstall(installed.id)"
            ><template #icon><Icon class="settings-button-icon" name="trash" :size="15" /></template
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
      <GitRemotePanel v-if="installed.id === 'git'" />
      <MCPConnectionGuide
        v-if="installed.id === 'mcp'"
        :plugin="installed"
        :mode="values.mode || 'oauth'"
        :dirty="dirty"
      />
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
      <AAlert
        v-if="remoteChanged"
        type="warning"
        show-icon
        message="已保存配置在其他位置发生变化"
        description="当前输入已保留。请先重新载入最新配置，再检查并重新填写需要保留的更改。"
      >
        <template #action>
          <APopconfirm
            title="重新载入会丢弃当前未保存输入，确定继续？"
            ok-text="丢弃输入并重新载入"
            cancel-text="保留当前输入"
            @confirm="reloadConfig"
          >
            <AButton :disabled="busy"
              ><template #icon
                ><Icon class="settings-button-icon" name="refresh" :size="15" /></template
              >重新载入已保存配置</AButton
            >
          </APopconfirm>
        </template>
      </AAlert>
      <p v-else-if="dirty" class="muted plugin-draft-notice" role="status">
        有未保存的更改。返回插件列表后，本页会保留各插件的输入。
      </p>
      <form class="plugin-form" @submit.prevent="save">
        <MCPDomainPermissions v-if="installed.id === 'mcp'" :key="installed.configVersion" v-model="values.permissionPolicy" :disabled="busy" />
        <details v-if="installed.id==='mcp' && !values.permissionPolicy" class="field-wide" :open="legacyOpen" @toggle="legacyOpen=($event.target as HTMLDetailsElement).open">
          <summary>旧版兼容设置</summary>
          <p class="muted">保留旧连接的目录与只读语义。编辑并保存上方分域权限后，使用新的独立能力与资源范围。</p>
          <div v-for="(field,key) in legacyFields as Record<string,any>" :key="key" class="plugin-field">
            <label :for="'plugin-field-'+key">{{field.title}}</label>
            <ASwitch v-if="field.type==='boolean'" v-model:checked="values[key]" :id="'plugin-field-'+key" :aria-label="field.title" :disabled="busy" />
            <AInput.TextArea v-else v-model:value="values[key]" :id="'plugin-field-'+key" :aria-label="field.title" :aria-invalid="invalidField===String(key)" :status="invalidField===String(key)?'error':undefined" :disabled="busy" :auto-size="{minRows:4,maxRows:10}" spellcheck="false" />
            <p v-if="key==='allowedPrefixes'" class="muted">每行一个知识库相对目录或文件，最多64项；不支持上级路径、隐藏目录或绝对路径。</p>
            <p v-else-if="field.description" class="muted">{{field.description}}</p>
            <p v-if="invalidField===String(key)" class="plugin-field-error" role="alert">{{error}}</p>
          </div>
        </details>
        <div
          v-for="(field, key) in standardFields as Record<string, any>"
          :key="key"
          class="plugin-field"
          :class="{
            'field-wide': !['integer', 'number'].includes(field.type),
            'field-toggle': field.type === 'boolean',
          }"
        >
          <div class="field-heading">
            <label :for="'plugin-field-' + key">{{ field.title || key }}</label>
            <span class="field-format">{{ requirement(key) }}</span>
          </div>
          <ASwitch
            v-if="field.type === 'boolean'"
            v-model:checked="values[key]"
            :id="'plugin-field-' + key"
            :aria-label="field.title || key"
            :disabled="busy"
          />
          <AInput.TextArea
            v-else-if="prefixField(key)"
            v-model:value="values[key]"
            :id="'plugin-field-' + key"
            :aria-label="field.title || String(key)"
            :aria-invalid="invalidField === String(key)"
            :status="invalidField === String(key) ? 'error' : undefined"
            :disabled="busy"
            :auto-size="{ minRows: 4, maxRows: 10 }"
            spellcheck="false"
          />
          <ASelect
            v-else-if="taskArrayField(key)"
            :value="arrayValue(key)"
            @update:value="values[key] = JSON.stringify($event)"
            mode="multiple"
            :id="'plugin-field-' + key"
            :options="key === 'toDooListIds' ? toDooListOptions : taskDomainOptions"
            :aria-label="field.title || String(key)"
            :disabled="busy || !(values.permissionPolicy ? values.permissionPolicy.domains?.['to-doo']?.enabled : values.allowToDoo)"
            :placeholder="key === 'toDooListIds' ? '全部清单，可选择缩小范围' : '选择允许的内容'"
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
            :options="enumOptions(key, field)"
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
              installed.configuredSecrets.includes(String(key)) ? '已配置；留空保留' : '尚未配置'
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
            spellcheck="false"
          />
          <AInput
            v-else
            v-model:value="values[key]"
            :id="'plugin-field-' + key"
            :aria-label="field.title || String(key)"
            :disabled="busy"
          />
          <template v-if="installed.id === 'mcp' && key === 'tunnelToken'">
            <AButton :disabled="busy" class="generate-connection-key" @click="generateConnectionKey"
              ><template #icon><Icon class="settings-button-icon" name="key" :size="15" /></template
              >生成连接密钥</AButton
            >
            <p class="muted">
              这是 DooKnow 的连接密钥，与 OpenAI API key
              不同。可在本浏览器生成，生成后仍需保存配置；已有密钥留空会保留。
            </p>
          </template>
          <AButton
            v-if="field.writeOnly && installed.configuredSecrets.includes(String(key))"
            size="small"
            type="text"
            :disabled="busy"
            class="clear-secret"
            @click="values[key] = null"
            ><template #icon><Icon class="settings-button-icon" name="trash" :size="15" /></template
            >清除已配置值</AButton
          >
          <p v-if="prefixField(key)" class="muted">
            每行填写一个知识库内的相对目录或文件，最多 64
            项。填写的目录下内容均可访问；不能使用绝对路径、上级目录或隐藏目录。
          </p>
          <p v-else-if="field.description" class="muted">{{ field.description }}</p>
          <p v-else-if="['array', 'object'].includes(field.type)" class="muted">
            {{
              field.type === 'array'
                ? '请填写有效的 JSON 数组，保留方括号与原有数据格式。'
                : '使用 JSON 对象填写配置，保留键名与数据格式。'
            }}
          </p>
          <p v-if="invalidField === String(key)" class="plugin-field-error" role="alert">
            {{ error }}
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
            <span class="field-format">{{ requirement(key) }} · JSON</span>
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
            :disabled="busy || remoteChanged"
            ><template #icon><Icon class="settings-button-icon" name="save" :size="15" /></template
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
  display: grid;
  gap: 16px;
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
  flex-wrap: wrap;
  margin: 0;
}
.section-heading :deep(.ant-tabs-nav) {
  margin: 0;
}
.section-heading :deep(.ant-tabs-content-holder) {
  display: none;
}
.section-heading > div,
.plugin-identity {
  min-width: 0;
  overflow-wrap: anywhere;
}
.plugin-identity,
.plugin-tab {
  display: flex;
  align-items: center;
  gap: 8px;
}
.plugin-tab > svg {
  flex-shrink: 0;
}
.plugin-icon {
  display: grid;
  flex: 0 0 34px;
  width: 34px;
  height: 34px;
  place-items: center;
  border-radius: 9px;
  color: var(--blue, #4566c6);
  background: var(--blue-soft, #edf1fc);
}
.section-heading h2 {
  margin: 0 0 5px;
  font-size: 16px;
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
.section-heading > .ant-btn:last-child {
  margin-inline-start: auto;
}
.plugin-card,
.plugin-settings {
  min-width: 0;
  border: 1px solid var(--border, #e3e6ec);
  border-radius: 10px;
  padding: var(--settings-card-padding, 20px);
  margin: 0;
  background: var(--panel, #fff);
}
.plugin-card h3,
.settings-heading h3 {
  margin: 0;
  font-size: 15px;
  font-weight: 600;
}
.settings-heading h3 {
  font-size: 16px;
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
.plugin-form :deep(.generate-connection-key) {
  margin-top: 8px;
}
.plugin-draft-notice {
  margin-bottom: 14px;
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
    gap: 8px;
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
