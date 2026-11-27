<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import {
  Alert as AAlert,
  Button as AButton,
  Input as AInput,
  Popconfirm as APopconfirm,
  Select as ASelect,
  Switch as ASwitch,
} from 'ant-design-vue';
import Icon from '../Icon.vue';
import MCPConnectionTabs from '../MCPConnectionTabs.vue';
import MCPDomainPermissions from '../MCPDomainPermissions.vue';
import { featureConfig } from '../../../../shared/feature-config';
import { ApiError, api } from '../../api';
import { features, refreshFeatures, saveFeatureConfig, setFeatureEnabled } from '../../features';
import {
  hasUnsavedMcpSettings,
  legacyMcpSwitches,
  loadMcpDraft,
  mcpDraftSession,
  mcpSettingsDraft,
} from '../../mcp-settings-draft';

const fields = featureConfig.mcp.properties;
const mcp = computed(() => features.value.mcp);
const values = computed(() => mcpSettingsDraft.value?.values);
const stale = computed(
  () => !!mcp.value && mcpSettingsDraft.value?.configVersion !== mcp.value.configVersion,
);
const enableBlocked = computed(() => stale.value || hasUnsavedMcpSettings());
const busy = ref(false);
const error = ref('');
const notice = ref('');
const invalidPrefixes = ref(false);
const legacyOpen = ref(false);
const expectedSession = mcpDraftSession();
let active = true;
const current = () => active && expectedSession === mcpDraftSession();
onBeforeUnmount(() => {
  active = false;
});
watch(
  mcp,
  (feature) => {
    if (feature) loadMcpDraft(feature, expectedSession);
  },
  { immediate: true },
);

const listOptions = ref([{ label: '收集箱', value: 'inbox' }]);
const taskDomainOptions = [
  ['tasks', '任务与目标'],
  ['records', '成果与进展记录'],
  ['focus', '专注记录'],
  ['habits', '习惯与打卡'],
  ['anniversaries', '纪念日'],
  ['calendar', '日历数据'],
  ['statistics', '统计摘要'],
  ['settings', '应用偏好'],
].map(([value, label]) => ({ value, label }));
const toDooEnabled = computed(() =>
  values.value?.permissionPolicy
    ? values.value.permissionPolicy.domains?.['to-doo']?.enabled
    : values.value?.allowToDoo,
);
watch(
  toDooEnabled,
  async (enabled) => {
    if (!enabled) return;
    try {
      const { lists } = await api<{ lists: { id: string; name: string; deletedAt?: string }[] }>(
        '/api/to-doo/state?kind=list&limit=1000',
      );
      if (!current()) return;
      listOptions.value = [
        { label: '收集箱', value: 'inbox' },
        ...lists
          .filter((list) => !list.deletedAt)
          .map((list) => ({ label: list.name, value: list.id })),
        ...(values.value?.toDooListIds ?? [])
          .filter((id) => id !== 'inbox' && !lists.some((list) => list.id === id))
          .map((value) => ({ label: '已选择的清单（暂不可用）', value })),
      ];
    } catch {
      /* The saved list selection remains usable when To Doo is unavailable. */
    }
  },
  { immediate: true },
);

async function run(work: () => Promise<void>) {
  if (busy.value || !current()) return;
  busy.value = true;
  error.value = '';
  notice.value = '';
  invalidPrefixes.value = false;
  try {
    await work();
  } catch (failure) {
    if (!current()) return;
    error.value = failure instanceof Error ? failure.message : '操作失败，请重试。';
    if (failure instanceof ApiError && failure.data.code === 'CONFIG_VERSION_CONFLICT')
      await refreshFeatures().catch(() => {});
  } finally {
    busy.value = false;
  }
}
onMounted(() => void run(refreshFeatures));

