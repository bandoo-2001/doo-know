<script setup lang="ts">
import { provideToDooConfirm } from '../to-doo-controls';
import '../to-doo-ant.css';
import ToDooSelect from './to-doo/ToDooSelect.vue';

import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue';
import {
  Button as AButton,
  Drawer as ADrawer,
  Modal as AModal,
  Popover as APopover,
  Segmented as ASegmented,
} from 'ant-design-vue';
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
import ToDooIcon from './to-doo/ToDooIcon.vue';
import ToDooNavigation from './to-doo/ToDooNavigation.vue';
import ToDooDisclosure from './to-doo/ToDooDisclosure.vue';
import { toDooQuickFilter, toDooQuickViews, type ToDooQuickFilter } from '../to-doo-presentation';
import '../to-doo.css';
import '../to-doo-priority.css';
const props = withDefaults(
  defineProps<{
    section: ToDooAppSection;
    selection?: ToDooSelection;
    tree: TreeEntry[];
    hostedNavigation?: boolean;
  }>(),
  { selection: () => ({}), hostedNavigation: false },
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
  creatingListId = ref<string>(),
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
const confirmation = provideToDooConfirm();
const confirmRequest = confirmation.current;
const navigationOpen = ref(false);
const settingsVersion = ref(0);
const hasSecondaryNavigation = computed(
  () =>
    !props.hostedNavigation ||
    ['tasks', 'board', 'overview', 'calendar', 'timeline'].includes(props.section),
);
const calendarToday = computed(() => toDooLocalDate(new Date(), state.snapshot?.settings.timeZone));
const calendarDate = computed(() => props.selection.date || calendarToday.value);
watch(hasSecondaryNavigation, (visible) => {
  if (!visible) navigationOpen.value = false;
});
const workspaceRef = ref<HTMLElement>();
const navigationDialog = ref<HTMLElement>();
let navigationOpener: HTMLElement | undefined;
let navigationCycleActive = false;
function openNavigation(event: MouseEvent) {
  navigationOpener = event.currentTarget as HTMLElement;
  navigationCycleActive = true;
  navigationOpen.value = true;
}
function focusNavigationStart() {
  const dialog = navigationDialog.value;
  if (dialog && !dialog.contains(document.activeElement))
    dialog.querySelector<HTMLElement>('button:not([disabled])')?.focus({ preventScroll: true });
}
watch(
  navigationOpen,
  (open) => {
    if (open) void nextTick(focusNavigationStart);
  },
  { flush: 'post' },
);
function navigationFocusChanged(open: boolean) {
  if (open) {
    focusNavigationStart();
    return;
  }
  const restore = navigationCycleActive;
  navigationCycleActive = false;
  if (!restore || !navigationOpener?.isConnected) return;
  const antModals = [
    ...document.querySelectorAll<HTMLElement>(
      '.todo-ant-modal[role="dialog"], .todo-ant-modal [role="dialog"]',
    ),
  ].filter((element) => element.getClientRects().length);
  const antModal =
    antModals.find((element) => element.closest('.todo-action-confirm')) ||
    antModals.find((element) => element.closest('.todo-leave-modal')) ||
    antModals.at(-1);
  if (antModal) {
    if (!antModal.contains(document.activeElement))
      antModal.querySelector<HTMLElement>('button:not([disabled])')?.focus({ preventScroll: true });
    return;
  }
  // A navigation choice may open a task, editor or unsaved-changes prompt.
  // Keep focus in that surface instead of returning to the page underneath it.
  const surfaces = [
    ...(workspaceRef.value?.querySelectorAll<HTMLElement>(
      '.todo-modal[role="dialog"], .todo-detail-layer [aria-label="任务详情"]',
    ) || []),
  ].filter((element) => element.getClientRects().length);
  const modal =
    surfaces.find((element) => element.getAttribute('aria-label') === '尚有未保存内容') ||
    surfaces.find((element) => element.getAttribute('role') === 'dialog') ||
    surfaces[0];
  if (modal) {
    if (!modal.contains(document.activeElement))
      modal
        .querySelector<HTMLElement>(
          'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled])',
        )
        ?.focus({ preventScroll: true });
  } else if (navigationOpener?.isConnected) {
    navigationOpener.focus({ preventScroll: true });
  }
}
function trapNavigationFocus(event: KeyboardEvent) {
  if (!navigationOpen.value || event.key !== 'Tab') return;
  const drawer = event.currentTarget as HTMLElement;
  const controls = [
    ...drawer.querySelectorAll<HTMLElement>(
      'button:not([disabled]), a[href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
    ),
  ].filter(
    (element) =>
      element.getClientRects().length && !element.closest('[hidden], [aria-hidden="true"]'),
  );
  const first = controls[0],
    last = controls.at(-1);
  if (!first || !last) return;
  if (
    event.shiftKey &&
    (document.activeElement === first || !controls.includes(document.activeElement as HTMLElement))
  ) {
    event.preventDefault();
    last.focus();
  } else if (
    !event.shiftKey &&
    (document.activeElement === last || !controls.includes(document.activeElement as HTMLElement))
  ) {
    event.preventDefault();
    first.focus();
  }
}
const quickView = computed<ToDooQuickFilter>(() => props.selection.taskFilter || 'all');
const listCatalog = ref<ToDooEntityMap['list'][]>([]),
  listCursor = ref<string>(),
  listLoading = ref(false),
  listError = ref(false);
const lists = computed(() =>
  [
    ...new Map(
      [...listCatalog.value, ...(state.snapshot?.lists || [])].map((l) => [l.id, l]),
    ).values(),
  ].filter((l) => !l.deletedAt && !l.archivedAt),
);
let listReloadQueued = false;
async function loadLists(append = false) {
  if (listLoading.value) {
    if (!append) listReloadQueued = true;
    return;
  }
  listLoading.value = true;
  listError.value = false;
  try {
    const query = new URLSearchParams({ kind: 'list', limit: '200' });
    if (append && listCursor.value) query.set('cursor', listCursor.value);
    const catalog = (await model.request('/api/to-doo/state?' + query.toString())) as NonNullable<
      typeof state.snapshot
    >;
    listCatalog.value = append ? [...listCatalog.value, ...catalog.lists] : catalog.lists;
    listCursor.value = catalog.page.nextCursor || undefined;
  } catch {
    listError.value = true;
  } finally {
    listLoading.value = false;
    if (listReloadQueued) {
      listReloadQueued = false;
      void loadLists();
    }
  }
}
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
const title = computed(() =>
  props.section === 'tasks'
    ? lists.value.find((l) => l.id === props.selection.list)?.name ||
      toDooQuickViews.find((v) => v.id === quickView.value)?.name ||
      '所有任务'
    : nav.find((n) => n[0] === props.section)?.[1] || '目标总览',
);
const mobileTools = nav.filter(([section]) =>
  ['calendar', 'matrix', 'focus', 'habits'].includes(section),
);
const mobileQuickViews = toDooQuickViews.filter((view) => view.id !== 'all');
const mobileNavigation = computed(() => {
  if (props.section !== 'tasks') return props.section;
  if (props.selection.list) return 'list:' + props.selection.list;
  return mobileQuickViews.some((view) => view.id === quickView.value)
    ? 'quick:' + quickView.value
    : 'tasks';
});
function changeMobileNavigation(value: string) {
  if (value.startsWith('list:')) chooseList(value.slice(5));
  else if (value.startsWith('quick:')) {
    const view = mobileQuickViews.find((item) => 'quick:' + item.id === value);
    if (view) void chooseQuickView(view.id);
  } else if (value === 'new-list') edit('list', undefined, { kind: 'list' });
  else if (value === 'more-lists') void loadLists(!!listCursor.value && !listError.value);
  else if (nav.some(([section]) => section === value)) navigate(value as ToDooAppSection);
}
async function chooseQuickView(value: ToDooQuickFilter) {
  navigationOpen.value = false;
  state.filter = toDooQuickFilter(
    { ...state.filter, listIds: [] },
    value,
    toDooLocalDate(new Date(), state.snapshot?.settings.timeZone),
  );
  if (props.section === 'tasks' && !props.selection.list && props.selection.taskFilter === value)
    await model.load({
      ...state.query,
      view: 'tasks',
      listIds: value === 'inbox' ? ['inbox'] : undefined,
      filter: { ...state.filter },
      cursor: undefined,
    });
  else navigate('tasks', { taskFilter: value });
}
function chooseList(id: string) {
  navigationOpen.value = false;
  state.filter = { listIds: [id] };
  navigate('tasks', { list: id, taskFilter: 'all' });
}
function changeTaskView(section: ToDooAppSection) {
  navigate(section, { ...props.selection, task: undefined });
}
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
  navigationOpen.value = false;
  if (props.section === 'settings' && section !== 'settings') {
    void requestSectionLeave(section).then((allowed) => {
      if (allowed) emit('navigate', section, selection);
    });
  } else emit('navigate', section, selection);
}
function create(parent?: string) {
  creating.value = true;
  parentId.value = parent;
  creatingListId.value = props.selection.list;
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
function closeEditor() {
  const refreshLists = editor.value?.kind === 'list';
  editor.value = undefined;
  if (refreshLists) void loadLists();
}
async function retryOriginal() {
  const pending = state.pendingMutation;
  const action = pending?.action;
  const affectsList = !!pending && 'kind' in pending.payload && pending.payload.kind === 'list';
  const fromDetail = creating.value && detailOpen.value;
  const result = await model.retryPending();
  if (result && affectsList) void loadLists();
  if (result && action === 'create_task' && state.selectedTaskId && fromDetail)
    created(state.selectedTaskId);
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
  void nextTick(() =>
    document.querySelector<HTMLElement>('.todo-leave-modal button')?.focus({ preventScroll: true }),
  );
  return new Promise((resolve) => (leaveResolver = resolve));
}
async function requestSectionLeave(nextSection: ToDooAppSection): Promise<boolean> {
  if (props.section !== 'settings' || nextSection === 'settings') return true;
  if (!state.busy && !settingsRef.value?.hasUnsavedChanges()) return true;
  return requestLeave();
}
function finishLeave(answer: boolean) {
  leaving.value = false;
  if (answer) {
    if (props.section === 'settings') settingsVersion.value++;
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
  () => [
    props.section,
    props.selection.date,
    props.selection.list,
    props.selection.calendarView,
    props.selection.taskFilter,
  ],
  async (_current, previous) => {
    const today = toDooLocalDate(),
      anchor = props.selection.date || today;
    if (!previous || previous[4] !== props.selection.taskFilter)
      state.filter = toDooQuickFilter(
        state.filter,
        quickView.value,
        toDooLocalDate(new Date(), state.snapshot?.settings.timeZone),
      );
    state.filter.listIds = props.selection.list ? [props.selection.list] : [];
    await model.load({
      view: props.section,
      listIds: quickView.value === 'inbox' ? ['inbox'] : undefined,
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
    void loadLists();
    // A deep link can load before the dataset's timezone is known.
    if (state.snapshot && ['today', 'upcoming', 'overdue'].includes(quickView.value)) {
      const corrected = toDooQuickFilter(
        state.filter,
        quickView.value,
        toDooLocalDate(new Date(), state.snapshot.settings.timeZone),
      );
      if (
        corrected.from !== state.filter.from ||
        corrected.to !== state.filter.to ||
        corrected.dueBefore !== state.filter.dueBefore
      ) {
        state.filter = corrected;
        await model.load({ ...state.query, filter: corrected, cursor: undefined });
      }
    }
    if (props.selection.task) {
      await model.ensureTask(props.selection.task);
      model.selectTask(
        props.selection.task,
        state.selectedTaskId === props.selection.task ? state.selectedOccurrenceId : undefined,
      );
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
defineExpose({ hasUnsavedChanges, requestLeave, requestSectionLeave });
</script>
<template>
  <section
    ref="workspaceRef"
    class="to-doo-workspace"
    :class="{
      'todo-compact': density === 'compact',
      'todo-has-detail': detailOpen,
      'todo-no-sidebar': !hasSecondaryNavigation,
      'todo-hosted-navigation': hostedNavigation,
    }"
    aria-label="To Doo 行动工作空间"
  >
    <aside v-if="hasSecondaryNavigation" class="todo-sidebar">
      <ToDooNavigation
        :hosted-navigation="hostedNavigation"
        :date="calendarDate"
        :today="calendarToday"
        :calendar-view="selection.calendarView"
        :section="section"
        :quick-view="quickView"
        :list-id="selection.list"
        :lists="lists"
        :items="nav"
        :list-loading="listLoading"
        :list-error="listError"
        :has-more-lists="!!listCursor"
        @navigate="navigate"
        @quick="chooseQuickView"
        @list="chooseList"
        @new-list="
          navigationOpen = false;
          edit('list', undefined, { kind: 'list' });
        "
        @load-lists="loadLists(!!listCursor && !listError)"
        @back="
          navigationOpen = false;
          back();
        "
      />
    </aside>
    <ADrawer
      v-if="hasSecondaryNavigation"
      v-model:open="navigationOpen"
      placement="left"
      :width="288"
      :get-container="false"
      :root-style="{ position: 'fixed' }"
      class="todo-navigation-drawer"
      :destroy-on-close="true"
      :closable="false"
      :autofocus="false"
      @after-open-change="navigationFocusChanged"
    >
      <div
        ref="navigationDialog"
        class="todo-sidebar todo-drawer-sidebar"
        role="dialog"
        aria-modal="true"
        aria-label="功能导航"
        tabindex="-1"
        @keydown.capture="trapNavigationFocus"
      >
        <div class="todo-drawer-heading">
          <h2>功能导航</h2>
          <AButton type="text" aria-label="关闭功能导航" @click="navigationOpen = false">×</AButton>
        </div>
        <ToDooNavigation
          :hosted-navigation="hostedNavigation"
          :date="calendarDate"
          :today="calendarToday"
          :calendar-view="selection.calendarView"
          :section="section"
          :quick-view="quickView"
          :list-id="selection.list"
          :lists="lists"
          :items="nav"
          :list-loading="listLoading"
          :list-error="listError"
          :has-more-lists="!!listCursor"
          @navigate="navigate"
          @quick="chooseQuickView"
          @list="chooseList"
          @new-list="
            navigationOpen = false;
            edit('list', undefined, { kind: 'list' });
          "
          @load-lists="loadLists(!!listCursor && !listError)"
          @back="
            navigationOpen = false;
            back();
          "
        />
      </div>
    </ADrawer>
    <main class="todo-main">
      <div class="todo-topbar">
        <div class="todo-topbar-brand" aria-label="To Doo">
          <span class="todo-app-mark"><ToDooIcon name="check" :size="16" /></span
          ><span>To Doo</span>
          <small>知识 · 行动 · 成果</small>
        </div>
        <AButton
          v-if="hasSecondaryNavigation"
          type="text"
          class="todo-navigation-trigger"
          aria-label="功能导航"
          aria-haspopup="dialog"
          :aria-expanded="navigationOpen"
          @click="openNavigation"
          ><ToDooIcon name="board" :size="16" />{{
            hostedNavigation ? '目录' : '功能导航'
          }}</AButton
        >
        <span class="todo-desktop-crumb">我的工作空间 / {{ title }}</span
        ><ToDooSelect
          v-if="!hostedNavigation"
          class="todo-mobile-nav"
          :value="mobileNavigation"
          aria-label="切换 To Doo 页面"
          @change="changeMobileNavigation"
        >
          <optgroup label="我的待办">
            <option v-for="view in mobileQuickViews" :key="view.id" :value="'quick:' + view.id">
              {{ view.name }}
            </option>
          </optgroup>
          <optgroup label="我的清单">
            <option v-for="list in lists" :key="list.id" :value="'list:' + list.id">
              {{ list.name }}
            </option>
            <option v-if="listCursor || listError" value="more-lists" :disabled="listLoading">
              {{ listError ? '重试载入清单' : '更多清单' }}
            </option>
            <option value="new-list">新建清单</option>
          </optgroup>
          <optgroup label="工作空间">
            <option v-for="item in nav" :key="item[0]" :value="item[0]">
              {{ item[1] }}
            </option>
          </optgroup></ToDooSelect
        ><span class="todo-spacer"></span>
        <APopover trigger="click" placement="bottomRight">
          <template #content
            ><div class="todo-ant-density">
              <span>界面密度</span
              ><ASegmented
                v-model:value="density"
                aria-label="界面密度"
                :options="[
                  { label: '舒展', value: 'comfortable' },
                  { label: '紧凑', value: 'compact' },
                ]"
              /></div
          ></template>
          <AButton type="text" size="small" aria-label="显示选项"
            ><ToDooIcon name="more"
          /></AButton>
        </APopover>
        <AButton
          html-type="button"
          class="todo-icon-button"
          aria-label="刷新 To Doo"
          :disabled="state.loading || state.busy"
          @click="model.load()"
          type="text"
        >
          ↻</AButton
        ><AButton
          html-type="button"
          class="todo-icon-button"
          aria-label="打开通知中心"
          @click="navigate('notifications')"
          type="text"
        >
          <ToDooIcon name="notifications" /><small v-if="unread">{{ unread }}</small>
        </AButton>
      </div>
      <nav v-if="!hostedNavigation" class="todo-mobile-tools" aria-label="计划与执行入口">
        <AButton
          v-for="item in mobileTools"
          :key="item[0]"
          type="text"
          :class="{ active: section === item[0] }"
          :aria-current="section === item[0] ? 'page' : undefined"
          @click="navigate(item[0])"
          ><ToDooIcon :name="item[0]" :size="15" />{{ item[1] }}</AButton
        >
        <AButton type="text" aria-haspopup="dialog" @click="openNavigation"
          ><ToDooIcon name="more" :size="15" />全部功能</AButton
        >
      </nav>
      <div class="todo-page" :class="{ 'todo-page-matrix': section === 'matrix' }">
        <header class="todo-page-heading">
          <div>
            <h1>{{ title }}</h1>
            <p v-if="section !== 'tasks'">{{ descriptions[section] }}</p>
            <p v-else class="todo-daily-caption">
              {{
                selection.list
                  ? '把下一步，放进清单里'
                  : quickView === 'today'
                    ? '专注今天，一件一件来'
                    : quickView === 'inbox'
                      ? '先记下来，稍后再安排'
                      : '留出空间，专注手上的事'
              }}
            </p>
          </div>
          <div
            v-if="
              taskSections.includes(section) || section === 'calendar' || section === 'timeline'
            "
            class="todo-actions"
          >
            <AButton
              v-if="section === 'overview'"
              type="primary"
              class="todo-button todo-primary"
              aria-label="新建目标"
              @click="edit('list', undefined, { kind: 'goal' })"
            >
              ＋ 新建目标</AButton
            ><AButton
              :type="section !== 'overview' ? 'primary' : 'default'"
              class="todo-button"
              aria-label="新建任务"
              :class="{ 'todo-primary': section !== 'overview' }"
              @click="create()"
            >
              ＋ 新建任务
            </AButton>
          </div>
        </header>
        <nav v-if="section === 'tasks'" class="todo-mobile-quick-nav" aria-label="常用任务入口">
          <AButton
            v-for="view in toDooQuickViews"
            :key="view.id"
            html-type="button"
            :class="{ active: section === 'tasks' && !selection.list && quickView === view.id }"
            @click="chooseQuickView(view.id)"
            type="text"
          >
            {{ view.name }}
          </AButton>
        </nav>
        <div v-if="state.error" class="todo-error todo-alert" role="alert">
          {{ state.error
          }}<AButton html-type="button" class="todo-link" @click="state.error = ''" type="link"
            >关闭提示</AButton
          >
        </div>
        <p v-if="state.notice" class="todo-notice" role="status">{{ state.notice }}</p>
        <AButton
          v-if="createdNoteId && !detailOpen"
          class="todo-link todo-open-output"
          html-type="button"
          aria-label="打开成果笔记"
          @click="emit('open-note', createdNoteId)"
          type="link"
        >
          打开成果笔记 ↗
        </AButton>
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
          ><AButton
            html-type="button"
            class="todo-button"
            :disabled="state.busy"
            @click="retryOriginal"
            type="default"
          >
            重试原操作
          </AButton>
        </div>
        <AButton
          v-if="model.hasNewTaskDraft() && !creating"
          html-type="button"
          class="todo-link"
          @click="create()"
          type="link"
        >
          继续新建任务草稿
        </AButton>
        <p v-if="state.loading" class="todo-muted" role="status">正在载入…</p>
        <div v-if="!state.snapshot && !state.loading" class="todo-empty todo-panel">
          <p>暂时无法载入工作空间。</p>
          <AButton html-type="button" class="todo-button" @click="model.load()" type="default"
            >重新载入</AButton
          >
        </div>
        <template v-if="state.snapshot"
          ><KeepAlive
            ><ToDooTaskViews
              v-if="taskSections.includes(section)"
              :model="model"
              :tree="tree"
              :section="section"
              :quick-view="quickView"
              :creating="creating"
              @quick-filter="chooseQuickView"
              @bulk="bulkOpen = true"
              @open="open"
              @create="create"
              @list="chooseList"
              @edit="edit"
              @navigate="changeTaskView" /><ToDooCalendar
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
              :key="'settings-' + settingsVersion"
              ref="settingsRef"
              :model="model"
              @resume-outcome="resumeOutcome"
              @open-note="emit('open-note', $event)"
              @edit="edit"
          /></KeepAlive>
          <div v-if="moreCollections.length" class="todo-load-more">
            <span>当前工作集分批载入，历史记录按需读取</span>
            <AButton
              v-for="kind in moreCollections"
              :key="kind"
              html-type="button"
              class="todo-button"
              :disabled="state.loading || state.collectionLoading"
              @click="model.nextCollectionPage(kind)"
              type="default"
            >
              继续载入{{ collectionLabels[kind] || kind }}
            </AButton>
          </div>
          <ToDooDisclosure v-if="state.snapshot.warnings.length" class="todo-warnings">
            <template #header>{{ state.snapshot.warnings.length }} 项内容需要核对</template>
            <p v-for="(w, i) in state.snapshot.warnings" :key="i">{{ w.message }}</p>
          </ToDooDisclosure></template
        >
      </div>
    </main>
    <div v-if="detailOpen" class="todo-detail-layer">
      <AButton
        html-type="button"
        class="todo-detail-scrim"
        aria-label="收起任务详情"
        @click="closeDetail"
        type="text"
      ></AButton
      ><ToDooTaskDetail
        :key="creating ? 'new-' + parentId + '@' + creatingListId : 'detail'"
        ref="detailRef"
        :model="model"
        :tree="tree"
        :creating="creating"
        :parent-task-id="parentId"
        :list-id="creating ? creatingListId : selection.list"
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
      :open="outcomeNoteOpen"
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
      @close="closeEditor"
      @open-note="emit('open-note', $event)"
    />
    <AModal
      :open="leaving"
      title="尚有未保存内容"
      :footer="null"
      :closable="false"
      :mask-closable="false"
      :z-index="1800"
      wrap-class-name="todo-ant-modal todo-leave-modal"
      @cancel="finishLeave(false)"
    >
      <p>可以继续编辑，或明确放弃尚未提交的表单后离开。</p>
      <div class="todo-ant-modal-actions">
        <AButton type="primary" @click="finishLeave(false)">继续编辑</AButton>
        <AButton danger @click="finishLeave(true)">放弃更改并离开</AButton>
      </div>
    </AModal>
    <AModal
      :open="!!confirmRequest"
      :title="confirmRequest?.title"
      :mask-closable="false"
      :z-index="1840"
      :ok-button-props="{ danger: confirmRequest?.danger }"
      ok-text="确认"
      cancel-text="取消"
      wrap-class-name="todo-ant-modal todo-action-confirm"
      @ok="confirmation.finish(true)"
      @cancel="confirmation.finish(false)"
    >
      <p>{{ confirmRequest?.content }}</p>
    </AModal>
  </section>
</template>
