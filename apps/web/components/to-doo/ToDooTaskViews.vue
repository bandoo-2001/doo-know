<script setup lang="ts">
import { toDooFilterSummary } from '../../to-doo-presentation';
import ToDooDisclosure from './ToDooDisclosure.vue';
import ToDooHint from './ToDooHint.vue';
import ToDooTaskOverviewSummary from './ToDooTaskOverviewSummary.vue';
import { useToDooConfirm } from '../../to-doo-controls';
import ToDooDateField from './ToDooDateField.vue';
import ToDooSelect from './ToDooSelect.vue';

import { computed, ref } from 'vue';
import {
  Button as AButton,
  Card as ACard,
  Empty as AEmpty,
  Progress as AProgress,
  Checkbox as ACheckbox,
  Dropdown as ADropdown,
  Menu as AMenu,
  MenuItem as AMenuItem,
  Input as AInput,
  Segmented as ASegmented,
  Tag as ATag,
} from 'ant-design-vue';
import type { TreeEntry } from '../../../../shared/contracts';
import ToDooFilterGroup from './ToDooFilterGroup.vue';
import type { ToDooAppSection } from '../../navigation';
import type { ToDooEntityKind } from '../../../../shared/to-doo-contracts';
import {
  toDooLocalDate,
  toDooDisplayTime,
  shiftToDooDate,
  toDooStatusLabels,
  toDooPriorityLabels,
  toDooItemMatchesDateRange,
  toDooPending,
  type ToDooCreateSeed,
  type ToDooItem,
  type ToDooWorkbench,
} from '../../to-doo-workbench';
import ToDooTaskRow from './ToDooTaskRow.vue';
import ToDooQuickAdd from './ToDooQuickAdd.vue';
import ToDooIcon from './ToDooIcon.vue';
import ToDooTaskMenu from './ToDooTaskMenu.vue';
import ToDooTaskGroupMenu from './ToDooTaskGroupMenu.vue';
import { groupTaskItems, taskSectionIds, boardTaskCards } from '../../to-doo-task-groups';
import type { ToDooQuickFilter } from '../../to-doo-presentation';
const confirmAction = useToDooConfirm();
const props = withDefaults(
  defineProps<{
    model: ToDooWorkbench;
    section: ToDooAppSection;
    tree: TreeEntry[];
    quickView?: ToDooQuickFilter;
    creating?: boolean;
  }>(),
  { quickView: 'all' },
);
const emit = defineEmits<{
  open: [item: ToDooItem];
  create: [parentTaskId?: string, sectionId?: string | null, seed?: ToDooCreateSeed];
  list: [id: string];
  edit: [kind: ToDooEntityKind, entity?: Record<string, any>, seed?: Record<string, any>];
  navigate: [section: ToDooAppSection];
  bulk: [];
  'quick-filter': [value: ToDooQuickFilter];
}>();
const viewOptions = [
  { value: 'tasks', label: '列表' },
  { value: 'board', label: '看板' },
  { value: 'matrix', label: '四象限' },
  { value: 'timeline', label: '时间线' },
];
function chooseView(value: string | number) {
  if (value === 'tasks' || value === 'board' || value === 'matrix' || value === 'timeline')
    emit('navigate', value);
}
const quadrants = [
  { name: '重要且紧急', action: '立即行动', tone: 'do', empty: '优先处理影响大、时间紧的任务。' },
  { name: '重要不紧急', action: '安排计划', tone: 'plan', empty: '给重要的长期任务安排一段时间。' },
  {
    name: '紧急不重要',
    action: '协调处理',
    tone: 'delegate',
    empty: '及时协调、委派或简化紧急事务。',
  },
  {
    name: '不紧急不重要',
    action: '留待以后',
    tone: 'later',
    empty: '暂时不急的想法可以留在这里，定期回顾。',
  },
];
const advancedFilters = ref(false);
const toolsOpen = ref(false);
const filterOpen = ref(false),
  showCompleted = ref(false);
const builtin = computed({
  get: () => props.quickView,
  set: (value: ToDooQuickFilter) => emit('quick-filter', value),
});
const state = props.model.state,
  selecting = ref(false),
  collapsed = ref<string[]>([]),
  boardBy = ref('status'),
  bulkList = ref(''),
  bulkDate = ref(''),
  bulkPriority = ref<'none' | 'low' | 'normal' | 'high'>('normal');
