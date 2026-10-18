<script setup lang="ts">
import { computed } from 'vue';
import { NModal, NButton, NAlert } from 'naive-ui';
import { pluginPanel, pluginComponents } from '../../../packages/plugin-ui/host';
import { pluginRegistry, pluginUIErrors } from '../plugins';
import PluginBoundary from './PluginBoundary.vue';
const item = computed(() =>
  pluginRegistry.value.contributions.find((c) => c.id === pluginPanel.value?.id),
);
</script>
<template>
  <NModal
    :show="!!pluginPanel && !!item"
    preset="card"
    class="dialog-card plugin-dialog"
    :title="item?.title"
    :closable="false"
    @mask-click="pluginPanel = undefined"
  >
    <template #header-extra
      ><NButton size="small" quaternary aria-label="关闭插件面板" @click="pluginPanel = undefined"
        >关闭</NButton
      ></template
    >
    <div class="plugin-panel-content">
      <PluginBoundary v-if="item?.component && pluginComponents[item.component]" :key="item.id"
        ><component :is="pluginComponents[item.component]" :context="pluginPanel?.context || {}"
      /></PluginBoundary>
      <NAlert v-else type="error">{{
        (item && pluginUIErrors[item.pluginId]) || '插件界面尚未加载，请稍后重试'
      }}</NAlert>
    </div>
  </NModal>
</template>
<style scoped>
.plugin-dialog {
  width: min(820px, calc(100vw - 40px));
  max-height: calc(100dvh - 48px);
  margin: 24px auto;
  border: 1px solid var(--border, #e3e6ec);
  border-radius: 10px;
}
.plugin-panel-content {
  min-width: 0;
  max-height: calc(100dvh - 164px);
  overflow: auto;
  overscroll-behavior: contain;
  overflow-wrap: anywhere;
}
.plugin-panel-content :deep(> *) {
  min-width: 0;
}
@media (max-width: 600px) {
  .plugin-dialog {
    width: calc(100vw - 24px);
    max-height: calc(100dvh - 24px);
    margin: 12px auto;
  }
  .plugin-panel-content {
    max-height: calc(100dvh - 132px);
  }
}
</style>
