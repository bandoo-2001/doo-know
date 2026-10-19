<script setup lang="ts">
import type { TreeEntry } from '../../../shared/contracts';
import Icon from './Icon.vue';
defineProps<{
  entries: TreeEntry[];
  selected: string;
  kind: 'recent' | 'favorites';
  menuPath: string;
}>();
const emit = defineEmits<{
  select: [entry: TreeEntry];
  menu: [entry: TreeEntry, event: MouseEvent | KeyboardEvent];
}>();
function menuKey(entry: TreeEntry, event: KeyboardEvent) {
  if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) {
    event.preventDefault();
    emit('menu', entry, event);
  }
}
</script>
<template>
  <ul class="note-collection" :aria-label="kind === 'recent' ? '最近编辑的笔记' : '收藏的笔记'">
    <li
      v-for="entry in entries"
      :key="entry.id"
      :class="{ selected: entry.path === selected }"
      @contextmenu.prevent.stop="emit('menu', entry, $event)"
      @keydown="menuKey(entry, $event)"
    >
      <button
        class="collection-open"
        :title="entry.path"
        :aria-label="entry.name"
        :aria-current="entry.path === selected ? 'page' : undefined"
        @click="emit('select', entry)"
      >
        <Icon :name="entry.favorite ? 'star' : 'file'" :size="16" />
        <span
          ><b>{{ entry.name }}</b
          ><small>{{ entry.path }}</small>
          <time v-if="entry.updatedAt" :datetime="entry.updatedAt">{{
            new Date(entry.updatedAt).toLocaleString('zh-CN')
          }}</time>
        </span>
      </button>
      <button
        class="collection-more icon-button"
        :aria-label="`${entry.name} 的更多操作`"
        aria-haspopup="menu"
        :aria-expanded="menuPath === entry.path"
        :aria-controls="menuPath === entry.path ? 'tree-context-menu' : undefined"
        @click="emit('menu', entry, $event)"
      >
        <Icon name="more" :size="16" />
      </button>
    </li>
  </ul>
  <p v-if="!entries.length" class="muted empty-search">
    {{ kind === 'recent' ? '暂无最近编辑的笔记' : '暂无收藏，可右键笔记或在编辑窗口中收藏' }}
  </p>
</template>
