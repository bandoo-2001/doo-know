<script setup lang="ts">
import {
  computed,
  nextTick,
  onActivated,
  onDeactivated,
  onUnmounted,
  reactive,
  ref,
  watch,
} from 'vue';
import { useEventListener, useIntervalFn, useMediaQuery } from '@vueuse/core';
import {
  Alert as AAlert,
  Button as AButton,
  Dropdown as ADropdown,
  Drawer as ADrawer,
  Empty as AEmpty,
  Input,
  InputNumber as AInputNumber,
  Menu as AMenu,
  Modal as AModal,
  Segmented as ASegmented,
  Statistic as AStatistic,
  Tag as ATag,
} from 'ant-design-vue';
import type {
  ToDooEntityKind,
  ToDooEntityMap,
  ToDooFocusHistory,
  ToDooFocusTrend,
  ToDooSnapshot,
} from '../../../../shared/to-doo-contracts';
import {
  focusElapsed,
  shiftToDooDate,
  toDooLocalDate,
  type ToDooWorkbench,
} from '../../to-doo-workbench';
import { reconcileFocusHistory, type FocusHistoryScan } from '../../to-doo-focus-history-sync';
import { useToDooConfirm } from '../../to-doo-controls';
import { guardToDooTaskAction } from '../../to-doo-action-guard';
import ToDooSelect from './ToDooSelect.vue';
import ToDooDateField from './ToDooDateField.vue';
import ToDooIcon from './ToDooIcon.vue';
import ToDooPageToolbar from './ToDooPageToolbar.vue';
import ToDooSectionHeader from './ToDooSectionHeader.vue';
import ToDooFocusTimerFields from './ToDooFocusTimerFields.vue';
import ToDooFocusTrendChart from './ToDooFocusTrend.vue';
import '../../to-doo-focus.css';

type Session = ToDooEntityMap['focusSession'];
type Topic = ToDooEntityMap['focusTopic'];
const ATextarea = Input.TextArea,
  AMenuItem = AMenu.Item;
const props = defineProps<{
  model: ToDooWorkbench;
  occurrenceId?: string;
  context?: string;
  contextualNavigation?: boolean;
  historyRequest?: number;
  historyRange?: { from: string; to: string };
  historySessionId?: string;
}>();
const emit = defineEmits<{
  edit: [kind: ToDooEntityKind, entity?: Record<string, any>, seed?: Record<string, any>];
  task: [id: string, occurrenceId?: string];
  'context-change': [value: string];
  'task-context-consumed': [];
}>();
const state = props.model.state,
  confirm = useToDooConfirm();
const focusRoot = ref<HTMLElement>();
function timerContainer() {
  return focusRoot.value!.closest<HTMLElement>('.to-doo-workspace') || focusRoot.value!;
}
const focusBusy = ref(false),
  localPane = ref<'projects' | 'history'>('projects');
const projectsSection = ref<HTMLElement>(),
  recordsSection = ref<HTMLElement>();
const mobilePane = computed({
  get: () =>
    props.context === undefined
      ? localPane.value
      : props.context === 'history'
        ? 'history'
        : 'projects',
  set: (value: 'projects' | 'history') => {
    localPane.value = value;
    emit('context-change', value);
  },
});
async function revealContext() {
  await nextTick();
  if (!props.contextualNavigation || narrowTimer.value) return;
  const target = mobilePane.value === 'history' ? recordsSection.value : projectsSection.value;
  target?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
}
let historyActionFocus: { origin: Element | null } | undefined;
function focusRequestedHistory(request: NonNullable<typeof historyActionFocus>) {
  if (historyActionFocus !== request) return;
  if (typeof document === 'undefined') {
    historyActionFocus = undefined;
    return;
  }
  const current = document.activeElement;
  // Keep a delayed navigation from stealing focus after the user has moved on.
  if (
    !visible.value ||
    (current !== request.origin &&
      current !== document.body &&
      !projectsSection.value?.contains(current))
  ) {
    historyActionFocus = undefined;
    return;
  }
  if (mobilePane.value !== 'history') return;
  historyActionFocus = undefined;
  recordsSection.value?.setAttribute?.('tabindex', '-1');
  recordsSection.value?.focus?.({ preventScroll: true });
}
async function showHistoryFromAction() {
  const request = (historyActionFocus =
    typeof document === 'undefined' ? undefined : { origin: document.activeElement });
  mobilePane.value = 'history';
  await nextTick();
  // Dropdown items are portalled outside the pane being left. A successful
  // controlled context may be acknowledged after this first render tick.
  if (request) focusRequestedHistory(request);
  if (mobilePane.value === 'history') await revealContext();
}
watch(
  () => props.context,
  async (_context, previous) => {
    const leaving = previous === 'history' ? recordsSection.value : projectsSection.value;
    const moveFocus = typeof document !== 'undefined' && leaving?.contains?.(document.activeElement);
    const actionRequest = historyActionFocus;
    await nextTick();
    if (actionRequest) focusRequestedHistory(actionRequest);
    else if (moveFocus) {
      const target = mobilePane.value === 'history' ? recordsSection.value : projectsSection.value;
      target?.setAttribute?.('tabindex', '-1');
      target?.focus?.({ preventScroll: true });
    }
    await revealContext();
  },
);
onActivated(revealContext);
const history = ref<ToDooFocusHistory>(),
  loading = ref(false),
  error = ref('');
const historyScroller = ref<HTMLElement>(),
  loadingMore = ref(false),
  pageError = ref('');
const narrowTimer = useMediaQuery('(max-width: 600px)'),
  wideFocus = useMediaQuery('(min-width: 1600px)'),
  timerSettings = ref(false);
watch(narrowTimer, (narrow) => {
  if (!narrow) timerSettings.value = false;
});
const archived = ref('active'),
  selectedTopic = ref(''),
  topicFilter = ref(''),
  period = ref('all');
const showTrend = ref(false),
  trendPeriod = ref<ToDooFocusTrend['period']>('week'),
  trendDate = ref('');
const from = ref(''),
  to = ref(''),
  mode = ref<'pomodoro' | 'stopwatch' | 'break'>('pomodoro');
const sourceSessionId = ref('');
const target = ref<number | ''>(state.snapshot?.settings.focusMinutes || 25),
  chosen = ref(props.occurrenceId || '');
const tick = ref(Date.now()),
  clockOffset = ref(0),
  notes = reactive<Record<string, string>>(Object.create(null));
const noteBaselines: Record<string, string> = Object.create(null);
const noteConflict = ref<{
  session: Session;
  submitted: string;
  draftKey: string;
  finish?: boolean;
}>();
let activityEpoch = 0;
const focusDataset = () => state.snapshot?.datasetId ?? history.value?.datasetId;
const draftKey = (id: string) => JSON.stringify([focusDataset() ?? null, id]);
const draftIsCurrent = (key: string) => JSON.parse(key)[0] === (focusDataset() ?? null);
const draftSessionId = (key: string): string => JSON.parse(key)[1];
const sessionNote = (session: Session) => notes[draftKey(session.id)] ?? session.note;
function captureFocusContext() {
  const generation = activityEpoch,
    datasetId = focusDataset();
  return () => visible.value && activityEpoch === generation && focusDataset() === datasetId;
}
let epoch = 0;
let loadedScope = '',
  loadedQuery = '';
const syncing = ref(false),
  pendingScan = ref<FocusHistoryScan>();
