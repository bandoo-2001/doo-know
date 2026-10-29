<script setup lang="ts">
import { computed, ref } from 'vue';
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
const props = defineProps<{ model: ToDooWorkbench; section: ToDooAppSection; tree: TreeEntry[] }>();
const emit = defineEmits<{
  open: [item: ToDooItem];
  create: [parentTaskId?: string];
  list: [id: string];
  edit: [kind: ToDooEntityKind, entity?: Record<string, any>, seed?: Record<string, any>];
  navigate: [section: ToDooAppSection];
  bulk: [];
}>();
const advancedFilters = ref(false);
const state = props.model.state,
  selecting = ref(false),
  collapsed = ref<string[]>([]),
  builtin = ref('all'),
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
async function complete(item: ToDooItem) {
  if (!item.occurrence) return;
  const children =
    state.snapshot?.tasks.filter((t) => !t.deletedAt && t.parentTaskId === item.task.id) || [];
  if (
    item.status !== 'done' &&
    children.length &&
    !confirm(`这个任务有 ${children.length} 个子任务，是否一并完成？`)
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
function quickFilter(value: string) {
  builtin.value = value;
  const filter = { ...state.filter };
  delete filter.statuses;
  delete filter.from;
  delete filter.to;
  delete filter.dueBefore;
  delete filter.unscheduled;
  delete filter.includeDeleted;
  delete filter.includeArchived;
  if (value === 'today') {
    filter.from = today.value;
    filter.to = today.value;
    filter.statuses = ['todo', 'doing', 'blocked'];
  }
  if (value === 'upcoming') {
    filter.from = today.value;
    filter.to = shiftToDooDate(today.value, 6);
  }
  if (value === 'overdue') {
    filter.dueBefore = shiftToDooDate(today.value, -1);
    filter.statuses = ['todo', 'doing', 'blocked'];
  }
  if (value === 'unscheduled') filter.unscheduled = true;
  if (value === 'done') filter.statuses = ['done'];
  if (value === 'blocked') filter.statuses = ['blocked'];
  if (value === 'trash') filter.includeDeleted = true;
  if (value === 'archived') filter.includeArchived = true;
  state.filter = filter;
  void filterChanged();
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
  if (
    operation === 'delete' &&
    !confirm(`将选中的 ${state.selectedIds.length} 项及其子任务移入回收站？`)
  )
    return;
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
      ><button
        type="button"
        class="todo-link"
        @click="
          state.filter = {};
          model.load({ ...state.query, filter: {}, cursor: undefined });
        "
      >
        清除筛选
      </button>
    </div>
    <div class="todo-section-title">
      <h2>正在推进的目标</h2>
      <div class="todo-actions">
        <button
          type="button"
          class="todo-link"
          @click="emit('edit', 'list', undefined, { kind: 'list' })"
        >
          ＋ 清单</button
        ><button
          type="button"
          class="todo-link"
          @click="emit('edit', 'list', undefined, { kind: 'goal' })"
        >
          ＋ 目标
        </button>
      </div>
    </div>
    <div v-if="lists.length" class="todo-goals">
      <article v-for="l in lists" :key="l.id" class="todo-goal">
        <div class="todo-between">
          <span class="todo-badge accent">{{ l.kind === 'goal' ? '目标' : '清单' }}</span
          ><button
            class="todo-icon-button"
            type="button"
            :aria-label="'编辑 ' + l.name"
            @click="emit('edit', 'list', l)"
          >
            ⋯
          </button>
        </div>
        <button class="todo-goal-name" type="button" @click="emit('list', l.id)">
          {{ l.name }}
        </button>
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
      <button
        type="button"
        class="todo-button todo-primary"
        @click="emit('edit', 'list', undefined, { kind: 'goal' })"
      >
        创建第一个目标
      </button>
    </div>
    <div class="todo-overview-grid">
      <section class="todo-panel">
        <div class="todo-panel-header">
          <h2>
            今天的行动 <small>{{ todayItems.length }} 项</small>
          </h2>
          <button
            class="todo-icon-button"
            type="button"
            aria-label="新建今日行动"
            @click="emit('create')"
          >
            ＋
          </button>
        </div>
        <ToDooTaskRow
          v-for="item in todayItems.slice(0, 12)"
          :key="item.key"
          :item="item"
          @open="emit('open', $event)"
          @complete="complete"
          @child="emit('create', $event)"
        />
        <div v-if="!todayItems.length" class="todo-empty">
          <p>今天还没有安排，留一点时间给重要的事。</p>
          <button class="todo-button" type="button" @click="emit('create')">添加一个行动</button>
        </div>
        <div class="todo-panel-footer">
          <span>完成行动与成果验证分别记录</span
          ><button class="todo-link" type="button" @click="emit('navigate', 'tasks')">
            全部任务 →
          </button>
        </div>
      </section>
      <aside>
        <section class="todo-panel">
          <div class="todo-panel-header">
            <h2>正在使用的资料</h2>
            <span>▤</span>
          </div>
          <button
            v-for="m in materials"
            :key="m.title"
            type="button"
            class="todo-saved-row todo-text-button"
            @click="emit('open', m.task)"
          >
            <span
              >{{ m.title }}<small>{{ m.task.title }}</small></span
            ><span>↗</span>
          </button>
          <p v-if="!materials.length" class="todo-empty">将笔记关联到任务，需要时随时回到资料。</p>
        </section>
        <section class="todo-panel todo-top-gap">
          <div class="todo-panel-header"><h2>最近的成果</h2></div>
          <button
            v-for="o in state.snapshot?.outcomes.filter((o) => !o.deletedAt).slice(0, 3)"
            :key="o.id"
            type="button"
            class="todo-saved-row todo-text-button"
            @click="emit('edit', 'outcome', o)"
          >
            {{ o.summary }}
          </button>
          <p v-if="!state.snapshot?.outcomes.some((o) => !o.deletedAt)" class="todo-empty">
            行动完成后，可以留下一条成果与证据。
          </p>
        </section>
      </aside>
    </div>
  </template>
  <template v-else>
    <form class="todo-filters" @submit.prevent="filterChanged">
      <select v-model="builtin" aria-label="内建筛选" @change="quickFilter(builtin)">
        <option value="all">全部任务</option>
        <option value="inbox">收集箱</option>
        <option value="today">今天</option>
        <option value="upcoming">近期 7 天</option>
        <option value="overdue">逾期</option>
        <option value="unscheduled">未安排</option>
        <option value="done">已完成</option>
        <option value="blocked">受阻</option>
        <option value="archived">已归档</option>
        <option value="trash">回收站</option></select
      ><select
        :value="state.filter.listIds?.[0] || ''"
        aria-label="筛选目标清单"
        @change="
          state.filter.listIds = ($event.target as HTMLSelectElement).value
            ? [($event.target as HTMLSelectElement).value]
            : [];
          filterChanged();
        "
      >
        <option value="">全部目标与清单</option>
        <option v-for="l in lists" :key="l.id" :value="l.id">{{ l.name }}</option></select
      ><select
        :value="state.filter.tagIds?.[0] || ''"
        aria-label="筛选标签"
        @change="
          state.filter.tagIds = ($event.target as HTMLSelectElement).value
            ? [($event.target as HTMLSelectElement).value]
            : [];
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
        </option></select
      ><label class="todo-search"
        ><input
          v-model="state.filter.query"
          placeholder="搜索任务、说明与成果"
          aria-label="搜索任务"
        /><button type="submit" aria-label="执行搜索">⌕</button></label
      ><select v-model="state.sort" aria-label="任务排序">
        <option value="manual">手动顺序</option>
        <option value="due">截止日期</option>
        <option value="priority">优先级</option>
        <option value="created">最近创建</option>
        <option value="title">标题</option></select
      ><button
        type="button"
        class="todo-button"
        @click="
          selecting = !selecting;
          state.selectedIds = [];
        "
      >
        {{ selecting ? '结束多选' : '多选' }}</button
      ><button
        type="button"
        class="todo-button"
        @click="
          advancedFilters = !advancedFilters;
          if (advancedFilters && !state.filter.group)
            state.filter.group = { operator: 'and', conditions: [] };
        "
      >
        条件组</button
      ><button type="button" class="todo-button" @click="saveView">保存视图</button>
    </form>
    <div v-if="advancedFilters && state.filter.group" class="todo-panel todo-filter-builder">
      <ToDooFilterGroup v-model="state.filter.group" :model="model" />
      <div class="todo-actions">
        <button class="todo-button todo-primary" type="button" @click="filterChanged">
          应用条件组</button
        ><button
          class="todo-link"
          type="button"
          @click="
            delete state.filter.group;
            advancedFilters = false;
            filterChanged();
          "
        >
          清除条件组
        </button>
      </div>
    </div>
    <div v-if="state.snapshot?.views.some((v) => !v.deletedAt)" class="todo-saved-views">
      <span>保存的视图</span>
      <div
        v-for="v in state.snapshot.views.filter((v) => !v.deletedAt)"
        :key="v.id"
        class="todo-actions"
      >
        <button type="button" class="todo-link" @click="applyView(v)">{{ v.name }}</button
        ><button
          type="button"
          class="todo-icon-button"
          :aria-label="'编辑视图 ' + v.name"
          @click="emit('edit', 'view', v)"
        >
          ⋯
        </button>
      </div>
    </div>
    <div v-if="selecting" class="todo-batch">
      <label class="todo-checkbox"
        ><input
          type="checkbox"
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
        ><button class="todo-button todo-primary" type="button" @click="emit('bulk')">
          批量编辑字段</button
        ><button class="todo-button" type="button" :disabled="state.busy" @click="bulk('complete')">
          完成整棵子树</button
        ><button class="todo-button" type="button" :disabled="state.busy" @click="bulk('copy')">
          复制</button
        ><button class="todo-button" type="button" :disabled="state.busy" @click="bulk('cancel')">
          取消</button
        ><button class="todo-button" type="button" :disabled="state.busy" @click="bulk('archive')">
          归档</button
        ><button
          class="todo-button todo-danger"
          type="button"
          :disabled="state.busy"
          @click="bulk('delete')"
        >
          删除</button
        ><button
          v-if="builtin === 'trash'"
          class="todo-button"
          type="button"
          :disabled="state.busy"
          @click="bulk('restore')"
        >
          恢复</button
        ><select v-model="bulkList" aria-label="移动到清单">
          <option value="">收集箱</option>
          <option v-for="l in lists" :key="l.id" :value="l.id">{{ l.name }}</option></select
        ><button class="todo-button" type="button" :disabled="state.busy" @click="bulk('move')">
          移动到</button
        ><select v-model="bulkPriority" aria-label="批量优先级">
          <option v-for="(n, k) in toDooPriorityLabels" :key="k" :value="k">{{ n }}</option></select
        ><button class="todo-button" type="button" @click="bulk('priority')">设置优先级</button
        ><input v-model="bulkDate" type="date" aria-label="批量截止日期" /><button
          class="todo-button"
          type="button"
          @click="bulkDue"
        >
          设置截止</button
        ><button
          class="todo-button"
          type="button"
          @click="
            reorderStep(
              items.find((i) => i.task.id === state.selectedIds[0]),
              -1,
            )
          "
        >
          上移首项</button
        ><button
          class="todo-button"
          type="button"
          @click="
            reorderStep(
              items.find((i) => i.task.id === state.selectedIds[0]),
              1,
            )
          "
        >
          下移首项</button
        ><button class="todo-button" type="button" @click="indent()">缩进</button
        ><button class="todo-button" type="button" @click="indent(true)">提升</button></template
      >
    </div>
    <div v-if="section === 'tasks'" class="todo-panel todo-tree">
      <div class="todo-panel-header">
        <h2>
          任务大纲 <small>{{ items.length }} 项执行记录</small>
        </h2>
        <div class="todo-actions">
          <button
            class="todo-link"
            type="button"
            @click="
              emit('edit', 'section', undefined, {
                listId: state.filter.listIds?.[0] || lists[0]?.id || '',
              })
            "
          >
            ＋ 章节</button
          ><button class="todo-link" type="button" @click="emit('edit', 'tag')">＋ 标签</button
          ><button class="todo-link" type="button" @click="emit('edit', 'template')">
            ＋ 模板
          </button>
        </div>
      </div>
      <div
        v-for="item in visibleItems"
        :key="item.key"
        class="todo-tree-row"
        draggable="true"
        @dragstart="drag($event, item)"
        @dragover.prevent
        @drop="reorderBefore($event, item)"
        @keydown.alt.up.prevent="reorderStep(item, -1)"
        @keydown.alt.down.prevent="reorderStep(item, 1)"
      >
        <button
          v-if="state.snapshot?.tasks.some((t) => t.parentTaskId === item.task.id && !t.deletedAt)"
          type="button"
          class="todo-collapse"
          :aria-label="(collapsed.includes(item.task.id) ? '展开 ' : '折叠 ') + item.title"
          @click="toggleTree(item.task.id)"
        >
          {{ collapsed.includes(item.task.id) ? '›' : '⌄' }}</button
        ><ToDooTaskRow
          :item="item"
          :selecting="selecting"
          :selected="state.selectedIds.includes(item.task.id)"
          @open="emit('open', $event)"
          @complete="complete"
          @select="select"
          @child="emit('create', $event)"
        />
      </div>
      <div v-if="!items.length" class="todo-empty">
        <h2>这里还没有任务</h2>
        <p>创建一个具体行动，或调整筛选条件。</p>
        <button class="todo-button todo-primary" type="button" @click="emit('create')">
          新建任务
        </button>
      </div>
      <div v-if="state.snapshot?.templates.some((t) => !t.deletedAt)" class="todo-panel-footer">
        <span>从模板创建</span>
        <div
          v-for="t in state.snapshot.templates.filter((t) => !t.deletedAt)"
          :key="t.id"
          class="todo-actions"
        >
          <button
            class="todo-link"
            type="button"
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
          >
            {{ t.name }}</button
          ><button
            class="todo-icon-button"
            type="button"
            :aria-label="'编辑模板 ' + t.name"
            @click="emit('edit', 'template', t)"
          >
            ⋯
          </button>
        </div>
      </div>
    </div>
    <template v-else-if="section === 'board'"
      ><div class="todo-section-title">
        <span class="todo-muted todo-small">拖动卡片改变分组；点击卡片可编辑全部信息</span
        ><select v-model="boardBy" aria-label="看板分组">
          <option value="status">按状态</option>
          <option value="list">按清单</option>
          <option value="priority">按优先级</option>
          <option value="section">按章节</option>
          <option value="tag">按标签</option>
        </select>
      </div>
      <div class="todo-board">
        <section
          v-for="column in columns"
          :key="column.id"
          class="todo-board-column"
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
            draggable="true"
            @dragstart="drag($event, item)"
          >
            <span class="todo-badge">{{ item.list?.name || '收集箱' }}</span
            ><button type="button" class="todo-task-title" @click="emit('open', item)">
              {{ item.title }}
            </button>
            <p v-if="item.task.description">{{ item.task.description.slice(0, 80) }}</p>
            <div class="todo-between todo-muted todo-small">
              <span
                >{{ toDooPriorityLabels[item.task.priority] }} · ▤
                {{ item.task.noteRefs.length }}</span
              ><span>{{ item.date || '未安排' }}</span>
            </div>
            <div class="todo-actions">
              <input
                v-if="selecting"
                type="checkbox"
                :checked="state.selectedIds.includes(item.task.id)"
                :aria-label="'选择 ' + item.title"
                @change="select(item.task.id)"
              /><button
                type="button"
                class="todo-link"
                :disabled="!item.occurrence"
                @click="complete(item)"
              >
                {{ item.status === 'done' ? '重新打开' : '完成' }}</button
              ><select
                :value="item.status"
                :disabled="!item.occurrence"
                aria-label="修改任务状态"
                @change="
                  item.occurrence &&
                  model.setStatus(
                    item.occurrence.id,
                    ($event.target as HTMLSelectElement).value as any,
                  )
                "
              >
                <option v-if="!item.occurrence" value="unavailable">执行记录尚未载入</option>
                <option v-for="(n, k) in toDooStatusLabels" :key="k" :value="k">{{ n }}</option>
              </select>
            </div>
          </article>
          <button class="todo-link" type="button" @click="emit('create')">＋ 添加任务</button>
        </section>
      </div></template
    >
    <div v-else-if="section === 'matrix'" class="todo-quadrants">
      <section
        v-for="(label, index) in ['重要且紧急', '重要不紧急', '紧急不重要', '不紧急不重要']"
        :key="index"
        class="todo-panel todo-quadrant"
        @dragover.prevent
        @drop="dropQuadrant($event, index)"
      >
        <div class="todo-panel-header">
          <h2>{{ label }}</h2>
          <span class="todo-badge">{{ items.filter((i) => quadrant(i, index)).length }}</span>
        </div>
        <div
          v-for="item in items.filter((i) => quadrant(i, index))"
          :key="item.key"
          draggable="true"
          @dragstart="drag($event, item)"
        >
          <ToDooTaskRow
            :item="item"
            :selecting="selecting"
            :selected="state.selectedIds.includes(item.task.id)"
            @open="emit('open', $event)"
            @complete="complete"
            @select="select"
            @child="emit('create', $event)"
          />
        </div>
        <p v-if="!items.some((i) => quadrant(i, index))" class="todo-empty">把合适的行动放到这里</p>
      </section>
    </div>
  </template>
</template>
