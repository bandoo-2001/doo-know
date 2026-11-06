<script setup lang="ts">
import Icon from './Icon.vue';
defineProps<{ context: string; app?: boolean; status?: string; drawerOpen?: boolean; functional?: boolean }>();
const emit = defineEmits<{ 'open-sidebar': []; 'return-app': [] }>();
</script>
<template>
  <header :class="['workspace-header', {'workspace-header-functional': functional}]" aria-label="DooKnow 工作区">
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
    <span v-if="!functional" class="workspace-header-divider" aria-hidden="true"></span>
    <span v-if="!functional" class="workspace-header-context" :title="context">{{ context }}</span>
    <div id="workspace-header-actions" v-show="functional" class="workspace-header-actions"></div>
    <div v-if="functional" class="workspace-header-compact-actions"><slot name="compact-actions" /></div>
    <div id="workspace-header-account" v-show="functional" class="workspace-header-account"></div>
    <span v-if="status" class="workspace-header-status">{{ status }}</span>
  </header>
</template>