function toggle(enabled: boolean) {
  if (enabled && enableBlocked.value) return;
  void run(async () => {
    await setFeatureEnabled('mcp', enabled);
  });
}
function reload() {
  void run(async () => {
    await refreshFeatures();
    if (current() && mcp.value) loadMcpDraft(mcp.value, expectedSession, true);
  });
}
function save() {
  const draft = mcpSettingsDraft.value;
  if (!draft || stale.value) return;
  void run(async () => {
    const allowedPrefixes = draft.values.allowedPrefixes.split(/\r?\n/);
    if (allowedPrefixes.at(-1) === '') allowedPrefixes.pop();
    if (
      !allowedPrefixes.length ||
      allowedPrefixes.length > 64 ||
      allowedPrefixes.some(
        (entry) =>
          /[\\\x00-\x1f]/.test(entry) ||
          entry.split('/').some((part) => !part || part.startsWith('.')),
      )
    ) {
      invalidPrefixes.value = true;
      legacyOpen.value = true;
      await nextTick();
      document.getElementById('mcp-allowed-prefixes')?.focus();
      throw Error(
        '每行填写一个知识库相对目录或文件，最多 64 项。请移除空行、绝对路径、上级目录和隐藏目录。',
      );
    }
    const saved = await saveFeatureConfig(
      'mcp',
      { ...draft.values, allowedPrefixes },
      draft.configVersion,
    );
    if (current()) {
      loadMcpDraft(saved, expectedSession, true);
      notice.value = 'MCP 配置已保存。';
    }
  });
}
</script>

<template>
  <div class="settings-stack" role="region" aria-label="MCP 服务设置">
    <section class="settings-card">
      <div class="mcp-service-header">
        <h2 class="settings-section-title"><Icon name="link" :size="18" />MCP 服务</h2>
        <ASwitch
          aria-label="启用 MCP 服务"
          :checked="mcp?.desiredEnabled ?? false"
          :loading="busy"
          :disabled="!mcp || busy || (!mcp.desiredEnabled && enableBlocked)"
          @change="(enabled) => toggle(enabled === true)"
        />
        <p class="settings-muted">允许已授权的客户端访问知识库、博客和 To Doo。</p>
      </div>
      <p v-if="mcp && !mcp.desiredEnabled && enableBlocked" role="status">
        保存当前权限和连接配置后即可启用 MCP。
      </p>
      <AAlert v-if="error" type="error" show-icon :message="error" />
      <AAlert v-else-if="mcp?.error" type="warning" show-icon :message="mcp.error" />
      <AButton
        v-if="(!mcp && error) || mcp?.state === 'failed'"
        size="small"
        :disabled="busy || (mcp?.state === 'failed' && enableBlocked)"
        @click="mcp?.state === 'failed' ? toggle(true) : reload()"
      >
        {{ mcp?.state === 'failed' ? '重试启用' : '重试读取设置' }}
      </AButton>
    </section>
    <MCPConnectionTabs v-if="mcp" :feature="mcp" :dirty="hasUnsavedMcpSettings()">
      <template #permissions>
        <AAlert
          v-if="stale && values"
          class="mcp-config-conflict"
          type="warning"
          show-icon
          message="MCP 配置已在其他位置更新。"
          description="当前输入已保留。重新载入已保存设置后，可以继续编辑。"
        >
          <template #action>
            <APopconfirm
              title="重新载入会丢弃当前未保存输入"
              ok-text="重新载入"
              cancel-text="继续编辑"
              @confirm="reload"
            >
              <AButton size="small" :disabled="busy">重新载入已保存配置</AButton>
            </APopconfirm>
          </template>
        </AAlert>
        <form v-if="mcp && values" class="mcp-config-form" @submit.prevent="save">
          <MCPDomainPermissions
            :key="mcpSettingsDraft?.configVersion"
            v-model="values.permissionPolicy"
            :disabled="busy"
          />
          <div
            v-for="key in ['oauthEnabled', 'apiKeyEnabled'] as const"
            :key="key"
            class="mcp-config-field mcp-config-toggle"
          >
            <label :for="'mcp-' + key">{{ fields[key].title }}</label>
            <ASwitch
              :id="'mcp-' + key"
              v-model:checked="values[key]"
              :aria-label="fields[key].title"
              :disabled="busy"
            />
          </div>
          <div class="mcp-config-field">
            <label for="mcp-external-origin">{{ fields.externalWebOrigin.title }}</label>
            <AInput
              id="mcp-external-origin"
              v-model:value="values.externalWebOrigin"
              :maxlength="2048"
              :disabled="busy"
            />
            <p>{{ fields.externalWebOrigin.description }}</p>
          </div>
          <details
            v-if="!values.permissionPolicy"
            :open="legacyOpen"
            @toggle="legacyOpen = ($event.target as HTMLDetailsElement).open"
          >
            <summary>旧版兼容设置</summary>
            <p>
              旧连接仍按原目录与只读设置授权。保存上方的分域权限后，使用独立的业务权限和资源范围。
            </p>
            <div
              v-for="key in legacyMcpSwitches"
              :key="key"
              class="mcp-config-field mcp-config-toggle"
            >
              <label :for="'mcp-' + key">{{ fields[key].title }}</label>
              <ASwitch
                :id="'mcp-' + key"
                v-model:checked="values[key]"
                :aria-label="fields[key].title"
                :disabled="busy"
              />
            </div>
            <div class="mcp-config-field">
              <label for="mcp-allowed-prefixes">{{ fields.allowedPrefixes.title }}</label>
              <AInput.TextArea
                id="mcp-allowed-prefixes"
                v-model:value="values.allowedPrefixes"
                spellcheck="false"
                :disabled="busy"
                :aria-invalid="invalidPrefixes"
                :status="invalidPrefixes ? 'error' : undefined"
                :auto-size="{ minRows: 4, maxRows: 10 }"
              />
              <p>每行一个知识库相对目录或文件，最多 64 项。</p>
            </div>
          </details>
          <div class="mcp-config-field">
            <label for="mcp-to-doo-lists">{{ fields.toDooListIds.title }}</label>
            <ASelect
              id="mcp-to-doo-lists"
              v-model:value="values.toDooListIds"
              mode="multiple"
              :options="listOptions"
              :disabled="busy || !toDooEnabled"
              placeholder="全部清单"
            />
          </div>
          <div class="mcp-config-field">
            <label for="mcp-to-doo-domains">{{ fields.toDooDomains.title }}</label>
            <ASelect
              id="mcp-to-doo-domains"
              v-model:value="values.toDooDomains"
              mode="multiple"
              :options="taskDomainOptions"
              :disabled="busy || !toDooEnabled"
            />
          </div>
          <footer class="mcp-config-footer">
            <AButton
              html-type="submit"
              type="primary"
              :disabled="busy || stale || !hasUnsavedMcpSettings()"
              >保存 MCP 配置</AButton
            >
            <span v-if="notice" role="status">{{ notice }}</span>
            <span v-else-if="hasUnsavedMcpSettings() && !stale" role="status"
              >有未保存的更改。</span
            >
          </footer>
        </form>
      </template>
    </MCPConnectionTabs>
  </div>
