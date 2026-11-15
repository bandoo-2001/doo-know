<script setup lang="ts">
import { provideToDooConfirm } from '../to-doo-controls';
import '../to-doo-ant.css';
import { useToDooClock } from '../to-doo-time';
import { resolveToDooContext, toDooContextEntries } from '../to-doo-context-navigation';

import {
  computed,
  defineAsyncComponent,
  defineComponent,
  h,
  inject,
  nextTick,
  onBeforeUnmount,
  reactive,
  ref,
  watch,
  type AsyncComponentLoader,
  type Component,
  type Ref,
} from 'vue';
import {
  Button as AButton,
  ConfigProvider as AConfigProvider,
  Drawer as ADrawer,
  Dropdown as ADropdown,
  Menu as AMenu,
  MenuItem as AMenuItem,
  Modal as AModal,
  Popover as APopover,
} from 'ant-design-vue';
import type { TreeEntry } from '../../../shared/contracts';
import type {
  ToDooEntityKind,
  ToDooEntityMap,
  ToDooSnapshot,
  ToDooQuery,
  ToDooReminderSource,
} from '../../../shared/to-doo-contracts';
import { api } from '../api';
import { resolvedTheme } from '../preferences';
import { toDooAntTheme } from '../ant-design';
import type { ToDooDensity } from '../platform-theme';
import type { ToDooAppSection } from '../navigation';
import {
  createToDooWorkbench,
  shiftToDooDate,
  toDooLocalDate,
  toDooDisplayTime,
  toDooItemMatchesDateRange,
  type ToDooItem,
  type ToDooCreateSeed,
  type ToDooSelection,
} from '../to-doo-workbench';
import ToDooTaskViews from './to-doo/ToDooTaskViews.vue';
import ToDooBatchEditor from './to-doo/ToDooBatchEditor.vue';
import ToDooOutcomeNote from './to-doo/ToDooOutcomeNote.vue';
import ToDooTaskDetail from './to-doo/ToDooTaskDetail.vue';
import ToDooEntityEditor from './to-doo/ToDooEntityEditor.vue';
import ToDooIcon from './to-doo/ToDooIcon.vue';
import ToDooNavigation from './to-doo/ToDooNavigation.vue';
import ToDooPageHeader from './to-doo/ToDooPageHeader.vue';
import ToDooDisclosure from './to-doo/ToDooDisclosure.vue';
import ToDooLoadingState from './to-doo/ToDooLoadingState.vue';
import ToDooPageLoadError from './to-doo/ToDooPageLoadError.vue';
import {
  toDooQuickFilter,
  toDooQuickViews,
  toDooFilterSummary,
  toDooAdditionalFilters,
  toDooDateLabel,
  toDooCalendarRange,
  type ToDooQuickFilter,
  type ToDooTaskPlacement,
} from '../to-doo-presentation';
import '../to-doo.css';
import '../to-doo-tokens.css';
import '../to-doo-priority.css';
import '../to-doo-task-detail.css';
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
const pageAttempts = reactive({ calendar: 0, rhythm: 0, review: 0, settings: 0 });
function asyncPage<T extends Component>(
  key: keyof typeof pageAttempts,
  loader: AsyncComponentLoader<T>,
) {
  return defineAsyncComponent<T>({
    loader,
    delay: 150,
    loadingComponent: defineComponent(
      () => () => h(ToDooLoadingState, { section: props.section, embedded: true }),
    ),
    errorComponent: defineComponent({
      props: ['error'],
      setup: () => () => h(ToDooPageLoadError, { onRetry: () => pageAttempts[key]++ }),
    }),
  });
}
const ToDooCalendar = asyncPage('calendar', () => import('./to-doo/ToDooCalendar.vue'));
const ToDooRhythm = asyncPage('rhythm', () => import('./to-doo/ToDooRhythm.vue'));
const ToDooReview = asyncPage('review', () => import('./to-doo/ToDooReview.vue'));
const ToDooSettings = asyncPage('settings', () => import('./to-doo/ToDooSettings.vue'));
const ownerId = inject<Ref<string> | undefined>('dooknow.owner-id', undefined);
const model = createToDooWorkbench(api, { recoveryScope: ownerId?.value }),
  state = model.state,
  creating = ref(false),
  parentId = ref<string>(),
  creatingListId = ref<string>(),
  detailOpen = ref(false),
  focusOccurrence = ref(''),
  density = ref<ToDooDensity>(readDensity());
function readDensity(): ToDooDensity {
  try {
    return localStorage.getItem('dooknow.to-doo.density') === 'compact' ? 'compact' : 'comfortable';
  } catch {
    return 'comfortable';
  }
}
watch(density, value => {
  try { localStorage.setItem('dooknow.to-doo.density', value); } catch { /* The current preference still works. */ }
});
const activeToDooTheme = computed(() => toDooAntTheme(resolvedTheme.value, density.value));
let noticeTimer: ReturnType<typeof setTimeout> | undefined;
let completionTimer: ReturnType<typeof setTimeout> | undefined;
let completionDeadline = 0, completionRemaining = 6000;
function pauseCompletion() {
  clearTimeout(completionTimer);
  completionRemaining = Math.max(0, completionDeadline - Date.now());
}
function resumeCompletion() {
  clearTimeout(completionTimer);
  if (!state.completionFeedback) return;
  completionDeadline = Date.now() + completionRemaining;
  completionTimer = setTimeout(() => { state.completionFeedback = null; }, completionRemaining);
}
watch(() => state.completionFeedback, value => {
  clearTimeout(completionTimer);
  if (value) { completionRemaining = 6000; resumeCompletion(); }
});
watch(() => state.notice, notice => {
  clearTimeout(noticeTimer);
  if (notice && !state.pendingMutation && !state.conflict)
    noticeTimer = setTimeout(() => { if (state.notice === notice) state.notice = ''; }, 3000);
});
watch(() => props.section, () => {
  state.notice = '';
  state.completionFeedback = null;
});
onBeforeUnmount(() => { clearTimeout(noticeTimer); clearTimeout(completionTimer); });
const focusHistoryRequest = ref(0),
  habitHistoryRequest = ref(0);