const today = computed(() => toDooLocalDate(new Date(), state.snapshot?.settings.timeZone));
const items = computed(() =>
  props.model
    .items()
    .filter(
      (row) =>
        (builtin.value !== 'inbox' || row.task.listId === null) &&
        (builtin.value !== 'trash' || !!row.task.deletedAt) &&
        (builtin.value !== 'archived' || !!row.task.archivedAt),
    ),
);
const visibleItems = computed(() =>
  items.value.filter((item) => {
    let parent = item.task.parentTaskId;
    const seen = new Set<string>();
    while (parent && !seen.has(parent)) {
      if (collapsed.value.includes(parent)) return false;
      seen.add(parent);
      parent = state.snapshot?.tasks.find((t) => t.id === parent)?.parentTaskId || null;
    }
    return true;
  }),
);
const completedItems = computed(() => visibleItems.value.filter((i) => i.status === 'done'));
const outlineItems = computed(() =>
  visibleItems.value.filter(
    (i) =>
      i.status !== 'done' ||
      showCompleted.value ||
      builtin.value === 'done' ||
      !!state.filter.query,
  ),
);
const filterCount = computed(() => toDooFilterSummary(state.filter).length);
const lists = computed(
  () => state.snapshot?.lists.filter((l) => !l.deletedAt && !l.archivedAt) || [],
);
const goals = computed(() => lists.value.filter((list) => list.kind === 'goal'));
const ordinaryLists = computed(() => lists.value.filter((list) => list.kind !== 'goal'));
const recentOutcomes = computed(
  () => state.snapshot?.outcomes.filter((outcome) => !outcome.deletedAt).slice(0, 3) ?? [],
);
const matrixIncludesCompleted = computed(
  () =>
    builtin.value === 'done' ||
    !!state.filter.statuses?.includes('done') ||
    !!state.filter.query ||
    !!state.filter.group,
);
const matrixItems = computed(() =>
  items.value.filter(
    (item) => item.status !== 'done' || showCompleted.value || matrixIncludesCompleted.value,
  ),
);
const activeListId = computed(() =>
  state.filter.listIds?.length === 1 ? state.filter.listIds[0] : undefined,
);
const sections = computed(
  () =>
    state.snapshot?.sections
      .filter(
        (section) =>
          !section.deletedAt && (!activeListId.value || section.listId === activeListId.value),
      )
      .sort((a, b) => a.orderKey.localeCompare(b.orderKey) || a.id.localeCompare(b.id)) ?? [],
);
const outlineGroups = computed(() =>
  groupTaskItems(
    outlineItems.value,
    props.model.taskDefinitions(),
    sections.value,
    activeListId.value,
  ),
);
const expandedBoardCards = ref<string[]>([]);
const effectiveSections = computed(() => taskSectionIds(props.model.taskDefinitions()));
const sectionIds = computed(() => new Set(sections.value.map((section) => section.id)));
const groupCollapsed = (id: string) => state.collapsedTaskGroups.includes(id);
function toggleGroup(id: string) {
  state.collapsedTaskGroups = groupCollapsed(id)
    ? state.collapsedTaskGroups.filter((value) => value !== id)
    : [...state.collapsedTaskGroups, id];
}
const columnSection = (id: string) => sections.value.find((section) => section.id === id);
function newSection() {
  const listId = activeListId.value || lists.value[0]?.id || '';
  emit('edit', 'section', undefined, { listId, sectionPlacement: {} });
}
const todayItems = computed(() =>
  items.value.filter(
    (i) =>
      toDooItemMatchesDateRange(i, today.value, today.value, state.snapshot?.settings.timeZone) &&
      toDooPending(i.status),
  ),
);
const materials = computed(() => {
  const refs = new Map<string, { title: string; task: ToDooItem }>();
  todayItems.value.forEach((i) =>
    i.task.noteRefs.forEach((r) => refs.set(r.noteId, { title: r.title || '关联资料', task: i })),
  );
  return [...refs.values()].slice(0, 5);
});
const columns = computed(() =>
  boardBy.value === 'list'
    ? [{ id: '', name: '收集箱' }, ...lists.value.map((l) => ({ id: l.id, name: l.name }))]
    : boardBy.value === 'priority'
      ? Object.entries(toDooPriorityLabels).map(([id, name]) => ({ id, name }))
      : boardBy.value === 'section'
        ? [
            { id: '', name: '未分组' },
            ...(sections.value.map((s) => ({ id: s.id, name: s.name })) || []),
          ]
        : boardBy.value === 'tag'
          ? [
              { id: '', name: '无标签' },
              ...(state.snapshot?.tags
                .filter((t) => !t.deletedAt)
                .map((t) => ({ id: t.id, name: t.name })) || []),
            ]
          : Object.entries(toDooStatusLabels)
              .filter(
                ([id]) =>
                  !['cancelled', 'skipped'].includes(id) ||
                  items.value.some((i) => i.status === id),
              )
              .map(([id, name]) => ({ id, name })),
);
function inColumn(item: ToDooItem, id: string) {
  return boardBy.value === 'list'
    ? (item.task.listId || '') === id
    : boardBy.value === 'priority'
      ? item.task.priority === id
      : boardBy.value === 'section'
        ? (sectionIds.value.has(effectiveSections.value.get(item.task.id) ?? '')
            ? effectiveSections.value.get(item.task.id)
            : '') === id
        : boardBy.value === 'tag'
          ? id
            ? item.task.tagIds.includes(id)
            : !item.task.tagIds.length
          : item.status === id;
}
function select(id: string) {
  state.selectedIds = state.selectedIds.includes(id)
    ? state.selectedIds.filter((v) => v !== id)
    : [...state.selectedIds, id];
}
function active(item: ToDooItem) {
  return (
    state.selectedTaskId === item.task.id &&
    (item.occurrence?.id || '') === state.selectedOccurrenceId
  );
}
async function changeStatus(
  item: ToDooItem,
  status: NonNullable<ToDooItem['occurrence']>['status'],
) {
  if (!item.occurrence) return;
  const children = status === 'done' ? await props.model.statusChildCount(item.task.id) : 0;
  if (children === null) return;
  if (
    status === 'done' &&
    children &&
    !(await confirmAction(`这个任务有 ${children} 个子任务，是否一并完成？`))
  )
    return;
  await props.model.setStatus(item.occurrence.id, status, status === 'done' && children > 0);
}
async function complete(item: ToDooItem) {
  return changeStatus(item, item.status === 'done' ? 'todo' : 'done');
}
const createContext = computed<ToDooCreateSeed>(() => ({
  initialStatus: 'todo',
  priority: 'none',
  tagIds: [],
  planDate: '',
  ...(activeListId.value ? { listId: activeListId.value } : {}),
  ...(builtin.value === 'today' ? { planDate: today.value } : {}),
  ...(state.filter.tagIds?.length ? { tagIds: [...state.filter.tagIds] } : {}),
  ...(state.filter.priorities?.length === 1 ? { priority: state.filter.priorities[0] } : {}),
}));
function createInColumn(id: string) {
  const seed: ToDooCreateSeed = { ...createContext.value };
  if (boardBy.value === 'status')
    seed.initialStatus = id as NonNullable<ToDooItem['occurrence']>['status'];
  if (boardBy.value === 'list') seed.listId = id || null;
  if (boardBy.value === 'priority') seed.priority = id as ToDooItem['task']['priority'];
  if (boardBy.value === 'tag') seed.tagIds = id ? [...new Set([...(seed.tagIds || []), id])] : [];
  emit(
    'create',
    undefined,
    boardBy.value === 'section' && activeListId.value ? id || null : undefined,
    seed,
  );
}
function jumpTo(id: string) {
  document
    .getElementById(id)
    ?.scrollIntoView({ behavior: 'smooth', block: 'start', inline: 'center' });
}
async function filterChanged() {
  await props.model.load({ ...state.query, cursor: undefined, filter: { ...state.filter } });
}
function toggleTree(id: string) {
  collapsed.value = collapsed.value.includes(id)
    ? collapsed.value.filter((v) => v !== id)
    : [...collapsed.value, id];
}
function drag(event: DragEvent, item: ToDooItem) {
  event.dataTransfer?.setData('application/x-to-doo-item', item.key);
}
async function drop(event: DragEvent, column: string) {
  event.preventDefault();
  const item = items.value.find(
    (i) => i.key === event.dataTransfer?.getData('application/x-to-doo-item'),
  );
  if (!item) return;
  if (boardBy.value === 'status') {
    await changeStatus(item, column as any);
  } else {
    const patch =
      boardBy.value === 'priority'
        ? { priority: column as any }
        : boardBy.value === 'section'
          ? { sectionId: column || null }
          : boardBy.value === 'tag'
            ? { tagIds: column ? [...new Set([...item.task.tagIds, column])] : [] }
            : undefined;
    await props.model.execute({
      action: 'batch_tasks',
      payload: {
        ids: [item.task.id],
        expectedRevisions: { [item.task.id]: item.task.revision },
        operation: boardBy.value === 'list' ? 'move' : 'patch',
        ...(patch ? { patch } : {}),
        ...(boardBy.value === 'list' ? { listId: column || null } : {}),
        includeDescendants: true,
      },
    });
  }
}
function urgent(item: ToDooItem) {
  if (item.task.urgentOverride !== null) return item.task.urgentOverride;
  if (!item.occurrence?.due) return false;
  const d = toDooDisplayTime(
    { ...item.occurrence.due, time: item.occurrence.due.time || '23:59' },
    'UTC',
  );
  return (
    Date.parse(d.date + 'T' + d.time + ':00Z') <=
    Date.now() + (state.snapshot?.settings.urgentHours || 48) * 3600000
  );
}
function quadrant(item: ToDooItem, index: number) {
  return (item.task.importance === 'important' ? 0 : 2) + (urgent(item) ? 0 : 1) === index;
}
async function dropQuadrant(event: DragEvent, index: number) {
  event.preventDefault();
  const item = items.value.find(
    (i) => i.key === event.dataTransfer?.getData('application/x-to-doo-item'),
  );
  if (item) await setQuadrant(item, index);
}
async function setQuadrant(item: ToDooItem, index: number) {
  await props.model.execute({
    action: 'update_task',
    payload: {
      id: item.task.id,
      expectedRevision: item.task.revision,
      patch: { importance: index < 2 ? 'important' : 'normal', urgentOverride: index % 2 === 0 },
    },
  });
}
async function bulk(
  operation:
    | 'complete'
    | 'cancel'
    | 'copy'
    | 'delete'
    | 'restore'
    | 'move'
    | 'archive'
    | 'priority',
) {
  const selection = [...state.selectedIds].sort().join('\n');
  if (
    operation === 'delete' &&
    !(await confirmAction(`将选中的 ${state.selectedIds.length} 项及其子任务移入回收站？`))
  )
    return;
  if (operation === 'delete' && [...state.selectedIds].sort().join('\n') !== selection) return;
  await props.model.batch(
    operation === 'archive' || operation === 'priority' ? 'patch' : operation,
    operation === 'move'
      ? { listId: bulkList.value || null }
      : operation === 'archive'
        ? { patch: { archivedAt: new Date().toISOString() } }
        : operation === 'priority'
          ? { patch: { priority: bulkPriority.value } }
          : {},
  );
}
async function bulkDue() {
  const occurrences =
    state.snapshot?.occurrences.filter(
      (o) => state.selectedIds.includes(o.taskId) && !o.deletedAt,
    ) || [];
  if (!occurrences.length) return;
  await props.model.execute(
    {
      action: 'import_entities',
      payload: {
        entities: occurrences.map((o) => ({
          kind: 'occurrence' as const,
          entity: {
            ...o,
            due: bulkDate.value
              ? {
                  date: bulkDate.value,
                  time: o.due?.time || null,
                  timeZone: o.due?.timeZone || state.snapshot!.settings.timeZone,
                }
              : null,
          },
          expectedRevision: o.revision,
        })),
      },
    },
    '截止日期已批量保存',
  );
}
async function indent(outdent = false) {
  const id = state.selectedIds[0],
    task = state.snapshot?.tasks.find((t) => t.id === id);
  if (!task) return;
  const parent = state.snapshot?.tasks.find((t) => t.id === task.parentTaskId);
  const previous = visibleItems.value[visibleItems.value.findIndex((i) => i.task.id === id) - 1];
  await props.model.batch('move', {
    parentTaskId: outdent ? parent?.parentTaskId || null : previous?.task.id || null,
  });
}
async function reorderBefore(event: DragEvent, target: ToDooItem) {
  event.preventDefault();
  const moved = items.value.find(
    (i) => i.key === event.dataTransfer?.getData('application/x-to-doo-item'),
  );
  if (!moved || moved.task.id === target.task.id) return;
  await reorder(moved, target);
}
async function reorder(moved: ToDooItem, target: ToDooItem) {
  if (
    moved.task.parentTaskId !== target.task.parentTaskId ||
    moved.task.listId !== target.task.listId
  ) {
    state.error = '请先将任务移动到同一父项与清单后排序';
    return;
  }
  const siblings = [
    ...new Map(
      items.value
        .filter(
          (i) =>
            i.task.parentTaskId === target.task.parentTaskId &&
            i.task.listId === target.task.listId,
        )
        .map((i) => [i.task.id, i.task]),
    ).values(),
  ].filter((t) => t.id !== moved.task.id);
  siblings.splice(
    Math.max(
      0,
      siblings.findIndex((t) => t.id === target.task.id),
    ),
    0,
    moved.task,
  );
  await props.model.execute(
    {
      action: 'import_entities',
      payload: {
        entities: siblings.map((t, index) => ({
          kind: 'task' as const,
          entity: { ...t, orderKey: 'a' + String(index).padStart(8, '0') },
          expectedRevision: t.revision,
        })),
      },
    },
    '任务顺序已保存',
  );
}
async function reorderStep(item: ToDooItem | undefined, delta: number) {
  if (!item) return;
  const siblings = [
    ...new Map(
      items.value
        .filter(
          (i) =>
            i.task.parentTaskId === item.task.parentTaskId && i.task.listId === item.task.listId,
        )
        .map((i) => [i.task.id, i]),
    ).values(),
  ];
  const index = siblings.findIndex((i) => i.task.id === item.task.id),
    target = siblings[index + delta];
  if (!target) return;
  if (delta < 0) await reorder(item, target);
  else await reorder(target, item);
}
async function applyView(view: NonNullable<typeof state.snapshot>['views'][number]) {
  state.filter = JSON.parse(JSON.stringify(view.filter));
  state.sort = view.sort;
  await props.model.load({
    ...state.query,
    view: view.mode,
    filter: state.filter,
    cursor: undefined,
  });
  emit('navigate', view.mode);
}
function saveView() {
  emit('edit', 'view', undefined, {
    filter: JSON.parse(JSON.stringify(state.filter)),
    mode: props.section,
    sort: state.sort,
  });
}
</script>
<template>
  <div v-if="section === 'overview'" class="todo-goal-overview">
    <ToDooTaskOverviewSummary :model="model" />
    <div
      v-if="
        state.filter.query ||
        state.filter.group ||
        state.filter.statuses?.length ||
        state.filter.tagIds?.length
      "
      class="todo-panel-footer todo-top-gap"
    >
      <span>当前行动按已选条件显示</span>
      <AButton
        type="link"
        @click="
          state.filter = {};
          model.load({ ...state.query, filter: {}, cursor: undefined });
        "
        >清除筛选</AButton
      >
    </div>
    <section class="todo-panel todo-overview-today" aria-label="今日行动">
      <div class="todo-panel-header">
        <h2>
          今天的行动 <small>· {{ todayItems.length }} 项待办</small>
        </h2>
        <AButton
          class="todo-icon-button"
          html-type="button"
          aria-label="新建今日行动"
          @click="emit('create', undefined, undefined, { ...createContext, planDate: today })"
          type="text"
          ><ToDooIcon name="plus" :size="18"
        /></AButton>
      </div>
      <div class="todo-overview-action-list">
        <ToDooTaskRow
          v-for="item in todayItems.slice(0, 12)"
          :key="item.key"
          :item="item"
          :active="active(item)"
          :today="today"
          :time-zone="state.snapshot?.settings.timeZone"
          :style="{ '--task-list-color': item.list?.color || 'var(--todo-accent)' }"
          @open="emit('open', $event)"
          @complete="complete"
          @child="emit('create', $event)"
          ><template #actions
            ><ToDooTaskMenu
              :model="model"
              :item="item"
              @open="emit('open', $event)"
              @child="emit('create', $event)"
              @edit="(kind, entity, seed) => emit('edit', kind, entity, seed)" /></template
        ></ToDooTaskRow>
      </div>
      <AEmpty v-if="!todayItems.length" class="todo-empty todo-overview-empty">
        <template #image
          ><span class="todo-overview-empty-icon"><ToDooIcon name="today" :size="28" /></span
        ></template>
        <template #description><p>今天还没有安排，留一点时间给重要的事。</p></template>
        <AButton
          type="default"
          @click="emit('create', undefined, undefined, { ...createContext, planDate: today })"
          >添加一个行动</AButton
        >
      </AEmpty>
      <div v-if="todayItems.length > 12" class="todo-panel-footer">
        <AButton type="link" @click="emit('quick-filter', 'today')"
          >查看全部 {{ todayItems.length }} 项今日行动 →</AButton
        >
      </div>
    </section>
    <section class="todo-overview-goals" aria-label="我的目标">
      <div class="todo-section-title todo-goals-heading">
        <h2>我的目标</h2>
        <span
          class="todo-goals-caption"
          title="按未归档叶子行动的执行次数计算；重复行动每次分别计数，取消和跳过不计。"
          >进度 = 已完成行动次数 / 目标行动次数</span
        >
      </div>
      <div class="todo-goals">
        <ACard v-for="goal in goals" :key="goal.id" class="todo-goal" role="article">
          <header class="todo-goal-header">
            <span class="todo-goal-icon"><ToDooIcon name="overview" :size="34" /></span>
            <div class="todo-goal-copy">
              <AButton
                class="todo-goal-name"
                html-type="button"
                type="text"
                @click="emit('list', goal.id)"
                >{{ goal.name }}</AButton
              >
              <p v-if="goal.description || goal.criteria">
                {{ goal.description || goal.criteria }}
              </p>
            </div>
            <ATag
              :bordered="false"
              class="todo-goal-state"
              :class="{
                'is-complete':
                  !!state.snapshot?.statistics.byList[goal.id]?.total &&
                  state.snapshot.statistics.byList[goal.id].completed >=
                    state.snapshot.statistics.byList[goal.id].total,
              }"
            >
              {{
                !state.snapshot?.statistics.byList[goal.id]?.total
                  ? '未开始'
                  : state.snapshot.statistics.byList[goal.id].completed >=
                      state.snapshot.statistics.byList[goal.id].total
                    ? '已完成'
                    : '进行中'
              }}
            </ATag>
            <AButton
              class="todo-icon-button todo-goal-edit"
              html-type="button"
              :aria-label="'编辑 ' + goal.name"
              type="text"
              @click="emit('edit', 'list', goal)"
              ><ToDooIcon name="more" :size="16"
            /></AButton>
          </header>
          <div v-if="state.snapshot?.statistics.byList[goal.id]?.total" class="todo-goal-progress">
            <span class="todo-goal-fraction"
              >{{ state.snapshot.statistics.byList[goal.id].completed }} /
              {{ state.snapshot.statistics.byList[goal.id].total }}</span
            >
            <AProgress
              :aria-label="goal.name + '完成进度'"
              :aria-valuenow="
                Math.round(
                  (state.snapshot.statistics.byList[goal.id].completed /
                    state.snapshot.statistics.byList[goal.id].total) *
                    100,
                )
              "
              :aria-valuemin="0"
              :aria-valuemax="100"
              :percent="
                Math.round(
                  (state.snapshot.statistics.byList[goal.id].completed /
                    state.snapshot.statistics.byList[goal.id].total) *
                    100,
                )
              "
              :show-info="false"
              :stroke-width="12"
              stroke-color="var(--todo-accent)"
              trail-color="var(--todo-soft)"
              status="normal"
            />
            <span class="todo-goal-percentage"
              >{{
                Math.round(
                  (state.snapshot.statistics.byList[goal.id].completed /
                    state.snapshot.statistics.byList[goal.id].total) *
                    100,
                )
              }}%</span
            >
          </div>
          <div v-else class="todo-goal-start">
            <span>还没有行动，先为目标迈出一步。</span>
            <AButton type="link" @click="emit('create', undefined, undefined, { listId: goal.id })"
              >＋ 添加行动</AButton
            >
          </div>
          <footer class="todo-goal-details">
            <span v-if="goal.goalDate"
              ><ToDooIcon name="calendar" :size="17" />目标日期：<time :datetime="goal.goalDate">{{
                goal.goalDate
              }}</time></span
            >
            <span v-else class="todo-muted"
              ><ToDooIcon name="calendar" :size="17" />未设置目标日期</span
            >
            <span v-if="goal.noteRefs.length">{{ goal.noteRefs.length }} 份资料</span>
          </footer>
        </ACard>
      </div>
      <AEmpty v-if="!goals.length" class="todo-panel todo-empty todo-overview-empty">
        <template #image
          ><span class="todo-overview-empty-icon"><ToDooIcon name="overview" :size="32" /></span
        ></template>
        <template #description
          ><h3>从一个想实现的目标开始</h3>
          <p>把目标拆成具体行动，让每一次完成都看得见。</p></template
        >
        <AButton
          class="todo-button todo-primary"
          type="primary"
          @click="emit('edit', 'list', undefined, { kind: 'goal' })"
          >创建第一个目标</AButton
        >
      </AEmpty>
    </section>
    <details
      v-if="ordinaryLists.length || materials.length || recentOutcomes.length"
      class="todo-overview-resources"
    >
      <summary>清单、资料与成果 <ToDooIcon name="chevron" :size="15" /></summary>
      <div class="todo-overview-context">
        <section class="todo-panel todo-overview-lists">
          <div class="todo-panel-header">
            <h2>清单</h2>
            <AButton
              html-type="button"
              type="text"
              class="todo-icon-button"
              aria-label="新建清单"
              @click="emit('edit', 'list', undefined, { kind: 'list' })"
              >＋</AButton
            >
          </div>
          <div v-for="list in ordinaryLists" :key="list.id" class="todo-overview-list">
            <AButton
              html-type="button"
              type="text"
              class="todo-saved-row todo-text-button"
              @click="emit('list', list.id)"
            >
              <span
                >{{ list.name
                }}<small v-if="list.description || list.criteria">{{
                  list.description || list.criteria
                }}</small
                ><small v-if="list.goalDate || list.noteRefs.length"
                  ><span v-if="list.goalDate">{{ list.goalDate }}</span
                  ><span v-if="list.goalDate && list.noteRefs.length"> · </span
                  ><span v-if="list.noteRefs.length">{{ list.noteRefs.length }} 份资料</span></small
                ></span
              >
              <small v-if="state.snapshot?.statistics.byList[list.id]?.total"
                >{{ state.snapshot?.statistics.byList[list.id]?.total }} 项任务</small
              >
            </AButton>
            <AButton
              html-type="button"
              type="text"
              class="todo-icon-button"
              :aria-label="'编辑 ' + list.name"
              @click="emit('edit', 'list', list)"
              >⋯</AButton
            >
          </div>
          <div v-if="!lists.length" class="todo-empty">
            <p>为工作、学习和生活创建清单，把资料与行动放在一起。</p>
            <AButton
              html-type="button"
              type="link"
              @click="emit('edit', 'list', undefined, { kind: 'goal' })"
              >创建第一个目标</AButton
            >
          </div>
        </section>
        <section v-if="materials.length" class="todo-panel">
          <div class="todo-panel-header">
            <h2>正在使用的资料</h2>
            <span>▤</span>
          </div>
          <AButton
            v-for="m in materials"
            :key="m.title"
            html-type="button"
            class="todo-saved-row todo-text-button"
            @click="emit('open', m.task)"
            type="text"
          >
            <span
              >{{ m.title }}<small>{{ m.task.title }}</small></span
            ><span>↗</span>
          </AButton>
        </section>
        <section v-if="recentOutcomes.length" class="todo-panel">
          <div class="todo-panel-header"><h2>最近的成果</h2></div>
          <AButton
            v-for="o in recentOutcomes"
            :key="o.id"
            html-type="button"
            class="todo-saved-row todo-text-button"
            @click="emit('edit', 'outcome', o)"
            type="text"
          >
            {{ o.summary }}
          </AButton>
        </section>
      </div>
    </details>
  </div>
  <template v-else>
    <ToDooQuickAdd
      v-if="!creating && section !== 'tasks'"
      :model="model"
      :list-id="state.filter.listIds?.[0]"
      :default-date="builtin === 'today' || builtin === 'upcoming' ? today : undefined"
      :seed="createContext"
      @expand="emit('create')"
    />
    <div class="todo-task-toolbar" :class="{ 'todo-task-list-toolbar': section === 'tasks' }">
      <ASegmented
        class="todo-view-switch todo-view-segmented"
        aria-label="任务展示方式"
        :value="section"
        :options="viewOptions"
        @change="chooseView"
      />
      <AButton
        type="text"
        class="todo-task-tools-toggle"
        aria-label="搜索与管理"
        :aria-expanded="toolsOpen"
        @click="toolsOpen = !toolsOpen"
        >搜索与管理</AButton
      >
      <form
        class="todo-toolbar-search todo-task-secondary-tools"
        :class="{ 'is-open': toolsOpen }"
        role="search"
        @submit.prevent="filterChanged"
      >
        <label class="todo-search"
          ><AInput
            v-model:value="state.filter.query"
            placeholder="搜索任务"
            aria-label="搜索任务" /><AButton html-type="submit" aria-label="执行搜索" type="text">
            <ToDooIcon name="search" :size="16" /></AButton
        ></label>
      </form>
      <ToDooSelect
        v-if="section === 'board'"
        v-model="boardBy"
        class="todo-board-group-picker todo-task-secondary-tools"
        :class="{ 'is-open': toolsOpen }"
        aria-label="看板分组"
      >
        <option value="status">按状态</option>
        <option value="list">按清单</option>
        <option value="priority">按优先级</option>
        <option value="section">按分组</option>
        <option value="tag">按标签</option>
      </ToDooSelect>
      <AButton
        html-type="button"
        class="todo-button todo-filter-toggle"
        :class="{ 'is-active': filterOpen || filterCount }"
        :aria-expanded="filterOpen"
        @click="filterOpen = !filterOpen"
        type="default"
      >
        <ToDooIcon name="filter" :size="16" />筛选与排序<small v-if="filterCount">{{
          filterCount
        }}</small>
      </AButton>
      <ADropdown :trigger="['click']" placement="bottomRight">
        <AButton
          type="text"
          aria-label="任务管理"
          class="todo-task-secondary-tools"
          :class="{ 'is-open': toolsOpen }"
          ><ToDooIcon name="more" :size="16" />任务管理</AButton
        >
        <template #overlay
          ><AMenu>
            <AMenuItem
              key="select"
              @click="
                selecting = !selecting;
                state.selectedIds = [];
              "
              >{{ selecting ? '结束多选' : '多选' }}</AMenuItem
            >
            <AMenuItem key="save-view" @click="saveView">保存视图</AMenuItem>
            <AMenuItem key="section" @click="newSection">＋ 分组</AMenuItem>
            <AMenuItem key="tag" @click="emit('edit', 'tag')">＋ 标签</AMenuItem>
            <AMenuItem key="template" @click="emit('edit', 'template')">＋ 模板</AMenuItem>
          </AMenu></template
        >
      </ADropdown>
    </div>
    <form v-if="filterOpen" class="todo-filters todo-filter-panel" @submit.prevent="filterChanged">
      <label
        >任务范围<ToDooSelect v-model="builtin" aria-label="内建筛选">
          <option value="all">全部任务</option>
          <option value="inbox">收集箱</option>
          <option value="today">今天</option>
          <option value="upcoming">近期 7 天</option>
          <option value="overdue">逾期</option>
          <option value="unscheduled">未安排</option>
          <option value="done">已完成</option>
          <option value="blocked">受阻</option>
          <option value="archived">已归档</option>
          <option value="trash">回收站</option>
        </ToDooSelect></label
      >
      <label
        >清单<ToDooSelect
          :value="state.filter.listIds?.[0] || ''"
          aria-label="筛选目标清单"
          @change="$event ? emit('list', $event) : emit('quick-filter', 'all')"
        >
          <option value="">全部目标与清单</option>
          <option v-for="l in lists" :key="l.id" :value="l.id">{{ l.name }}</option>
        </ToDooSelect></label
      >
      <label
        >标签<ToDooSelect
          :value="state.filter.tagIds?.[0] || ''"
          aria-label="筛选标签"
          @change="
            state.filter.tagIds = $event ? [$event] : [];
            filterChanged();
          "
        >
          <option value="">全部标签</option>
          <option
            v-for="tag in state.snapshot?.tags.filter((t) => !t.deletedAt)"
            :key="tag.id"
            :value="tag.id"
          >
            {{ tag.name }}
          </option>
        </ToDooSelect></label
      >
      <label
        >排序<ToDooSelect v-model="state.sort" aria-label="任务排序">
          <option value="manual">手动顺序</option>
          <option value="due">截止日期</option>
          <option value="priority">优先级</option>
          <option value="created">最近创建</option>
          <option value="title">标题</option>
        </ToDooSelect></label
      >
      <AButton
        html-type="button"
        class="todo-button"
        @click="
          advancedFilters = !advancedFilters;
          if (advancedFilters && !state.filter.group)
            state.filter.group = { operator: 'and', conditions: [] };
        "
        type="default"
      >
        条件组
      </AButton>
      <AButton
        html-type="button"
        class="todo-link"
        @click="
          state.filter = {};
          advancedFilters = false;
          emit('quick-filter', 'all');
        "
        type="link"
      >
        清除筛选
      </AButton>
    </form>
    <div v-if="advancedFilters && state.filter.group" class="todo-panel todo-filter-builder">
      <ToDooFilterGroup v-model="state.filter.group" :model="model" />
      <div class="todo-actions">
        <AButton
          class="todo-button todo-primary"
          html-type="button"
          @click="filterChanged"
          type="primary"
        >
          应用条件组</AButton
        ><AButton
          class="todo-link"
          html-type="button"
          @click="
            delete state.filter.group;
            advancedFilters = false;
            filterChanged();
          "
          type="link"
        >
          清除条件组
        </AButton>
      </div>
    </div>
    <div v-if="state.snapshot?.views.some((v) => !v.deletedAt)" class="todo-saved-views">
      <span>保存的视图</span>
      <div
        v-for="v in state.snapshot.views.filter((v) => !v.deletedAt)"
        :key="v.id"
        class="todo-actions"
      >
        <AButton html-type="button" class="todo-link" @click="applyView(v)" type="link">{{
          v.name
        }}</AButton
        ><AButton
          html-type="button"
          class="todo-icon-button"
          :aria-label="'编辑视图 ' + v.name"
          @click="emit('edit', 'view', v)"
          type="text"
        >
          ⋯
        </AButton>
      </div>
    </div>
    <div v-if="selecting" class="todo-batch">
      <label class="todo-checkbox"
        ><ACheckbox
          :checked="
            !!items.length && state.selectedIds.length === new Set(items.map((i) => i.task.id)).size
          "
          @change="
            state.selectedIds = ($event.target as HTMLInputElement).checked
              ? [...new Set(items.map((i) => i.task.id))]
              : []
          "
        />选择当前结果</label
      ><span>{{ state.selectedIds.length }} 项</span
      ><template v-if="state.selectedIds.length"
        ><AButton
          class="todo-button todo-primary"
          html-type="button"
          @click="emit('bulk')"
          type="primary"
        >
          批量编辑字段</AButton
        ><AButton
          class="todo-button"
          html-type="button"
          :disabled="state.busy"
          @click="bulk('complete')"
          type="default"
        >
          完成整棵子树
        </AButton>
        <ToDooDisclosure class="todo-batch-more">
          <template #header><span>更多批量操作</span></template>
          <div class="todo-batch-more-content">
            <AButton
              class="todo-button"
              html-type="button"
              :disabled="state.busy"
              @click="bulk('copy')"
              type="default"
            >
              复制</AButton
            ><AButton
              class="todo-button"
              html-type="button"
              :disabled="state.busy"
              @click="bulk('cancel')"
              type="default"
            >
              取消</AButton
            ><AButton
              class="todo-button"
              html-type="button"
              :disabled="state.busy"
              @click="bulk('archive')"
              type="default"
            >
              归档</AButton
            ><AButton
              class="todo-button todo-danger"
              html-type="button"
              :disabled="state.busy"
              @click="bulk('delete')"
              type="default"
              danger
            >
              删除</AButton
            ><AButton
              v-if="builtin === 'trash'"
              class="todo-button"
              html-type="button"
              :disabled="state.busy"
              @click="bulk('restore')"
              type="default"
            >
              恢复</AButton
            ><ToDooSelect v-model="bulkList" aria-label="移动到清单">
              <option value="">收集箱</option>
              <option v-for="l in lists" :key="l.id" :value="l.id">
                {{ l.name }}
              </option></ToDooSelect
            ><AButton
              class="todo-button"
              html-type="button"
              :disabled="state.busy"
              @click="bulk('move')"
              type="default"
            >
              移动到</AButton
            ><ToDooSelect v-model="bulkPriority" aria-label="批量优先级">
              <option v-for="(n, k) in toDooPriorityLabels" :key="k" :value="k">
                {{ n }}
              </option></ToDooSelect
            ><AButton
              class="todo-button"
              html-type="button"
              @click="bulk('priority')"
              type="default"
              >设置优先级</AButton
            ><ToDooDateField v-model="bulkDate" type="date" aria-label="批量截止日期" /><AButton
              class="todo-button"
              html-type="button"
              @click="bulkDue"
              type="default"
            >
              设置截止</AButton
            ><AButton
              class="todo-button"
              html-type="button"
              @click="
                reorderStep(
                  items.find((i) => i.task.id === state.selectedIds[0]),
                  -1,
                )
              "
              type="default"
            >
              上移首项</AButton
            ><AButton
              class="todo-button"
              html-type="button"
              @click="
                reorderStep(
                  items.find((i) => i.task.id === state.selectedIds[0]),
                  1,
                )
              "
              type="default"
            >
              下移首项</AButton
            ><AButton class="todo-button" html-type="button" @click="indent()" type="default"
              >缩进</AButton
            ><AButton class="todo-button" html-type="button" @click="indent(true)" type="default"
              >提升</AButton
            >
          </div>
        </ToDooDisclosure></template
      >
    </div>
    <div v-if="section === 'tasks' && !creating" class="todo-task-list-capture">
      <ToDooQuickAdd
        :model="model"
        :list-id="state.filter.listIds?.[0]"
        :default-date="builtin === 'today' || builtin === 'upcoming' ? today : undefined"
        :seed="createContext"
        @expand="emit('create')"
      />
    </div>
    <div v-if="section === 'tasks'" class="todo-panel todo-tree todo-task-list-panel">
      <div class="todo-panel-header todo-task-list-heading">
        <h2>
          {{ state.filter.query ? '搜索结果' : '待办任务' }}
          <small>{{ items.filter((i) => toDooPending(i.status)).length }} 项</small>
        </h2>
        <AButton
          v-if="state.filter.listIds?.[0]"
          html-type="button"
          class="todo-icon-button"
          aria-label="编辑当前清单"
          @click="
            emit(
              'edit',
              'list',
              lists.find((l) => l.id === state.filter.listIds?.[0]),
            )
          "
          type="text"
        >
          <ToDooIcon name="more" :size="16" />
        </AButton>
      </div>
      <section v-for="group in outlineGroups" :key="group.id" class="todo-task-group">
        <header v-if="group.showHeader" class="todo-task-group-heading">
          <AButton
            type="text"
            class="todo-group-toggle"
            :aria-label="(groupCollapsed(group.id) ? '展开分组 ' : '折叠分组 ') + group.name"
            :aria-expanded="!groupCollapsed(group.id)"
            @click="toggleGroup(group.id)"
          >
            <span aria-hidden="true">{{ groupCollapsed(group.id) ? '›' : '⌄' }}</span>
            <h2>{{ group.name }}</h2>
            <small>{{ group.items.length }}</small>
          </AButton>
          <div class="todo-actions">
            <AButton
              type="text"
              class="todo-icon-button"
              :aria-label="'添加任务到分组 ' + group.name"
              @click="emit('create', undefined, group.section?.id ?? null)"
              ><ToDooIcon name="plus" :size="15"
            /></AButton>
            <ToDooTaskGroupMenu
              v-if="group.section"
              :model="model"
              :section="group.section"
              @edit="(kind, entity, seed) => emit('edit', kind, entity, seed)"
            />
          </div>
        </header>
        <div v-if="!groupCollapsed(group.id)">
          <ToDooTaskMenu
            v-for="item in group.items"
            :key="item.key"
            :model="model"
            :item="item"
            context-menu
            @open="emit('open', $event)"
            @child="emit('create', $event)"
            @edit="(kind, entity, seed) => emit('edit', kind, entity, seed)"
          >
            <div
              class="todo-tree-row"
              draggable="true"
              @dragstart="drag($event, item)"
              @dragover.prevent
              @drop="reorderBefore($event, item)"
              @keydown.alt.up.prevent="reorderStep(item, -1)"
              @keydown.alt.down.prevent="reorderStep(item, 1)"
            >
              <AButton
                v-if="
                  state.snapshot?.tasks.some((t) => t.parentTaskId === item.task.id && !t.deletedAt)
                "
                html-type="button"
                class="todo-collapse"
                :aria-label="(collapsed.includes(item.task.id) ? '展开 ' : '折叠 ') + item.title"
                @click="toggleTree(item.task.id)"
                type="text"
                >{{ collapsed.includes(item.task.id) ? '›' : '⌄' }}</AButton
              >
              <ToDooTaskRow
                :item="item"
                :hide-list="!!state.filter.listIds?.length"
                :style="{ '--task-list-color': item.list?.color || 'var(--todo-accent)' }"
                :today="today"
                :time-zone="state.snapshot?.settings.timeZone"
                :active="active(item)"
                :selecting="selecting"
                :selected="state.selectedIds.includes(item.task.id)"
                @open="emit('open', $event)"
                @complete="complete"
                @select="select"
                @child="emit('create', $event)"
              >
                <template #actions
                  ><ToDooTaskMenu
                    :model="model"
                    :item="item"
                    @open="emit('open', $event)"
                    @child="emit('create', $event)"
                    @edit="(kind, entity, seed) => emit('edit', kind, entity, seed)"
                /></template>
              </ToDooTaskRow>
            </div>
          </ToDooTaskMenu>
          <AButton
            v-if="!group.items.length && group.showHeader"
            type="link"
            class="todo-link todo-group-empty"
            @click="emit('create', undefined, group.section?.id ?? null)"
            >＋ 添加任务</AButton
          >
        </div>
      </section>
      <AButton
        v-if="completedItems.length && builtin !== 'done' && !state.filter.query"
        html-type="button"
        class="todo-completed-toggle"
        :aria-label="showCompleted ? '隐藏已完成任务' : '显示已完成任务'"
        :aria-expanded="showCompleted"
        @click="showCompleted = !showCompleted"
        type="text"
      >
        <span>{{ showCompleted ? '⌄' : '›' }}</span
        >已完成 <small>{{ completedItems.length }}</small>
      </AButton>
      <div v-if="!items.length" class="todo-empty">
        <span class="todo-empty-check" aria-hidden="true"
          ><ToDooIcon name="check" :size="28"
        /></span>
        <h2>
          {{
            state.filter.query
              ? '没有找到匹配的任务'
              : builtin === 'today'
                ? '今天，留一点空间给自己'
                : '从一件小事开始'
          }}
        </h2>
        <p>
          {{
            state.filter.query
              ? '试试其他关键词，或清除筛选。'
              : '在上方输入待办，按 Enter 就能记下来。'
          }}
        </p>
        <AButton
          class="todo-button todo-primary"
          html-type="button"
          @click="emit('create')"
          type="primary"
        >
          新建任务
        </AButton>
      </div>
      <div v-if="state.snapshot?.templates.some((t) => !t.deletedAt)" class="todo-panel-footer">
        <span>从模板创建</span>
        <div
          v-for="t in state.snapshot.templates.filter((t) => !t.deletedAt)"
          :key="t.id"
          class="todo-actions"
        >
          <AButton
            class="todo-link"
            html-type="button"
            :disabled="state.busy"
            @click="
              model.execute({
                action: 'apply_template',
                payload: {
                  templateId: t.id,
                  listId: state.filter.listIds?.[0] || null,
                  titlePrefix: '',
                },
              })
            "
            type="link"
          >
            {{ t.name }}</AButton
          ><AButton
            class="todo-icon-button"
            html-type="button"
            :aria-label="'编辑模板 ' + t.name"
            @click="emit('edit', 'template', t)"
            type="text"
          >
            ⋯
          </AButton>
        </div>
      </div>
    </div>
    <template v-else-if="section === 'board'">
      <nav class="todo-task-jumps" aria-label="看板列概览">
        <AButton
          v-for="column in columns"
          :key="column.id"
          type="text"
          @click="jumpTo('todo-board-' + boardBy + '-' + column.id)"
          >{{ column.name }} {{ items.filter((i) => inColumn(i, column.id)).length }}</AButton
        >
      </nav>
      <div class="todo-board">
        <section
          v-for="column in columns"
          :key="column.id"
          class="todo-board-column"
          :id="'todo-board-' + boardBy + '-' + column.id"
          :class="boardBy === 'priority' ? 'todo-priority-' + column.id : undefined"
          @dragover.prevent
          @drop="drop($event, column.id)"
        >
          <div class="todo-board-column-heading">
            <h2>{{ column.name }}</h2>
            <small>{{ items.filter((i) => inColumn(i, column.id)).length }}</small>
            <ToDooTaskGroupMenu
              v-if="boardBy === 'section' && columnSection(column.id)"
              :model="model"
              :section="columnSection(column.id)!"
              @edit="(kind, entity, seed) => emit('edit', kind, entity, seed)"
            />
          </div>
          <ToDooTaskMenu
            v-for="card in boardTaskCards(items.filter((i) => inColumn(i, column.id)))"
            :key="card.item.key"
            :model="model"
            :item="card.item"
            context-menu
            @open="emit('open', $event)"
            @child="emit('create', $event)"
            @edit="(kind, entity, seed) => emit('edit', kind, entity, seed)"
          >
            <article
              class="todo-board-card"
              :class="'todo-priority-' + card.item.task.priority"
              :aria-label="'任务 ' + card.item.title"
              draggable="true"
              @dragstart="drag($event, card.item)"
            >
              <ToDooTaskRow
                :item="card.item"
                :active="active(card.item)"
                :hide-list="!!activeListId || boardBy === 'list'"
                :today="today"
                :time-zone="state.snapshot?.settings.timeZone"
                :selecting="selecting"
                :selected="state.selectedIds.includes(card.item.task.id)"
                @open="emit('open', $event)"
                @complete="complete"
                @select="select"
                @child="emit('create', $event)"
              >
                <template #actions
                  ><ToDooTaskMenu
                    :model="model"
                    :item="card.item"
                    @open="emit('open', $event)"
                    @child="emit('create', $event)"
                    @edit="(kind, entity, seed) => emit('edit', kind, entity, seed)"
                /></template>
              </ToDooTaskRow>
              <p v-if="card.item.task.description" class="todo-board-description">
                {{ card.item.task.description.slice(0, 80) }}
              </p>
              <div v-if="card.children.length" class="todo-board-children">
                <ToDooTaskMenu
                  v-for="child in expandedBoardCards.includes(card.item.key)
                    ? card.children
                    : card.children.slice(0, 3)"
                  :key="child.key"
                  :model="model"
                  :item="child"
                  context-menu
                  @open="emit('open', $event)"
                  @child="emit('create', $event)"
                  @edit="(kind, entity, seed) => emit('edit', kind, entity, seed)"
                  ><div
                    class="todo-board-subtask"
                    @contextmenu.stop
                    draggable="true"
                    @dragstart.stop="drag($event, child)"
                  >
                    <ToDooTaskRow
                      :item="child"
                      :active="active(child)"
                      hide-list
                      :today="today"
                      :time-zone="state.snapshot?.settings.timeZone"
                      :selecting="selecting"
                      :selected="state.selectedIds.includes(child.task.id)"
                      @open="emit('open', $event)"
                      @complete="complete"
                      @select="select"
                      @child="emit('create', $event)"
                    >
                      <template #actions
                        ><ToDooTaskMenu
                          :model="model"
                          :item="child"
                          @open="emit('open', $event)"
                          @child="emit('create', $event)"
                          @edit="(kind, entity, seed) => emit('edit', kind, entity, seed)"
                      /></template>
                    </ToDooTaskRow></div
                ></ToDooTaskMenu>
                <AButton
                  v-if="card.children.length > 3"
                  type="link"
                  class="todo-link"
                  @click="
                    expandedBoardCards = expandedBoardCards.includes(card.item.key)
                      ? expandedBoardCards.filter((key) => key !== card.item.key)
                      : [...expandedBoardCards, card.item.key]
                  "
                  >{{
                    expandedBoardCards.includes(card.item.key)
                      ? '收起子任务'
                      : '查看全部 ' + card.children.length + ' 个子任务'
                  }}</AButton
                >
              </div>
            </article>
          </ToDooTaskMenu>
          <AButton
            class="todo-link"
            html-type="button"
            @click="createInColumn(column.id)"
            type="link"
            >＋ 添加任务</AButton
          >
        </section>
      </div></template
    >
    <template v-else-if="section === 'matrix'">
      <div
        v-if="items.some((item) => item.status === 'done') && !matrixIncludesCompleted"
        class="todo-matrix-completed"
      >
        <AButton
          html-type="button"
          type="text"
          :aria-label="showCompleted ? '隐藏已完成任务' : '显示已完成任务'"
          :aria-expanded="showCompleted"
          @click="showCompleted = !showCompleted"
        >
          {{ showCompleted ? '隐藏已完成' : '显示已完成' }}
          <small>{{ items.filter((item) => item.status === 'done').length }}</small>
        </AButton>
      </div>
      <ToDooHint :model="model" hint-id="matrix-placement">
        象限按重要程度与截止时间判断紧急性，和优先级分别设置；拖动或选择象限会手动覆盖紧急判断。
      </ToDooHint>
      <nav class="todo-task-jumps" aria-label="象限概览">
        <AButton
          v-for="(zone, index) in quadrants"
          :key="zone.tone"
          type="text"
          @click="jumpTo('todo-quadrant-' + zone.tone)"
          >{{ zone.name }} {{ matrixItems.filter((i) => quadrant(i, index)).length }}</AButton
        >
      </nav>
      <div class="todo-quadrants">
        <section
          v-for="(zone, index) in quadrants"
          :key="index"
          class="todo-panel todo-quadrant"
          :id="'todo-quadrant-' + zone.tone"
          :class="'todo-quadrant-' + zone.tone"
          @dragover.prevent
          @drop="dropQuadrant($event, index)"
        >
          <div class="todo-panel-header">
            <div class="todo-quadrant-heading">
              <h2>{{ zone.name }}</h2>
              <span class="todo-quadrant-action">{{ zone.action }}</span>
            </div>
            <span class="todo-badge">{{
              matrixItems.filter((i) => quadrant(i, index)).length
            }}</span>
          </div>
          <div class="todo-quadrant-items">
            <div
              v-for="item in matrixItems.filter((i) => quadrant(i, index))"
              :key="item.key"
              class="todo-quadrant-item"
              draggable="true"
              @dragstart="drag($event, item)"
            >
              <ToDooTaskRow
                :item="item"
                :active="active(item)"
                :today="today"
                :time-zone="state.snapshot?.settings.timeZone"
                :selecting="selecting"
                :selected="state.selectedIds.includes(item.task.id)"
                @open="emit('open', $event)"
                @complete="complete"
                @select="select"
                @child="emit('create', $event)"
                ><template #actions
                  ><ToDooTaskMenu
                    :model="model"
                    :item="item"
                    @open="emit('open', $event)"
                    @child="emit('create', $event)"
                    @edit="(kind, entity, seed) => emit('edit', kind, entity, seed)" /></template
              ></ToDooTaskRow>
              <div class="todo-matrix-classification">
                <ToDooSelect
                  :value="String(index)"
                  :aria-label="'设置象限 ' + item.title"
                  :disabled="state.busy || !!state.pendingMutation"
                  @change="setQuadrant(item, Number($event))"
                  ><option
                    v-for="(target, targetIndex) in quadrants"
                    :key="target.tone"
                    :value="String(targetIndex)"
                  >
                    {{ target.name }}
                  </option></ToDooSelect
                >
                <template v-if="item.task.urgentOverride !== null"
                  ><ATag>{{ item.task.urgentOverride ? '手动紧急' : '手动不紧急' }}</ATag
                  ><AButton
                    type="link"
                    :aria-label="'恢复自动紧急判断 ' + item.title"
                    :disabled="state.busy || !!state.pendingMutation"
                    @click="
                      model.execute({
                        action: 'update_task',
                        payload: {
                          id: item.task.id,
                          expectedRevision: item.task.revision,
                          patch: { urgentOverride: null },
                        },
                      })
                    "
                    >恢复自动</AButton
                  ></template
                >
                <span v-else class="todo-muted todo-small">自动判断紧急性</span>
              </div>
            </div>
            <div v-if="!matrixItems.some((i) => quadrant(i, index))" class="todo-empty">
              <p>{{ zone.empty }}</p>
            </div>
          </div>
        </section>
      </div>
    </template>
  </template>
