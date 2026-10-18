<script setup lang="ts">
import type { OutlinePage } from '../../../shared/knowledge-contracts';
defineProps<{ outline?: OutlinePage }>();
defineEmits<{ select: [line: number]; next: [cursor: string] }>();
</script>
<template>
  <nav v-if="outline" class="note-outline" aria-label="大文件目录">
    <b>章节</b
    ><button
      v-for="item in outline.items"
      :key="item.startByte"
      :style="{ paddingLeft: `${item.level * 8}px` }"
      @click="$emit('select', item.line)"
    >
      {{ item.title }}</button
    ><button v-if="outline.nextCursor" @click="$emit('next', outline.nextCursor)">更多章节</button>
  </nav>
</template>

<style scoped>
.note-outline {
  display: flex;
  gap: 7px;
  flex-wrap: wrap;
  align-items: center;
  padding: 12px 0;
  margin: 4px 0;
  border-bottom: 1px solid var(--border, #e3e6ec);
}
.note-outline b {
  color: var(--muted, #7a8190);
  font-size: 11px;
  font-weight: 500;
  margin-right: 3px;
}
.note-outline button {
  border: 1px solid var(--border, #e3e6ec);
  border-radius: 5px;
  background: #fff;
  padding: 5px 9px;
  font-size: 11px;
  color: #69758e;
  max-width: 100%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.note-outline button:hover {
  background: #f2f5fc;
  color: var(--blue, #4566c6);
}
</style>
