<script setup lang="ts">
import { computed } from 'vue';
import { NModal } from 'naive-ui';
import { Button as AButton, Alert as AAlert } from 'ant-design-vue';
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
    @update:show="
      (show) => {
        if (!show) pluginPanel = undefined;
      }
    "
    @mask-click="pluginPanel = undefined"
  >
    <template #header-extra
      ><AButton size="small" type="text" aria-label="关闭插件面板" @click="pluginPanel = undefined"
        >关闭</AButton
      ></template
    >
    <div class="plugin-panel-content">
      <PluginBoundary v-if="item?.component && pluginComponents[item.component]" :key="item.id"
        ><component :is="pluginComponents[item.component]" :context="pluginPanel?.context || {}"
      /></PluginBoundary>
      <AAlert
        v-else
        type="error"
        show-icon
        :message="(item && pluginUIErrors[item.pluginId]) || '插件界面尚未加载，请稍后重试'"
      />
    </div>
  </NModal>
</template>
<style>
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
.plugin-dialog .n-card-header {
  align-items: flex-start;
  gap: 12px;
}
.plugin-dialog .n-card-header__main {
  min-width: 0;
  overflow-wrap: anywhere;
  line-height: 1.6;
}
.plugin-dialog .n-card-header__extra {
  flex-shrink: 0;
}
.plugin-panel-content > * {
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