function recordScope() {
  return JSON.stringify({
    topic: topicFilter.value,
    from: from.value,
    to: to.value,
    source: sourceSessionId.value,
  });
}
const visible = ref(false);
const clock = useIntervalFn(() => (tick.value = Date.now()), 1000, { immediate: false });
const polling = useIntervalFn(
  () => {
    if (typeof document === 'undefined' || document.visibilityState === 'visible')
      void load(false, true);
  },
  10000,
  { immediate: false },
);
useEventListener(
  () => (visible.value && typeof document !== 'undefined' ? document : undefined),
  'visibilitychange',
  wake,
);
const active = computed(() => history.value?.active ?? null);
const startUnavailable = computed(
  () =>
    !history.value ||
    !!active.value ||
    state.busy ||
    focusBusy.value ||
    !!state.pendingMutation ||
    (loading.value && !syncing.value),
);
const finishedTaskSession = ref<Session>();
function consumeTaskContext() {
  if (!props.occurrenceId) return;
  if (!active.value) chosen.value = props.occurrenceId;
  mobilePane.value = 'projects';
  finishedTaskSession.value = undefined;
  emit('task-context-consumed');
}
function freeFocus() {
  if (active.value) return;
  selectedTopic.value = '';
  chosen.value = '';
  finishedTaskSession.value = undefined;
  emit('task-context-consumed');
}
async function sessionTask(session: Session) {
  if (!session.occurrenceId) return;
  const params = new URLSearchParams({
    kind: 'occurrence',
    ids: session.occurrenceId,
    filter: JSON.stringify({ includeArchived: true }),
    limit: '1',
  });
  const response = (await props.model.request('/api/to-doo/state?' + params)) as ToDooSnapshot;
  const occurrence = response.occurrences.find(
    (row) => row.id === session.occurrenceId && !row.deletedAt,
  );
  if (!occurrence) throw Error('关联任务暂不可用，请在所有任务或回收站核对。');
  return occurrence;
}
async function viewSessionTask(session: Session) {
  if (state.busy || focusBusy.value) return;
  const current = captureFocusContext(),
    occurrenceId = session.occurrenceId;
  focusBusy.value = true;
  try {
    const occurrence = await sessionTask(session);
    if (occurrence && current() && session.occurrenceId === occurrenceId)
      emit('task', occurrence.taskId, occurrence.id);
  } catch (cause) {
    if (current()) state.error = cause instanceof Error ? cause.message : String(cause);
  } finally {
    focusBusy.value = false;
  }
}
async function completeSessionTask(session: Session) {
  if (state.busy || focusBusy.value) return;
  const sessionId = session.id,
    occurrenceId = session.occurrenceId,
    datasetId = state.snapshot?.datasetId;
  const current = () =>
    visible.value &&
    state.snapshot?.datasetId === datasetId &&
    session.id === sessionId &&
    session.occurrenceId === occurrenceId &&
    finishedTaskSession.value?.id === sessionId &&
    finishedTaskSession.value?.occurrenceId === occurrenceId;
  if (!current()) return;
  focusBusy.value = true;
  try {
    const occurrence = await sessionTask(session);
    if (!occurrence || !current()) return;
    if (occurrence.status === 'done') {
      finishedTaskSession.value = undefined;
      state.notice = '这项任务已经完成';
      return;
    }
    await props.model.ensureTask(occurrence.taskId);
    if (
      !current() ||
      !(await guardToDooTaskAction(props.model, [occurrence.taskId], confirm, {
        includeDescendants: true,
        current,
      }))
    )
      return;
    const count = await props.model.statusChildCount(occurrence.taskId);
    if (count === null || !current()) return;
    if (count && !(await confirm(`这个任务有 ${count} 个子任务，是否一并完成？`))) return;
    if (!current()) return;
    const result = await props.model.setStatus(occurrence.id, 'done', count > 0);
    if (result && current()) finishedTaskSession.value = undefined;
  } catch (cause) {
    state.error = cause instanceof Error ? cause.message : String(cause);
  } finally {
    focusBusy.value = false;
  }
}
function editActiveNote(value: string) {
  const session = active.value;
  if (!session) return;
  const key = draftKey(session.id);
  if (!Object.hasOwn(noteBaselines, key)) noteBaselines[key] = session.note;
  if (value === noteBaselines[key]) {
    delete notes[key];
    delete noteBaselines[key];
  } else notes[key] = value;
}
const now = computed(() => tick.value + clockOffset.value);
const topicEntities = ref<Topic[]>([]),
  topicCursor = ref<string | null>(null),
  topicLoading = ref(false),
  topicError = ref('');
let topicEpoch = 0;
const allTopics = computed(() => topicEntities.value.filter((topic) => !topic.deletedAt));
const topics = computed(() =>
  allTopics.value.filter((topic) => !!topic.archivedAt === (archived.value === 'archived')),
);
const selected = computed(() => allTopics.value.find((topic) => topic.id === selectedTopic.value));
const totals = computed(() => history.value?.overview);
const nextBreak = computed(
  () =>
    totals.value?.nextBreak ?? {
      kind: 'short' as const,
      minutes: state.snapshot?.settings.shortBreakMinutes ?? 5,
    },
);
const customTarget = ref(false);
watch(mode, () => {
  customTarget.value = false;
});
watch(nextBreak, (value) => {
  if (!active.value && mode.value === 'break' && !customTarget.value) target.value = value.minutes;
});
const timerSummary = computed(() => {
  const value = active.value,
    timerMode = value?.mode ?? mode.value,
    minutes = value ? value.targetMinutes : target.value;
  return (
    { pomodoro: '番茄钟', stopwatch: '正计时', break: '休息' }[timerMode] +
    (timerMode !== 'stopwatch' && minutes !== null && minutes !== '' ? ` · ${minutes} 分钟` : '')
  );
});
const linkedAction = computed(() =>
  active.value
    ? active.value.taskTitle ||
      (active.value.occurrenceId
        ? taskOptions.value.find((option) => option.value === active.value?.occurrenceId)?.label ||
          ''
        : '')
    : chosen.value
      ? taskOptions.value.find((option) => option.value === chosen.value)?.label || ''
      : '',
);
const items = computed(() => history.value?.items ?? []);
const today = computed(() =>
  toDooLocalDate(new Date(now.value), history.value?.timeZone ?? state.snapshot?.settings.timeZone),
);
const topicOptions = computed(() => [
  { value: '', label: '全部项目' },
  { value: ':unassigned:', label: '未关联项目' },
  ...allTopics.value.map((topic) => ({
    value: topic.id,
    label: topic.name + (topic.archivedAt ? '（已归档）' : ''),
  })),
  ...(topicFilter.value &&
  topicFilter.value !== ':unassigned:' &&
  !allTopics.value.some((topic) => topic.id === topicFilter.value)
    ? [
        {
          value: topicFilter.value,
          label:
            (items.value.find((session) => session.topicId === topicFilter.value)?.topicName ||
              '原项目') + '（已移除）',
        },
      ]
    : []),
]);
const taskOptions = computed(() => [
  { value: '', label: '不关联任务' },
  ...(state.snapshot?.occurrences ?? [])
    .filter((row) => !row.deletedAt && !['done', 'cancelled', 'skipped'].includes(row.status))
    .flatMap((row) => {
      const task = state.snapshot?.tasks.find((task) => task.id === row.taskId && !task.deletedAt);
      const list = task?.listId
        ? props.model.taskLists().find((list) => list.id === task.listId)
        : undefined;
      return task && !task.archivedAt
        ? [
            {
              value: row.id,
              label:
                (row.titleOverride || task.title) +
                (list ? ' · ' + list.name : '') +
                (task.recurrence && row.scheduledDate ? ' · ' + row.scheduledDate : ''),
            },
          ]
        : [];
    }),
]);
const elapsed = computed(() => (active.value ? focusElapsed(active.value, now.value) : 0));
// A countdown shows the remaining share. An open-ended stopwatch has no percentage.
const dialRemaining = computed(() => {
  if ((active.value?.mode ?? mode.value) === 'stopwatch') return null;
  const minutes = Number(active.value ? active.value.targetMinutes : target.value);
  if (!(minutes > 0)) return 0;
  return Math.max(0, Math.min(100, 100 * (1 - elapsed.value / (minutes * 60))));
});
const display = computed(() => {
  const seconds = active.value
    ? active.value.targetMinutes === null
      ? elapsed.value
      : Math.max(0, active.value.targetMinutes * 60 - elapsed.value)
    : mode.value === 'stopwatch'
      ? 0
      : Number(target.value || 0) * 60;
  return (
    Math.floor(seconds / 60)
      .toString()
      .padStart(2, '0') +
    ':' +
    Math.floor(seconds % 60)
      .toString()
      .padStart(2, '0')
  );
});
const statusLabel = (status: Session['status']) =>
  ({
    running: '进行中',
    paused: '已暂停',
    finished: '已完成',
    cancelled: '已取消',
    interrupted: '已中断',
  })[status];
