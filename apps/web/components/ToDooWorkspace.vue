<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue';
import type { TreeEntry } from '../../../shared/contracts';
import type { ToDooEntityKind, ToDooEntityMap } from '../../../shared/to-doo-contracts';
import { api } from '../api';
import type { ToDooAppSection } from '../navigation';
import {
  createToDooWorkbench,
  shiftToDooDate,
  toDooLocalDate,
  type ToDooItem,
  type ToDooSelection,
} from '../to-doo-workbench';
import ToDooTaskViews from './to-doo/ToDooTaskViews.vue';
import ToDooBatchEditor from './to-doo/ToDooBatchEditor.vue';
import ToDooOutcomeNote from './to-doo/ToDooOutcomeNote.vue';
import ToDooCalendar from './to-doo/ToDooCalendar.vue';
import ToDooRhythm from './to-doo/ToDooRhythm.vue';
import ToDooReview from './to-doo/ToDooReview.vue';
import ToDooSettings from './to-doo/ToDooSettings.vue';
import ToDooTaskDetail from './to-doo/ToDooTaskDetail.vue';
import ToDooEntityEditor from './to-doo/ToDooEntityEditor.vue';
import '../to-doo.css';
const props = withDefaults(
  defineProps<{ section: ToDooAppSection; selection?: ToDooSelection; tree: TreeEntry[] }>(),
  { selection: () => ({}) },
);
const emit = defineEmits<{
  navigate: [section: ToDooAppSection, selection?: ToDooSelection];
  'open-note': [id: string];
  back: [];
  'note-created': [id: string];
}>();
const model = createToDooWorkbench(api),
  state = model.state,
  creating = ref(false),
  parentId = ref<string>(),
  detailOpen = ref(false),
  focusOccurrence = ref(''),
  density = ref('comfortable');
const detailRef = ref<InstanceType<typeof ToDooTaskDetail>>(),
  editorRef = ref<InstanceType<typeof ToDooEntityEditor>>(),
  settingsRef = ref<InstanceType<typeof ToDooSettings>>();
const editor = ref<{
  kind: ToDooEntityKind;
  entity?: Record<string, any>;
  seed?: Record<string, any>;
}>();
const outcomeNote = ref<{
  task: NonNullable<typeof state.snapshot>['tasks'][number];
  occurrence: NonNullable<typeof state.snapshot>['occurrences'][number];
  operation?: ToDooEntityMap['operation'];
}>();
const outcomeNoteOpen = ref(false);
const outcomeRef = ref<InstanceType<typeof ToDooOutcomeNote>>();
const createdNoteId = ref(''),
  createdNoteTaskId = ref('');
