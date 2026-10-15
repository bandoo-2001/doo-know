<script setup lang="ts">
import { computed } from 'vue';
import { NButton } from 'naive-ui';
import type { ContributionSlot } from '../../../packages/plugin-contracts';
import { pluginRegistry, contributionVisible } from '../plugins';
import { pluginComponents, pluginPanel } from '../../../packages/plugin-ui/host';
import { api } from '../api';
import PluginBoundary from './PluginBoundary.vue';
const props = withDefaults(defineProps<{ slotName: ContributionSlot; context?: Record<string, any> }>(), { context: () => ({}) });
const items = computed(() => pluginRegistry.value.contributions.filter(c => c.slot === props.slotName && contributionVisible(c, props.context)));
async function invoke(item: typeof items.value[number]) {
  if (item.component) pluginPanel.value = { id: item.id, context: props.context };
  else if (item.command) await api(`/api/plugins/${item.pluginId}/call`, 'POST', { kind: 'command', id: item.command, input: props.context, requestId: crypto.randomUUID() });
}
</script>
<template>
  <template v-for="item in items" :key="item.id">
    <NButton v-if="slotName === 'navigation' || !item.component" @click="invoke(item)">{{ item.title }}</NButton>
    <PluginBoundary v-else-if="pluginComponents[item.component]"><component :is="pluginComponents[item.component]" :context="context" /></PluginBoundary>
  </template>
</template>