const sessionName = (session: Session) =>
  session.topicName ||
  allTopics.value.find((topic) => topic.id === session.topicId)?.name ||
  session.taskTitle ||
  (session.occurrenceId ? '历史任务专注' : '自由专注');
const duration = (minutes = 0) => {
  const rounded = Math.max(0, Math.round(minutes));
  return rounded >= 60
    ? `${Math.floor(rounded / 60)} 小时${rounded % 60 ? ' ' + (rounded % 60) + ' 分' : ''}`
    : `${rounded} 分钟`;
};
const dateOf = (session: Session) =>
  toDooLocalDate(
    new Date(session.segments[0]?.start ?? session.createdAt),
    history.value?.timeZone,
  );
const groups = computed(() => {
  const grouped = new Map<string, Session[]>();
  for (const session of items.value) {
    const date = dateOf(session),
      rows = grouped.get(date) ?? [];
    rows.push(session);
    grouped.set(date, rows);
  }
  return [...grouped].map(([date, sessions]) => ({ date, sessions }));
});
function timeRange(session: Session) {
  const start = session.segments[0]?.start ?? session.createdAt,
    end = session.segments.at(-1)?.end;
  const format = (value: string) =>
    new Intl.DateTimeFormat('zh-CN', {
      timeZone: history.value?.timeZone,
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    }).format(new Date(value));
  return (
    format(start) +
    (end
      ? ' — ' +
        (toDooLocalDate(new Date(end), history.value?.timeZone) !== dateOf(session)
          ? toDooLocalDate(new Date(end), history.value?.timeZone) + ' '
          : '') +
        format(end)
      : '')
  );
}
function query() {
  return {
    ids: sourceSessionId.value || undefined,
    topicId:
      topicFilter.value && topicFilter.value !== ':unassigned:' ? topicFilter.value : undefined,
    unassigned: topicFilter.value === ':unassigned:' || undefined,
    from: from.value || undefined,
    to: to.value || undefined,
    trendPeriod: showTrend.value ? trendPeriod.value : undefined,
    trendDate: showTrend.value ? trendDate.value || undefined : undefined,
    limit: 50,
  };
}
async function loadTopics(append = false) {
  const token = ++topicEpoch,
    datasetId = state.snapshot?.datasetId;
  const current = () => token === topicEpoch && datasetId === state.snapshot?.datasetId;
  topicLoading.value = true;
  const params = new URLSearchParams({
    kind: 'focusTopic',
    limit: '200',
    filter: JSON.stringify({ includeArchived: true }),
  });
  if (append && topicCursor.value) params.set('cursor', topicCursor.value);
  try {
    const response = await props.model.request('/api/to-doo/state?' + params);
    if (!current()) return;
    let entries = append
      ? [
          ...new Map(
            [...topicEntities.value, ...response.focusTopics].map((topic: Topic) => [
              topic.id,
              topic,
            ]),
          ).values(),
        ]
      : response.focusTopics;
    // Timer and history project choices may live on later pages. Verify them
    // before replacing the catalogue head, without changing the user's scope.
    const selectedId = selectedTopic.value;
    const missingIds = [...new Set([selectedId, topicFilter.value])].filter(
      (id) =>
        id &&
        id !== ':unassigned:' &&
        !entries.some((topic: Topic) => topic.id === id && !topic.deletedAt),
    );
    if (missingIds.length) {
      const selectedResponse = await props.model.request(
        '/api/to-doo/state?' +
          new URLSearchParams({
            kind: 'focusTopic',
            ids: missingIds.join(','),
            limit: String(missingIds.length),
            filter: JSON.stringify({ includeArchived: true }),
          }),
      );
      if (!current()) return;
      const existing = selectedResponse.focusTopics.filter(
        (topic: Topic) => missingIds.includes(topic.id) && !topic.deletedAt,
      );
      entries = [...entries, ...existing];
      if (
        selectedId &&
        selectedTopic.value === selectedId &&
        !entries.some((topic: Topic) => topic.id === selectedId && !topic.deletedAt)
      )
        selectedTopic.value = '';
    }
    if (!current()) return;
    topicEntities.value = entries;
    topicCursor.value = response.page.nextCursor;
    topicError.value = '';
  } catch (cause) {
    if (current()) topicError.value = cause instanceof Error ? cause.message : String(cause);
  } finally {
    if (token === topicEpoch) topicLoading.value = false;
  }
}
async function load(append = false, activityOnly = false) {
  if (append && (loading.value || loadingMore.value || !history.value?.page.nextCursor)) return;
  if (
    activityOnly &&
    (loading.value || loadingMore.value || syncing.value || focusBusy.value || state.busy)
  )
    return;
  if (from.value && to.value && from.value > to.value) {
    error.value = '结束日期不能早于开始日期';
    return;
  }
  const token = activityOnly ? epoch : ++epoch,
    selection = JSON.stringify(query()),
    scope = recordScope(),
    dataset = state.snapshot?.datasetId;
  if (activityOnly) syncing.value = true;
  const current = () =>
    token === epoch &&
    selection === JSON.stringify(query()) &&
    dataset === state.snapshot?.datasetId;
  if (append) {
    loadingMore.value = true;
    pageError.value = '';
  } else if (!activityOnly) {
    loading.value = true;
    loadingMore.value = false;
    pageError.value = '';
  }
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query()))
    if (value !== undefined) params.set(key, String(value));
  if (append && history.value?.page.nextCursor) params.set('cursor', history.value.page.nextCursor);
  try {
    const response = (await props.model.request(
      '/api/to-doo/focus/history?' + params,
    )) as ToDooFocusHistory;
    if (!current() || (dataset && response.datasetId !== dataset)) return;
    const old = history.value,
      scopeChanged = loadedScope !== scope;
    if (narrowTimer.value && old?.active && !response.active) mobilePane.value = 'history';
    if (activityOnly && old && Date.parse(response.now) < Date.parse(old.now)) return;
    clockOffset.value = Date.parse(response.now) - Date.now();
    tick.value = Date.now();
    if (!append && old && loadedScope === scope && old.datasetId === response.datasetId) {
      // Timer controls use the fresh head immediately; slower pages reconcile history separately.
      syncing.value = true;
      history.value = {
        ...old,
        active: response.active,
        overview: response.overview,
        trend: response.trend,
        now: response.now,
      };
      const result = await reconcileFocusHistory(
        old,
        response,
        async (cursor) => {
          if (!current()) throw new Error('专注范围已切换');
          const next = new URLSearchParams(params);
          next.set('cursor', cursor);
          const page = (await props.model.request(
            '/api/to-doo/focus/history?' + next,
          )) as ToDooFocusHistory;
          if (!current()) throw new Error('专注范围已切换');
          return page;
        },
        pendingScan.value,
        20,
        loadedQuery !== selection,
      );
      if (!current()) return;
      history.value = result.history;
      pendingScan.value = result.pending;
    } else {
      history.value = {
        ...response,
        items:
          append && old?.datasetId === response.datasetId
            ? [...new Map([...old.items, ...response.items].map((row) => [row.id, row])).values()]
            : response.items,
      };
      pendingScan.value = undefined;
    }
    loadedScope = scope;
    loadedQuery = selection;
    error.value = '';
    if (!append && !activityOnly && scopeChanged) {
      await nextTick();
      if (token === epoch && historyScroller.value) historyScroller.value.scrollTop = 0;
    }
  } catch (cause) {
    if (current()) {
      const message = cause instanceof Error ? cause.message : String(cause);
      if (append) pageError.value = message;
      else error.value = message;
    }
  } finally {
    if (token === epoch) syncing.value = false;
    if (!activityOnly && token === epoch) {
      if (append) loadingMore.value = false;
      else loading.value = false;
    }
  }
}
function loadNearHistoryEnd() {
  const element = historyScroller.value;
  if (
    !visible.value ||
    !element ||
    !element.clientHeight ||
    mobilePane.value !== 'history' ||
    loading.value ||
    loadingMore.value ||
    pageError.value ||
    error.value ||
    !!pendingScan.value ||
    !history.value?.page.hasMore
  )
    return;
  if (element.scrollHeight - element.scrollTop - element.clientHeight <= 48) void load(true);
}
function activate() {
  if (visible.value) return;
  activityEpoch++;
  visible.value = true;
  tick.value = Date.now();
  if (!props.occurrenceId) chosen.value = '';
  consumeTaskContext();
  void load();
  void loadTopics();
  void revealRequestedHistory();
  clock.resume();
  polling.resume();
}
function deactivate() {
  activityEpoch++;
  visible.value = false;
  historyActionFocus = undefined;
  timerSettings.value = false;
  if (!active.value) chosen.value = '';
  finishedTaskSession.value = undefined;
  topicEpoch++;
  epoch++;
  loading.value = false;
  loadingMore.value = false;
  clock.pause();
  polling.pause();
}
function wake() {
  if (visible.value && document.visibilityState === 'visible') {
    tick.value = Date.now();
    void load(false, true);
  }
}
onActivated(activate);
onDeactivated(deactivate);
onUnmounted(() => {
  deactivate();
  delete state.externalDirty.focus;
});
watch(notes, () => (state.externalDirty.focus = Object.keys(notes).length > 0), {
  deep: true,
});
watch(
  () => [state.snapshot?.datasetId, state.snapshot?.version] as const,
  (current, previous) => {
    if (current[0] !== previous?.[0]) {
      activityEpoch++;
      epoch++;
      topicEpoch++;
      selectedTopic.value = '';
      chosen.value = '';
      topicFilter.value = '';
      sourceSessionId.value = '';
      from.value = '';
      to.value = '';
      period.value = 'all';
      showTrend.value = false;
      history.value = undefined;
      topicEntities.value = [];
      loadedScope = '';
      loadedQuery = '';
      pendingScan.value = undefined;
      finishedTaskSession.value = undefined;
    }
    if (visible.value) {
      void load();
      void loadTopics();
    }
  },
);
watch([topicFilter, showTrend, trendPeriod, trendDate], () => {
  if (visible.value) void load();
});
watch(
  () => props.occurrenceId,
  () => consumeTaskContext(),
);
let latestHistoryRequest = 0;
let historyScrollPending = false;
async function revealRequestedHistory() {
  if (!visible.value || !historyScrollPending) return;
  await nextTick();
  if (!visible.value) return;
  if (!narrowTimer.value)
    focusRoot.value
      ?.querySelector<HTMLElement>('.todo-focus-records')
      ?.scrollIntoView({ block: 'start' });
  historyScrollPending = false;
}
watch(
  () => props.historyRequest,
  (request) => {
    if (!request || request <= latestHistoryRequest) return;
    latestHistoryRequest = request;
    mobilePane.value = 'history';
    topicFilter.value = '';
    sourceSessionId.value = props.historySessionId || '';
    period.value = props.historyRange ? 'custom' : 'all';
    from.value = props.historyRange?.from || '';
    to.value = props.historyRange?.to || '';
    showTrend.value = false;
    historyScrollPending = true;
    if (visible.value) {
      void load();
      void revealRequestedHistory();
    }
  },
  { immediate: true },
);
function chooseTopic(topic: Topic) {
  if (!active.value) selectedTopic.value = topic.id;
}
function viewTopicHistory(topic: Topic) {
  sourceSessionId.value = '';
  topicFilter.value = topic.id;
  void showHistoryFromAction();
}
function openTrend(topic: Topic) {
  viewTopicHistory(topic);
  showTrend.value = true;
}
function changeTrend(value: { period: ToDooFocusTrend['period']; date: string }) {
  trendPeriod.value = value.period;
  trendDate.value = value.date;
}
function periodChanged(value: string | number) {
  period.value = String(value);
  if (value === 'custom') return;
  sourceSessionId.value = '';
  from.value =
    value === 'today' ? today.value : value === 'week' ? shiftToDooDate(today.value, -6) : '';
  to.value = value === 'all' ? '' : today.value;
  void load();
}
function clearSourceSession() {
  if (!sourceSessionId.value) return;
  sourceSessionId.value = '';
  topicFilter.value = '';
  period.value = 'all';
  from.value = '';
  to.value = '';
  void load();
}
function applyHistoryDates() {
  sourceSessionId.value = '';
  void load();
}
function changeHistoryTopic(value: unknown) {
  const next = value == null ? '' : String(value);
  const changed = topicFilter.value !== next;
  const hadSource = !!sourceSessionId.value;
  sourceSessionId.value = '';
  topicFilter.value = next;
  if (hadSource && !changed) void load();
}
function viewAllHistory() {
  const changed = topicFilter.value !== '';
  const hadSource = !!sourceSessionId.value;
  sourceSessionId.value = '';
  topicFilter.value = '';
  void showHistoryFromAction();
  if (hadSource && !changed) void load();
}
async function start(topic?: Topic) {
  if (startUnavailable.value || (topic && (topic.archivedAt || mode.value === 'break'))) return;
  if (mode.value === 'break' && target.value === 0) {
    mode.value = 'pomodoro';
    target.value = state.snapshot?.settings.focusMinutes ?? 25;
    state.notice = '已跳过休息';
    return;
  }
  const project = topic ?? selected.value;
  if (project?.archivedAt) {
    state.error = '请先恢复已归档的专注项目';
    return;
  }
  if (
    mode.value !== 'stopwatch' &&
    (target.value === '' ||
      !Number.isFinite(target.value) ||
      target.value < 1 ||
      target.value > 1440)
  ) {
    state.error = '请输入 1 到 1440 分钟的专注时长';
    return;
  }
  const occurrence = state.snapshot?.occurrences.find((row) => row.id === chosen.value),
    task = state.snapshot?.tasks.find((row) => row.id === occurrence?.taskId);
  const current = captureFocusContext();
  if (!current()) return;
  focusBusy.value = true;
  try {
    const result = await props.model.execute(
      {
        action: 'start_focus',
        payload: {
          mode: mode.value,
          targetMinutes: mode.value === 'stopwatch' ? null : Number(target.value),
          topicId: topic?.id ?? (selectedTopic.value || null),
          ...(topic ? { requireIdle: true } : {}),
          occurrenceId: chosen.value || null,
          listId: task ? task.listId : (project?.listId ?? null),
        },
      },
      '专注已开始',
    );
    if (result && current()) {
      if (topic) selectedTopic.value = topic.id;
      finishedTaskSession.value = undefined;
    }
    if (current()) await load();
  } finally {
    focusBusy.value = false;
  }
}
async function control(
  operation: 'pause' | 'resume' | 'finish' | 'cancel' | 'takeover',
  session = active.value,
) {
  if (!session || state.busy || focusBusy.value) return;
  if (operation === 'resume' && session.correctedMinutes !== null) {
    state.error = '这条记录已修正，请保留记录并开始新的专注。';
    return;
  }
  const context = captureFocusContext(),
    datasetId = focusDataset();
  const key = draftKey(session.id),
    wasActive = active.value?.id === session.id;
  const id = session.id,
    revision = session.revision;
  const current = () => {
    const latest = wasActive ? active.value : items.value.find((row) => row.id === id);
    return (
      context() &&
      history.value?.datasetId === datasetId &&
      latest?.id === id &&
      latest.revision === revision
    );
  };
  if (!current()) return;
  const submittedNote = notes[key] ?? session.note;
  if (
    operation === 'finish' &&
    Object.hasOwn(notes, key) &&
    session.note !== noteBaselines[key] &&
    session.note !== submittedNote
  ) {
    noteConflict.value = { session, submitted: submittedNote, draftKey: key, finish: true };
    return;
  }
  if (
    operation === 'cancel' &&
    !(await confirm('取消后不计入专注统计，已有时间片段仍可回看。', { title: '取消本次专注' }))
  )
    return;
  if (!current() || state.busy || focusBusy.value) return;
  focusBusy.value = true;
  try {
    const result = await props.model.execute(
      {
        action: 'control_focus',
        payload: {
          id: session.id,
          expectedRevision: session.revision,
          operation,
          ...(operation === 'finish' ? { note: submittedNote } : {}),
        },
      },
      operation === 'finish' ? '本次专注已保存' : '专注状态已保存',
    );
    if (result && context() && operation === 'finish') {
      finishedTaskSession.value = session.occurrenceId ? { ...session } : undefined;
      chosen.value = '';
      if (notes[key] === submittedNote) {
        delete notes[key];
        delete noteBaselines[key];
      } else if (Object.hasOwn(notes, key)) noteBaselines[key] = submittedNote;
    }
    if (result && context() && operation === 'cancel') chosen.value = '';
    if (context()) await load();
  } finally {
    focusBusy.value = false;
  }
}
async function archiveTopic(topic: Topic) {
  if (state.busy || focusBusy.value) return;
  const current = captureFocusContext();
  if (!current()) return;
  focusBusy.value = true;
  try {
    const result = await props.model.saveEntity(
      'focusTopic',
      { ...topic, archivedAt: topic.archivedAt ? null : new Date(now.value).toISOString() },
      topic.revision,
    );
    if (result && current()) {
      await loadTopics();
      if (current()) await load();
    }
  } finally {
    focusBusy.value = false;
  }
}
const correction = ref<Session>(),
  correctedMinutes = ref<number | ''>(''),
  correctionError = ref('');
