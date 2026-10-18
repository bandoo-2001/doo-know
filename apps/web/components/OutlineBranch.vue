<script setup lang="ts">
import type { OutlineNode } from '../document-outline';
defineProps<{ entries: OutlineNode[]; activeLine?: number }>();
defineEmits<{ select: [line: number] }>();
</script>
<template>
  <ol class="outline-branch">
    <li v-for="item in entries" :key="item.line" :data-level="item.level">
      <button
        type="button"
        :class="{ active: item.line === activeLine }"
        :aria-current="item.line === activeLine ? 'location' : undefined"
        :title="item.title"
        @click="$emit('select', item.line)"
      >
        {{ item.title }}
      </button>
      <OutlineBranch
        v-if="item.children.length"
        :entries="item.children"
        :active-line="activeLine"
        @select="$emit('select', $event)"
      />
    </li>
  </ol>
</template>
