<script setup lang="ts">
import { computed } from 'vue';
import { Button as AButton, Checkbox as ACheckbox, Tag as ATag } from 'ant-design-vue';
import type { ToDooItem } from '../../to-doo-workbench';
import { toDooDisplayTime, toDooLocalDate, toDooPriorityLabels } from '../../to-doo-workbench';
import { toDooDateLabel } from '../../to-doo-presentation';
const props = withDefaults(
  defineProps<{
    item: ToDooItem;
    active?: boolean;
    selected?: boolean;
    selecting?: boolean;
    hideList?: boolean;
    today?: string;
    timeZone?: string;
  }>(),
  { today: () => toDooLocalDate() },
);
const emit = defineEmits<{
  open: [item: ToDooItem];
  complete: [item: ToDooItem];
  select: [id: string];
  child: [id: string];
}>();
const dates = computed(() => {
  const { item, today, timeZone } = props;
  const plan =
    item.blocks[0]?.start ||
    (item.task.recurrence && item.occurrence?.scheduledDate
      ? { date: item.occurrence.scheduledDate, time: null }
      : null);
  const due = item.occurrence?.due
    ? toDooDisplayTime(item.occurrence.due, timeZone || item.occurrence.due.timeZone)
    : null;
  const overdue =
    !!due && due.date < today && !['done', 'cancelled', 'skipped'].includes(item.status);
  const same = plan && due && plan.date === due.date && plan.time === due.time;
  const values = same
    ? [{ kind: 'both', label: '计划 / 截止', value: due, overdue }]
    : [
        ...(plan ? [{ kind: 'plan', label: '计划', value: plan, overdue: false }] : []),
        ...(due ? [{ kind: 'deadline', label: '截止', value: due, overdue }] : []),
      ];
  return values.map((date) => ({
    ...date,
    description:
      date.label +
      ' ' +
      date.value.date +
      (date.value.time ? ' ' + date.value.time : '') +
      (date.overdue ? '（已逾期）' : ''),
  }));
});
</script>
<template>
  <div
    class="todo-task-row"
    :class="{
      'is-done': item.status === 'done',
      'is-active': active,
      'is-selected': selected,
      ['todo-priority-' + item.task.priority]: true,
    }"
    :style="{ '--depth': Math.min(item.depth, 5) }"
  >
    <ACheckbox
      v-if="selecting"
      :checked="selected"
      :aria-label="'选择 ' + item.title"
      @change="emit('select', item.task.id)"
    />
    <AButton
      v-else
      html-type="button"
      class="todo-check"
      :class="{ 'is-checked': item.status === 'done' }"
      :disabled="!item.occurrence"
      :aria-label="(item.status === 'done' ? '重新打开 ' : '完成 ') + item.title"
      @click="emit('complete', item)"
      type="text"
    >
      {{ item.status === 'done' ? '✓' : '' }}
    </AButton>
    <AButton
      html-type="button"
      class="todo-task-body"
      :aria-label="item.title"
      :aria-current="active ? 'true' : undefined"
      @click="emit('open', item)"
      type="text"
    >
      <span>{{ item.title }}</span
      ><small
        ><ATag
          class="todo-priority-label"
          :aria-label="'优先级：' + toDooPriorityLabels[item.task.priority]"
          >{{ toDooPriorityLabels[item.task.priority]
          }}{{ item.task.priority === 'none' ? '' : '优先级' }}</ATag
        ><span v-if="item.list && !hideList" class="todo-row-list">{{ item.list.name }}</span
        ><span v-if="item.task.noteRefs.length">▤ {{ item.task.noteRefs.length }}</span
        ><span v-if="item.task.recurrence" title="重复任务">↻</span
        ><span v-if="item.status === 'blocked'">受阻</span
        ><span v-if="item.status === 'unavailable'">执行记录尚未载入</span></small
      >
    </AButton>
    <span v-if="dates.length" class="todo-task-dates">
      <span
        v-for="date in dates"
        :key="date.kind"
        class="todo-task-date"
        :class="{
          'todo-task-plan': date.kind !== 'deadline',
          'todo-task-deadline': date.kind !== 'plan',
          'todo-danger': date.overdue,
          'todo-date-today': date.value.date === today,
        }"
        :title="date.description"
        :aria-label="date.description"
      >
        <span class="todo-task-date-kind">{{ date.label }}</span>
        <span class="todo-task-date-value"
          >{{ toDooDateLabel(date.value.date, today)
          }}<small v-if="date.value.time">{{ date.value.time }}</small></span
        >
      </span>
    </span>
    <AButton
      html-type="button"
      class="todo-icon-button todo-row-add"
      :aria-label="'添加子任务 ' + item.title"
      @click="emit('child', item.task.id)"
      type="text"
    >
      ＋
    </AButton>
  </div>
</template>