const bulkOpen = ref(false);
const leaving = ref(false);
let leaveResolver: ((answer: boolean) => void) | undefined;
const nav: [ToDooAppSection, string, string][] = [
  ['overview', '目标总览', '◎'],
  ['tasks', '所有任务', '☷'],
  ['board', '看板', '▥'],
  ['calendar', '日历', '▦'],
  ['timeline', '时间线', '≡'],
  ['matrix', '四象限', '⊞'],
  ['focus', '专注', '◷'],
  ['habits', '习惯', '↻'],
  ['anniversaries', '纪念日', '◇'],
  ['stats', '统计与复盘', '⌁'],
  ['notifications', '通知中心', '♧'],
  ['settings', '设置', '⚙'],
];
const title = computed(() => nav.find((n) => n[0] === props.section)?.[1] || '目标总览');
const descriptions: Record<ToDooAppSection, string> = {
  overview: '目标、资料、行动与成果，放在同一个工作流里',
  tasks: '让目标清晰，让下一步具体',
  board: '看见任务在流动，也看见下一步',
  calendar: '把行动放进时间，为计划留出余地',
  timeline: '安排阶段、识别依赖，为重要里程碑留出空间',
  matrix: '先看重要性，再决定把时间放在哪里',
  focus: '给一个行动，一段完整的时间',
  habits: '让小行动重复发生，让变化慢慢积累',
  anniversaries: '记得重要日子，也为它们做好准备',
  stats: '看见真实投入与成果，给下一步一个清晰方向',
  notifications: '重要提醒集中在这里',
  settings: '把 To Doo 调整成适合自己的工作方式',
};
const unread = computed(
  () =>
    state.snapshot?.reminderEvents.filter(
      (r) =>
        !r.deletedAt &&
        r.userState === 'unread' &&
        (r.firstRaisedAt || r.scheduledAt <= new Date().toISOString()),
    ).length || 0,
);
const taskSections = ['overview', 'tasks', 'board', 'matrix'];
const collectionLabels: Partial<Record<ToDooEntityKind, string>> = {
  task: '任务',
  occurrence: '执行实例',
  timeBlock: '时间安排',
  habit: '习惯',
  habitEntry: '习惯记录',
  anniversary: '纪念日',
  focusSession: '专注记录',
  reminderEvent: '通知',
  outcome: '成果',
  record: '推进记录',
  activity: '历史',
  review: '复盘',
  list: '目标与清单',
  section: '章节',
  tag: '标签',
  view: '保存视图',
  template: '模板',
  calendarEvent: '日历事件',
  calendarSource: '日历来源',
};
const sectionKinds: Record<ToDooAppSection, ToDooEntityKind[]> = {
  overview: ['task', 'occurrence', 'list', 'outcome'],
  tasks: ['task', 'occurrence', 'section', 'tag', 'view'],
  board: ['task', 'occurrence', 'section', 'tag'],
  matrix: ['task', 'occurrence'],
  calendar: [
    'task',
    'occurrence',
    'timeBlock',
    'calendarEvent',
    'habit',
    'habitEntry',
    'anniversary',
  ],
  timeline: ['task', 'occurrence', 'timeBlock'],
  focus: ['task', 'occurrence', 'focusSession'],
  habits: ['habit', 'habitEntry'],
  anniversaries: ['anniversary'],
  stats: ['outcome', 'record', 'review', 'focusSession', 'habitEntry'],
  notifications: ['reminderEvent'],
  settings: ['list', 'tag', 'view', 'template', 'calendarSource'],
};
const moreCollections = computed(() =>
  sectionKinds[props.section].filter((kind) => state.snapshot?.collectionPages?.[kind]?.nextCursor),
);
function navigate(section: ToDooAppSection, selection: ToDooSelection = {}) {
  emit('navigate', section, selection);
}
function create(parent?: string) {
  creating.value = true;
  parentId.value = parent;
  detailOpen.value = true;
}
function open(item: ToDooItem) {
  model.selectTask(item.task.id, item.occurrence?.id);
  detailOpen.value = true;
  creating.value = false;
  navigate(props.section, { ...props.selection, task: item.task.id });
}
async function selectTask(id: string, occurrence?: string) {
  if (!state.snapshot?.tasks.some((t) => t.id === id)) await model.ensureTask(id);
  model.selectTask(id, occurrence);
  creating.value = false;
  detailOpen.value = true;
  navigate(props.section, { ...props.selection, task: id });
}
function closeDetail() {
  creating.value = false;
  detailOpen.value = false;
  navigate(props.section, { ...props.selection, task: undefined });
}
function edit(kind: ToDooEntityKind, entity?: Record<string, any>, seed?: Record<string, any>) {
  editor.value = { kind, entity, seed };
  state.error = '';
}
async function retryOriginal() {
  const action = state.pendingMutation?.action;
  const result = await model.retryPending();
  if (result && action === 'create_task' && state.selectedTaskId) created(state.selectedTaskId);
}
function created(id: string) {
  creating.value = false;
  detailOpen.value = true;
  navigate(props.section, { ...props.selection, task: id });
}
function hasUnsavedChanges() {
  return (
    state.busy ||
    !!outcomeRef.value?.hasUnsavedChanges() ||
    bulkOpen.value ||
    model.hasUnsavedChanges() ||
    !!detailRef.value?.hasUnsavedChanges() ||
    !!editorRef.value?.hasUnsavedChanges() ||
    !!settingsRef.value?.hasUnsavedChanges()
  );
}
async function requestLeave(): Promise<boolean> {
  if (state.busy) {
    state.notice = '正在保存，请等待完成后离开';
    return false;
  }
  if (!hasUnsavedChanges()) return true;
  if (leaving.value) return false;
  leaving.value = true;
  return new Promise((resolve) => (leaveResolver = resolve));
}
function finishLeave(answer: boolean) {
  leaving.value = false;
  if (answer) {
    Object.keys(state.drafts).forEach((k) => delete state.drafts[k]);
    editor.value = undefined;
    bulkOpen.value = false;
    outcomeNote.value = undefined;
    outcomeNoteOpen.value = false;
    creating.value = false;
    detailOpen.value = false;
  }
  leaveResolver?.(answer);
  leaveResolver = undefined;
}
function openOutcomeNote() {
  if (model.dirty()) {
    state.error = '请先保存任务内容，再创建成果笔记';
    return;
  }
  const draft = model.draft();
  if (!draft?.occurrence) return;
  if (!outcomeNote.value)
    outcomeNote.value = {
      task: JSON.parse(JSON.stringify(draft.task)),
      occurrence: JSON.parse(JSON.stringify(draft.occurrence)),
    };
  outcomeNoteOpen.value = true;
}
async function resumeOutcome(operation: ToDooEntityMap['operation']) {
  if (
    outcomeNote.value &&
    outcomeRef.value?.hasUnsavedChanges() &&
    outcomeNote.value.operation?.id !== operation.id
  ) {
    state.notice = '请先继续处理已保留的成果表单';
    outcomeNoteOpen.value = true;
    return;
  }
  try {
    let occurrence = state.snapshot?.occurrences.find((o) => o.id === operation.occurrenceId);
    if (!occurrence) {
      const data = await model.request(
        '/api/to-doo/state?kind=occurrence&ids=' +
          encodeURIComponent(operation.occurrenceId) +
          '&limit=1',
      );
      model.acceptSnapshot(data, true);
      occurrence = data.occurrences[0];
    }
    if (!occurrence) {
      state.error = '原行动的执行记录暂不可用，已保存成果仍保留';
      return;
    }
    await model.ensureTask(occurrence.taskId);
    const task = state.snapshot?.tasks.find((t) => t.id === occurrence!.taskId);
    if (!task) {
      state.error = '原任务暂不可用，请先核对回收站或同步状态';
      return;
    }
    outcomeNote.value = {
      task: JSON.parse(JSON.stringify(task)),
      occurrence: JSON.parse(JSON.stringify(occurrence)),
      operation: JSON.parse(JSON.stringify(operation)),
    };
    outcomeNoteOpen.value = true;
  } catch (e) {
    state.error = e instanceof Error ? e.message : String(e);
  }
}
async function back() {
  if (await requestLeave()) emit('back');
}
function beforeUnload(event: BeforeUnloadEvent) {
  if (hasUnsavedChanges()) {
    event.preventDefault();
    event.returnValue = '';
  }
}
window.addEventListener('beforeunload', beforeUnload);
onBeforeUnmount(() => {
  window.removeEventListener('beforeunload', beforeUnload);
  leaveResolver?.(false);
});
watch(
  () => [props.section, props.selection.date, props.selection.list, props.selection.calendarView],
  async () => {
    const today = toDooLocalDate(),
      anchor = props.selection.date || today;
    state.filter.listIds = props.selection.list ? [props.selection.list] : [];
    await model.load({
      view: props.section,
      ...(['calendar', 'timeline'].includes(props.section)
        ? {
            from: shiftToDooDate(anchor, props.section === 'timeline' ? 0 : -7),
            to: shiftToDooDate(anchor, props.section === 'timeline' ? 27 : 42),
          }
        : props.section === 'stats'
          ? { from: shiftToDooDate(today, -6), to: today }
          : {}),
      limit: 200,
      filter: [...taskSections, 'calendar', 'timeline'].includes(props.section)
        ? state.filter
        : undefined,
    });
    if (props.selection.task) {
      await model.ensureTask(props.selection.task);
      model.selectTask(props.selection.task);
      detailOpen.value = true;
    }
  },
  { immediate: true },
);
watch(
  () => props.selection.task,
  async (id) => {
    if (id) {
      await model.ensureTask(id);
      model.selectTask(id, state.selectedTaskId === id ? state.selectedOccurrenceId : undefined);
      detailOpen.value = true;
      creating.value = false;
    } else if (!creating.value) detailOpen.value = false;
  },
);
defineExpose({ hasUnsavedChanges, requestLeave });
</script>
<template>
  <section
    class="to-doo-workspace"
    :class="{ 'todo-compact': density === 'compact' }"
    aria-label="To Doo 行动工作空间"
  >
    <aside class="todo-sidebar">
      <div class="todo-app-title"><span>✓</span>To Doo</div>
      <nav aria-label="To Doo 导航">
        <template v-for="(item, i) in nav" :key="item[0]"
          ><span v-if="i === 0 || i === 6 || i === 10" class="todo-nav-label">{{
            i === 0 ? '工作空间' : i === 6 ? '节奏与回顾' : '通知与偏好'
          }}</span
          ><button
            type="button"
            :class="{ active: section === item[0] }"
            :aria-current="section === item[0] ? 'page' : undefined"
            @click="navigate(item[0])"
          >
            <span class="todo-nav-icon" aria-hidden="true">{{ item[2] }}</span
            >{{ item[1] }}<small v-if="item[0] === 'notifications' && unread">{{ unread }}</small>
          </button></template
        >
      </nav>
      <div class="todo-sidebar-footer">
        <p>目标 → 资料 → 行动 → 成果</p>
        <button type="button" class="todo-link" @click="back">‹ 返回应用</button>
      </div>
    </aside>
    <main class="todo-main">
      <div class="todo-topbar">
        <span class="todo-desktop-crumb">我的工作空间 / {{ title }}</span
        ><select
          class="todo-mobile-nav"
          :value="section"
          aria-label="切换 To Doo 页面"
          @change="navigate(($event.target as HTMLSelectElement).value as ToDooAppSection)"
        >
          <option v-for="item in nav" :key="item[0]" :value="item[0]">{{ item[1] }}</option></select
        ><span class="todo-spacer"></span
        ><select v-model="density" class="todo-density" aria-label="界面密度">
          <option value="comfortable">舒展</option>
          <option value="compact">紧凑</option></select
        ><button
          type="button"
          class="todo-icon-button"
          aria-label="刷新 To Doo"
          :disabled="state.loading || state.busy"
          @click="model.load()"
        >
          ↻</button
        ><button
          type="button"
          class="todo-icon-button"
          aria-label="打开通知中心"
          @click="navigate('notifications')"
        >
          ♧<small v-if="unread">{{ unread }}</small>
        </button>
      </div>
      <div class="todo-page">
        <header class="todo-page-heading">
          <div>
            <h1>{{ title }}</h1>
            <p>{{ descriptions[section] }}</p>
          </div>
          <div
            v-if="
              taskSections.includes(section) || section === 'calendar' || section === 'timeline'
            "
            class="todo-actions"
          >
            <button
              v-if="section === 'overview'"
              type="button"
              class="todo-button todo-primary"
              aria-label="新建目标"
              @click="edit('list', undefined, { kind: 'goal' })"
            >
              ＋ 新建目标</button
            ><button
              type="button"
              class="todo-button"
              aria-label="新建任务"
              :class="{ 'todo-primary': section !== 'overview' }"
              @click="create()"
            >
              ＋ 新建任务
            </button>
          </div>
        </header>
        <div v-if="state.error" class="todo-error todo-alert" role="alert">
          {{ state.error
          }}<button type="button" class="todo-link" @click="state.error = ''">关闭提示</button>
        </div>
        <p v-if="state.notice" class="todo-notice" role="status">{{ state.notice }}</p>
        <button
          v-if="createdNoteId && !detailOpen"
          class="todo-link todo-open-output"
          type="button"
          aria-label="打开成果笔记"
          @click="emit('open-note', createdNoteId)"
        >
          打开成果笔记 ↗
        </button>
        <p v-if="state.localWarning" class="todo-warning" role="alert">{{ state.localWarning }}</p>
        <div
          v-if="state.pendingMutation && !state.busy"
          class="todo-panel todo-pad todo-pending-request"
        >
          <h3>有一次提交的结果待核对</h3>
          <p>重试会继续原操作，不会重新创建一份。核对前先保留其他修改。</p>
          <span v-if="'title' in state.pendingMutation.payload" class="todo-muted">{{
            state.pendingMutation.payload.title
          }}</span
          ><button type="button" class="todo-button" :disabled="state.busy" @click="retryOriginal">
            重试原操作
          </button>
        </div>
        <button
          v-if="model.hasNewTaskDraft() && !creating"
          type="button"
          class="todo-link"
          @click="create()"
        >
          继续新建任务草稿
        </button>
        <p v-if="state.loading" class="todo-muted" role="status">正在载入…</p>
        <div v-if="!state.snapshot && !state.loading" class="todo-empty todo-panel">
          <p>暂时无法载入工作空间。</p>
          <button type="button" class="todo-button" @click="model.load()">重新载入</button>
        </div>
        <template v-if="state.snapshot"
          ><KeepAlive
            ><ToDooTaskViews
              v-if="taskSections.includes(section)"
              :model="model"
              :tree="tree"
              :section="section"
              @bulk="bulkOpen = true"
              @open="open"
              @create="create"
              @list="navigate('tasks', { list: $event })"
              @edit="edit"
              @navigate="navigate" /><ToDooCalendar
              v-else-if="section === 'calendar' || section === 'timeline'"
              :model="model"
              :date="selection.date"
              :view="selection.calendarView || 'month'"
              :timeline="section === 'timeline'"
              @open="open"
              @navigate="navigate(section, { ...selection, ...$event })"
              @edit="edit" /><ToDooRhythm
              v-else-if="section === 'focus' || section === 'habits' || section === 'anniversaries'"
              :model="model"
              :section="section"
              :occurrence-id="focusOccurrence"
              @edit="edit"
              @task="selectTask" /><ToDooReview
              v-else-if="section === 'stats' || section === 'notifications'"
              :model="model"
              :section="section"
              @edit="edit"
              @task="selectTask" /><ToDooSettings
              v-else-if="section === 'settings'"
              ref="settingsRef"
              :model="model"
              @resume-outcome="resumeOutcome"
              @open-note="emit('open-note', $event)"
              @edit="edit"
          /></KeepAlive>
          <div v-if="moreCollections.length" class="todo-load-more">
            <span>当前工作集分批载入，历史记录按需读取</span>
            <button
              v-for="kind in moreCollections"
              :key="kind"
              type="button"
              class="todo-button"
              :disabled="state.loading || state.collectionLoading"
              @click="model.nextCollectionPage(kind)"
            >
              继续载入{{ collectionLabels[kind] || kind }}
            </button>
          </div>
          <details v-if="state.snapshot.warnings.length" class="todo-warnings">
            <summary>{{ state.snapshot.warnings.length }} 项内容需要核对</summary>
            <p v-for="(w, i) in state.snapshot.warnings" :key="i">{{ w.message }}</p>
          </details></template
        >
      </div>
    </main>
    <div v-if="detailOpen" class="todo-detail-layer">
      <button
        type="button"
        class="todo-detail-scrim"
        aria-label="收起任务详情"
        @click="closeDetail"
      ></button
      ><ToDooTaskDetail
        :key="creating ? 'new-' + parentId : 'detail'"
        ref="detailRef"
        :model="model"
        :tree="tree"
        :creating="creating"
        :parent-task-id="parentId"
        :list-id="selection.list"
        :created-note-id="state.selectedTaskId === createdNoteTaskId ? createdNoteId : undefined"
        @close="closeDetail"
        @created="created"
        @select="selectTask"
        @edit="edit"
        @open-note="emit('open-note', $event)"
        @child="create"
        @outcome-note="openOutcomeNote"
        @focus="
          focusOccurrence = $event || '';
          detailOpen = false;
          navigate('focus');
        "
      />
    </div>
    <ToDooOutcomeNote
      v-if="outcomeNote"
      v-show="outcomeNoteOpen"
      ref="outcomeRef"
      :model="model"
      :task="outcomeNote.task"
      :occurrence="outcomeNote.occurrence"
      :operation="outcomeNote.operation"
      :key="outcomeNote.operation?.id || outcomeNote.occurrence.id"
      :tree="tree"
      @close="outcomeNoteOpen = false"
      @saved="
        createdNoteId = $event;
        createdNoteTaskId = outcomeNote?.task.id || '';
        emit('note-created', $event);
        outcomeNote = undefined;
        outcomeNoteOpen = false;
      "
      @open-note="emit('open-note', $event)"
    />
    <ToDooBatchEditor
      v-if="bulkOpen"
      :model="model"
      :tree="tree"
      @close="bulkOpen = false"
      @open-note="emit('open-note', $event)"
    /><ToDooEntityEditor
      v-if="editor"
      :key="editor.kind + ':' + (editor.entity?.id || 'new')"
      ref="editorRef"
      :model="model"
      :kind="editor.kind"
      :entity="editor.entity"
      :seed="editor.seed"
      :tree="tree"
      @close="editor = undefined"
      @open-note="emit('open-note', $event)"
    />
    <div v-if="leaving" class="todo-modal-backdrop">
      <section class="todo-modal" role="dialog" aria-modal="true" aria-label="尚有未保存内容">
        <h2>还有内容未保存</h2>
        <p>可以继续编辑，或明确放弃尚未提交的表单后离开。</p>
        <div class="todo-actions">
          <button type="button" class="todo-button todo-primary" @click="finishLeave(false)">
            继续编辑</button
          ><button type="button" class="todo-button todo-danger" @click="finishLeave(true)">
            放弃更改并离开
          </button>
        </div>
      </section>
    </div>
  </section>
</template>
