<script setup lang="ts">
import type { ToDooItem } from '../../to-doo-workbench';
defineProps<{ item: ToDooItem; selected?: boolean; selecting?: boolean }>();
const emit = defineEmits<{
  open: [item: ToDooItem];
  complete: [item: ToDooItem];
  select: [id: string];
  child: [id: string];
}>();
</script>
<template>
  <div
    class="todo-task-row"
    :class="{ 'is-done': item.status === 'done' }"
    :style="{ '--depth': Math.min(item.depth, 5) }"
  >
    <input
      v-if="selecting"
      type="checkbox"
      :checked="selected"
      :aria-label="'选择 ' + item.title"
      @change="emit('select', item.task.id)"
    />
    <button
      v-else
      type="button"
      class="todo-check"
      :class="{ 'is-checked': item.status === 'done' }"
      :disabled="!item.occurrence"
      :aria-label="(item.status === 'done' ? '重新打开 ' : '完成 ') + item.title"
      @click="emit('complete', item)"
    >
      {{ item.status === 'done' ? '✓' : '' }}
    </button>
    <button
      type="button"
      class="todo-task-body"
      :aria-label="item.title"
      @click="emit('open', item)"
    >
      <span>{{ item.title }}</span
      ><small
        ><span v-if="item.list" class="todo-badge">{{ item.list.name }}</span
        ><span v-if="item.task.noteRefs.length">▤ {{ item.task.noteRefs.length }}</span
        ><span v-if="item.task.estimateMinutes !== null">{{ item.task.estimateMinutes }} 分钟</span
        ><span v-if="item.task.recurrence">↻ 重复</span
        ><span v-if="item.status === 'blocked'">受阻</span
        ><span v-if="item.status === 'unavailable'">执行记录尚未载入</span></small
      >
    </button>
    <span class="todo-task-date"
      >{{ item.date || '未安排'
      }}<small v-if="item.blocks[0]?.start.time">{{ item.blocks[0].start.time }}</small></span
    >
    <button
      type="button"
      class="todo-icon-button todo-row-add"
      :aria-label="'添加子任务 ' + item.title"
      @click="emit('child', item.task.id)"
    >
      ＋
    </button>
  </div>
</template>
