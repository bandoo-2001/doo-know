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
} from 'ant-design-vue';
import type {
  ToDooEntityKind,
  ToDooEntityMap,
  ToDooFocusHistory,
  ToDooFocusTrend,
} from '../../../../shared/to-doo-contracts';
import {
  focusElapsed,
  shiftToDooDate,
  toDooLocalDate,
  type ToDooWorkbench,
} from '../../to-doo-workbench';
import { reconcileFocusHistory, type FocusHistoryScan } from '../../to-doo-focus-history-sync';
import { useToDooConfirm } from '../../to-doo-controls';
import ToDooSelect from './ToDooSelect.vue';
import ToDooDateField from './ToDooDateField.vue';
import ToDooIcon from './ToDooIcon.vue';
import ToDooPageToolbar from './ToDooPageToolbar.vue';
import ToDooSectionHeader from './ToDooSectionHeader.vue';
import ToDooFocusTimerFields from './ToDooFocusTimerFields.vue';
import ToDooFocusTrendChart from './ToDooFocusTrend.vue';
import ToDooHint from './ToDooHint.vue';
import '../../to-doo-focus.css';

type Session = ToDooEntityMap['focusSession'];
type Topic = ToDooEntityMap['focusTopic'];
const ATextarea = Input.TextArea,
  AMenuItem = AMenu.Item;
const props = defineProps<{ model: ToDooWorkbench; occurrenceId?: string }>();
const emit = defineEmits<{
  edit: [kind: ToDooEntityKind, entity?: Record<string, any>, seed?: Record<string, any>];
  task: [id: string, occurrenceId?: string];
}>();
const state = props.model.state,
  confirm = useToDooConfirm();
const focusRoot = ref<HTMLElement>();
function timerContainer() {
  return focusRoot.value!.closest<HTMLElement>('.to-doo-workspace') || focusRoot.value!;
}
const focusBusy = ref(false),
  mobilePane = ref<'projects' | 'history'>('projects');
const history = ref<ToDooFocusHistory>(),
  loading = ref(false),
  error = ref('');
const historyScroller = ref<HTMLElement>(),
  loadingMore = ref(false),
  pageError = ref('');
const narrowTimer = useMediaQuery('(max-width: 600px)'),
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
const target = ref<number | ''>(state.snapshot?.settings.focusMinutes || 25),
  chosen = ref(props.occurrenceId || '');
const tick = ref(Date.now()),
  clockOffset = ref(0),
  notes = reactive<Record<string, string>>(Object.create(null));
const noteBaselines: Record<string, string> = Object.create(null);
const noteConflict = ref<{ session: Session; submitted: string; finish?: boolean }>();
let epoch = 0;
let loadedScope = '',
  loadedQuery = '';
const syncing = ref(false),
  pendingScan = ref<FocusHistoryScan>();
