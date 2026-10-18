<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { Alert as AAlert, Button as AButton } from 'ant-design-vue';
import { api } from '../../api';
import type { ManagementOverview } from '../../../../shared/management-contracts';
import StorageSettings from '../StorageSettings.vue';
import ShareManagement from './ShareManagement.vue';
import TransferPanel from './TransferPanel.vue';
const emit = defineEmits<{ 'open-note': [id: string]; changed: [] }>();
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
  <div class="settings-stack">
    <section class="settings-card">
      <div class="settings-item-header">
        <div>
          <h2>当前知识库</h2>
          <p>这里的目录位于运行知识库的服务器上。</p>
        </div>
        <AButton size="small" :loading="busy" @click="load">刷新信息</AButton>
      </div>
      <AAlert v-if="error" type="error" :message="error" />
      <p v-if="busy && !state" role="status">正在读取知识库信息…</p>
      <template v-if="state"
        ><p>
          <strong>{{ state.library.name || '尚未绑定知识库' }}</strong>
        </p>
        <p class="settings-muted">
          {{ state.library.ready ? '知识库可用' : '知识库暂时不可用' }} · 时区
          {{ state.library.timeZone }}
        </p>
        <details>
          <summary>服务器上的原文目录</summary>
          <p>
            <code>{{ state.library.path || '尚未绑定目录' }}</code>
          </p>
          <p class="settings-muted">
            目录绑定由部署配置管理。迁移可以先导出或恢复到独立副本，核验后再更新服务配置。
          </p>
        </details></template
      >
    </section>
    <section class="settings-card"><StorageSettings /></section>
    <TransferPanel
      @open-note="emit('open-note', $event)"
      @changed="emit('changed')"
    /><ShareManagement />
  </div>
</template>
