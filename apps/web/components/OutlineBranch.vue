<script setup lang="ts">
import { useId } from 'vue';
import type { OutlineNode } from '../document-outline';
import Icon from './Icon.vue';
defineProps<{ entries: OutlineNode[]; activeLine?: number; collapsedLines: ReadonlySet<number> }>();
defineEmits<{ select: [line: number]; toggle: [heading: OutlineNode] }>();
const branchId = useId();
</script>
<template>
  <ol class="outline-branch">
    <li v-for="item in entries" :key="item.line" :data-level="item.level">
      <div class="outline-entry">
        <button
          v-if="item.children.length"
          type="button"
          class="outline-disclosure"
          :aria-label="`${collapsedLines.has(item.line) ? '展开' : '收起'} ${item.title}`"
          :aria-expanded="!collapsedLines.has(item.line)"
          :aria-controls="`${branchId}-${item.line}`"
          @click="$emit('toggle', item)"
        >
          <Icon name="chevron" :size="12" />
        </button>
        <span v-else class="outline-disclosure-placeholder" aria-hidden="true"></span>
        <button
          type="button"
          class="outline-link"
          :class="{ active: item.line === activeLine }"
          :aria-current="item.line === activeLine ? 'location' : undefined"
          :title="item.title"
          @click="$emit('select', item.line)"
        >
          {{ item.title }}
        </button>
      </div>
      <OutlineBranch
        v-if="item.children.length"
        v-show="!collapsedLines.has(item.line)"
        :id="`${branchId}-${item.line}`"
        :entries="item.children"
        :active-line="activeLine"
        :collapsed-lines="collapsedLines"
        @select="$emit('select', $event)"
        @toggle="$emit('toggle', $event)"
      />
    </li>
  </ol>
</template>
