<script setup lang="ts">
import Icon from './Icon.vue';

defineProps<{ sidebarCollapsed: boolean; canBack: boolean; canForward: boolean; compact?: boolean; drawerOpen?: boolean }>();
const emit = defineEmits<{ 'toggle-sidebar': []; 'open-sidebar': []; back: []; forward: [] }>();
</script>

<template>
  <div :class="['document-navigation', { 'document-navigation-compact': compact }]">
    <button v-if="compact" id="workspace-note-sidebar-toggle" class="icon-button compact-sidebar-toggle" type="button" aria-label="打开侧栏" title="打开目录" aria-controls="notebook-navigation" :aria-expanded="!!drawerOpen" @click="emit('open-sidebar')"><Icon name="sidebar" :size="18" /></button>
    <button
      v-else
      class="icon-button desktop-sidebar-toggle"
      type="button"
      :aria-label="sidebarCollapsed ? '展开侧栏' : '收起侧栏'"
      :title="sidebarCollapsed ? '展开侧栏' : '收起侧栏'"
      :aria-expanded="!sidebarCollapsed"
      aria-controls="notebook-navigation"
      @click="emit('toggle-sidebar')"
    >
      <Icon name="sidebar" :size="18" />
    </button>
    <button
      class="icon-button"
      type="button"
      aria-label="后退"
      title="后退"
      :disabled="!canBack"
      @click="emit('back')"
    >
      <Icon name="back" :size="18" />
    </button>
    <button
      class="icon-button"
      type="button"
      aria-label="前进"
      title="前进"
      :disabled="!canForward"
      @click="emit('forward')"
    >
      <Icon name="forward" :size="18" />
    </button>
  </div>
</template>