function recordScope() {
  return JSON.stringify({ topic: topicFilter.value, from: from.value, to: to.value });
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
function editActiveNote(value: string) {
  const session = active.value;
  if (!session) return;
  if (!Object.hasOwn(noteBaselines, session.id)) noteBaselines[session.id] = session.note;
  if (value === noteBaselines[session.id]) {
    delete notes[session.id];
    delete noteBaselines[session.id];
  } else notes[session.id] = value;
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
]);
const taskOptions = computed(() => [
  { value: '', label: '不关联任务' },
  ...(state.snapshot?.occurrences ?? [])
    .filter((row) => !row.deletedAt && !['done', 'cancelled', 'skipped'].includes(row.status))
    .flatMap((row) => {
      const task = state.snapshot?.tasks.find((task) => task.id === row.taskId && !task.deletedAt);
      return task ? [{ value: row.id, label: row.titleOverride || task.title }] : [];
    }),
]);
const elapsed = computed(() => (active.value ? focusElapsed(active.value, now.value) : 0));
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
const duration = (minutes = 0) =>
  minutes >= 60
    ? `${Math.floor(minutes / 60)} 小时${Math.round(minutes % 60) ? ' ' + Math.round(minutes % 60) + ' 分' : ''}`
    : `${Math.round(minutes)} 分钟`;
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
      : ' · ' + statusLabel(session.status))
  );
}
function query() {
  return {
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
  const token = ++topicEpoch;
  topicLoading.value = true;
  const params = new URLSearchParams({
    kind: 'focusTopic',
    limit: '200',
    filter: JSON.stringify({ includeArchived: true }),
  });
  if (append && topicCursor.value) params.set('cursor', topicCursor.value);
  try {
    const response = await props.model.request('/api/to-doo/state?' + params);
    if (token !== topicEpoch) return;
    topicEntities.value = append
      ? [
          ...new Map(
            [...topicEntities.value, ...response.focusTopics].map((topic: Topic) => [
              topic.id,
              topic,
            ]),
          ).values(),
        ]
      : response.focusTopics;
    topicCursor.value = response.page.nextCursor;
    topicError.value = '';
  } catch (cause) {
    if (token === topicEpoch)
      topicError.value = cause instanceof Error ? cause.message : String(cause);
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
    (narrowTimer.value && mobilePane.value !== 'history') ||
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
  visible.value = true;
  tick.value = Date.now();
  void load();
  void loadTopics();
  clock.resume();
  polling.resume();
}
function deactivate() {
  visible.value = false;
  timerSettings.value = false;
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
  () => state.snapshot?.version,
  () => {
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
  (id) => {
    if (!active.value) chosen.value = id || '';
  },
);
watch(allTopics, (values, old) => {
  const added = values.find(
    (topic) => !topic.archivedAt && !old?.some((row) => row.id === topic.id),
  );
  if (added && old?.length !== values.length && !active.value) selectedTopic.value = added.id;
});
function chooseTopic(topic: Topic) {
  if (!active.value) selectedTopic.value = topic.id;
}
function viewTopicHistory(topic: Topic) {
  topicFilter.value = topic.id;
  mobilePane.value = 'history';
}
function openTrend(topic: Topic) {
  viewTopicHistory(topic);
  showTrend.value = true;
  mobilePane.value = 'history';
}
function changeTrend(value: { period: ToDooFocusTrend['period']; date: string }) {
  trendPeriod.value = value.period;
  trendDate.value = value.date;
}
function periodChanged(value: string | number) {
  period.value = String(value);
  if (value === 'custom') return;
  from.value =
    value === 'today' ? today.value : value === 'week' ? shiftToDooDate(today.value, -6) : '';
  to.value = value === 'all' ? '' : today.value;
  void load();
}
async function start(topic?: Topic) {
  if (state.busy || active.value) return;
  if (mode.value === 'break' && target.value === 0) {
    mode.value = 'pomodoro';
    target.value = state.snapshot?.settings.focusMinutes ?? 25;
    if (!topic) {
      state.notice = '已跳过休息';
      return;
    }
  }
  if (topic) selectedTopic.value = topic.id;
  if (selected.value?.archivedAt) {
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
  const result = await props.model.execute(
    {
      action: 'start_focus',
      payload: {
        mode: mode.value,
        targetMinutes: mode.value === 'stopwatch' ? null : Number(target.value),
        topicId: selectedTopic.value || null,
        occurrenceId: chosen.value || null,
        listId: task ? task.listId : (selected.value?.listId ?? null),
      },
    },
    '专注已开始',
  );
  if (result) await load();
}
async function control(
  operation: 'pause' | 'resume' | 'finish' | 'cancel' | 'takeover',
  session = active.value,
) {
  if (!session || state.busy || focusBusy.value) return;
  const submittedNote = notes[session.id] ?? session.note;
  if (
    operation === 'finish' &&
    Object.hasOwn(notes, session.id) &&
    session.note !== noteBaselines[session.id] &&
    session.note !== submittedNote
  ) {
    noteConflict.value = { session, submitted: submittedNote, finish: true };
    return;
  }
  if (
    operation === 'cancel' &&
    !(await confirm('取消后不计入专注统计，已有时间片段仍可回看。', { title: '取消本次专注' }))
  )
    return;
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
    if (result && operation === 'finish') {
      if (notes[session.id] === submittedNote) {
        delete notes[session.id];
        delete noteBaselines[session.id];
      } else if (Object.hasOwn(notes, session.id)) noteBaselines[session.id] = submittedNote;
    }
    await load();
  } finally {
    focusBusy.value = false;
  }
}
async function archiveTopic(topic: Topic) {
  const result = await props.model.saveEntity(
    'focusTopic',
    { ...topic, archivedAt: topic.archivedAt ? null : new Date(now.value).toISOString() },
    topic.revision,
  );
  if (result) {
    await loadTopics();
    await load();
  }
}
const correction = ref<Session>(),
  correctedMinutes = ref<number | ''>(''),
  correctionError = ref('');
function closeHistoryActions(event?: Event) {
  const details = (event?.currentTarget as HTMLElement | undefined)?.closest('details');
  details?.removeAttribute('open');
  details?.querySelector('summary')?.focus();
}
function correct(session: Session) {
  correction.value = session;
  correctedMinutes.value = Math.round(focusElapsed(session, now.value) / 60);
  correctionError.value = '';
}
async function saveCorrection() {
  const session = correction.value;
  if (!session || state.busy) return;
  if (
    correctedMinutes.value === '' ||
    !Number.isFinite(correctedMinutes.value) ||
    correctedMinutes.value < 0 ||
    correctedMinutes.value > 525600
  ) {
    correctionError.value = '请输入有效的非负分钟数';
    return;
  }
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
  if (result) {
    correction.value = undefined;
    await load();
  }
}
async function persistNote(session: Session, note: string, submitted: string, finish = false) {
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
  if (!result) return false;
  if (notes[session.id] === submitted) {
    delete notes[session.id];
    delete noteBaselines[session.id];
  } else if (Object.hasOwn(notes, session.id)) noteBaselines[session.id] = note;
  await load();
  return true;
}
async function readNoteSession(id: string): Promise<Session | undefined> {
  const response = await props.model.request(
    '/api/to-doo/state?kind=focusSession&ids=' + encodeURIComponent(id),
  );
  const session = response.focusSessions[0];
  if (!session) state.error = '原专注记录暂不可用，输入仍已保留';
  return session;
}
async function saveRetainedNote(id: string) {
  if (state.busy || focusBusy.value) return;
  focusBusy.value = true;
  const submitted = notes[id];
  try {
    const session = await readNoteSession(id);
    if (!session) return;
    if (session.note !== (noteBaselines[id] ?? '') && session.note !== submitted) {
      noteConflict.value = { session, submitted };
      return;
    }
    await persistNote(session, submitted, submitted);
  } catch (cause) {
    state.error = cause instanceof Error ? cause.message : String(cause);
  } finally {
    focusBusy.value = false;
  }
}
async function resolveNoteConflict(merge: boolean) {
  const conflict = noteConflict.value;
  if (!conflict || state.busy || focusBusy.value) return;
  focusBusy.value = true;
  try {
    const session = await readNoteSession(conflict.session.id);
    if (!session) return;
    if (session.revision !== conflict.session.revision) {
      noteConflict.value = { ...conflict, session };
      state.error = '记录再次更新，请核对最新内容后再保存';
      return;
    }
    const note = merge
      ? [session.note, conflict.submitted].filter(Boolean).join('\n\n')
      : conflict.submitted;
    if (await persistNote(session, note, conflict.submitted, conflict.finish))
      noteConflict.value = undefined;
  } catch (cause) {
    state.error = cause instanceof Error ? cause.message : String(cause);
  } finally {
    focusBusy.value = false;
  }
}
</script>

<template>
  <div ref="focusRoot" class="todo-focus-workspace">
    <ASegmented
      v-if="narrowTimer"
      v-model:value="mobilePane"
      class="todo-focus-mobile-panes"
      aria-label="专注页面"
      :options="[
        { label: '项目', value: 'projects' },
        { label: '历史', value: 'history' },
      ]"
    />
    <div class="todo-focus-panels">
      <section
        v-show="!narrowTimer || mobilePane === 'projects'"
        class="todo-focus-projects"
        aria-label="专注项目"
      >
        <ToDooPageToolbar>
          <ASegmented
            v-model:value="archived"
            aria-label="专注项目状态"
            :options="[
              { label: '进行中', value: 'active' },
              { label: '已归档', value: 'archived' },
            ]"
          />
          <AButton
            type="text"
            :class="{ active: !topicFilter }"
            @click="
              topicFilter = '';
              mobilePane = 'history';
            "
            >查看全部记录</AButton
          >
          <AButton :disabled="!!active" :aria-pressed="!selectedTopic" @click="selectedTopic = ''"
            >自由专注</AButton
          >
        </ToDooPageToolbar>
        <ToDooHint :model="model" hint-id="focus-project-selection">
          选择项目用于计时；查看累计用于筛选记录。
        </ToDooHint>
        <AAlert v-if="topicError" type="error" :message="topicError"
          ><template #action
            ><AButton type="link" @click="loadTopics()">重试</AButton></template
          ></AAlert
        >
        <div class="todo-focus-project-head" aria-hidden="true">
          <span>计时项目</span><span>今日</span><span>累计 / 记录</span><span></span>
        </div>
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
            @click="chooseTopic(topic)"
            ><span class="todo-focus-topic-icon" :style="{ color: topic.color }"
              ><ToDooIcon name="focus" :size="22" /></span
            ><span>{{ topic.name }}</span></AButton
          >
          <span class="todo-focus-topic-duration">{{
            duration(totals?.byTopic[topic.id]?.today.minutes)
          }}</span>
          <AButton
            type="text"
            class="todo-focus-topic-total"
            :aria-label="'查看累计 ' + topic.name"
            @click="viewTopicHistory(topic)"
          >
            <span>{{ duration(totals?.byTopic[topic.id]?.lifetime.minutes) }}</span
            ><small>查看累计</small>
          </AButton>
          <div class="todo-focus-topic-actions">
            <AButton
              v-if="!topic.archivedAt"
              type="text"
              shape="circle"
              :aria-label="'开始专注 ' + topic.name"
              :disabled="!!active || state.busy"
              @click="start(topic)"
              ><ToDooIcon name="play" :size="16"
            /></AButton>
            <ADropdown :trigger="['click']"
              ><AButton type="text" :aria-label="'专注项目操作 ' + topic.name"
                ><ToDooIcon name="more" :size="17" /></AButton
              ><template #overlay
                ><AMenu
                  ><AMenuItem @click="openTrend(topic)">时长趋势</AMenuItem
                  ><AMenuItem @click="emit('edit', 'focusTopic', topic)">编辑项目</AMenuItem
                  ><AMenuItem @click="archiveTopic(topic)">{{
                    topic.archivedAt ? '恢复项目' : '归档项目'
                  }}</AMenuItem></AMenu
                ></template
              ></ADropdown
            >
          </div>
        </article>
        <AEmpty
          v-if="!topics.length"
          :description="
            archived === 'archived'
              ? '归档的项目和记录会一直保留在这里'
              : '为阅读、学习或工作建立一个专注项目'
          "
          class="todo-focus-empty"
          ><AButton
            v-if="archived !== 'archived'"
            type="default"
            @click="emit('edit', 'focusTopic')"
            >创建专注项目</AButton
          ></AEmpty
        >
        <AButton v-if="topicCursor" block :loading="topicLoading" @click="loadTopics(true)"
          >加载更多专注项目</AButton
        >
      </section>
      <aside
        v-show="!narrowTimer || mobilePane === 'history'"
        class="todo-focus-records"
        aria-label="专注概览和历史"
      >
        <ToDooSectionHeader title="专注概览"
          ><AButton
            type="text"
            size="small"
            :aria-expanded="showTrend"
            @click="showTrend = !showTrend"
            >{{ showTrend ? '收起趋势' : '时长趋势' }}</AButton
          ><ToDooSelect v-model="topicFilter" aria-label="专注记录项目" :options="topicOptions"
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
        <form v-if="period === 'custom'" class="todo-focus-date-range" @submit.prevent="load()">
          <label
            >从<ToDooDateField
              v-model="from"
              type="date"
              required
              aria-label="专注开始日期" /></label
          ><label
            >到<ToDooDateField v-model="to" type="date" required aria-label="专注结束日期" /></label
          ><AButton html-type="submit">查看</AButton>
        </form>
        <AAlert v-if="error && !showTrend" type="error" :message="error" show-icon
          ><template #action><AButton type="link" @click="load()">重试</AButton></template></AAlert
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
            >
              <ToDooIcon name="focus" :size="17" />
              <div class="todo-focus-history-copy">
                <div class="todo-between">
                  <strong>{{ sessionName(session) }}</strong
                  ><span
                    >{{ duration(focusElapsed(session, now) / 60)
                    }}<small v-if="session.correctedMinutes !== null" class="todo-focus-corrected"
                      >已修正</small
                    ></span
                  >
                </div>
                <small
                  >{{ timeRange(session) }} ·
                  {{ session.mode === 'break' ? '休息' : statusLabel(session.status) }}</small
                >
                <p v-if="session.taskTitle && session.topicName" class="todo-muted">
                  {{ session.taskTitle }}
                </p>
                <p v-if="session.note">{{ session.note }}</p>
                <div class="todo-focus-history-actions">
                  <AButton
                    v-if="session.status === 'interrupted'"
                    type="link"
                    size="small"
                    :disabled="state.busy || focusBusy || active?.status === 'running'"
                    @click="control('resume', session)"
                    >继续计时</AButton
                  ><AButton
                    v-if="session.status === 'paused' && session.id !== active?.id"
                    type="link"
                    size="small"
                    :disabled="state.busy || focusBusy || active?.status === 'running'"
                    @click="control('resume', session)"
                    >继续这次专注</AButton
                  >
                  <details
                    class="todo-focus-history-more"
                    @keydown.esc.prevent.stop="closeHistoryActions($event)"
                  >
                    <summary :aria-label="sessionName(session) + ' · 更多记录操作'">更多</summary>
                    <div class="todo-focus-history-secondary">
                      <AButton
                        v-if="!['running', 'paused'].includes(session.status)"
                        type="link"
                        size="small"
                        @click="
                          closeHistoryActions($event);
                          correct(session);
                        "
                        >修正</AButton
                      >
                      <AButton
                        type="link"
                        size="small"
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
          <AEmpty v-if="history && !items.length" description="这个范围内还没有专注记录" />
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
        <ToDooHint :model="model" hint-id="focus-history-scope">
          历史/趋势项目独立于计时；概览统计该项目今日与累计。
        </ToDooHint>
        <details class="todo-focus-policy">
          <summary>统计口径</summary>
          <p class="todo-focus-count todo-muted">
            概览统计当前筛选项目的今日与累计，不受记录日期影响；趋势按所选周期，记录按所选日期范围。计时项目独立选择。
            完成次数按开始日计算；时长按每日片段计入，修正时长计入开始日。休息与取消不计入专注统计。
          </p>
        </details>
      </aside>
    </div>
    <section
      v-for="id in Object.keys(notes).filter((id) => id !== active?.id)"
      :key="id"
      class="todo-focus-retained-note"
    >
      <label>尚未保存的专注记录<ATextarea v-model:value="notes[id]" /></label
      ><AButton :disabled="state.busy || focusBusy" @click="saveRetainedNote(id)">保存记录</AButton>
    </section>
    <section class="todo-focus-timer" aria-label="专注计时器">
      <div class="todo-focus-timer-context">
        <ToDooIcon name="focus" :size="24" />
        <div>
          <strong>{{ active ? sessionName(active) : selected?.name || '自由专注' }}</strong
          ><small
            >{{
              active ? statusLabel(active.status) : selected?.archivedAt ? '项目已归档' : '准备开始'
            }}
            · {{ timerSummary }}</small
          >
          <small
            v-if="linkedAction && linkedAction !== (active ? sessionName(active) : selected?.name)"
            class="todo-focus-linked-action"
            >关联行动：{{ linkedAction
            }}<template v-if="!active">（切换项目仍保留）</template></small
          >
          <AButton v-if="!active && chosen" size="small" type="text" @click="chosen = ''"
            >清空关联行动</AButton
          >
          <small
            v-if="active && (Object.hasOwn(notes, active.id) || active.note)"
            class="todo-focus-note-status"
          >
            {{ Object.hasOwn(notes, active.id) ? '记录未保存' : '已添加专注记录' }}
          </small>
        </div>
      </div>
      <span class="todo-focus-timer-clock" role="timer" aria-label="专注计时">{{ display }}</span>
      <AButton
        type="text"
        class="todo-focus-settings-toggle"
        aria-label="计时设置"
        :aria-expanded="timerSettings"
        @click="timerSettings = true"
        >{{ active ? '记录与设置' : '设置' }}</AButton
      >
      <div class="todo-focus-timer-actions">
        <template v-if="active"
          ><AButton
            type="primary"
            class="todo-button todo-primary"
            :disabled="state.busy || focusBusy"
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
          class="todo-button todo-primary"
          :disabled="
            state.busy ||
            focusBusy ||
            (loading && !syncing) ||
            (!!selected?.archivedAt && !(mode === 'break' && target === 0))
          "
          @click="start()"
          ><ToDooIcon name="play" :size="16" />{{
            mode === 'break' && target === 0 ? '跳过休息' : '开始专注'
          }}</AButton
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
        :note="active ? (notes[active.id] ?? active.note) : ''"
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
      :open="!!noteConflict"
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
      </div>
      <template #footer>
        <AButton :disabled="focusBusy" @click="noteConflict = undefined">继续编辑</AButton>
        <AButton danger :disabled="focusBusy" @click="resolveNoteConflict(false)"
          >用本窗口内容替换</AButton
        >
        <AButton type="primary" :loading="focusBusy" @click="resolveNoteConflict(true)"
          >保留两份记录</AButton
        >
      </template>
    </AModal>
    <AModal
      :open="!!correction"
      title="修正专注时长"
      ok-text="保存"
      cancel-text="取消"
      :confirm-loading="state.busy"
      :mask-closable="false"
      wrap-class-name="todo-ant-modal"
      @ok="saveCorrection"
      @cancel="correction = undefined"
      ><form class="todo-form" @submit.prevent="saveCorrection">
        <label
          >实际分钟数<AInputNumber
            v-model:value="correctedMinutes"
            :min="0"
            :max="525600"
            aria-label="实际专注分钟数" /></label
        ><AAlert v-if="correctionError" type="error" :message="correctionError" /></form
    ></AModal>
  </div>
</template>