</template>

<style scoped>
.mcp-service-header {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  align-items: center;
  gap: 6px 12px;
}
.mcp-service-header h2,
.mcp-service-header p {
  margin: 0;
}
.mcp-service-header p {
  grid-column: 1 / -1;
}

.mcp-config-form {
  display: grid;
  gap: 14px;
}
.mcp-config-conflict + .mcp-config-form {
  margin-top: 16px;
}
.mcp-config-field {
  display: grid;
  gap: 6px;
  min-width: 0;
}
.mcp-config-toggle {
  grid-template-columns: minmax(0, 1fr) auto;
  align-items: center;
}
.mcp-config-field p,
details p {
  color: var(--muted);
  font-size: 12px;
  margin: 0;
}
.mcp-config-form details {
  padding: 12px;
  border: 1px solid var(--border);
  border-radius: var(--ui-radius, 8px);
}
.mcp-config-form details .mcp-config-field {
  margin-top: 10px;
}
details summary {
  cursor: pointer;
}
@media (max-width: 600px) {
  .mcp-config-conflict :deep(.ant-alert-action) {
    margin-inline: 0;
    margin-top: 8px;
    align-self: flex-start;
  }
  .mcp-config-conflict {
    flex-wrap: wrap;
  }
  .mcp-config-conflict :deep(.ant-alert-content) {
    flex: 1 1 calc(100% - 30px);
  }
}
.mcp-config-footer {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 10px;
}
</style>
