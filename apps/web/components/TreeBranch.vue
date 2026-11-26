<script setup lang="ts">
import { computed, ref } from 'vue';
import type { TreeEntry } from '../../../shared/contracts';
import Icon from './Icon.vue';
import { features } from '../features';
import { gitStatus } from '../git/status';
import { gitDecoration } from '../git/decoration';
const props = defineProps<{ entries: TreeEntry[]; selected: string; depth?: number; menuPath?: string }>();
const decorations = computed(() => {
  const changes = features.value.git?.state === 'enabled' ? gitStatus.value?.changes || [] : [];
  return new Map(changes.length ? props.entries.map((entry) => [entry.path, gitDecoration(changes, entry.path)]) : []);
});
const emit = defineEmits<{
  select: [entry: TreeEntry];
  menu: [entry: TreeEntry, event: MouseEvent | KeyboardEvent];
}>();
const expanded = ref(new Set<string>());
function toggle(p: string) {
  expanded.value.has(p) ? expanded.value.delete(p) : expanded.value.add(p);
}
function menuKey(entry: TreeEntry, event: KeyboardEvent) {
  if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) {
    event.preventDefault();
    emit('menu', entry, event);
  }
}
</script>
<template>
  <ul class="tree-level">
    <li v-for="entry in entries" :key="entry.path">
      <div
        :class="['tree-row', 'is-' + entry.type, { selected: entry.path === selected }]"
        :style="{ paddingLeft: `${12 + (depth || 0) * 14}px` }"
        @contextmenu.prevent.stop="emit('menu', entry, $event)"
        @keydown="menuKey(entry, $event)"
      >
        <button
          v-if="entry.type === 'folder'"
          class="tree-toggle"
          :aria-label="`${expanded.has(entry.path) ? '收起' : '展开'} ${entry.name}`"
          :aria-expanded="expanded.has(entry.path)"
          @click="toggle(entry.path)"
        >
          <Icon name="chevron" :size="14" :class="{ expanded: expanded.has(entry.path) }" /></button
        ><span v-else class="tree-spacer"></span
        ><button
          class="tree-select"
          :aria-current="entry.path === selected ? 'page' : undefined"
          :title="entry.path"
          @click="emit('select', entry)"
        >
          <Icon :name="entry.type === 'folder' ? 'folder' : entry.documentType==='mindmap' ? 'graph' : entry.documentType==='flowchart' ? 'code' : entry.documentType==='whiteboard'||/\.excalidraw$/i.test(entry.path) ? 'whiteboard' : 'file'" :size="18" /><span>{{
            entry.name
          }}</span>
        </button>
        <span v-if="decorations.get(entry.path)" class="dooknow-git-decoration" role="img"
          :aria-label="decorations.get(entry.path)?.title" :title="decorations.get(entry.path)?.title"
          :style="{ backgroundColor: decorations.get(entry.path)?.color }" />
        <button
          type="button"
          class="tree-more"
          :aria-label="`${entry.name} 的更多操作`"
          aria-haspopup="menu"
          :aria-expanded="menuPath === entry.path"
          :aria-controls="menuPath === entry.path ? 'tree-context-menu' : undefined"
          @click.stop="emit('menu', entry, $event)"
        >
          <Icon name="more" :size="16" />
        </button>
      </div>
      <TreeBranch
        v-if="entry.children?.length && expanded.has(entry.path)"
        :entries="entry.children"
        :selected="selected"
        :depth="(depth || 0) + 1"
        :menu-path="menuPath"
        @select="emit('select', $event)"
        @menu="(entry, event) => emit('menu', entry, event)"
      />
    </li>
  </ul>
</template>
<style>
.dooknow-git-decoration { width: 8px; height: 8px; border-radius: 50%; margin: 0 4px; flex-shrink: 0; }
.tree-more {
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  width: 28px;
  min-height: 30px;
  margin-right: 3px;
  padding: 0;
  border: 0;
  border-radius: 4px;
  color: inherit;
  background: transparent;
  cursor: pointer;
  opacity: 0;
}
.tree-row:hover .tree-more,
.tree-row:focus-within .tree-more,
.tree-more[aria-expanded='true'] {
  opacity: 1;
}
.tree-more:hover {
  background: var(--blue-soft, #e4eafa);
}
@media (hover: none), (pointer: coarse) {
  .tree-more {
    opacity: 1;
    min-height: 36px;
    width: 32px;
  }
}
</style>