const correctionContext = ref<() => boolean>();
let correctionEpoch = 0;
const correctionCurrent = computed(() => !correction.value || !!correctionContext.value?.());
function closeHistoryActions(event?: Event) {
  const details = (event?.currentTarget as HTMLElement | undefined)?.closest('details');
  details?.removeAttribute('open');
  details?.querySelector('summary')?.focus();
}
function correct(session: Session) {
  if (state.busy || focusBusy.value || ['running', 'paused'].includes(session.status)) return;
  const context = captureFocusContext();
  if (!context()) return;
  const token = ++correctionEpoch,
    id = session.id,
    revision = session.revision;
  correction.value = session;
  correctionContext.value = () =>
    context() &&
    token === correctionEpoch &&
    correction.value?.id === id &&
    correction.value.revision === revision;
  correctedMinutes.value = Math.round(focusElapsed(session, now.value) / 60);
  correctionError.value = '';
}
function closeCorrection() {
  if (state.busy || focusBusy.value) return;
  correctionEpoch++;
  correction.value = undefined;
  correctionContext.value = undefined;
  correctionError.value = '';
}
async function saveCorrection() {
  const session = correction.value;
  if (!session || state.busy || focusBusy.value) return;
  const current = correctionContext.value;
  if (!current?.()) {
    correctionError.value = '记录范围已变化，请重新打开修正。当前输入仍保留。';
    return;
  }
  if (
    correctedMinutes.value === '' ||
    !Number.isFinite(correctedMinutes.value) ||
    correctedMinutes.value < 0 ||
    correctedMinutes.value > 525600
  ) {
    correctionError.value = '请输入有效的非负分钟数';
    return;
  }
  correctionError.value = '';
  focusBusy.value = true;
  try {
    const result = await props.model.execute(
      {
        action: 'control_focus',
        payload: {
          id: session.id,
          expectedRevision: session.revision,
          operation: 'correct',
          correctedMinutes: correctedMinutes.value,
        },
      },
      '实际专注时间已修正',
    );
    if (result && current()) {
      correctionEpoch++;
      correction.value = undefined;
      correctionContext.value = undefined;
      await load();
    }
  } finally {
    focusBusy.value = false;
  }
}
async function persistNote(
  session: Session,
  note: string,
  submitted: string,
  key: string,
  finish: boolean,
  current: () => boolean,
) {
  if (!current() || !draftIsCurrent(key)) return false;
  const result = finish
    ? await props.model.execute(
        {
          action: 'control_focus',
          payload: {
            id: session.id,
            expectedRevision: session.revision,
            operation: 'finish',
            note,
          },
        },
        '本次专注已保存',
      )
    : await props.model.saveEntity('focusSession', { ...session, note }, session.revision);
  if (!result || !current() || !draftIsCurrent(key)) return false;
  if (finish) {
    finishedTaskSession.value = session.occurrenceId ? { ...session } : undefined;
    chosen.value = '';
  }
  if (notes[key] === submitted) {
    delete notes[key];
    delete noteBaselines[key];
  } else if (Object.hasOwn(notes, key)) noteBaselines[key] = note;
  await load();
  return true;
}
async function readNoteSession(id: string, current: () => boolean): Promise<Session | undefined> {
  const datasetId = focusDataset();
  const response = await props.model.request(
    '/api/to-doo/state?kind=focusSession&ids=' + encodeURIComponent(id),
  );
  if (!current()) return;
  if (response.datasetId && datasetId && response.datasetId !== datasetId)
    throw Error('数据已变化，输入仍已保留，请重新核对记录。');
  const session = (response.focusSessions || []).find(
    (row: Session) => row.id === id && !row.deletedAt,
  );
  if (!session) state.error = '原专注记录暂不可用，输入仍已保留';
  return session;
}
async function saveRetainedNote(key: string) {
  if (state.busy || focusBusy.value) return;
  if (!draftIsCurrent(key)) {
    state.error = '请切回原数据后保存这份输入；当前内容仍保留。';
    return;
  }
  const current = captureFocusContext(),
    id = draftSessionId(key);
  if (!current() || !Object.hasOwn(notes, key)) return;
  focusBusy.value = true;
  const submitted = notes[key];
  try {
    const session = await readNoteSession(id, current);
    if (!session || !current()) return;
    if (session.note !== (noteBaselines[key] ?? '') && session.note !== submitted) {
      noteConflict.value = { session, submitted, draftKey: key };
      return;
    }
    await persistNote(session, submitted, submitted, key, false, current);
  } catch (cause) {
    if (current()) state.error = cause instanceof Error ? cause.message : String(cause);
  } finally {
    focusBusy.value = false;
  }
}
async function resolveNoteConflict(merge: boolean) {
  const conflict = noteConflict.value;
  if (!conflict || state.busy || focusBusy.value) return;
  if (!draftIsCurrent(conflict.draftKey)) {
    state.error = '数据已切换，输入仍保留，请切回原数据后再保存。';
    return;
  }
  const context = captureFocusContext();
  const current = () =>
    context() && noteConflict.value === conflict && draftIsCurrent(conflict.draftKey);
  if (!current()) return;
  focusBusy.value = true;
  try {
    const session = await readNoteSession(conflict.session.id, current);
    if (!session || !current()) return;
    if (session.revision !== conflict.session.revision) {
      noteConflict.value = { ...conflict, session };
      state.error = '记录再次更新，请核对最新内容后再保存';
      return;
    }
    const note = merge
      ? [session.note, conflict.submitted].filter(Boolean).join('\n\n')
      : conflict.submitted;
    if (
      await persistNote(
        session,
        note,
        conflict.submitted,
        conflict.draftKey,
        !!conflict.finish,
        current,
      )
    )
      noteConflict.value = undefined;
  } catch (cause) {
    if (current()) state.error = cause instanceof Error ? cause.message : String(cause);
  } finally {
    focusBusy.value = false;
  }
}
async function discardRetainedNote(key: string) {
  if (state.busy || focusBusy.value || !Object.hasOwn(notes, key)) return;
  const value = notes[key];
  if (!(await confirm('放弃这份尚未保存的输入？已保存的专注记录不会删除。'))) return;
  if (notes[key] !== value) {
    state.error = '输入已有更新，请核对后再放弃。';
    return;
  }
  delete notes[key];
  delete noteBaselines[key];
}
</script>

