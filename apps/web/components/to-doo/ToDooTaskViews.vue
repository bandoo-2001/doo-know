<script setup lang="ts">
import ToDooDisclosure from './ToDooDisclosure.vue';
import { useToDooConfirm } from '../../to-doo-controls';
import ToDooDateField from './ToDooDateField.vue';
import ToDooSelect from './ToDooSelect.vue';

import { computed, ref } from 'vue';
import {
  Button as AButton,
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
  type ToDooItem,
  type ToDooWorkbench,
} from '../../to-doo-workbench';
import ToDooTaskRow from './ToDooTaskRow.vue';
import ToDooQuickAdd from './ToDooQuickAdd.vue';
import ToDooIcon from './ToDooIcon.vue';
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
  create: [parentTaskId?: string];
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
];
function chooseView(value: string | number) {
  if (value === 'tasks' || value === 'board' || value === 'matrix') emit('navigate', value);
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
const filterCount = computed(
  () =>
    Number(!!state.filter.tagIds?.length) +
    Number(!!state.filter.group?.conditions.length) +
    Number(!['all', 'inbox', 'today', 'upcoming'].includes(builtin.value)),
);
const lists = computed(
  () => state.snapshot?.lists.filter((l) => !l.deletedAt && !l.archivedAt) || [],
);
const todayItems = computed(() =>
  items.value.filter(
    (i) => i.date === today.value && !['done', 'cancelled', 'skipped'].includes(i.status),
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
            { id: '', name: '未分章节' },
            ...(state.snapshot?.sections
              .filter((s) => !s.deletedAt)
              .map((s) => ({ id: s.id, name: s.name })) || []),
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
        ? (item.task.sectionId || '') === id
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
async function complete(item: ToDooItem) {
  if (!item.occurrence) return;
  const children =
    state.snapshot?.tasks.filter((t) => !t.deletedAt && t.parentTaskId === item.task.id) || [];
  if (
    item.status !== 'done' &&
    children.length &&
    !(await confirmAction(`这个任务有 ${children.length} 个子任务，是否一并完成？`))
  )
    return;
  await props.model.setStatus(
    item.occurrence.id,
    item.status === 'done' ? 'todo' : 'done',
    children.length > 0,
  );
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
    if (item.occurrence) await props.model.setStatus(item.occurrence.id, column as any);
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
  if (item)
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
  <template v-if="section === 'overview'"
    ><div
      v-if="
        state.filter.query ||
        state.filter.group ||
        state.filter.statuses?.length ||
        state.filter.tagIds?.length
      "
      class="todo-panel-footer todo-top-gap"
    >
      <span>当前行动按已选条件显示</span
      ><AButton
        html-type="button"
        class="todo-link"
        @click="
          state.filter = {};
          model.load({ ...state.query, filter: {}, cursor: undefined });
        "
        type="link"
      >
        清除筛选
      </AButton>
    </div>
    <div class="todo-section-title">
      <h2>正在推进的目标</h2>
      <div class="todo-actions">
        <AButton
          html-type="button"
          class="todo-link"
          @click="emit('edit', 'list', undefined, { kind: 'list' })"
          type="link"
        >
          ＋ 清单</AButton
        ><AButton
          html-type="button"
          class="todo-link"
          @click="emit('edit', 'list', undefined, { kind: 'goal' })"
          type="link"
        >
          ＋ 目标
        </AButton>
      </div>
    </div>
    <div v-if="lists.length" class="todo-goals">
      <article v-for="l in lists" :key="l.id" class="todo-goal">
        <div class="todo-between">
          <span class="todo-badge accent">{{ l.kind === 'goal' ? '目标' : '清单' }}</span
          ><AButton
            class="todo-icon-button"
            html-type="button"
            :aria-label="'编辑 ' + l.name"
            @click="emit('edit', 'list', l)"
            type="text"
          >
            ⋯
          </AButton>
        </div>
        <AButton class="todo-goal-name" html-type="button" @click="emit('list', l.id)" type="text">
          {{ l.name }}
        </AButton>
        <p>{{ l.description || l.criteria || '把下一步行动放在这里' }}</p>
        <div class="todo-goal-progress">
          <progress
            :value="state.snapshot?.statistics.byList[l.id]?.completed || 0"
            :max="state.snapshot?.statistics.byList[l.id]?.total || 1"
          ></progress
          ><span
            >{{ state.snapshot?.statistics.byList[l.id]?.completed || 0 }}/{{
              state.snapshot?.statistics.byList[l.id]?.total || 0
            }}</span
          >
        </div>
        <div class="todo-between todo-muted todo-small">
          <span>{{ l.goalDate ? '目标 ' + l.goalDate : '持续推进' }}</span
          ><span>{{ l.noteRefs.length }} 份资料</span>
        </div>
      </article>
    </div>
    <div v-else class="todo-empty todo-panel">
      <h2>从一个目标，或一件小事开始</h2>
      <p>为工作、学习和生活创建清单，把资料与行动放在一起。</p>
      <AButton
        html-type="button"
        class="todo-button todo-primary"
        @click="emit('edit', 'list', undefined, { kind: 'goal' })"
        type="primary"
      >
        创建第一个目标
      </AButton>
    </div>
    <div class="todo-overview-grid">
      <section class="todo-panel">
        <div class="todo-panel-header">
          <h2>
            今天的行动 <small>{{ todayItems.length }} 项</small>
          </h2>
          <AButton
            class="todo-icon-button"
            html-type="button"
            aria-label="新建今日行动"
            @click="emit('create')"
            type="text"
          >
            ＋
          </AButton>
        </div>
        <ToDooTaskRow
          v-for="item in todayItems.slice(0, 12)"
          :key="item.key"
          :item="item"
          :active="active(item)"
          :today="today"
          :time-zone="state.snapshot?.settings.timeZone"
          @open="emit('open', $event)"
          @complete="complete"
          @child="emit('create', $event)"
        />
        <div v-if="!todayItems.length" class="todo-empty">
          <p>今天还没有安排，留一点时间给重要的事。</p>
          <AButton class="todo-button" html-type="button" @click="emit('create')" type="default"
            >添加一个行动</AButton
          >
        </div>
        <div class="todo-panel-footer">
          <span>完成行动与成果验证分别记录</span
          ><AButton
            class="todo-link"
            html-type="button"
            @click="emit('navigate', 'tasks')"
            type="link"
          >
            全部任务 →
          </AButton>
        </div>
      </section>
      <aside>
        <section class="todo-panel">
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
          <p v-if="!materials.length" class="todo-empty">将笔记关联到任务，需要时随时回到资料。</p>
        </section>
        <section class="todo-panel todo-top-gap">
          <div class="todo-panel-header"><h2>最近的成果</h2></div>
          <AButton
            v-for="o in state.snapshot?.outcomes.filter((o) => !o.deletedAt).slice(0, 3)"
            :key="o.id"
            html-type="button"
            class="todo-saved-row todo-text-button"
            @click="emit('edit', 'outcome', o)"
            type="text"
          >
            {{ o.summary }}
          </AButton>
          <p v-if="!state.snapshot?.outcomes.some((o) => !o.deletedAt)" class="todo-empty">
            行动完成后，可以留下一条成果与证据。
          </p>
        </section>
      </aside>
    </div>
  </template>
  <template v-else>
    <ToDooQuickAdd
      v-if="!creating"
      :model="model"
      :list-id="state.filter.listIds?.[0]"
      :default-date="builtin === 'today' || builtin === 'upcoming' ? today : undefined"
      @expand="emit('create')"
    />
    <div class="todo-task-toolbar">
      <ASegmented
        class="todo-view-switch todo-view-segmented"
        aria-label="任务展示方式"
        :value="section"
        :options="viewOptions"
        @change="chooseView"
      />
      <form class="todo-toolbar-search" role="search" @submit.prevent="filterChanged">
        <label class="todo-search"
          ><AInput
            v-model:value="state.filter.query"
            placeholder="搜索任务"
            aria-label="搜索任务" /><AButton html-type="submit" aria-label="执行搜索" type="text">
            <ToDooIcon name="search" :size="16" /></AButton
        ></label>
      </form>
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
        <AButton type="text" aria-label="任务管理"
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
            <AMenuItem
              key="section"
              @click="
                emit('edit', 'section', undefined, {
                  listId: state.filter.listIds?.[0] || lists[0]?.id || '',
                })
              "
              >＋ 章节</AMenuItem
            >
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
    <div v-if="section === 'tasks'" class="todo-panel todo-tree">
      <div class="todo-panel-header todo-task-list-heading">
        <h2>
          {{ state.filter.query ? '搜索结果' : '待办任务' }}
          <small>{{ items.filter((i) => i.status !== 'done').length }} 项</small>
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
      <div
        v-for="item in outlineItems"
        :key="item.key"
        class="todo-tree-row"
        draggable="true"
        @dragstart="drag($event, item)"
        @dragover.prevent
        @drop="reorderBefore($event, item)"
        @keydown.alt.up.prevent="reorderStep(item, -1)"
        @keydown.alt.down.prevent="reorderStep(item, 1)"
      >
        <AButton
          v-if="state.snapshot?.tasks.some((t) => t.parentTaskId === item.task.id && !t.deletedAt)"
          html-type="button"
          class="todo-collapse"
          :aria-label="(collapsed.includes(item.task.id) ? '展开 ' : '折叠 ') + item.title"
          @click="toggleTree(item.task.id)"
          type="text"
        >
          {{ collapsed.includes(item.task.id) ? '›' : '⌄' }}</AButton
        ><ToDooTaskRow
          :item="item"
          :hide-list="!!state.filter.listIds?.length"
          :today="today"
          :time-zone="state.snapshot?.settings.timeZone"
          :active="active(item)"
          :selecting="selecting"
          :selected="state.selectedIds.includes(item.task.id)"
          @open="emit('open', $event)"
          @complete="complete"
          @select="select"
          @child="emit('create', $event)"
        />
      </div>
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
    <template v-else-if="section === 'board'"
      ><div class="todo-section-title">
        <span class="todo-muted todo-small">拖动卡片改变分组；点击卡片可编辑全部信息</span
        ><ToDooSelect v-model="boardBy" aria-label="看板分组">
          <option value="status">按状态</option>
          <option value="list">按清单</option>
          <option value="priority">按优先级</option>
          <option value="section">按章节</option>
          <option value="tag">按标签</option>
        </ToDooSelect>
      </div>
      <div class="todo-board">
        <section
          v-for="column in columns"
          :key="column.id"
          class="todo-board-column"
          :class="boardBy === 'priority' ? 'todo-priority-' + column.id : undefined"
          @dragover.prevent
          @drop="drop($event, column.id)"
        >
          <div class="todo-between">
            <h2>{{ column.name }}</h2>
            <span class="todo-badge">{{ items.filter((i) => inColumn(i, column.id)).length }}</span>
          </div>
          <article
            v-for="item in items.filter((i) => inColumn(i, column.id))"
            :key="item.key"
            class="todo-board-card"
            :class="'todo-priority-' + item.task.priority"
            draggable="true"
            @dragstart="drag($event, item)"
          >
            <span class="todo-badge">{{ item.list?.name || '收集箱' }}</span
            ><AButton
              html-type="button"
              class="todo-task-title"
              @click="emit('open', item)"
              type="text"
            >
              {{ item.title }}
            </AButton>
            <p v-if="item.task.description">{{ item.task.description.slice(0, 80) }}</p>
            <div class="todo-between todo-muted todo-small">
              <ATag class="todo-priority-label"
                >{{ toDooPriorityLabels[item.task.priority]
                }}{{ item.task.priority === 'none' ? '' : '优先级' }}</ATag
              ><span>▤ {{ item.task.noteRefs.length }}</span
              ><span>{{ item.date || '未安排' }}</span>
            </div>
            <div class="todo-actions">
              <ACheckbox
                v-if="selecting"
                :checked="state.selectedIds.includes(item.task.id)"
                :aria-label="'选择 ' + item.title"
                @change="select(item.task.id)"
              /><AButton
                html-type="button"
                class="todo-link"
                :disabled="!item.occurrence"
                @click="complete(item)"
                type="link"
              >
                {{ item.status === 'done' ? '重新打开' : '完成' }}</AButton
              ><ToDooSelect
                :value="item.status"
                :disabled="!item.occurrence"
                aria-label="修改任务状态"
                @change="item.occurrence && model.setStatus(item.occurrence.id, $event as any)"
              >
                <option v-if="!item.occurrence" value="unavailable">执行记录尚未载入</option>
                <option v-for="(n, k) in toDooStatusLabels" :key="k" :value="k">{{ n }}</option>
              </ToDooSelect>
            </div>
          </article>
          <AButton class="todo-link" html-type="button" @click="emit('create')" type="link"
            >＋ 添加任务</AButton
          >
        </section>
      </div></template
    >
    <div v-else-if="section === 'matrix'" class="todo-quadrants">
      <section
        v-for="(zone, index) in quadrants"
        :key="index"
        class="todo-panel todo-quadrant"
        :class="'todo-quadrant-' + zone.tone"
        @dragover.prevent
        @drop="dropQuadrant($event, index)"
      >
        <div class="todo-panel-header">
          <div class="todo-quadrant-heading">
            <h2>{{ zone.name }}</h2>
            <span class="todo-quadrant-action">{{ zone.action }}</span>
          </div>
          <span class="todo-badge">{{ items.filter((i) => quadrant(i, index)).length }}</span>
        </div>
        <div class="todo-quadrant-items">
          <div
            v-for="item in items.filter((i) => quadrant(i, index))"
            :key="item.key"
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
            />
          </div>
          <div v-if="!items.some((i) => quadrant(i, index))" class="todo-empty">
            <strong>当前没有{{ zone.name }}的任务</strong>
            <p>{{ zone.empty }}</p>
            <p class="todo-muted">在上方添加任务后设置重要与紧急程度，也可拖入已有任务。</p>
          </div>
        </div>
      </section>
    </div>
  </template>
</template>