</template>
<style scoped>
/* These surfaces belong only to the task module; shared row styles stay intact. */
.todo-goal-overview {
  display: grid;
  gap: 20px;
  min-width: 0;
}
.todo-overview-today {
  padding: 4px 16px 12px;
  border-radius: 12px;
}
.todo-overview-today > .todo-panel-header {
  padding: 10px 4px 12px;
  border: 0;
}
.todo-overview-today h2,
.todo-goals-heading h2 {
  margin: 0;
  font-size: 28px;
  font-weight: 700;
  line-height: 1.25;
  letter-spacing: -0.5px;
}
.todo-overview-goals {
  margin-top: 12px;
}
.todo-overview-today h2 small {
  color: var(--todo-muted);
  font-size: 18px;
  font-weight: 400;
  letter-spacing: 0;
}
.todo-overview-action-list :deep(.todo-task-row),
.todo-task-list-panel :deep(.todo-task-row) {
  min-height: 72px;
  padding-block: 10px;
  gap: 14px;
}
.todo-overview-action-list :deep(.todo-task-name),
.todo-task-list-panel :deep(.todo-task-name) {
  font-size: 20px;
  font-weight: 700;
  line-height: 28px;
}
.todo-overview-action-list :deep(.todo-check),
.todo-task-list-panel :deep(.todo-check) {
  width: 26px;
  min-width: 26px;
  height: 26px;
  border-radius: 50%;
  border-color: color-mix(in srgb, var(--todo-muted) 65%, var(--todo-line));
}
.todo-overview-action-list :deep(.todo-task-meta),
.todo-task-list-panel :deep(.todo-task-meta) {
  font-size: 16px;
  line-height: 22px;
}
.todo-overview-action-list :deep(.todo-row-list),
.todo-task-list-panel :deep(.todo-row-list) {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  font-size: inherit;
}
.todo-overview-action-list :deep(.todo-task-date),
.todo-task-list-panel :deep(.todo-task-date) {
  max-width: 160px;
}
.todo-overview-action-list :deep(.todo-task-date-kind),
.todo-task-list-panel :deep(.todo-task-date-kind) {
  font-size: 12px;
}
.todo-overview-action-list :deep(.todo-task-date-value),
.todo-task-list-panel :deep(.todo-task-date-value) {
  font-size: 14px;
}
.todo-overview-action-list :deep(.todo-task-date-value small),
.todo-task-list-panel :deep(.todo-task-date-value small) {
  font-size: 18px;
}
.todo-overview-action-list :deep(.todo-row-list)::before,
.todo-task-list-panel :deep(.todo-row-list)::before {
  content: '';
  width: 11px;
  height: 11px;
  flex: 0 0 11px;
  border-radius: 50%;
  background: var(--task-list-color, var(--todo-accent));
}
.todo-overview-action-list :deep(.todo-task-row.is-active),
.todo-task-list-panel :deep(.todo-task-row.is-active) {
  background: var(--todo-tint);
}
.todo-overview-action-list :deep(.todo-task-row.is-active)::before,
.todo-task-list-panel :deep(.todo-task-row.is-active)::before {
  top: 0;
  bottom: 0;
  width: 4px;
  border-radius: 4px 0 0 4px;
}
.todo-overview-action-list :deep(.todo-task-menu-trigger),
.todo-task-list-panel :deep(.todo-task-menu-trigger) {
  opacity: 1;
  color: var(--todo-muted);
}
.todo-goals-heading {
  justify-content: flex-start;
  flex-wrap: wrap;
  gap: 10px 16px;
  margin: 0 0 16px;
}
.todo-goals-caption {
  background: var(--todo-soft);
  color: var(--todo-muted);
  padding: 5px 12px;
  border-radius: 7px;
  font-size: 14px;
}
.todo-overview-goals .todo-goals {
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 18px;
}
.todo-overview-goals .todo-goal {
  min-width: 0;
  border-color: var(--todo-line);
  border-radius: 12px;
  box-shadow: none;
  background: var(--todo-paper);
  padding: 0;
  font: inherit;
}
.todo-overview-goals .todo-goal :deep(.ant-card-body) {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 236px;
  gap: 26px;
  padding: 22px;
}
.todo-overview-goals .todo-goal :deep(.ant-card-body)::before,
.todo-overview-goals .todo-goal :deep(.ant-card-body)::after {
  display: none;
}
.todo-goal-header {
  display: grid;
  grid-template-columns: 60px minmax(0, 1fr) auto;
  align-items: start;
  gap: 6px 16px;
  min-width: 0;
  position: relative;
}
.todo-goal-icon {
  display: grid;
  place-items: center;
  width: 60px;
  height: 60px;
  grid-column: 1;
  grid-row: 1 / 3;
  border-radius: 12px;
  color: var(--todo-accent);
  background: var(--todo-tint);
}
.todo-goal-copy {
  display: contents;
}
.todo-overview-goals .todo-goal-name {
  display: block;
  width: 100%;
  height: auto;
  padding: 0;
  white-space: normal;
  text-align: left;
  font-size: 24px !important;
  font-weight: 700;
  line-height: 32px;
  grid-column: 2;
  grid-row: 1;
  color: var(--todo-ink);
  overflow-wrap: anywhere;
}
.todo-goal-copy p {
  margin: 0;
  grid-column: 2 / -1;
  grid-row: 2;
  color: var(--todo-muted);
  font-size: 16px;
  line-height: 26px;
  overflow-wrap: anywhere;
}
.todo-goal-state {
  grid-column: 3;
  grid-row: 1;
  margin: 0;
  font-size: 14px;
  line-height: 26px;
  color: var(--todo-accent);
  background: var(--todo-tint);
  border-radius: 6px;
  padding: 0 8px;
}
.todo-goal-state.is-complete {
  color: var(--todo-green);
  background: color-mix(in srgb, var(--todo-green) 12%, var(--todo-paper));
}
.todo-goal-edit {
  position: absolute;
  right: -8px;
  top: 30px;
}
.todo-goal-progress {
  display: flex;
  align-items: center;
  gap: 14px;
  margin-top: auto;
  font-size: 20px;
}
.todo-goal-progress :deep(.ant-progress) {
  flex: 1;
  width: 100%;
  min-width: 30px;
  margin: 0;
  line-height: 1;
}
.todo-goal-fraction,
.todo-goal-percentage {
  flex-shrink: 0;
  font-variant-numeric: tabular-nums;
}
.todo-goal-details {
  display: flex;
  justify-content: space-between;
  flex-wrap: wrap;
  gap: 8px;
  padding-top: 14px;
  border-top: 1px solid var(--todo-line);
  color: var(--todo-muted);
  font-size: 16px;
}
.todo-goal-details > span {
  display: inline-flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 6px;
}
.todo-goal-start {
  display: flex;
  align-items: center;
  justify-content: space-between;
  flex-wrap: wrap;
  gap: 8px;
  color: var(--todo-muted);
  font-size: 12px;
  margin-top: auto;
}
.todo-overview-empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 12px;
  min-height: 0;
  margin: 0;
  padding: 28px 16px;
  border-radius: 12px;
}
.todo-overview-empty :deep(.ant-empty-image) {
  height: auto;
  margin: 0;
}
.todo-overview-empty :deep(.ant-empty-description),
.todo-overview-empty :deep(.ant-empty-footer) {
  margin: 0;
}
.todo-overview-empty :deep(.ant-empty-description) {
  color: var(--todo-muted);
  line-height: 24px;
}
.todo-overview-empty p,
.todo-overview-empty h3 {
  margin: 0;
}
.todo-overview-empty-icon {
  display: grid;
  place-items: center;
  width: 52px;
  height: 52px;
  background: var(--todo-tint);
  color: var(--todo-accent);
  border-radius: 14px;
}
.todo-overview-resources {
  border-top: 1px solid var(--todo-line);
  padding-top: 16px;
  color: var(--todo-muted);
  font-size: 12px;
}
.todo-overview-resources > summary {
  display: flex;
  align-items: center;
  gap: 8px;
  width: fit-content;
  cursor: pointer;
  list-style: none;
}
.todo-overview-resources[open] > summary svg {
  transform: rotate(90deg);
}
.todo-overview-context {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(min(100%, 280px), 1fr));
  gap: 16px;
  margin-top: 16px;
  min-width: 0;
}
.todo-overview-list {
  display: flex;
  align-items: center;
  padding-right: 9px;
  border-bottom: 1px solid var(--todo-line);
}
.todo-overview-list:last-child {
  border-bottom: 0;
}
.todo-overview-list > .todo-saved-row {
  flex: 1;
  min-width: 0;
  border: 0;
}
.todo-task-list-toolbar {
  padding: 0 0 12px;
  border-bottom: 1px solid var(--todo-line);
  margin-bottom: 4px;
}
.todo-task-list-toolbar :deep(.ant-segmented) {
  background: transparent;
  padding: 0;
}
.todo-task-list-toolbar :deep(.ant-segmented-item) {
  padding: 5px 6px;
  border-radius: 0;
  border-bottom: 2px solid transparent;
}
.todo-task-list-toolbar :deep(.ant-segmented-item-selected) {
  color: var(--todo-accent);
  background: transparent;
  border-bottom-color: var(--todo-accent);
  box-shadow: none;
}
.todo-task-list-toolbar :deep(.ant-segmented-thumb) {
  background: transparent;
  box-shadow: none;
}
.todo-task-list-capture :deep(.todo-quick-add) {
  background: var(--todo-soft);
  border-radius: 8px;
  margin: 12px 0 18px;
}
.todo-task-list-panel > .todo-task-list-heading {
  padding: 0 10px;
  min-height: 34px;
  border: 0;
  border-radius: 6px;
  background: var(--todo-soft);
}
.todo-task-list-panel > .todo-task-list-heading h2 {
  color: var(--todo-ink);
  font-weight: 550;
}
.todo-task-list-panel .todo-task-group-heading {
  background: var(--todo-soft);
  border-radius: 6px;
  margin-top: 14px;
  border-bottom: 0;
}
@container (max-width: 850px) {
  .todo-overview-goals .todo-goals {
    grid-template-columns: 1fr;
  }
}
@container (max-width: 520px) {
  .todo-overview-goals {
    margin-top: 0;
  }
  .todo-goal-overview {
    gap: 20px;
  }
  .todo-overview-today {
    padding: 2px 8px 8px;
  }
  .todo-overview-today h2,
  .todo-goals-heading h2 {
    font-size: 19px;
  }
  .todo-overview-today h2 small {
    font-size: 12px;
  }
  .todo-overview-goals .todo-goal {
    padding: 0;
  }
  .todo-overview-goals .todo-goal :deep(.ant-card-body) {
    padding: 16px;
    min-height: 212px;
    gap: 20px;
  }
  .todo-goal-header {
    grid-template-columns: 40px minmax(0, 1fr) auto;
    gap: 4px 10px;
  }
  .todo-goal-icon {
    width: 40px;
    height: 40px;
    flex-basis: 40px;
  }
  .todo-overview-goals .todo-goal-name {
    font-size: 18px !important;
    line-height: 26px;
  }
  .todo-goal-state {
    font-size: 11px;
    padding: 0 6px;
  }
  .todo-goal-copy p {
    font-size: 14px;
    line-height: 22px;
  }
  .todo-goal-progress {
    font-size: 16px;
    gap: 10px;
  }
  .todo-goal-details {
    font-size: 12px;
  }
  .todo-goals-caption {
    font-size: 11px;
  }
  .todo-overview-action-list :deep(.todo-task-row),
  .todo-task-list-panel :deep(.todo-task-row) {
    grid-template-columns: 22px minmax(0, 1fr) 28px;
    gap: 4px 10px;
    padding-inline-start: calc(8px + var(--depth, 0) * 15px);
    padding-inline-end: 8px;
    min-height: 64px;
  }
  .todo-overview-action-list :deep(.todo-task-name),
  .todo-task-list-panel :deep(.todo-task-name) {
    font-size: 16px;
    line-height: 24px;
  }
  .todo-overview-action-list :deep(.todo-task-meta),
  .todo-task-list-panel :deep(.todo-task-meta) {
    font-size: 12px;
    line-height: 18px;
  }
  .todo-overview-action-list :deep(.todo-task-date-kind),
  .todo-task-list-panel :deep(.todo-task-date-kind) {
    font-size: 10px;
  }
  .todo-overview-action-list :deep(.todo-task-date-value),
  .todo-task-list-panel :deep(.todo-task-date-value),
  .todo-overview-action-list :deep(.todo-task-date-value small),
  .todo-task-list-panel :deep(.todo-task-date-value small) {
    font-size: 12px;
  }
  .todo-overview-action-list :deep(.todo-check),
  .todo-task-list-panel :deep(.todo-check) {
    width: 22px;
    height: 22px;
    min-width: 22px;
  }
}
.todo-matrix-completed {
  display: flex;
  justify-content: flex-end;
  margin-top: -6px;
  margin-bottom: 4px;
}
.todo-matrix-completed .ant-btn {
  font-size: 11px;
  color: var(--todo-muted);
}
</style>
