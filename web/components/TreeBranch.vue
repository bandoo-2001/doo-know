<script setup lang="ts">
import { ref } from 'vue';
import type { TreeEntry } from '../../shared/contracts';
import Icon from './Icon.vue';
import PluginSlot from './PluginSlot.vue';
defineProps<{ entries: TreeEntry[]; selected: string; depth?: number }>();
const emit = defineEmits<{ select: [entry: TreeEntry] }>();
const closed = ref(new Set<string>());
function toggle(p: string) {
  closed.value.has(p) ? closed.value.delete(p) : closed.value.add(p);
}
</script>
<template>
  <ul class="tree-level">
    <li v-for="entry in entries" :key="entry.path">
      <div
        :class="['tree-row', { selected: entry.path === selected }]"
        :style="{ paddingLeft: `${12 + (depth || 0) * 19}px` }"
      >
        <button
          v-if="entry.type === 'folder'"
          class="tree-toggle"
          :aria-label="`${closed.has(entry.path) ? '展开' : '收起'} ${entry.name}`"
          :aria-expanded="!closed.has(entry.path)"
          @click="toggle(entry.path)"
        >
          <Icon name="chevron" :size="14" :class="{ expanded: !closed.has(entry.path) }" /></button
        ><span v-else class="tree-spacer"></span
        ><button class="tree-select" :title="entry.name" @click="emit('select', entry)">
          <Icon :name="entry.type === 'folder' ? 'folder' : 'file'" :size="18" /><span>{{
            entry.name
          }}</span>
        </button>
        <PluginSlot slot-name="fileDecoration" :context="{ relativePath: entry.path, file: { path: entry.path }, workspace: { ready: true } }" />
      </div>
      <TreeBranch
        v-if="entry.children?.length && !closed.has(entry.path)"
        :entries="entry.children"
        :selected="selected"
        :depth="(depth || 0) + 1"
        @select="emit('select', $event)"
      />
    </li>
  </ul>
</template>
