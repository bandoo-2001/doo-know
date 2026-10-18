<script setup lang="ts">
import { computed } from 'vue';
import { buildOutline, type OutlineHeading } from '../document-outline';
import OutlineBranch from './OutlineBranch.vue';
const props = defineProps<{ headings: OutlineHeading[]; activeLine?: number }>();
defineEmits<{ select: [line: number] }>();
const entries = computed(() => buildOutline(props.headings));
</script>
<template>
  <nav class="document-toc" aria-label="本文章节">
    <h2>目录</h2>
    <div class="document-toc-scroll">
      <OutlineBranch
        v-if="entries.length"
        :entries="entries"
        :active-line="activeLine"
        @select="$emit('select', $event)"
      />
      <p v-else class="outline-empty">添加标题后，章节将显示在这里。</p>
    </div>
  </nav>
</template>
