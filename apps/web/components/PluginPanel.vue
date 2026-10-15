<script setup lang="ts">
import { computed } from 'vue';
import { NModal, NButton, NAlert } from 'naive-ui';
import { pluginPanel, pluginComponents } from '../../../packages/plugin-ui/host';
import { pluginRegistry, pluginUIErrors } from '../plugins';
import PluginBoundary from './PluginBoundary.vue';
const item = computed(() => pluginRegistry.value.contributions.find(c => c.id === pluginPanel.value?.id));
</script>
<template>
  <NModal :show="!!pluginPanel && !!item" preset="card" class="dialog-card plugin-dialog" :title="item?.title" :closable="false" @mask-click="pluginPanel = undefined">
    <div class="utility-row"><span></span><NButton aria-label="关闭插件面板" @click="pluginPanel = undefined">关闭</NButton></div>
    <PluginBoundary v-if="item?.component && pluginComponents[item.component]" :key="item.id"><component :is="pluginComponents[item.component]" :context="pluginPanel?.context || {}" /></PluginBoundary>
    <NAlert v-else type="error">{{ item && pluginUIErrors[item.pluginId] || '插件界面尚未加载，请稍后重试' }}</NAlert>
  </NModal>
</template>
<style scoped>.plugin-dialog { width: min(860px, 94vw); }</style>