const focusHistoryRange = ref<{ from: string; to: string }>();
const habitHistoryDate = ref<string>();
const reviewRange = ref<{ from: string; to: string }>();
watch(
  () => state.snapshot?.statistics,
  (statistics) => {
    if (
      props.section === 'stats' &&
      statistics?.scope === 'period' &&
      statistics.from &&
      statistics.to
    )
      reviewRange.value = { from: statistics.from, to: statistics.to };
  },
);
const reviewRef = ref<InstanceType<typeof ToDooReview>>();
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
const taskDraftsOpen = ref(false);
const draftManagerOpen = ref(false);
const taskToolbarTarget = ref<HTMLElement>();
const retainedTaskDrafts = computed(() => model.retainedNewTaskDrafts());
const retainedEdits = computed(() => model.retainedTaskDrafts());
async function continueTaskDraft(key: string) {
  const entry = retainedEdits.value.find(value => value.key === key);
  if (!entry) return;
  taskDraftsOpen.value = false;
  draftManagerOpen.value = false;
  await selectTask(entry.taskId, entry.occurrenceId || undefined);
}
async function discardTaskDraft(key: string) {
  const entry = retainedEdits.value.find(value => value.key === key);
  if (!entry || !(await confirmation.ask(`放弃「${entry.title}」的未保存修改？`, { danger: true }))) return;
  model.discardTaskDraft(key);
}
async function discardNewTaskDraft(key: string) {
  const entry = retainedTaskDrafts.value.find(value => value.key === key);
  if (!entry || !(await confirmation.ask(`放弃「${entry.draft.title || '未命名任务'}」的新建草稿？`, { danger: true }))) return;
  model.clearNewTaskDraft(entry.parentTaskId || undefined, entry.listId || '');
}
async function recoverLegacyDrafts() {
  if (!(await confirmation.ask('发现此资料库的旧版本地恢复记录。请确认这些记录属于当前账号，再恢复到当前账号的草稿中。', { title: '确认旧草稿归属' }))) return;
  await model.adoptLegacyRecovery();
}
const taskDestination = ref<{
  message: string;
  label: string;
  section: ToDooAppSection;
  selection: ToDooSelection;
}>();
watch(
  () => state.busy,
  (busy) => {
    if (busy) taskDestination.value = undefined;
  },
);
watch([() => props.section, () => props.selection.list, () => props.selection.taskFilter], () => {
  taskDestination.value = undefined;
  taskDraftsOpen.value = false;
});
const confirmation = provideToDooConfirm();
const confirmRequest = confirmation.current;
const navigationOpen = ref(false);
const settingsVersion = ref(0);
const { now: calendarNow } = useToDooClock();
const calendarToday = computed(() =>
  toDooLocalDate(new Date(calendarNow.value), state.snapshot?.settings.timeZone),
);
const calendarDate = computed(() => props.selection.date || calendarToday.value);
const pageContext = computed(() =>
  props.selection.appPage ? resolveToDooContext(props.section, props.selection.appPage) : undefined,
);
function changePageContext(value: string) {
  if (toDooContextEntries(props.section).some((entry) => entry.id === value))
    navigate(props.section, { ...props.selection, appPage: value });
}
const workspaceRef = ref<HTMLElement>();
const detailLayer = ref<HTMLElement>();
const viewportWidth = ref(window.innerWidth);
const detailOverlay = computed(() => viewportWidth.value < 960);
const condensedNavigation = computed(() => detailOpen.value && !detailOverlay.value && viewportWidth.value < 1032);
let detailOpener: HTMLElement | undefined;
function resizeDetail() {
  viewportWidth.value = window.innerWidth;
  const compactNavigation = window.matchMedia?.(
    '(max-width: 1000px), (max-width: 1100px) and (orientation: portrait), (max-width: 1366px) and (orientation: portrait) and (pointer: coarse)',
  ).matches;
  if (compactNavigation === false && navigationOpen.value) {
    const restoreNavigationFocus = navigationDialog.value?.contains(document.activeElement);
    navigationOpen.value = false;
    if (restoreNavigationFocus)
      void nextTick(() =>
        workspaceRef.value
          ?.querySelector<HTMLElement>(
            '.todo-sidebar nav [aria-current="page"], .todo-sidebar nav button',
          )
          ?.focus({ preventScroll: true }),
      );
  }
}
window.addEventListener('resize', resizeDetail);
onBeforeUnmount(() => window.removeEventListener('resize', resizeDetail));
watch([detailOpen, detailOverlay], ([open, overlay], previous) => {
  if (typeof document === 'undefined') return;
  if (open && !previous?.[0]) detailOpener = document.activeElement as HTMLElement;
  if (open && overlay) {
    void nextTick(() => {
      detailLayer.value
        ?.querySelector<HTMLElement>(
          '.todo-title-input input, .todo-title-input textarea, .todo-create-fields input',
        )
        ?.focus({ preventScroll: true });
    });
  } else if (
    !open &&
    previous?.[0] &&
    detailOpener?.isConnected &&
    detailLayer.value?.contains(document.activeElement)
  ) {
    const opener = detailOpener;
    void nextTick(() => opener.isConnected && opener.focus({ preventScroll: true }));
  }
});
function detailKeydown(event: KeyboardEvent) {
  if (!detailOverlay.value || event.defaultPrevented || event.isComposing) return;
  if (event.key === 'Escape') {
    // Let the active picker, selection popup or confirmation consume Escape first.
    if (
      [
        ...document.querySelectorAll<HTMLElement>(
          '.ant-select-dropdown, .ant-picker-dropdown, .ant-popover, .ant-modal-wrap',
        ),
      ].some((element) => element.getClientRects().length > 0)
    )
      return;
    event.preventDefault();
    event.stopPropagation();
    closeDetail();
  } else if (event.key === 'Tab') {
    const controls = [
      ...(detailLayer.value?.querySelectorAll<HTMLElement>(
        '.todo-detail button:not([disabled]), .todo-detail input:not([disabled]), .todo-detail textarea:not([disabled]), .todo-detail a[href], .todo-detail [tabindex]:not([tabindex="-1"])',
      ) || []),
    ].filter(
      (element) =>
        element.getClientRects().length && !element.closest('[hidden], [aria-hidden="true"]'),
    );
    const first = controls[0],
      last = controls.at(-1);
    if (
      first &&
      last &&
      ((event.shiftKey && document.activeElement === first) ||
        (!event.shiftKey && document.activeElement === last))
    ) {
      event.preventDefault();
      (event.shiftKey ? last : first).focus();
    }
  }
}
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
async function selectLinkedTask(id: string, occurrenceId?: string) {
  await model.ensureTask(id);
  if (props.selection.task !== id || props.selection.occurrence !== occurrenceId) return false;
  if (
    occurrenceId &&
    !state.snapshot?.occurrences.some((o) => o.id === occurrenceId && o.taskId === id)
  ) {
    try {
      const data = await model.request(
        '/api/to-doo/state?kind=occurrence&ids=' + encodeURIComponent(occurrenceId),
      );
      if (props.selection.task !== id || props.selection.occurrence !== occurrenceId) return false;
      if (
        !data.occurrences.some(
          (o: { id: string; taskId: string }) => o.id === occurrenceId && o.taskId === id,
        )
      ) {
        state.error = '对应的任务执行记录已变化，请在通知中心核对';
        return false;
      }
      model.acceptSnapshot(data, true);
    } catch (cause) {
      state.error = cause instanceof Error ? cause.message : String(cause);
      return false;
    }
  }
  model.selectTask(
    id,
    occurrenceId || (state.selectedTaskId === id ? state.selectedOccurrenceId : undefined),
  );
  detailOpen.value = true;
  return true;
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
  props.selection.list &&
  ['tasks', 'board', 'matrix', 'calendar', 'timeline'].includes(props.section)
    ? lists.value.find((l) => l.id === props.selection.list)?.name || '当前清单'
    : props.section === 'tasks'
      ? lists.value.find((l) => l.id === props.selection.list)?.name ||
        toDooQuickViews.find((v) => v.id === quickView.value)?.name ||
        '所有任务'
      : nav.find((n) => n[0] === props.section)?.[1] || '目标总览',
);
async function chooseQuickView(value: ToDooQuickFilter) {
  navigationOpen.value = false;
  state.filter = toDooQuickFilter({}, value, calendarToday.value);
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
  navigate(section, { ...props.selection });
}
function chooseDestination(section: ToDooAppSection) {
  state.filter = {};
  navigate(section);
}
function openListHabits(id: string) {
  state.filter = {};
  navigate('habits', { list: id });
}
function openActivityHistory(section: 'focus' | 'habits', range: { from: string; to: string }) {
  if (section === 'focus') {
    focusOccurrence.value = '';
    focusHistoryRange.value = range;
    focusHistoryRequest.value++;
  } else {
    habitHistoryDate.value = range.to;
    habitHistoryRequest.value++;
  }
  chooseDestination(section);
}
async function searchAllTasks() {
  const query = state.filter.query?.trim();
  state.filter = query ? { query } : {};
  if (props.section === 'tasks' && !props.selection.list && quickView.value === 'all')
    await model.load({
      ...state.query,
      view: 'tasks',
      listIds: undefined,
      filter: { ...state.filter },
      cursor: undefined,
    });
  else navigate('tasks', { taskFilter: 'all' });
}
function taskSaved(value: ToDooTaskPlacement) {
  if (props.section === 'stats') {
    taskDestination.value = {
      message: `已保存「${value.title}」`,
      label: '查看任务',
      section: 'tasks',
      selection: {
        taskFilter: 'all',
        task: value.taskId,
        ...(value.listId ? { list: value.listId } : {}),
      },
    };
    return;
  }
  if (!showTaskScope.value && props.section !== 'calendar') return;
  const remainsVisible = model
    .items()
    .some(
      (item) =>
        item.task.id === value.taskId &&
        (quickView.value !== 'inbox' || item.task.listId === null) &&
        (props.section !== 'calendar' ||
          toDooItemMatchesDateRange(
            item,
            state.query.from || calendarDate.value,
            state.query.to || calendarDate.value,
            state.snapshot?.settings.timeZone,
          )),
    );
  if (remainsVisible) return;
  if (
    (props.selection.list || quickView.value === 'inbox') &&
    value.listId !== (props.selection.list || null)
  ) {
    const name = value.listId
      ? lists.value.find((list) => list.id === value.listId)?.name || '新清单'
      : '收集箱';
    taskDestination.value = {
      message: `已将「${value.title}」移到「${name}」`,
      label: value.listId ? '查看清单' : '查看收集箱',
      section: 'tasks',
      selection: value.listId ? { list: value.listId, taskFilter: 'all' } : { taskFilter: 'inbox' },
    };
  } else if (
    value.planDates.length &&
    !scopeFilters.value.length &&
    (props.section === 'calendar' || ['today', 'upcoming'].includes(quickView.value))
  ) {
    const date = [...value.planDates].sort()[0];
    taskDestination.value = {
      message: `「${value.title}」已安排到${toDooDateLabel(date, calendarToday.value)}`,
      label: '查看安排',
      section: 'calendar',
      selection: { date, calendarView: 'month' },
    };
  } else {
    taskDestination.value = {
      message: `「${value.title}」已保存，当前范围不包含这项任务`,
      label: '查看任务',
      section: 'tasks',
      selection: { taskFilter: 'all', task: value.taskId },
    };
  }
}
function openTaskDestination() {
  const target = taskDestination.value;
  if (!target) return;
  state.filter = {};
  detailOpen.value = false;
  navigate(target.section, target.selection);
}
const unread = computed(
  () =>
    state.snapshot?.reminderUnreadCount ??
    state.snapshot?.reminderEvents.filter(
      (event) =>
        !event.deletedAt &&
        event.userState === 'unread' &&
        (event.firstRaisedAt || event.scheduledAt <= new Date().toISOString()),
    ).length ??
    0,
);
const taskSections = ['overview', 'tasks', 'board', 'matrix'];
const showTaskScope = computed(() =>
  ['tasks', 'board', 'matrix', 'timeline'].includes(props.section),
);
const scopeTitle = computed(() =>
  props.selection.list
    ? title.value
    : toDooQuickViews.find((view) => view.id === quickView.value)?.name ||
      {
        overdue: '逾期',
        unscheduled: '未安排',
        blocked: '受阻',
        done: '已完成',
        archived: '已归档',
        trash: '回收站',
      }[quickView.value as 'overdue' | 'unscheduled' | 'blocked' | 'done' | 'archived' | 'trash'] ||
      '所有任务',
);
const scopeFilters = computed(() =>
  toDooFilterSummary(
    toDooAdditionalFilters(
      state.filter,
      quickView.value,
      toDooLocalDate(new Date(), state.snapshot?.settings.timeZone),
      props.selection.list,
    ),
    { lists: lists.value, tags: state.snapshot?.tags },
  ),
);
async function clearScopeFilters() {
  if (props.selection.list && quickView.value !== 'all') {
    state.filter = { listIds: [props.selection.list] };
    navigate(props.section, { ...props.selection, taskFilter: 'all' });
    return;
  }
  state.filter = toDooQuickFilter(
    props.selection.list ? { listIds: [props.selection.list] } : {},
    quickView.value,
    calendarToday.value,
  );
  await model.load({
    ...state.query,
    filter: { ...state.filter },
    cursor: undefined,
  });
}
const collectionLabels: Partial<Record<ToDooEntityKind, string>> = {
  task: '任务',
  occurrence: '执行实例',
  timeBlock: '时间安排',
  habit: '习惯',
  habitEntry: '习惯记录',
  anniversary: '纪念日',
  focusTopic: '专注项目',
  focusSession: '专注记录',
  reminderEvent: '通知',
  outcome: '成果',
  record: '推进记录',
  activity: '历史',
  review: '复盘',
  list: '目标与清单',
  section: '分组',
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
  focus: ['task', 'occurrence'],
  habits: ['habit'],
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
function createPageTask(seed?: ToDooCreateSeed) {
  create(
    undefined,
    undefined,
    ['calendar', 'timeline'].includes(props.section)
      ? { planDate: calendarDate.value, ...seed }
      : seed,
  );
}
function create(parent?: string, sectionId?: string | null, seed?: ToDooCreateSeed) {
  const context: ToDooCreateSeed = {
    initialStatus: 'todo',
    priority: 'none',
    tagIds: [],
    planDate: '',
    ...(['today', 'upcoming'].includes(quickView.value)
      ? { planDate: toDooLocalDate(new Date(), state.snapshot?.settings.timeZone) }
      : {}),
    ...(state.filter.tagIds?.length ? { tagIds: [...state.filter.tagIds] } : {}),
    ...(state.filter.priorities?.length === 1 ? { priority: state.filter.priorities[0] } : {}),
    ...seed,
    ...(sectionId !== undefined ? { sectionId } : {}),
  };
  const list = seed?.listId !== undefined ? seed.listId || undefined : props.selection.list;
  model.newTaskDraft(parent, list, context);
  taskDraftsOpen.value = false;
  creating.value = true;
  parentId.value = parent;
  creatingListId.value = list;
  detailOpen.value = true;
}
function open(item: ToDooItem) {
  model.selectTask(item.task.id, item.occurrence?.id);
  detailOpen.value = true;
  creating.value = false;
  navigate(props.section, {
    ...props.selection,
    task: item.task.id,
    occurrence: item.occurrence?.id,
  });
}
async function selectTask(id: string, occurrence?: string) {
  if (!state.snapshot?.tasks.some((t) => t.id === id)) await model.ensureTask(id);
  model.selectTask(id, occurrence);
  creating.value = false;
  detailOpen.value = true;
  navigate(props.section, {
    ...props.selection,
    task: id,
    occurrence: model.state.selectedOccurrenceId || undefined,
  });
}
function continueNewDraft(key: string) {
  const retained = retainedTaskDrafts.value.find((entry) => entry.key === key);
  if (!retained) return;
  taskDraftsOpen.value = false;
  creating.value = true;
  parentId.value = retained.parentTaskId || undefined;
  // Empty string explicitly identifies the original inbox draft, even if the
  // current route or the parent task now belongs to another list.
  creatingListId.value = retained.listId || '';
  detailOpen.value = true;
}
function closeDetail() {
  creating.value = false;
  detailOpen.value = false;
  navigate(props.section, { ...props.selection, task: undefined, occurrence: undefined });
}
function openReminderSource(source: ToDooReminderSource) {
  navigate(source.section, {
    task: source.taskId,
    occurrence: source.occurrenceId,
    date: source.date,
  });
}
let reviewViewBeforeEditor: ToDooSnapshot | undefined;
async function edit(kind: ToDooEntityKind, entity?: Record<string, any>, seed?: Record<string, any>) {
  const linkedOccurrence = kind === 'timeBlock' ? entity?.occurrenceId || seed?.occurrenceId : undefined;
  if (linkedOccurrence) {
    const occurrence = state.snapshot?.occurrences.find(value => value.id === linkedOccurrence);
    if (occurrence) {
      await model.ensureTask(occurrence.taskId);
      await selectTask(occurrence.taskId, occurrence.id);
      await nextTick();
      detailRef.value?.openProperty('plan');
      return;
    }
  }
  reviewViewBeforeEditor =
    props.section === 'stats' && state.snapshot?.statistics.scope === 'period'
      ? JSON.parse(JSON.stringify(state.snapshot))
      : undefined;
  editor.value = { kind, entity, seed };
  state.error = '';
}
async function closeEditor() {
  const closed = editor.value;
  const section = props.section;
  const taskId = state.selectedTaskId,
    occurrenceId = state.selectedOccurrenceId;
  const linkedOccurrence =
    closed?.kind === 'timeBlock'
      ? closed.entity?.occurrenceId || closed.seed?.occurrenceId
      : undefined;
  const calendarQuery = ['calendar', 'timeline'].includes(section)
    ? { ...state.query, ...currentDateRange(), cursor: undefined }
    : undefined;
  const refreshLists = editor.value?.kind === 'list';
  editor.value = undefined;
  if (refreshLists) void loadLists();
  if (
    reviewViewBeforeEditor &&
    props.section === 'stats' &&
    state.snapshot?.statistics.scope !== 'period'
  ) {
    model.acceptSnapshot(reviewViewBeforeEditor);
    void model.load({ ...state.query, cursor: undefined });
  }
  reviewViewBeforeEditor = undefined;
  // Mutation replies use a general working set. Restore the actual displayed calendar interval.
  if (
    calendarQuery &&
    closed &&
    ['timeBlock', 'calendarEvent', 'habit', 'anniversary'].includes(closed.kind)
  )
    await model.load(calendarQuery);
  if (
    linkedOccurrence &&
    linkedOccurrence === occurrenceId &&
    taskId &&
    detailOpen.value &&
    !creating.value
  ) {
    await model.ensureTask(taskId);
    if (
      props.section !== section ||
      state.selectedTaskId !== taskId ||
      state.selectedOccurrenceId !== occurrenceId
    )
      return;
    const value = model.draft();
    if (value && !model.dirty())
      taskSaved({
        taskId,
        title: value.task.title,
        listId: value.task.listId,
        planDates: value.blocks
          .filter((block) => !block.deletedAt)
          .map(
            (block) =>
              toDooDisplayTime(block.start, state.snapshot?.settings.timeZone || 'UTC').date,
          ),
      });
  }
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
  const value = model.draft();
  if (value?.task.id === id)
    taskSaved({
      taskId: id,
      title: value.task.title,
      listId: value.task.listId,
      planDates: value.blocks
        .filter((block) => !block.deletedAt)
        .map(
          (block) => toDooDisplayTime(block.start, state.snapshot?.settings.timeZone || 'UTC').date,
        ),
    });
  if (props.section === 'stats' && taskDestination.value)
    taskDestination.value.message = `已创建「${value?.task.title || '下一步任务'}」`;
  navigate(props.section, {
    ...props.selection,
    task: id,
    occurrence: model.state.selectedOccurrenceId || undefined,
  });
}
function hasUnsavedChanges() {
  return (
    state.busy ||
    !!outcomeRef.value?.hasUnsavedChanges() ||
    bulkOpen.value ||
    model.hasUnsavedChanges() ||
    !!detailRef.value?.hasUnsavedChanges() ||
    !!editorRef.value?.hasUnsavedChanges() ||
    !!settingsRef.value?.hasUnsavedChanges?.()
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
  if (!state.busy && !settingsRef.value?.hasUnsavedChanges?.()) return true;
  return requestLeave();
}
function finishLeave(answer: boolean) {
  leaving.value = false;
  if (answer) {
    if (props.section === 'settings') settingsVersion.value++;
    Object.keys(state.drafts).forEach(key => model.discardTaskDraft(key));
    for (const entry of retainedTaskDrafts.value)
      model.clearNewTaskDraft(entry.parentTaskId || undefined, entry.listId || '');
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
function hasNonRecoverableChanges() {
  return !!outcomeRef.value?.hasUnsavedChanges() || bulkOpen.value ||
    !!editorRef.value?.hasUnsavedChanges() || !!settingsRef.value?.hasUnsavedChanges?.() ||
    !!detailRef.value?.hasInvalidInput?.();
}
function keepDraftsAndLeave() {
  if (hasNonRecoverableChanges() || !model.flushRecovery()) return;
  leaving.value = false;
  leaveResolver?.(true);
  leaveResolver = undefined;
}
function openOutcomeNote() {
  if (model.dirty()) {
    state.error = '请先保存任务内容，再创建成果笔记';
    return;
  }
  const draft = model.draft();
  if (!draft?.occurrence) return;
  const retained = outcomeNote.value;
  const differentOccurrence = retained && retained.occurrence.id !== draft.occurrence.id;
  if (differentOccurrence && outcomeRef.value?.hasUnsavedChanges()) {
    const date = retained.occurrence.scheduledDate || retained.occurrence.due?.date;
    state.notice = `已保留「${retained.task.title}」${date ? '（' + date + '）' : ''}的成果草稿，请先继续处理。保存后仍关联这次行动。`;
    outcomeNoteOpen.value = true;
    return;
  }
  if (!retained || differentOccurrence)
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
  // The workspace host guards the return, including its note navigation context.
  if (props.hostedNavigation || (await requestLeave())) emit('back');
}
function beforeUnload(event: BeforeUnloadEvent) {
  const retained = model.flushRecovery();
  if (hasUnsavedChanges() && (hasNonRecoverableChanges() || !retained)) {
    event.preventDefault();
    event.returnValue = '';
  }
}
window.addEventListener('beforeunload', beforeUnload);
function reminderChanged(event?: Event) {
  if ((event as CustomEvent | undefined)?.detail?.workspaceAlreadyLoaded === true) return;
  if (!state.busy) void model.load();
}
window.addEventListener('dooknow-to-doo-changed', reminderChanged);
onBeforeUnmount(() => {
  window.removeEventListener('beforeunload', beforeUnload);
  window.removeEventListener('dooknow-to-doo-changed', reminderChanged);
  leaveResolver?.(false);
});
function currentDateRange(): Pick<ToDooQuery, 'from' | 'to'> {
  const today = toDooLocalDate(new Date(), state.snapshot?.settings.timeZone ?? 'UTC');
  const anchor = props.selection.date || today;
  if (props.section === 'calendar' || props.section === 'timeline')
    return toDooCalendarRange(
      anchor,
      props.section === 'timeline' ? 'timeline' : props.selection.calendarView || 'month',
      state.snapshot?.settings.weekStartsOn ?? 1,
    );
  return props.section === 'stats'
    ? reviewRange.value || { from: shiftToDooDate(today, -6), to: today }
    : {};
}
watch(
  () => [
    props.section,
    props.selection.date,
    props.selection.list,
    props.selection.calendarView,
    props.selection.taskFilter,
  ],
  async (_current, previous, onCleanup) => {
    let live = true;
    onCleanup(() => {
      live = false;
    });
    const initialRange = currentDateRange();
    if (!previous || previous[4] !== props.selection.taskFilter)
      state.filter = toDooQuickFilter(
        state.filter,
        quickView.value,
        toDooLocalDate(new Date(), state.snapshot?.settings.timeZone),
      );
    if (!previous || previous[2] !== props.selection.list)
      state.filter.listIds = props.selection.list ? [props.selection.list] : [];
    await model.load({
      view: props.section,
      listIds: quickView.value === 'inbox' ? ['inbox'] : undefined,
      ...initialRange,
      ...(props.section === 'notifications' ? { sort: 'recent' as const, raisedOnly: true } : {}),
      limit: 200,
      filter: [...taskSections, 'calendar', 'timeline'].includes(props.section)
        ? state.filter
        : undefined,
    });
    if (!live) return;
    const resolvedRange = currentDateRange();
    if (
      state.query.view === props.section &&
      state.query.from === initialRange.from &&
      state.query.to === initialRange.to &&
      (resolvedRange.from !== initialRange.from || resolvedRange.to !== initialRange.to)
    ) {
      await model.load({ ...state.query, ...resolvedRange, cursor: undefined });
      if (!live) return;
    }
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
      await selectLinkedTask(props.selection.task, props.selection.occurrence);
    }
  },
  { immediate: true },
);
watch(
  () => [props.selection.task, props.selection.occurrence] as const,
  async ([id, occurrenceId]) => {
    if (id) {
      await selectLinkedTask(id, occurrenceId);
      creating.value = false;
    } else if (!creating.value) detailOpen.value = false;
  },
);
defineExpose({ hasUnsavedChanges, requestLeave, requestSectionLeave });
</script>
<template>
  <AConfigProvider :theme="activeToDooTheme">
  <section
    ref="workspaceRef"
    class="to-doo-workspace"
    :class="{
      'todo-compact': density === 'compact',
      'todo-has-detail': detailOpen,
      'todo-detail-docked': detailOpen && !detailOverlay,
      'todo-navigation-condensed': condensedNavigation,
      'todo-hosted-navigation': hostedNavigation,
      'todo-task-page': section === 'tasks' || section === 'overview',
      'todo-task-overview-page': section === 'overview',
      'todo-page-calendar': section === 'calendar',
      'todo-page-timeline': section === 'timeline',
    }"
    aria-label="To Doo 行动工作空间"
  >
    <div class="todo-topbar">
      <div class="todo-topbar-brand" aria-label="To Doo">
        <span class="todo-app-mark"><ToDooIcon name="check" :size="16" /></span><span>To Doo</span>
      </div>
      <AButton
        type="text"
        class="todo-navigation-trigger"
        aria-label="功能导航"
        aria-haspopup="dialog"
        :aria-expanded="navigationOpen"
        @click="openNavigation"
        ><ToDooIcon name="menu" :size="18" /><span>菜单</span
        ><small v-if="unread">{{ unread }}</small></AButton
      >
      <span class="todo-spacer"></span>
      <AButton type="text" class="todo-return" aria-label="返回 DooKnow" @click="back">
        <ToDooIcon name="back" :size="17" /><span>返回笔记</span>
      </AButton>
      <APopover trigger="click" placement="bottomRight">
        <template #content
          ><div class="todo-ant-density">
            <AButton type="text" :disabled="state.loading || state.busy" @click="model.load()"
              >刷新内容</AButton
            >
          </div></template
        >
        <AButton type="text" size="small" aria-label="显示选项"><ToDooIcon name="more" /></AButton>
      </APopover>
    </div>
    <aside class="todo-sidebar" aria-label="To Doo 侧栏">
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
        :unread="unread"
        @navigate="chooseDestination"
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
      v-model:open="navigationOpen"
      placement="left"
      :width="288"
      :get-container="false"
      :root-style="{ position: 'fixed', inset: '0', zIndex: 1400 }"
      :z-index="1400"
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
          :unread="unread"
          @navigate="chooseDestination"
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
    <main class="todo-main" :aria-busy="state.loading">
      <div
        v-if="state.loading && state.snapshot"
        class="todo-refresh-progress"
        role="status"
        aria-label="正在刷新 To Doo…"
        aria-live="polite"
      >
        <span class="todo-loading-sr-only">正在载入…</span>
      </div>
      <div class="todo-page" :class="{ 'todo-page-matrix': section === 'matrix' }">
        <ToDooPageHeader :title="showTaskScope ? scopeTitle : title">
          <template
            v-if="
              taskSections.includes(section) ||
              [
                'calendar',
                'timeline',
                'focus',
                'habits',
                'anniversaries',
                'stats',
                'notifications',
                'settings',
              ].includes(section)
            "
            #actions
          >
            <AButton
              v-if="section === 'settings' && settingsRef?.activeTab === 'preferences'"
              type="primary"
              class="todo-button todo-primary"
              :disabled="state.loading || state.busy || !settingsRef?.dirty"
              :loading="state.busy"
              @click="settingsRef?.submitPreferences()"
              >保存偏好</AButton
            >
            <AButton
              v-if="section === 'overview'"
              type="primary"
              class="todo-button todo-primary"
              aria-label="新建目标"
              @click="edit('list', undefined, { kind: 'goal' })"
              >＋ 新建目标</AButton
            >
            <div
              v-if="
                ['tasks', 'board', 'matrix', 'calendar', 'timeline'].includes(section) &&
                !['done', 'archived', 'trash'].includes(quickView)
              "
              class="todo-task-create-actions"
              :class="{
                'todo-has-drafts': showTaskScope && (retainedTaskDrafts.length || retainedEdits.length || state.legacyRecoveryAvailable) && !creating,
              }"
            >
              <AButton
                type="primary"
                class="todo-button todo-primary"
                aria-label="新建任务"
                @click="createPageTask()"
                >＋ 新建任务</AButton
              >
              <ADropdown
                v-if="showTaskScope && (retainedTaskDrafts.length || retainedEdits.length || state.legacyRecoveryAvailable) && !creating"
                v-model:open="taskDraftsOpen"
                :trigger="['click']"
                placement="bottomRight"
                overlay-class-name="todo-ant-popup todo-task-drafts-popup"
              >
                <AButton
                  type="primary"
                  class="todo-button todo-primary todo-task-drafts-trigger"
                  aria-label="任务草稿"
                  title="任务草稿"
                  aria-haspopup="menu"
                  :aria-expanded="taskDraftsOpen"
                  ><ToDooIcon name="chevron" :size="14"
                /></AButton>
                <template #overlay>
                  <AMenu :selectable="false" aria-label="任务草稿">
                    <AMenuItem v-for="entry in retainedEdits" :key="'edit:' + entry.key" @click="continueTaskDraft(entry.key)">
                      <span class="todo-task-draft-title">{{ entry.title || '未命名任务' }}</span>
                      <span class="todo-task-draft-context">{{ entry.recovered ? '恢复的修改' : '未保存修改' }}</span>
                    </AMenuItem>
                    <AMenuItem
                      v-for="entry in retainedTaskDrafts"
                      :key="entry.key"
                      @click="continueNewDraft(entry.key)"
                    >
                      <span
                        class="todo-task-draft-title"
                        :title="entry.draft.title.trim() || '未命名任务'"
                        >{{ entry.draft.title.trim() || '未命名任务' }}</span
                      >
                      <span class="todo-task-draft-context"
                        >{{ entry.parentTaskId ? '子任务 · ' : ''
                        }}{{
                          entry.draft.listId
                            ? lists.find((list) => list.id === entry.draft.listId)?.name ||
                              '任务清单'
                            : '收集箱'
                        }}</span
                      >
                    </AMenuItem>
                    <AMenuItem key="manage-drafts" @click="draftManagerOpen = true">管理任务草稿…</AMenuItem>
                  </AMenu>
                </template>
              </ADropdown>
            </div>
            <div v-if="showTaskScope && section !== 'overview'" ref="taskToolbarTarget" class="todo-header-task-toolbar" />
            <AButton
              v-if="section === 'habits'"
              type="primary"
              class="todo-button todo-primary"
              @click="edit('habit', undefined, { listId: selection.list || null })"
              >＋ 新建习惯</AButton
            >
            <AButton
              v-if="section === 'anniversaries'"
              type="primary"
              class="todo-button todo-primary"
              @click="edit('anniversary')"
              >＋ 新建纪念日</AButton
            >
            <AButton
              v-if="section === 'stats'"
              type="primary"
              class="todo-button todo-primary"
              :disabled="
                state.loading ||
                state.busy ||
                state.snapshot?.statistics.scope !== 'period' ||
                !reviewRef?.createReview
              "
              @click="reviewRef?.createReview?.()"
              >＋ 写一篇复盘</AButton
            >
            <AButton
              v-if="section === 'notifications'"
              :disabled="
                state.loading ||
                state.busy ||
                !state.snapshot ||
                !!reviewRef?.actingReminder ||
                !reviewRef?.markAll
              "
              :loading="reviewRef?.markingAll"
              @click="reviewRef?.markAll?.()"
              >全部标为已读</AButton
            >
          </template>
        </ToDooPageHeader>
        <div v-if="showTaskScope && scopeFilters.length" class="todo-task-scope">
          <details v-if="scopeFilters.length" class="todo-scope-filters">
            <summary>筛选 {{ scopeFilters.length }} 项</summary>
            <ul>
              <li v-for="part in scopeFilters" :key="part">{{ part }}</li>
            </ul>
            <AButton type="link" @click="clearScopeFilters">清除筛选</AButton>
          </details>
        </div>

        <div v-if="state.error && !state.conflict" class="todo-error todo-alert" role="alert">
          {{ state.error
          }}<AButton html-type="button" class="todo-link" @click="state.error = ''" type="link"
            >关闭提示</AButton
          >
        </div>
        <div v-if="state.conflict && !detailOpen" class="todo-error todo-alert" role="alert">
          <span>这份任务有更新需要比较，本地修改仍保留。</span>
          <AButton type="link" @click="detailOpen = true">打开任务核对</AButton>
        </div>
        <div v-if="taskDestination" class="todo-action-feedback" role="status">
          <span>{{ taskDestination.message }}</span
          ><AButton type="link" @click="openTaskDestination">{{ taskDestination.label }}</AButton>
        </div>
        <div v-else-if="state.completionFeedback" class="todo-action-feedback todo-transient-feedback" role="status" @mouseenter="pauseCompletion" @mouseleave="resumeCompletion" @focusin="pauseCompletion" @focusout="resumeCompletion">
          <span>已完成「{{ state.completionFeedback.title }}」</span>
          <AButton
            v-if="state.completionFeedback.undoable"
            type="link"
            :disabled="state.busy"
            @click="model.undoCompletion()"
            >撤销</AButton
          >
          <AButton
            v-if="section !== 'tasks' || quickView !== 'done'"
            type="link"
            @click="chooseQuickView('done')"
            >查看已完成</AButton
          >
        </div>
        <p v-else-if="state.notice" class="todo-notice todo-transient-notice" role="status">{{ state.notice }}</p>
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
        <p v-if="state.recoveryStatus === 'unavailable'" class="todo-warning" role="alert">此浏览器暂时无法保存恢复记录，请保存任务后再离开。</p>
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
        <ToDooLoadingState v-if="state.loading && !state.snapshot" :section="section" embedded />
        <div v-if="!state.snapshot && !state.loading" class="todo-empty todo-panel">
          <p>暂时无法载入工作空间。</p>
          <AButton html-type="button" class="todo-button" @click="model.load()" type="default"
            >重新载入</AButton
          >
        </div>
        <div
          v-if="state.snapshot"
          class="todo-content"
          :class="{ 'todo-readable-list-content': section === 'tasks' }"
        >
          <KeepAlive
            ><ToDooTaskViews
              :toolbar-target="taskToolbarTarget"
              v-if="taskSections.includes(section)"
              :model="model"
              :tree="tree"
              :section="section"
              :quick-view="quickView"
              :scope-list-id="selection.list"
              :creating="creating"
              v-model:density="density"
              @quick-filter="chooseQuickView"
              @clear-filters="clearScopeFilters"
              @search-all="searchAllTasks"
              @task-created="taskSaved"
              @habits="openListHabits"
              @bulk="bulkOpen = true"
              @open="open"
              @create="create"
              @list="chooseList"
              @edit="edit"
              @navigate="changeTaskView" /><ToDooCalendar
              v-else-if="section === 'calendar' || section === 'timeline'"
              :key="'calendar:' + pageAttempts.calendar"
              :model="model"
              :date="selection.date"
              :view="selection.calendarView || 'month'"
              :timeline="section === 'timeline'"
              @open="open"
              @navigate="navigate(section, { ...selection, ...$event })"
              @task-view="changeTaskView"
              @create-task="createPageTask"
              @habits="chooseDestination('habits')"
              @edit="edit" /><ToDooRhythm
              v-else-if="section === 'focus' || section === 'habits' || section === 'anniversaries'"
              :key="'rhythm:' + pageAttempts.rhythm"
              :model="model"
              :section="section"
              :occurrence-id="focusOccurrence"
              :list-id="selection.list"
              :history-request="section === 'focus' ? focusHistoryRequest : habitHistoryRequest"
              :history-date="habitHistoryDate"
              :history-range="focusHistoryRange"
              :context="pageContext"
              @context-change="changePageContext"
              @edit="edit"
              @list="chooseList"
              @all-habits="chooseDestination('habits')"
              @task-context-consumed="focusOccurrence = ''"
              @task="selectTask" /><ToDooReview
              v-else-if="section === 'stats' || section === 'notifications'"
              :key="'review:' + pageAttempts.review"
              ref="reviewRef"
              :model="model"
              :section="section"
              :context="pageContext"
              @context-change="changePageContext"
              @edit="edit"
              @task="selectTask"
              @source="openReminderSource"
              @completed="chooseQuickView('done')"
              @history="openActivityHistory"
              @list="chooseList"
              @create-task="createPageTask"
              @navigate="chooseDestination" /><ToDooSettings
              v-else-if="section === 'settings'"
              :key="'settings-' + settingsVersion + ':' + pageAttempts.settings"
              ref="settingsRef"
              :model="model"
              :context="pageContext"
              @context-change="changePageContext"
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
          </ToDooDisclosure>
        </div>
      </div>
    </main>
    <nav class="todo-bottom-navigation" aria-label="To Doo 快捷导航">
      <AButton
        type="text"
        :aria-current="
          section === 'tasks' && !selection.list && quickView === 'today' ? 'page' : undefined
        "
        @click="chooseQuickView('today')"
      >
        <ToDooIcon name="today" :size="21" /><span>今天</span>
      </AButton>
      <AButton
        type="text"
        :aria-current="
          section === 'tasks' && !selection.list && quickView === 'inbox' ? 'page' : undefined
        "
        @click="chooseQuickView('inbox')"
      >
        <ToDooIcon name="inbox" :size="21" /><span>收集箱</span>
      </AButton>
      <AButton
        type="text"
        :aria-current="section === 'calendar' ? 'page' : undefined"
        @click="chooseDestination('calendar')"
      >
        <ToDooIcon name="calendar" :size="21" /><span>日历</span>
      </AButton>
      <AButton
        type="text"
        aria-label="打开导航菜单"
        aria-haspopup="dialog"
        :aria-expanded="navigationOpen"
        @click="openNavigation"
      >
        <ToDooIcon name="menu" :size="21" /><span>菜单</span>
      </AButton>
    </nav>
    <div
      v-if="detailOpen"
      ref="detailLayer"
      class="todo-detail-layer"
      :role="detailOverlay ? 'dialog' : undefined"
      :aria-modal="detailOverlay ? true : undefined"
      :aria-label="detailOverlay ? '任务编辑' : undefined"
      @keydown="detailKeydown"
    >
      <AButton
        html-type="button"
        class="todo-detail-scrim"
        aria-label="收起任务详情"
        @click="closeDetail"
        type="text"
      ></AButton
      ><ToDooTaskDetail
        :key="
          creating
            ? 'new-' + parentId + '@' + creatingListId
            : 'detail-' + state.selectedTaskId + '@' + state.selectedOccurrenceId
        "
        ref="detailRef"
        :model="model"
        :tree="tree"
        :creating="creating"
        :parent-task-id="parentId"
        :list-id="creating ? creatingListId : selection.list"
        :created-note-id="state.selectedTaskId === createdNoteTaskId ? createdNoteId : undefined"
        @close="closeDetail"
        @created="created"
        @list-created="loadLists()"
        @saved="taskSaved"
        @select="selectTask"
        @edit="edit"
        @open-note="emit('open-note', $event)"
        @child="create"
        @outcome-note="openOutcomeNote"
        @focus="
          focusOccurrence = $event || '';
          detailOpen = false;
          chooseDestination('focus');
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
    <AModal :open="draftManagerOpen" title="任务草稿" :footer="null" wrap-class-name="todo-ant-modal" @cancel="draftManagerOpen = false">
      <p class="todo-muted">草稿保留在此浏览器，点击保存任务后才会提交到服务器。</p>
      <div v-if="state.legacyRecoveryAvailable" class="todo-alert todo-warning" role="status">
        <span>发现旧版本地恢复记录，需确认账号归属后恢复。</span><AButton type="link" :disabled="state.busy" @click="recoverLegacyDrafts">检查并恢复</AButton>
      </div>
      <div v-for="entry in retainedEdits" :key="entry.key" class="todo-draft-manager-row">
        <span>{{ entry.title || '未命名任务' }}<small>{{ entry.recovered ? '恢复的修改' : '未保存修改' }}</small><small v-if="state.unavailableDrafts[entry.key]">{{ state.unavailableDrafts[entry.key] }}</small></span>
        <AButton @click="continueTaskDraft(entry.key)">继续编辑</AButton><AButton danger type="text" :disabled="state.busy || !!state.pendingMutation" @click="discardTaskDraft(entry.key)">放弃</AButton>
      </div>
      <div v-for="entry in retainedTaskDrafts" :key="entry.key" class="todo-draft-manager-row">
        <span>{{ entry.draft.title || '未命名任务' }}<small>新建草稿</small></span>
        <AButton @click="draftManagerOpen = false; continueNewDraft(entry.key)">继续编辑</AButton>
        <AButton danger type="text" :disabled="state.busy || !!state.pendingMutation" @click="discardNewTaskDraft(entry.key)">放弃</AButton>
      </div>
      <p v-if="!retainedEdits.length && !retainedTaskDrafts.length" class="todo-muted">没有未保存的任务草稿</p>
    </AModal>
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
      <p>尚有内容没有保存到服务器。</p>
      <div class="todo-ant-modal-actions">
        <AButton type="primary" @click="finishLeave(false)">继续编辑</AButton>
        <AButton v-if="!hasNonRecoverableChanges()" @click="keepDraftsAndLeave">保留草稿并离开</AButton>
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
  </AConfigProvider>
</template>
<style scoped>
.todo-transient-notice, .todo-transient-feedback {
  position: absolute;
  inset: auto 16px 16px auto;
  z-index: 20;
  max-width: min(440px, calc(100% - 32px));
  padding: 10px 16px;
  color: var(--todo-ink);
  background: var(--todo-paper);
  border: 1px solid var(--todo-line);
  border-radius: var(--todo-radius);
  box-shadow: var(--todo-shadow);
}
.todo-transient-notice { pointer-events: none; }
.todo-draft-manager-row { display: flex; align-items: center; gap: 8px; padding: 12px 0; border-bottom: 1px solid var(--todo-line); }
.todo-draft-manager-row > span { flex: 1; min-width: 0; overflow-wrap: anywhere; }
.todo-draft-manager-row small { display: block; color: var(--todo-muted); }
</style>
