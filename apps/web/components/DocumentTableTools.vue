<script setup lang="ts">
import type { TableAction } from '../editor/contracts';
defineProps<{ disabled?: boolean }>();
const emit = defineEmits<{ action: [value: TableAction] }>();
const actions: { key: TableAction; label: string }[] = [
  { key: 'addRowBefore', label: '上方插入行' },
  { key: 'addRowAfter', label: '下方插入行' },
  { key: 'deleteRow', label: '删除行' },
  { key: 'addColumnBefore', label: '左侧插入列' },
  { key: 'addColumnAfter', label: '右侧插入列' },
  { key: 'deleteColumn', label: '删除列' },
  { key: 'alignLeft', label: '列左对齐' },
  { key: 'alignCenter', label: '列居中' },
  { key: 'alignRight', label: '列右对齐' },
  { key: 'deleteTable', label: '删除表格' },
];
</script>
<template>
  <div class="document-context-tools" role="toolbar" aria-label="表格操作" @mousedown.prevent>
    <button
      v-for="item in actions"
      :key="item.key"
      type="button"
      :disabled="disabled"
      @click="emit('action', item.key)"
    >
      {{ item.label }}
    </button>
  </div>
</template>
