<script setup lang="ts">
import Icon from './Icon.vue';
import type { WorkspaceMainMenuDefinition, WorkspaceMainMenuItem } from '../workspace-main-menu';
import '../workspace-main-menu.css';
const props = defineProps<{ definition: WorkspaceMainMenuDefinition }>();
function select(item: WorkspaceMainMenuItem) {
  if (!item.disabled) void props.definition.onSelect(item.id);
}
</script>
<template>
  <footer class="workspace-footer sidebar-footer workspace-main-menu" :data-menu-id="definition.id">
    <div class="workspace-menu-identity"><slot name="identity" /></div>
    <nav
      class="rail-notes-navigation"
      :aria-label="definition.label === 'DooKnow' ? '工作区' : definition.label + ' 主菜单'"
    >
      <button
        v-for="item in definition.items"
        :key="item.id"
        type="button"
        :disabled="item.disabled"
        :class="{ 'rail-apps-button': item.separated }"
        :title="item.title || item.label"
        :aria-current="definition.activeId === item.id ? 'page' : undefined"
        @click="select(item)"
      >
        <slot name="icon" :item="item"><Icon :name="item.icon" :size="21" /></slot>
        <span>{{ item.label }}</span
        ><small v-if="item.badge" class="workspace-menu-badge">{{ item.badge }}</small>
      </button>
    </nav>
    <nav
      class="footer-tools"
      :aria-label="definition.label === 'DooKnow' ? '常用工具' : definition.label + ' 工具'"
    >
      <button
        v-for="item in definition.utilities"
        :key="item.id"
        type="button"
        :disabled="item.disabled"
        :title="item.title || item.label"
        :aria-current="definition.activeId === item.id ? 'page' : undefined"
        @click="select(item)"
      >
        <slot name="icon" :item="item"><Icon :name="item.icon" :size="18" /></slot
        ><span>{{ item.label }}</span>
        <small v-if="item.badge" class="workspace-menu-badge">{{ item.badge }}</small>
      </button>
    </nav>
  </footer>
</template>