<template>
  <div ref="focusRoot" class="todo-focus-workspace">
    <div class="todo-focus-console">
      <section
        class="todo-focus-timer"
        :data-status="active?.status ?? 'idle'"
        :data-mode="active?.mode ?? mode"
        aria-label="专注计时器"
      >
        <span v-if="wideFocus" class="todo-focus-timer-caption">专注计时</span>
        <div class="todo-focus-dial">
          <svg class="todo-focus-ring" viewBox="0 0 120 120" aria-hidden="true" focusable="false">
            <circle class="todo-focus-track" cx="60" cy="60" r="55" />
            <circle
              v-if="dialRemaining !== null && dialRemaining > 0"
              class="todo-focus-remaining"
              cx="60"
              cy="60"
              r="55"
              pathLength="100"
              :stroke-dasharray="dialRemaining + ' 100'"
              transform="rotate(-90 60 60)"
            />
          </svg>
          <span
            class="todo-focus-timer-clock"
            :class="{ 'is-long': display.length > 5 }"
            role="timer"
            aria-label="专注计时"
            >{{ display }}</span
          >
        </div>
        <div class="todo-focus-timer-context">
          <div class="todo-focus-current">
            <strong>{{ active ? sessionName(active) : selected?.name || '自由专注' }}</strong>
            <div class="todo-focus-session-meta">
              <span class="todo-focus-state">{{
                active
                  ? statusLabel(active.status)
                  : selected?.archivedAt
                    ? '项目已归档'
                    : '准备开始'
              }}</span>
              <span>{{ timerSummary }}</span>
            </div>
            <small
              v-if="active && linkedAction && linkedAction !== sessionName(active)"
              class="todo-focus-linked-action"
              >任务：{{ linkedAction }}</small
            >
            <AButton v-if="!active && chosen" size="small" type="text" @click="chosen = ''"
              >取消关联任务</AButton
            >
            <small
              v-if="active && (Object.hasOwn(notes, draftKey(active.id)) || active.note)"
              class="todo-focus-note-status"
            >
              {{ Object.hasOwn(notes, draftKey(active.id)) ? '记录未保存' : '已添加专注记录' }}
            </small>
            <small
              v-if="active?.status === 'paused' && active.correctedMinutes !== null"
              class="todo-focus-note-status"
              >时长已修正，请结束保存后新开专注。</small
            >
          </div>
        </div>
        <div
          v-if="wideFocus && !active"
          class="todo-focus-quick-settings"
          :inert="timerSettings"
          :aria-hidden="timerSettings"
        >
          <ToDooFocusTimerFields
            :active="active"
            :show-task="false"
            v-model:mode="mode"
            v-model:target="target"
            v-model:chosen="chosen"
            :task-options="taskOptions"
            note=""
            :focus-minutes="state.snapshot?.settings.focusMinutes || 25"
            :break-minutes="nextBreak.minutes"
            :break-kind="nextBreak.kind"
            @target-edited="customTarget = true"
          />
        </div>
        <label v-if="!active" class="todo-focus-primary-task">
          专注任务<ToDooSelect
            v-model="chosen"
            aria-label="专注任务"
            :options="taskOptions"
            :disabled="state.busy || focusBusy"
          />
        </label>
        <AButton
          type="text"
          class="todo-focus-settings-toggle"
          aria-label="计时设置"
          :aria-expanded="timerSettings"
          @click="timerSettings = true"
          ><ToDooIcon name="settings" :size="16" /><span>{{
            active ? '记录与设置' : '设置'
          }}</span></AButton
        >
        <div class="todo-focus-timer-actions">
          <template v-if="active"
            ><AButton
              type="primary"
              :disabled="
                state.busy ||
                focusBusy ||
                (active.status === 'paused' && active.correctedMinutes !== null)
              "
              :title="
                active.status === 'paused' && active.correctedMinutes !== null
                  ? '时长已修正，请结束保存后新开专注'
                  : undefined
              "
              @click="control(active.status === 'paused' ? 'resume' : 'pause')"
              >{{ active.status === 'paused' ? '继续' : '暂停' }}</AButton
            ><AButton :disabled="state.busy || focusBusy" @click="control('finish')"
              >结束并保存</AButton
            ><AButton type="text" :disabled="state.busy || focusBusy" @click="control('cancel')"
              >取消本次</AButton
            ></template
          ><AButton
            v-else
            type="primary"
            :disabled="
              startUnavailable || (!!selected?.archivedAt && !(mode === 'break' && target === 0))
            "
            @click="start()"
            ><ToDooIcon name="play" :size="16" />{{
              mode === 'break' && target === 0 ? '跳过休息' : '开始专注'
            }}</AButton
          >
        </div>
        <label
          v-if="wideFocus && active"
          class="todo-focus-live-note"
          :inert="timerSettings"
          :aria-hidden="timerSettings"
        >
          随手记录<ATextarea
            :value="sessionNote(active)"
            aria-label="当前专注随手记录"
            :auto-size="{ minRows: 2, maxRows: 4 }"
            placeholder="完成了什么？下一步是什么？"
            @update:value="editActiveNote"
          />
        </label>
      </section>
      <section
        v-if="wideFocus && history"
        class="todo-focus-today-summary"
        aria-label="今日专注概览"
      >
        <div class="todo-focus-summary-heading">
          <h2>今日概览</h2>
          <span class="todo-focus-summary-scope"
            >统计范围：{{
              sourceSessionId
                ? '习惯来源记录'
                : topicOptions.find((option) => option.value === topicFilter)?.label || '所选项目'
            }}</span
          >
        </div>
        <div class="todo-focus-summary-values">
          <div>
            <strong>{{ Math.round(totals?.today.minutes || 0) }}</strong
            ><span>分钟</span><small>今日专注</small>
          </div>
          <div title="按已完成专注的开始日期统计次数">
            <strong>{{ totals?.today.completed || 0 }}</strong
            ><span>次</span><small>今日次数</small>
          </div>
        </div>
      </section>
      <section v-if="finishedTaskSession" class="todo-focus-task-next" aria-label="专注后的任务">
        <span>任务：{{ finishedTaskSession.taskTitle || '关联任务' }}</span>
        <div class="todo-actions">
          <AButton :disabled="state.busy || focusBusy" @click="viewSessionTask(finishedTaskSession)"
            >查看任务</AButton
          >
          <AButton
            :disabled="state.busy || focusBusy"
            @click="completeSessionTask(finishedTaskSession)"
            >完成任务</AButton
          >
        </div>
      </section>
    </div>
    <div class="todo-focus-library">
      <ASegmented
        v-if="!contextualNavigation"
        v-model:value="mobilePane"
        class="todo-focus-mobile-panes"
        aria-label="专注页面"
        :options="[
          { label: '专注', value: 'projects' },
          { label: '历史', value: 'history' },
        ]"
      />
      <div class="todo-focus-panels">
        <section
          ref="projectsSection"
          v-show="mobilePane === 'projects'"
          class="todo-focus-projects"
          aria-label="专注项目"
        >
          <ToDooPageToolbar>
            <h2 class="todo-focus-project-label">
              {{ archived === 'archived' ? '已归档项目' : '专注项目' }}
            </h2>
            <AButton
              type="text"
              class="todo-focus-free"
              :disabled="!!active"
              :aria-pressed="!selectedTopic && !chosen"
              @click="freeFocus"
              >自由专注</AButton
            >
            <AButton
              v-if="wideFocus"
              class="todo-focus-create"
              aria-label="新建专注项目"
              :disabled="state.busy || focusBusy"
              @click="emit('edit', 'focusTopic')"
            >
              <ToDooIcon name="plus" :size="16" />新建项目
            </AButton>
            <ADropdown :trigger="['click']" overlay-class-name="todo-ant-popup">
              <AButton type="text" class="todo-icon-button" aria-label="专注项目更多"
                ><ToDooIcon name="more" :size="16"
              /></AButton>
              <template #overlay>
                <AMenu :selectable="false">
                  <AMenuItem :disabled="state.busy" @click="emit('edit', 'focusTopic')"
                    >新建项目</AMenuItem
                  >
                  <AMenuItem @click="archived = archived === 'archived' ? 'active' : 'archived'">
                    {{ archived === 'archived' ? '进行中项目' : '已归档项目' }}
                  </AMenuItem>
                  <AMenuItem @click="viewAllHistory">查看全部记录</AMenuItem>
                </AMenu>
              </template>
            </ADropdown>
          </ToDooPageToolbar>

          <AAlert v-if="topicError" type="error" :message="topicError"
            ><template #action
              ><AButton type="link" @click="loadTopics()">重试</AButton></template
            ></AAlert
          >
          <article
            v-for="topic in topics"
            :key="topic.id"
            class="todo-focus-topic"
            :class="{ selected: selectedTopic === topic.id }"
          >
            <AButton
              type="text"
              class="todo-focus-topic-select"
              :aria-label="'选择专注项目 ' + topic.name"
              :aria-pressed="selectedTopic === topic.id"
              :disabled="!!active || state.busy || focusBusy"
              @click="chooseTopic(topic)"
              ><span class="todo-focus-topic-icon" :style="{ color: topic.color }"
                ><ToDooIcon name="focus" :size="16" /></span
              ><span>{{ topic.name }}</span></AButton
            >
            <AButton
              type="text"
              class="todo-focus-topic-total"
              :aria-label="'查看累计 ' + topic.name"
              :title="'查看累计 ' + topic.name"
              @click="viewTopicHistory(topic)"
            >
              <small>累计</small
              ><span>{{ duration(totals?.byTopic[topic.id]?.lifetime.minutes) }}</span>
            </AButton>
            <div class="todo-focus-topic-actions">
              <ADropdown :trigger="['click']" overlay-class-name="todo-ant-popup"
                ><AButton
                  type="text"
                  class="todo-icon-button todo-focus-topic-menu"
                  :aria-label="'专注项目操作 ' + topic.name"
                  ><ToDooIcon name="more" :size="17" /></AButton
                ><template #overlay
                  ><AMenu
                    ><AMenuItem @click="openTrend(topic)">时长趋势</AMenuItem
                    ><AMenuItem
                      :disabled="state.busy || focusBusy"
                      @click="emit('edit', 'focusTopic', topic)"
                      >编辑项目</AMenuItem
                    ><AMenuItem :disabled="state.busy || focusBusy" @click="archiveTopic(topic)">{{
                      topic.archivedAt ? '恢复项目' : '归档项目'
                    }}</AMenuItem></AMenu
                  ></template
                ></ADropdown
              >
              <AButton
                v-if="!active && !topic.archivedAt && mode !== 'break'"
                type="text"
                shape="circle"
                class="todo-focus-topic-start"
                :aria-label="'开始项目专注 ' + topic.name"
                :title="'开始项目专注 ' + topic.name"
                :disabled="startUnavailable"
                @click="start(topic)"
                ><ToDooIcon name="play" :size="15"
              /></AButton>
            </div>
          </article>
          <AEmpty
            v-if="!topics.length"
            :image="AEmpty.PRESENTED_IMAGE_SIMPLE"
            :description="archived === 'archived' ? '暂无归档项目' : '还没有专注项目'"
            class="todo-focus-empty"
            ><AButton
              v-if="archived !== 'archived'"
              type="default"
              @click="emit('edit', 'focusTopic')"
              ><ToDooIcon name="plus" :size="14" />创建专注项目</AButton
            ></AEmpty
          >
          <AButton v-if="topicCursor" block :loading="topicLoading" @click="loadTopics(true)"
            >加载更多专注项目</AButton
          >
        </section>
        <aside
          ref="recordsSection"
          v-show="mobilePane === 'history'"
          class="todo-focus-records"
          aria-label="专注概览和历史"
        >
          <div class="todo-focus-overview">
            <ToDooSectionHeader title="专注概览"
              ><AButton
                type="text"
                size="small"
                :aria-expanded="showTrend"
                @click="showTrend = !showTrend"
                >{{ showTrend ? '收起趋势' : '时长趋势' }}</AButton
              ><ToDooSelect
                :model-value="topicFilter"
                aria-label="专注记录项目"
                :options="topicOptions"
                @update:model-value="changeHistoryTopic"
            /></ToDooSectionHeader>
            <ToDooFocusTrendChart
              v-if="showTrend"
              :trend="history?.trend"
              :period="trendPeriod"
              :date="trendDate"
              :time-zone="history?.timeZone"
              :now="history?.now"
              :loading="loading"
              :error="error"
              @change="changeTrend"
              @retry="load()"
            />
            <div class="todo-focus-statistics">
              <AStatistic
                title="今日次数"
                aria-label="今日专注次数"
                :value="totals?.today.completed || 0"
                suffix="次"
              />
              <AStatistic
                title="今日时长"
                aria-label="今日专注时长"
                :value="Math.round(totals?.today.minutes || 0)"
                suffix="分钟"
              />
              <AStatistic
                title="累计次数"
                aria-label="累计专注次数"
                :value="totals?.lifetime.completed || 0"
                suffix="次"
              />
              <AStatistic
                title="累计时长"
                aria-label="累计专注时长"
                :value="Math.round(totals?.lifetime.minutes || 0)"
                suffix="分钟"
              />
            </div>
          </div>
          <div class="todo-focus-log">
            <div
              v-if="sourceSessionId"
              class="todo-focus-source-context todo-actions todo-between"
              role="status"
            >
              <span>来自习惯的专注记录</span>
              <AButton type="link" @click="clearSourceSession">查看全部专注记录</AButton>
            </div>
            <ToDooSectionHeader title="专注记录"
              ><ToDooSelect
                :value="period"
                aria-label="专注记录日期范围"
                :options="[
                  { value: 'all', label: '全部时间' },
                  { value: 'today', label: '今天' },
                  { value: 'week', label: '近 7 天' },
                  { value: 'custom', label: '自定义' },
                ]"
                @change="periodChanged" /><AButton
                type="text"
                aria-label="刷新专注记录"
                :loading="loading"
                @click="load()"
                ><ToDooIcon name="refresh" :size="16" /></AButton
            ></ToDooSectionHeader>
            <form
              v-if="period === 'custom'"
              class="todo-focus-date-range"
              @submit.prevent="applyHistoryDates"
            >
              <label
                >从<ToDooDateField
                  v-model="from"
                  type="date"
                  required
                  aria-label="专注开始日期" /></label
              ><label
                >到<ToDooDateField
                  v-model="to"
                  type="date"
                  required
                  aria-label="专注结束日期" /></label
              ><AButton html-type="submit">查看</AButton>
            </form>
            <AAlert v-if="error && !showTrend" type="error" :message="error" show-icon
              ><template #action
                ><AButton type="link" @click="load()">重试</AButton></template
              ></AAlert
            >
            <p v-if="loading && !history" role="status" class="todo-muted">正在载入专注记录…</p>
            <div
              ref="historyScroller"
              class="todo-focus-history"
              role="region"
              aria-label="专注记录列表"
              tabindex="0"
              :aria-busy="loading || loadingMore"
              @scroll.passive="loadNearHistoryEnd"
            >
              <section v-for="group in groups" :key="group.date">
                <h3 class="todo-focus-day">
                  {{ group.date === today ? '今天 · ' : '' }}{{ group.date }}
                </h3>
                <article
                  v-for="session in group.sessions"
                  :key="session.id"
                  class="todo-focus-history-item"
                  :data-session-id="session.id"
                  :data-status="session.status"
                  :data-mode="session.mode"
                >
                  <ToDooIcon name="focus" :size="17" />
                  <div class="todo-focus-history-copy">
                    <div class="todo-focus-history-title">
                      <strong>{{ sessionName(session) }}</strong
                      ><span
                        >{{ duration(focusElapsed(session, now) / 60) }}
                        <ATag
                          v-if="session.correctedMinutes !== null"
                          :bordered="false"
                          class="todo-focus-corrected"
                          title="保留人工修正；需继续时请开始新的专注"
                          >已修正</ATag
                        >
                      </span>
                    </div>
                    <div class="todo-focus-history-meta">
                      <span>{{ timeRange(session) }}</span>
                      <span v-if="session.mode === 'break'">休息</span>
                      <span class="todo-focus-state">{{ statusLabel(session.status) }}</span>
                    </div>
                    <p v-if="session.taskTitle && session.topicName" class="todo-muted">
                      {{ session.taskTitle }}
                    </p>
                    <p v-if="session.note">{{ session.note }}</p>
                    <div class="todo-focus-history-actions">
                      <AButton
                        v-if="session.occurrenceId"
                        type="link"
                        size="small"
                        :disabled="state.busy || focusBusy"
                        @click="viewSessionTask(session)"
                        >查看任务</AButton
                      >
                      <AButton
                        v-if="session.status === 'interrupted'"
                        type="link"
                        size="small"
                        :disabled="
                          state.busy ||
                          focusBusy ||
                          active?.status === 'running' ||
                          session.correctedMinutes !== null
                        "
                        :title="
                          session.correctedMinutes !== null
                            ? '已修正的记录请保留，并开始新的专注'
                            : undefined
                        "
                        @click="control('resume', session)"
                        >继续计时</AButton
                      ><AButton
                        v-if="session.status === 'paused' && session.id !== active?.id"
                        type="link"
                        size="small"
                        :disabled="
                          state.busy ||
                          focusBusy ||
                          active?.status === 'running' ||
                          session.correctedMinutes !== null
                        "
                        :title="
                          session.correctedMinutes !== null
                            ? '已修正的记录请保留，并开始新的专注'
                            : undefined
                        "
                        @click="control('resume', session)"
                        >继续这次专注</AButton
                      >
                      <details
                        class="todo-focus-history-more"
                        @keydown.esc.prevent.stop="closeHistoryActions($event)"
                      >
                        <summary :aria-label="sessionName(session) + ' · 更多记录操作'">
                          更多
                        </summary>
                        <div class="todo-focus-history-secondary">
                          <AButton
                            v-if="!['running', 'paused'].includes(session.status)"
                            type="link"
                            size="small"
                            :disabled="state.busy || focusBusy"
                            @click="
                              closeHistoryActions($event);
                              correct(session);
                            "
                            >修正</AButton
                          >
                          <AButton
                            type="link"
                            size="small"
                            :disabled="state.busy || focusBusy"
                            @click="
                              closeHistoryActions($event);
                              emit('edit', 'record', undefined, {
                                content: session.note,
                                sourceSessionId: session.id,
                                occurrenceId: session.occurrenceId,
                                minutes: Math.round(focusElapsed(session, now) / 60),
                              });
                            "
                            >记录</AButton
                          >
                        </div>
                      </details>
                    </div>
                  </div>
                </article>
              </section>
              <AEmpty
                v-if="history && !items.length"
                class="todo-focus-empty"
                :image="AEmpty.PRESENTED_IMAGE_SIMPLE"
                :description="
                  sourceSessionId ? '这条来源专注记录暂不可用' : '这个范围内还没有专注记录'
                "
              />
            </div>
            <p v-if="pageError" class="todo-focus-page-error" role="alert">{{ pageError }}</p>
            <div class="todo-focus-history-footer">
              <AButton
                v-if="pendingScan"
                size="small"
                type="text"
                :loading="loading || syncing"
                @click="load()"
                >继续同步记录</AButton
              >
              <AButton
                v-if="history?.page.hasMore && !pendingScan"
                size="small"
                type="text"
                :loading="loadingMore"
                :disabled="loading"
                @click="load(true)"
                >{{ pageError ? '重试加载' : '加载更早记录' }}</AButton
              >
              <p v-if="history?.page.total" class="todo-focus-count todo-muted" aria-live="polite">
                {{ history.page.total }} 条记录 ·
                {{
                  pendingScan || syncing
                    ? `已载入 ${items.length} 条 · 同步未完成`
                    : history.page.hasMore
                      ? `已载入 ${items.length} 条`
                      : '已全部载入'
                }}
              </p>
            </div>
          </div>
        </aside>
      </div>
    </div>
    <section
      v-for="key in Object.keys(notes).filter((key) => key !== (active ? draftKey(active.id) : ''))"
      :key="key"
      class="todo-focus-retained-note"
    >
      <label>尚未保存的专注记录<ATextarea v-model:value="notes[key]" /></label>
      <small v-if="!draftIsCurrent(key)" class="todo-muted"
        >这份输入来自另一份数据，切回原数据后可保存。</small
      >
      <div class="todo-actions">
        <AButton
          :disabled="state.busy || focusBusy || !draftIsCurrent(key)"
          @click="saveRetainedNote(key)"
          >保存记录</AButton
        >
        <AButton
          v-if="!draftIsCurrent(key)"
          type="text"
          :disabled="state.busy || focusBusy"
          @click="discardRetainedNote(key)"
          >放弃输入</AButton
        >
      </div>
    </section>
    <ADrawer
      v-if="focusRoot"
      v-model:open="timerSettings"
      title="计时设置"
      :placement="narrowTimer ? 'bottom' : 'right'"
      :height="narrowTimer ? 'auto' : undefined"
      :width="narrowTimer ? undefined : 440"
      :get-container="timerContainer"
      :root-style="{
        position: 'fixed',
        bottom: narrowTimer ? 'var(--workspace-bottom-inset, 0px)' : 0,
      }"
      class="todo-focus-timer-drawer"
    >
      <ToDooFocusTimerFields
        :active="active"
        v-model:mode="mode"
        v-model:target="target"
        v-model:chosen="chosen"
        :task-options="taskOptions"
        :note="active ? sessionNote(active) : ''"
        :focus-minutes="state.snapshot?.settings.focusMinutes || 25"
        :break-minutes="nextBreak.minutes"
        :break-kind="nextBreak.kind"
        @target-edited="customTarget = true"
        @update:note="editActiveNote"
      />
      <AButton class="todo-focus-settings-close" block @click="timerSettings = false"
        >收起计时设置</AButton
      >
    </ADrawer>
    <AModal
      :open="visible && !!noteConflict"
      title="专注记录已在其他窗口更新"
      :mask-closable="false"
      :closable="!focusBusy"
      wrap-class-name="todo-ant-modal"
      @cancel="!focusBusy && (noteConflict = undefined)"
    >
      <div v-if="noteConflict" class="todo-form">
        <p>核对两份内容后再保存，原有记录会保留到你作出选择。</p>
        <label
          >已保存的记录<ATextarea :value="noteConflict.session.note" readonly :rows="3"
        /></label>
        <label>本窗口的记录<ATextarea :value="noteConflict.submitted" readonly :rows="3" /></label>
        <AAlert v-if="state.error" type="error" :message="state.error" show-icon />
        <AAlert
          v-if="!draftIsCurrent(noteConflict.draftKey)"
          type="info"
          message="数据已切换，本窗口的输入仍保留。请切回原数据后再保存。"
          show-icon
        />
      </div>
      <template #footer>
        <AButton :disabled="focusBusy" @click="noteConflict = undefined">继续编辑</AButton>
        <AButton
          danger
          :disabled="focusBusy || (!!noteConflict && !draftIsCurrent(noteConflict.draftKey))"
          @click="resolveNoteConflict(false)"
          >用本窗口内容替换</AButton
        >
        <AButton
          type="primary"
          :loading="focusBusy"
          :disabled="!!noteConflict && !draftIsCurrent(noteConflict.draftKey)"
          @click="resolveNoteConflict(true)"
          >保留两份记录</AButton
        >
      </template>
    </AModal>
    <AModal
      :open="visible && !!correction"
      title="修正专注时长"
      ok-text="保存"
      cancel-text="取消"
      :confirm-loading="state.busy || focusBusy"
      :ok-button-props="{ disabled: state.busy || focusBusy || !correctionCurrent }"
      :cancel-button-props="{ disabled: state.busy || focusBusy }"
      :closable="!state.busy && !focusBusy"
      :keyboard="!state.busy && !focusBusy"
      :mask-closable="false"
      wrap-class-name="todo-ant-modal"
      @ok="saveCorrection"
      @cancel="closeCorrection"
      ><form class="todo-form" @submit.prevent="saveCorrection">
        <label
          >实际分钟数<AInputNumber
            v-model:value="correctedMinutes"
            :min="0"
            :max="525600"
            :disabled="state.busy || focusBusy"
            aria-label="实际专注分钟数" /></label
        ><AAlert
          v-if="!correctionCurrent"
          type="error"
          message="记录范围已变化，请重新打开修正。当前输入仍保留。"
        />
        <AAlert v-else-if="correctionError" type="error" :message="correctionError" />
        <AAlert v-if="state.error" type="error" :message="state.error" /></form
    ></AModal>
  </div>
</template>
