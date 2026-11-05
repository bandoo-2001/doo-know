<script setup lang="ts">
import Icon from './Icon.vue';
defineProps<{ context: string; app?: boolean; status?: string; drawerOpen?: boolean }>();
const emit = defineEmits<{ 'open-sidebar': []; 'return-app': [] }>();
</script>
<template>
  <header class="workspace-header" aria-label="DooKnow 工作区">
    <button
      v-if="app"
      type="button"
      class="workspace-header-menu icon-button"
      aria-label="返回 DooKnow"
      @click="emit('return-app')"
    ><Icon name="back" :size="20" /></button>
    <button
      v-else
      id="workspace-sidebar-toggle"
      type="button"
      class="workspace-header-menu icon-button"
      aria-label="打开侧栏"
      aria-controls="notebook-navigation"
      :aria-expanded="!!drawerOpen"
      @click="emit('open-sidebar')"
    ><Icon name="menu" :size="20" /></button>
    <div class="workspace-header-brand"><Icon name="book" :size="25" /><strong>DooKnow</strong></div>
    <span class="workspace-header-divider" aria-hidden="true"></span>
    <span class="workspace-header-context" :title="context">{{ context }}</span>
    <span v-if="status" class="workspace-header-status">{{ status }}</span>
  </header>
</template>
