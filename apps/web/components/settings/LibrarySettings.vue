<script setup lang="ts">
import Icon from '../Icon.vue';
import { onMounted, ref } from 'vue';
import { Alert as AAlert, Button as AButton } from 'ant-design-vue';
import { api } from '../../api';
import type { ManagementOverview } from '../../../../shared/management-contracts';
import StorageSettings from '../StorageSettings.vue';
import SettingsTabs from './SettingsTabs.vue';
import ShareManagement from './ShareManagement.vue';
import TransferPanel from './TransferPanel.vue';
import OrganizationOperations from './OrganizationOperations.vue';
const tabs = [
  { key: 'files', label: '资料管理' },
  { key: 'storage', label: '存储与整理' },
  { key: 'shares', label: '分享' },
] as const;
const activeTab = ref<(typeof tabs)[number]['key']>('files');
const emit = defineEmits<{ 'open-note': [id: string]; changed: []; 'open-git': [] }>();
const state = ref<ManagementOverview>(),
  error = ref(''),
  busy = ref(false);
async function load() {
  busy.value = true;
  error.value = '';
  try {
    state.value = await api<ManagementOverview>('/api/manage/overview');
  } catch (e) {
    error.value = (e as Error).message;
  } finally {
    busy.value = false;
  }
}
onMounted(() => void load());
</script>
<template>
  <SettingsTabs
    v-model="activeTab"
    :tabs="tabs"
    label="知识库管理选项"
    panel-class="settings-stack"
  >
    <template #default="{ tab }">
      <template v-if="tab.key === 'files'">
        <section class="settings-card library-current">
          <div class="settings-item-header">
            <div>
              <h2 class="settings-section-title"><Icon name="book" :size="18" />当前知识库</h2>
            </div>
            <AButton size="small" :loading="busy" @click="load"
              ><template #icon
                ><Icon class="settings-button-icon" name="refresh" :size="15" /></template
              >刷新信息</AButton
            >
          </div>
          <AAlert v-if="error" type="error" :message="error" />
          <p v-if="busy && !state" role="status">正在读取知识库信息…</p>
          <template v-if="state">
            <div class="library-identity">
              <strong>{{ state.library.name || '尚未绑定知识库' }}</strong>
              <span class="settings-indicator" :class="{ ready: state.library.ready }">{{
                state.library.ready ? '知识库可用' : '知识库暂时不可用'
              }}</span>
            </div>
            <div class="library-links">
              <details>
                <summary>服务器上的原文目录</summary>
                <p>
                  <code>{{ state.library.path || '尚未绑定目录' }}</code>
                </p>
                <p class="settings-muted">
                  目录绑定由部署配置管理。迁移可以先导出或恢复到独立副本，核验后再更新服务配置。
                </p>
              </details>
              <AButton type="link" size="small" @click="emit('open-git')">打开 Git 设置</AButton>
            </div>
          </template>
        </section>
        <TransferPanel @open-note="emit('open-note', $event)" @changed="emit('changed')" />
      </template>
      <template v-else-if="tab.key === 'storage'">
        <section class="settings-card"><StorageSettings /></section>
        <OrganizationOperations @changed="emit('changed')" />
      </template>
      <ShareManagement v-else />
    </template>
  </SettingsTabs>
</template>

<style scoped>
.library-identity {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px 12px;
  margin: 8px 0;
}
.library-identity strong {
  font-size: 18px;
  overflow-wrap: anywhere;
}
.library-links {
  display: flex;
  align-items: start;
  flex-wrap: wrap;
  gap: 6px 16px;
  justify-content: space-between;
}
.library-current .library-links details {
  min-width: 0;
  margin: 0;
  flex: 1 1 176px;
}
.library-current .library-links {
  border-top: 1px solid var(--border);
  padding-top: 10px;
}
</style>
