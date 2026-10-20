<script setup lang="ts">
import { computed, watch } from 'vue';
import { buildOutline, type OutlineHeading } from '../document-outline';
import OutlineBranch from './OutlineBranch.vue';
const props = defineProps<{ headings: OutlineHeading[]; activeLine?: number }>();
defineEmits<{ select: [line: number] }>();
const collapsed = defineModel<OutlineHeading[]>('collapsed', { default: () => [] });
const entries = computed(() => buildOutline(props.headings));
const sameHeading = (a: OutlineHeading, b: OutlineHeading) =>
  a.line === b.line && a.level === b.level && a.title === b.title;
const collapsedLines = computed(() => new Set(collapsed.value.map((heading) => heading.line)));
watch(
  () => props.headings,
  (headings) => {
    const valid = collapsed.value.filter((saved) =>
      headings.some((heading) => sameHeading(saved, heading)),
    );
    if (valid.length !== collapsed.value.length) collapsed.value = valid;
  },
  { immediate: true },
);
function toggle(heading: OutlineHeading) {
  const remaining = collapsed.value.filter((saved) => saved.line !== heading.line);
  if (!collapsedLines.value.has(heading.line)) {
    const { line, level, title } = heading;
    remaining.push({ line, level, title });
  }
  collapsed.value = remaining;
}
</script>
<template>
  <nav class="document-toc" aria-label="本文章节">
    <h2>目录</h2>
    <div class="document-toc-scroll">
      <OutlineBranch
        v-if="entries.length"
        :entries="entries"
        :active-line="activeLine"
        :collapsed-lines="collapsedLines"
        @select="$emit('select', $event)"
        @toggle="toggle"
      />
      <p v-else class="outline-empty">添加标题后，章节将显示在这里。</p>
    </div>
  </nav>
</template>
