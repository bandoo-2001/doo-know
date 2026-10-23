<script setup lang="ts">
import type { TableAction } from '../editor/contracts';
import Icon from './Icon.vue';
defineProps<{
  disabled?: boolean;
  rows?: number;
  columns?: number;
  alignment?: string;
}>();
const emit = defineEmits<{ action: [value: TableAction]; exit: [] }>();
const groups = [
  {
    label: '行',
    actions: [
      { key: 'addRowBefore', label: '上方插入行', icon: 'row-before' },
      { key: 'addRowAfter', label: '下方插入行', icon: 'row-after' },
      { key: 'deleteRow', label: '删除行', icon: 'row-delete' },
    ],
  },
  {
    label: '列',
    actions: [
      { key: 'addColumnBefore', label: '左侧插入列', icon: 'column-before' },
      { key: 'addColumnAfter', label: '右侧插入列', icon: 'column-after' },
      { key: 'deleteColumn', label: '删除列', icon: 'column-delete' },
    ],
  },
  {
    label: '对齐',
    actions: [
      { key: 'alignLeft', label: '列左对齐', icon: 'align-left', value: 'left' },
      { key: 'alignCenter', label: '列居中', icon: 'align-center', value: 'center' },
      { key: 'alignRight', label: '列右对齐', icon: 'align-right', value: 'right' },
    ],
  },
] satisfies {
  label: string;
  actions: { key: TableAction; label: string; icon: string; value?: string }[];
}[];
function keydown(event: KeyboardEvent) {
  if (event.key === 'Escape') {
    event.preventDefault();
    emit('exit');
    return;
  }
  if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
  const buttons = [
    ...(event.currentTarget as HTMLElement).querySelectorAll<HTMLButtonElement>(
      'button:not(:disabled)',
    ),
  ];
  const current = buttons.indexOf(event.target as HTMLButtonElement);
  if (current < 0) return;
  event.preventDefault();
  const index =
    event.key === 'Home'
      ? 0
      : event.key === 'End'
        ? buttons.length - 1
        : (current + (event.key === 'ArrowRight' ? 1 : -1) + buttons.length) % buttons.length;
  buttons[index]?.focus({ preventScroll: true });
  buttons[index]?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
}
</script>
<template>
  <div
    class="document-table-tools"
    role="toolbar"
    aria-label="表格操作"
    @mousedown.prevent
    @keydown="keydown"
  >
    <div class="table-tools-caption" :title="`${rows || 0} 行 · ${columns || 0} 列`">
      <Icon name="table" :size="16" />
      <span>{{ rows }} × {{ columns }}</span>
    </div>
    <div
      v-for="group in groups"
      :key="group.label"
      class="table-tools-group"
      role="group"
      :aria-label="group.label + '操作'"
    >
      <span class="table-tools-label" aria-hidden="true">{{ group.label }}</span>
      <button
        v-for="item in group.actions"
        :key="item.key"
        type="button"
        :aria-label="item.label"
        :title="item.label"
        :disabled="disabled"
        :aria-pressed="'value' in item ? alignment === item.value : undefined"
        :class="{ 'table-tools-delete': item.key.startsWith('delete') }"
        @click="emit('action', item.key)"
      >
        <Icon :name="item.icon" :size="16" />
      </button>
    </div>
    <div class="table-tools-group">
      <button
        type="button"
        class="table-tools-delete"
        aria-label="删除表格"
        title="删除表格"
        :disabled="disabled"
        @click="emit('action', 'deleteTable')"
      >
        <Icon name="trash" :size="16" />
      </button>
    </div>
  </div>
</template>
