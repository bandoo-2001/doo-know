<script setup lang="ts">
import type { OutlinePage } from '../../shared/knowledge-contracts';
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
