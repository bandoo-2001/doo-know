<script setup lang="ts">
import { computed, useId } from 'vue';
import { Button as AButton, Checkbox as ACheckbox, Tag as ATag } from 'ant-design-vue';
import type { ToDooItem } from '../../to-doo-workbench';
import type { ToDooDisplayFields } from '../../to-doo-display-preferences';
import {
  toDooDisplayTime,
  toDooLocalDate,
  toDooPriorityLabels,
  toDooDeadlineOverdue,
} from '../../to-doo-workbench';
import { toDooDateLabel } from '../../to-doo-presentation';
import ToDooIcon from './ToDooIcon.vue';
import ToDooListIcon from './ToDooListIcon.vue';
import ToDooTaskValueLabel from './ToDooTaskValueLabel.vue';
const props = withDefaults(
  defineProps<{
    item: ToDooItem;
    active?: boolean;
    selected?: boolean;
    selecting?: boolean;
    hideList?: boolean;
    parentTitle?: string;
    displayFields?: Partial<ToDooDisplayFields>;
    readOnly?: boolean;
    listNavigation?: boolean;
    rowContextActions?: boolean;
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
const rowId = useId();
function openFromRow(event: MouseEvent) {
  if (event.defaultPrevented || event.button !== 0) return;
  const row = event.currentTarget as HTMLElement;
  const target = event.target;
  if (!(target instanceof Element)) return;
  const control = target.closest('button, a, label, input, select, textarea, summary, [contenteditable], [role="button"], [role="checkbox"]');
  if (control && !control.classList.contains('todo-task-body')) return;
  const selection = row.ownerDocument.getSelection();
  if (event.detail > 0 && selection && !selection.isCollapsed &&
      (row.contains(selection.anchorNode) || row.contains(selection.focusNode))) return;
  if (!control) row.querySelector<HTMLButtonElement>('button.todo-task-body')?.focus({ preventScroll: true });
  event.stopPropagation();
  emit('open', props.item);
}
function openRowActions(event: MouseEvent | KeyboardEvent) {
  const target = event.target;
  if (!(target instanceof Element) || target.closest('input, textarea, select, [contenteditable]')) return;
  const row = event.currentTarget as HTMLElement;
  if (event instanceof KeyboardEvent) {
    if (!target.matches('.todo-task-body') || event.isComposing || event.keyCode === 229 ||
        event.altKey || event.ctrlKey || event.metaKey ||
        !(event.key === 'ContextMenu' || (event.key === 'F10' && event.shiftKey))) return;
  } else if (!props.rowContextActions) {
    // The list and board already position their context menus at the pointer.
    const body = row.querySelector<HTMLButtonElement>('button.todo-task-body');
    body?.focus({ preventScroll: true });
    return;
  }
  const button = row.querySelector<HTMLButtonElement>('button.todo-task-menu-trigger');
  if (event.defaultPrevented || !button || button.disabled) return;
  event.preventDefault();
  event.stopPropagation();
  if (!(event instanceof KeyboardEvent)) button.focus({ preventScroll: true });
  if (button.getAttribute('aria-expanded') !== 'true') button.click();
}
const hasMetadata = computed(() => {
  const { item, hideList } = props;
  return (
    !!props.parentTitle ||
    (props.displayFields?.priority !== false && item.task.priority !== 'none') ||
    (props.displayFields?.list !== false && !!item.list && !hideList) ||
    (props.displayFields?.resources !== false && item.task.noteRefs.length > 0) ||
    (props.displayFields?.recurrence !== false && !!item.task.recurrence) ||
    ['doing', 'blocked', 'done', 'cancelled', 'skipped'].includes(item.status) ||
    item.status === 'unavailable'
  );
});
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
  const overdue = toDooDeadlineOverdue(item.occurrence?.due, item.status, today);
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
const dateRange = computed(() => {
  const [start, end] = dates.value;
  if (!start || !end || start.value.date !== end.value.date || !start.value.time || !end.value.time) return undefined;
  return { compact: true };
});
const dateDescription = computed(() => dates.value.map(date => date.description).join('；'));
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
    @click="openFromRow"
    @contextmenu="openRowActions"
    @keydown="openRowActions"
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
      :disabled="readOnly || !item.occurrence"
      :aria-label="(item.status === 'done' ? '重新打开 ' : '完成 ') + item.title"
      :aria-pressed="item.status === 'done'"
      @click="emit('complete', item)"
      type="text"
    >
      <span class="todo-check-indicator" aria-hidden="true"><ToDooIcon name="check" :size="14" /></span>
    </AButton>
    <AButton
      html-type="button"
      class="todo-task-body"
      :data-task-key="item.key"
      :aria-keyshortcuts="listNavigation ? 'ArrowUp ArrowDown Home End Enter Shift+F10' : 'Shift+F10'"
      :aria-label="item.title"
      :aria-describedby="[hasMetadata && rowId + '-meta', dates.length > 0 && rowId + '-dates'].filter(Boolean).join(' ') || undefined"
      :aria-current="active ? 'true' : undefined"
      type="text"
    >
      <span class="todo-task-name" :title="item.title">{{ item.title }}</span>
      <small v-if="hasMetadata" :id="rowId + '-meta'" class="todo-task-meta">
        <span v-if="parentTitle" class="todo-row-parent" role="note"
          :title="'父任务：' + parentTitle" :aria-label="'子任务，父任务：' + parentTitle">子任务</span>
        <ATag
          v-if="displayFields?.priority !== false && item.task.priority !== 'none'"
          class="todo-priority-label"
          :aria-label="'优先级：' + toDooPriorityLabels[item.task.priority]"
          >{{ toDooPriorityLabels[item.task.priority] }}优先级</ATag
        >
        <span v-if="displayFields?.list !== false && item.list && !hideList" class="todo-row-list" :title="item.list.name"><ToDooListIcon :list="item.list.icon ? item.list : { color: item.list.color, icon: 'dot' }" :size="13" /><span>{{ item.list.name }}</span></span>
        <span v-if="displayFields?.resources !== false && item.task.noteRefs.length" class="todo-row-symbol" role="img" :aria-label="'关联资料 ' + item.task.noteRefs.length + ' 份'"><ToDooIcon name="attachment" :size="14" />{{ item.task.noteRefs.length }}</span>
        <span v-if="displayFields?.recurrence !== false && item.task.recurrence" class="todo-row-symbol" role="img" title="重复任务" aria-label="重复任务"><ToDooIcon name="repeat" :size="14" /></span>
        <ToDooTaskValueLabel v-if="['doing', 'blocked', 'done', 'cancelled', 'skipped'].includes(item.status)"
          kind="status" :value="item.status" />
        <span v-if="item.status === 'unavailable'">执行记录尚未载入</span>
      </small>
    </AButton>
    <span v-if="dates.length" :id="rowId + '-dates'" class="todo-task-dates"
      :class="{ 'is-range': !!dateRange }" :title="dateDescription" :aria-label="dateDescription">
      <span
        v-for="(date, index) in dates"
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
        <span v-if="dateRange && index > 0" class="todo-task-date-separator" aria-hidden="true">–</span>
        <span v-if="!dateRange" class="todo-task-date-kind">{{ date.label }}</span>
        <span class="todo-task-date-value"
          :class="{ 'todo-range-time-only': dateRange?.compact && index > 0 }"
          ><template v-if="!dateRange?.compact || index === 0">{{ toDooDateLabel(date.value.date, today) }}</template
          ><small v-if="date.value.time">{{ date.value.time }}</small></span
        >
      </span>
    </span>
    <slot name="actions"
      ><AButton
        html-type="button"
        class="todo-icon-button todo-row-add"
        :aria-label="'添加子任务 ' + item.title"
        @click="emit('child', item.task.id)"
        type="text"
      >
        ＋
      </AButton></slot
    >
  </div>
</template>
<style scoped>
.todo-row-parent {
  display: inline-flex;
  align-items: center;
  padding-inline: 5px;
  border: 1px solid var(--todo-line);
  border-radius: var(--todo-tag-radius);
  color: var(--todo-muted);
  font-size: var(--todo-caption-size);
  line-height: var(--todo-caption-line-height);
}
</style>
<style scoped>
.todo-task-dates.is-range { gap: 3px 4px; }
.todo-task-dates.is-range > .todo-task-date { flex-wrap: nowrap; gap: 4px; }
.todo-task-date-separator { align-self: center; flex: 0 0 8px; width: 8px; height: 1px; overflow: hidden; background: var(--todo-muted); opacity: .55; font-size: 0; line-height: 0; }
.todo-task-dates.is-range .todo-task-date-value { min-width: 0; white-space: normal; }
.todo-task-row > .todo-task-dates.is-range .todo-range-time-only small { margin-left: 0; }
.todo-task-dates.is-range .todo-task-date-value small { white-space: nowrap; }
.todo-task-row {
  cursor: pointer;
}
.todo-row-symbol {
  display: inline-flex;
  align-items: center;
  gap: var(--todo-space-4);
}
.todo-row-list > span {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.todo-row-list {
  display: inline-flex;
  align-items: center;
  gap: 5px;
}
.todo-row-list > .todo-list-icon {
  flex-shrink: 0;
  overflow: visible;
}
</style>
