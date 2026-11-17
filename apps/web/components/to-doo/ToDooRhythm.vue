<script setup lang="ts">
import { computed, nextTick, onUnmounted, reactive, ref, watch } from 'vue';
import {
  Alert as AAlert,
  Button as AButton,
  Empty as AEmpty,
  InputNumber as AInputNumber,
  Modal as AModal,
  Segmented as ASegmented,
} from 'ant-design-vue';
import ToDooFocus from './ToDooFocus.vue';
import ToDooHabitCard from './ToDooHabitCard.vue';
import ToDooHabitDetail from './ToDooHabitDetail.vue';
import '../../to-doo-habit-workspace.css';
import { habitPeriodPlan } from '../../to-doo-habit-insights';
import ToDooIcon from './ToDooIcon.vue';
import ToDooListIcon from './ToDooListIcon.vue';
import ToDooAnniversaryArt from './ToDooAnniversaryArt.vue';
import '../../to-doo-anniversary.css';
import { formatHabitSchedule } from '../../to-doo-habit-presentation';
import ToDooPageToolbar from './ToDooPageToolbar.vue';
import ToDooSectionHeader from './ToDooSectionHeader.vue';
import { useToDooClock } from '../../to-doo-time';
import { useToDooConfirm } from '../../to-doo-controls';
import type { ToDooEntityKind, ToDooEntityMap } from '../../../../shared/to-doo-contracts';
import { shiftToDooDate, toDooLocalDate, type ToDooWorkbench } from '../../to-doo-workbench';
import { toDooAnniversaryDate as nextToDooAnniversary } from '../../../../shared/to-doo-anniversaries';
import {
  getHabitPeriod,
  getHabitGoalMode,
  getHabitRule,
  summarizeHabitPeriod,
  sumHabitAmounts,
} from '../../../../shared/to-doo-habits';
const props = defineProps<{
  model: ToDooWorkbench;
  section: 'focus' | 'habits' | 'anniversaries';
  occurrenceId?: string;
  context?: string;
  contextualNavigation?: boolean;
  listId?: string;
  historyRequest?: number;
  historyDate?: string;
  historyRange?: { from: string; to: string };
  historySessionId?: string;
}>();
const emit = defineEmits<{
  edit: [kind: ToDooEntityKind, entity?: Record<string, any>, seed?: Record<string, any>];
  task: [id: string, occurrenceId?: string];
  'context-change': [value: string];
  list: [id: string];
  'all-habits': [];
  'task-context-consumed': [];
  'open-note': [id: string];
  'focus-session': [id: string];
}>();
const confirmAction = useToDooConfirm();
const { now: tick, active: clockActive } = useToDooClock();
const state = props.model.state,
  weekOffset = ref(0);
const today = computed(() =>
  toDooLocalDate(new Date(tick.value), state.snapshot?.settings.timeZone),
);
void props.model.ensureListCatalog();
const lists = computed(() => props.model.taskLists());
const scopedList = computed(() => lists.value.find((list) => list.id === props.listId));
const habits = computed(
  () =>
    state.snapshot?.habits.filter(
      (h) => !h.deletedAt && (!props.listId || h.listId === props.listId),
    ) || [],
);
const habitList = (habit: ToDooEntityMap['habit']) =>
  lists.value.find((list) => list.id === habit.listId);
const localHabitPane = ref('today');
const habitPane = computed({
  get: () =>
    props.context === undefined
      ? localHabitPane.value
      : props.context === 'history'
        ? 'history'
        : 'today',
  set: (value: string) => {
    localHabitPane.value = value;
    emit('context-change', value);
  },
});
const habitHistory = ref<HTMLElement>();
let appliedHistoryRequest = 0;
const localAnniversaryFilter = ref('upcoming');
const anniversaryFilter = computed({
  get: () =>
    props.context === undefined
      ? localAnniversaryFilter.value
      : ['upcoming', 'today', 'past'].includes(props.context)
        ? props.context
        : 'all',
  set: (value: string) => {
    localAnniversaryFilter.value = value;
    emit('context-change', value);
  },
});
const habitEntries = ref<ToDooEntityMap['habitEntry'][]>([]);
const habitLoading = ref(false),
  habitError = ref(''),
  appliedHabitQuery = ref('');
const quantities = reactive<Record<string, number | ''>>(Object.create(null));
const quantityErrors = reactive<Record<string, string>>(Object.create(null));
let habitEpoch = 0;
const selectedHabitId = ref('');
const selectedHabit = computed(() => habits.value.find(habit => habit.id === selectedHabitId.value));
const selectedHabitDate = ref<string | null>(null);
function openHabitStatistics(habit: ToDooEntityMap['habit']) {
  selectedHabitId.value = habit.id;
}
function closeHabitStatistics() {
  selectedHabitId.value = '';
}
const habitRecordDate = (habit: ToDooEntityMap['habit']) => selectedHabitDate.value ?? habitToday(habit);
const habitDateLabel = computed(() => selectedHabitDate.value || today.value);
function validHabitDate(date: string) {
  const instant = Date.parse(date + 'T12:00:00Z');
  return /^\d{4}-\d{2}-\d{2}$/.test(date) && Number.isFinite(instant) &&
    new Date(instant).toISOString().slice(0, 10) === date;
}
function selectHabitDate(date: string, habit?: ToDooEntityMap['habit']) {
  if (!validHabitDate(date) || date > (habit ? habitToday(habit) : today.value)) return false;
  const weekday = new Date(today.value + 'T12:00:00Z').getUTCDay();
  const start = shiftToDooDate(today.value, -((weekday - (state.snapshot?.settings.weekStartsOn ?? 1) + 7) % 7));
  weekOffset.value = Math.floor((Date.parse(date + 'T12:00:00Z') - Date.parse(start + 'T12:00:00Z')) / 604800000);
  // A detail calendar names an exact date. Only the workspace's Today shortcut
  // follows each habit's own local date when its timezone crosses midnight.
  selectedHabitDate.value = !habit && date === today.value ? null : date;
  return true;
}
function shiftHabitWeek(delta: number) {
  selectHabitDate([shiftToDooDate(habitDateLabel.value, delta * 7), today.value].sort()[0]!);
}
function returnToHabitToday() {
  selectedHabitDate.value = null;
  weekOffset.value = 0;
}
async function openHabitDay(habit: ToDooEntityMap['habit'], date: string) {
  if (props.section !== 'habits' || !clockActive.value || state.busy) return;
  const datasetId = state.snapshot?.datasetId;
  const detailId = selectedHabitId.value;
  if (!selectHabitDate(date, habit)) return;
  await nextTick();
  if (!habitReady.value) await loadHabitEntries();
  const current = habits.value.find(entry => entry.id === habit.id);
  if (props.section === 'habits' && clockActive.value && state.snapshot?.datasetId === datasetId &&
    selectedHabitId.value === detailId && current && habitRecordDate(current) === date)
    checkin(current, date);
}
const habitToday = (habit: ToDooEntityMap['habit']) =>
  toDooLocalDate(new Date(tick.value), habit.timeZone);
const quantityKey = (habit: ToDooEntityMap['habit']) => habit.id + ':' + habitRecordDate(habit);
const quantity = (habit: ToDooEntityMap['habit']) =>
  quantities[quantityKey(habit)] ??
  (getHabitRule(habit, habitRecordDate(habit)).frequency === 'daily'
    ? Math.max(
        0,
        sumHabitAmounts([getHabitRule(habit, habitRecordDate(habit)).target, -amount(habit.id, habitRecordDate(habit))]),
      ) || ''
    : 1);
const weekStart = computed(() => {
  const date = shiftToDooDate(today.value, weekOffset.value * 7),
    weekday = new Date(date + 'T12:00:00Z').getUTCDay();
  return shiftToDooDate(date, -((weekday - (state.snapshot?.settings.weekStartsOn ?? 1) + 7) % 7));
});
const days = computed(() =>
  Array.from({ length: 7 }, (_, i) => shiftToDooDate(weekStart.value, i)),
);
watch(
  () => [props.section, props.historyRequest, props.historyDate] as const,
  async () => {
    const request = props.historyRequest || 0;
    if (props.section !== 'habits' || !request || request === appliedHistoryRequest) return;
    appliedHistoryRequest = request;
    weekOffset.value = 0;
    const date = props.historyDate;
    if (date && validHabitDate(date))
      weekOffset.value = Math.floor(
        (Date.parse(date + 'T12:00:00Z') - Date.parse(weekStart.value + 'T12:00:00Z')) / 604800000,
      );
    habitPane.value = 'history';
    await nextTick();
    habitHistory.value?.scrollIntoView({ block: 'start', behavior: 'instant' });
  },
  { immediate: true },
);
const habitRange = computed(() => {
  const periods = habits.value
    .flatMap((habit) =>
      [habitToday(habit), habitRecordDate(habit), ...days.value].map((date) => getHabitPeriod(habit, date)),
    )
    .filter((period) => period.start < period.endExclusive);
  return {
    from: periods.reduce(
      (from, period) => (period.start < from ? period.start : from),
      today.value,
    ),
    to: periods.reduce(
      (to, period) =>
        shiftToDooDate(period.endExclusive, -1) > to ? shiftToDooDate(period.endExclusive, -1) : to,
      today.value,
    ),
  };
});
const habitQueryKey = computed(() => JSON.stringify([state.snapshot?.datasetId, habitRange.value, state.snapshot?.version]));
const habitReady = computed(
  () => !habitLoading.value && !habitError.value && appliedHabitQuery.value === habitQueryKey.value,
);
let pendingHabitLoad: { key: string; promise: Promise<void> } | undefined;
function loadHabitEntries(): Promise<void> {
  if (!clockActive.value || props.section !== 'habits') return Promise.resolve();
  const key = habitQueryKey.value;
  if (pendingHabitLoad?.key === key) return pendingHabitLoad.promise;
  const promise = readHabitEntries(key);
  pendingHabitLoad = { key, promise };
  void promise.finally(() => {
    if (pendingHabitLoad?.promise === promise) pendingHabitLoad = undefined;
  });
  return promise;
}
async function readHabitEntries(key: string) {
  const token = ++habitEpoch,
    datasetId = state.snapshot?.datasetId;
  habitLoading.value = true;
  habitError.value = '';
  const values: ToDooEntityMap['habitEntry'][] = [];
  let cursor: string | undefined, version: string | undefined;
  try {
    do {
      const params = new URLSearchParams({ kind: 'habitEntry', ...habitRange.value, limit: '200' });
      if (cursor) params.set('cursor', cursor);
      const snapshot = await props.model.request('/api/to-doo/state?' + params);
      if (token !== habitEpoch || key !== habitQueryKey.value || props.section !== 'habits') return;
      if (datasetId && snapshot.datasetId !== datasetId)
        throw Error('数据空间已变化，请刷新页面后再查看习惯记录');
      version ??= snapshot.version;
      if (version !== snapshot.version) throw Error('读取期间记录有更新，请重试读取习惯记录');
      values.push(...snapshot.habitEntries);
      cursor = snapshot.page.nextCursor || undefined;
    } while (cursor);
    habitEntries.value = values;
    appliedHabitQuery.value = key;
  } catch (cause) {
    if (token === habitEpoch)
      habitError.value = cause instanceof Error ? cause.message : String(cause);
  } finally {
    if (token === habitEpoch) habitLoading.value = false;
  }
}
watch(
  () => [clockActive.value, props.section, habitQueryKey.value],
  () => {
    if (clockActive.value && props.section === 'habits') void loadHabitEntries();
    else {
      habitEpoch++;
      pendingHabitLoad = undefined;
      habitLoading.value = false;
      closeHabitStatistics();
    }
  },
  { immediate: true },
);
onUnmounted(() => {
  habitEpoch++;
  delete state.externalDirty.habits;
});
const anniversaries = computed(
  () =>
    state.snapshot?.anniversaries
      .filter((a) => !a.deletedAt)
      .map((a) => ({ entity: a, next: nextToDooAnniversary(a, today.value) }))
      .sort((a, b) => (a.next || '9999').localeCompare(b.next || '9999')) || [],
);
const filteredAnniversaries = computed(() =>
  anniversaries.value.filter(({ next }) => {
    if (anniversaryFilter.value === 'all') return true;
    if (!next) return false;
    if (anniversaryFilter.value === 'today') return next === today.value;
    if (anniversaryFilter.value === 'past') return next < today.value;
    return next >= today.value && next <= shiftToDooDate(today.value, 30);
  }),
);
const anniversaryGroups = computed(() => {
  if (props.contextualNavigation)
    return [{ id: anniversaryFilter.value, label: '', items: filteredAnniversaries.value }];
  const bucket = (next: string | null) =>
    !next
      ? 'invalid'
      : next < today.value
        ? 'past'
        : next <= shiftToDooDate(today.value, 30)
          ? 'soon'
          : 'later';
  return [
    { id: 'soon', label: '今天及未来 30 天' },
    { id: 'later', label: '更远的日子' },
    { id: 'past', label: '已经过去' },
    { id: 'invalid', label: '待核对日期' },
  ]
    .map((group) => ({
      ...group,
      items: filteredAnniversaries.value.filter((row) => bucket(row.next) === group.id),
    }))
    .filter((group) => group.items.length);
});
const entries = (habitId: string, date: string) =>
  habitEntries.value.filter((e) => !e.deletedAt && e.habitId === habitId && e.localDate === date) ||
  [];
const amount = (habitId: string, date: string) =>
  sumHabitAmounts(entries(habitId, date).filter(entry => !entry.skipped).map(entry => entry.amount));
const summaries = computed(
  () =>
    new Map(
      habits.value.map((habit) => {
        const values = habitEntries.value.filter((e) => e.habitId === habit.id && e.localDate <= habitToday(habit));
        return [
          habit.id,
          {
            days: new Map(
              [...new Set([...days.value, habitToday(habit), habitRecordDate(habit)])].map((date) => [
                date,
                summarizeHabitPeriod(habit, values, date),
              ]),
            ),
          },
        ] as const;
      }),
    ),
);
const habitSummary = (habit: ToDooEntityMap['habit'], date: string) =>
  summaries.value.get(habit.id)!.days.get(date)!;
const exemptDay = (habit: ToDooEntityMap['habit'], date: string) => {
  return !getHabitPeriod(habit, date).scheduledDates.includes(date);
};
const expandedHabitGroups = reactive<Record<string, boolean>>({});
const habitPlans = computed(() => new Map(habits.value.map(habit => [habit.id,
  habitPeriodPlan(habit, habitEntries.value, habitRecordDate(habit), habitToday(habit)),
])));
const habitPlan = (habit: ToDooEntityMap['habit']) => habitPlans.value.get(habit.id)!;
const todayHabitGroups = computed(() => {
  const groups = [
    { id: 'pending', label: selectedHabitDate.value ? '当天的日常行动' : '今天的日常行动', folded: false, items: [] as ToDooEntityMap['habit'][] },
    { id: 'period', label: '这周与这个月', folded: false, items: [] as ToDooEntityMap['habit'][] },
    { id: 'periodDone', label: '已达标的周期目标', folded: true, items: [] as ToDooEntityMap['habit'][] },
    { id: 'done', label: '已完成的日常行动', folded: true, items: [] as ToDooEntityMap['habit'][] },
    { id: 'rest', label: '休息与跳过', folded: true, items: [] as ToDooEntityMap['habit'][] },
  ];
  for (const habit of habits.value) {
    const date = habitRecordDate(habit), summary = habitSummary(habit, date);
    const periodic = summary.rule.frequency !== 'daily';
    // A weekly/monthly goal remains visible throughout its period, including rest days.
    const resting = summary.status === 'inactive' || (periodic
      ? !summary.scheduledDates.length
      : exemptDay(habit, date) || habit.pausedDates.includes(date) || entries(habit.id, date).some(entry => entry.skipped));
    const completed = periodic ? summary.status === 'achieved' :
      getHabitGoalMode(summary.rule) === 'checkin' ? amount(habit.id, date) > 0 : summary.status === 'achieved';
    const group = resting ? 4 : periodic ? (completed ? 2 : 1) : completed ? 3 : 0;
    groups[group]!.items.push(habit);
  }
  return groups.filter(group => group.items.length);
});
const dailyPendingCount = computed(() => todayHabitGroups.value.find(group => group.id === 'pending')?.items.length || 0);
const periodPendingCount = computed(() => todayHabitGroups.value.find(group => group.id === 'period')?.items.length || 0);
function revealHabitGroup(habit: ToDooEntityMap['habit'], date: string) {
  expandedHabitGroups[getHabitRule(habit, date).frequency === 'daily' ? 'done' : 'periodDone'] = true;
}
async function skip(habit: ToDooEntityMap['habit'], date: string) {
  expandedHabitGroups.rest = true;
  if (!canWriteHabit(habit, date) || entries(habit.id, date).length) return;
  return props.model.execute(
    {
      action: 'checkin_habit',
      payload: {
        habitId: habit.id,
        expectedHabitRevision: habit.revision,
        localDate: date,
        amount: 0,
        note: '',
        skipped: true,
        sourceSessionId: null,
      },
    },
    '已记录跳过，按当期规则计算',
  );
}
type NumericDialog = {
  kind: 'habit'; habit: ToDooEntityMap['habit']; date: string;
  datasetId: string | undefined; rule: string;
};
const numericDialog = ref<NumericDialog | null>(null);
const dialogRule = computed(
  () => numericDialog.value && getHabitRule(numericDialog.value.habit, numericDialog.value.date),
);
const ordinaryDialog = computed(
  () => !!dialogRule.value && getHabitGoalMode(dialogRule.value) === 'checkin',
);
const dialogEntries = computed(() =>
  numericDialog.value
    ? entries(numericDialog.value.habit.id, numericDialog.value.date)
        .slice()
        .sort((a, b) => b.occurredAt.localeCompare(a.occurredAt))
    : [],
);
const dialogAmount = computed(() =>
  numericDialog.value ? amount(numericDialog.value.habit.id, numericDialog.value.date) : 0,
);
const dialogSummary = computed(
  () => numericDialog.value && habitSummary(numericDialog.value.habit, numericDialog.value.date),
);
const dialogRecorded = computed(
  () => numericDialog.value && amount(numericDialog.value.habit.id, numericDialog.value.date) > 0,
);
const dialogSkipped = computed(
  () => numericDialog.value && entries(numericDialog.value.habit.id, numericDialog.value.date).some(entry => entry.skipped),
);
const dialogExempt = computed(
  () => numericDialog.value && exemptDay(numericDialog.value.habit, numericDialog.value.date),
);
const numericValue = ref<number | ''>('');
const numericInitialValue = ref<number | ''>('');
const numericError = ref('');
function canWriteHabit(habit: ToDooEntityMap['habit'], date: string) {
  return props.section === 'habits' && clockActive.value && habitReady.value && !state.busy &&
    validHabitDate(date) && date <= habitToday(habit) &&
    habits.value.some(current => current.id === habit.id && current.revision === habit.revision);
}
function currentDialogHabit(dialog: NumericDialog) {
  if (state.snapshot?.datasetId !== dialog.datasetId || props.section !== 'habits' || !clockActive.value)
    return;
  const current = habits.value.find(habit => habit.id === dialog.habit.id);
  if (!current || JSON.stringify(getHabitRule(current, dialog.date)) !== dialog.rule) {
    numericError.value = '习惯规则已变化，请重新打开记录窗口核对；当前输入仍保留。';
    return;
  }
  if (current.revision !== dialog.habit.revision) {
    numericError.value = '习惯内容已更新，请重新打开记录窗口核对；当前输入仍保留。';
    return;
  }
  return current;
}
watch(
  [quantities, numericValue, numericDialog],
  () => {
    state.externalDirty.habits = Object.keys(quantities).length > 0 ||
      !!numericDialog.value && numericValue.value !== numericInitialValue.value;
  },
  { deep: true },
);
watch(
  () => [state.snapshot?.datasetId, props.section, props.listId] as const,
  ([datasetId, section, listId], [beforeDatasetId, beforeSection, beforeListId]) => {
    if (datasetId === beforeDatasetId && section === beforeSection && listId === beforeListId) return;
    numericDialog.value = null;
    numericError.value = '';
    selectedHabitId.value = '';
    if (datasetId !== beforeDatasetId) {
      selectedHabitDate.value = null;
      weekOffset.value = 0;
      habitEntries.value = [];
    }
    for (const key of Object.keys(quantities)) delete quantities[key];
    for (const key of Object.keys(quantityErrors)) delete quantityErrors[key];
  },
);
function closeNumeric() {
  if (state.busy) return;
  numericDialog.value = null;
  numericError.value = '';
}
function checkin(habit: ToDooEntityMap['habit'], date: string) {
  if (!canWriteHabit(habit, date)) return;
  const rule = getHabitRule(habit, date);
  numericValue.value =
    rule.frequency === 'daily' ? Math.max(0, sumHabitAmounts([rule.target, -amount(habit.id, date)])) || '' : 1;
  numericError.value = '';
  numericInitialValue.value = numericValue.value;
  numericDialog.value = { kind: 'habit', habit: JSON.parse(JSON.stringify(habit)), date, datasetId: state.snapshot?.datasetId,
    rule: JSON.stringify(rule) };
}
async function saveNumeric() {
  const dialog = numericDialog.value;
  if (!dialog || !habitReady.value || state.busy || props.section !== 'habits' || !clockActive.value ||
    state.snapshot?.datasetId !== dialog.datasetId)
    return;
  const current = currentDialogHabit(dialog);
  if (!current) return;
  if (!canWriteHabit(current, dialog.date)) return;
  if (exemptDay(current, dialog.date)) {
    numericError.value = '这一天的安排已变化，当前输入仍保留，请重新核对记录日期。';
    return;
  }
  if (dialogSkipped.value) {
    numericError.value = '这一天已跳过，请先撤销跳过记录再打卡；当前输入仍保留。';
    return;
  }
  if (ordinaryDialog.value && dialogRecorded.value) return;
  const value =
    getHabitGoalMode(getHabitRule(dialog.habit, dialog.date)) === 'checkin'
      ? 1
      : numericValue.value;
  if (value === '' || !Number.isFinite(value) || value <= 0) {
    numericError.value = '请输入大于 0 的数量';
    return;
  }
  if (value > 1000000) {
    numericError.value = '记录数量不能超过 1000000';
    return;
  }
  const result = await props.model.execute(
    {
      action: 'checkin_habit',
      payload: {
        habitId: dialog.habit.id,
        expectedHabitRevision: current.revision,
        localDate: dialog.date,
        amount: value,
        note: '',
        skipped: false,
        sourceSessionId: null,
      },
    },
    dialog.date === habitToday(dialog.habit)
      ? `已记录「${dialog.habit.name}」`
      : `已补记「${dialog.habit.name}」${dialog.date}`,
  );
  if (result) {
    revealHabitGroup(dialog.habit, dialog.date);
    numericDialog.value = null;
    numericError.value = '';
  }
}
async function undo(habit: ToDooEntityMap['habit'], date: string) {
  if (!canWriteHabit(habit, date)) return;
  const datasetId = state.snapshot?.datasetId;
  const scope = props.listId;
  const values = entries(habit.id, date);
  if (!values.length) return;
  if (
    !(await confirmAction(`撤销 ${date}「${habit.name}」的 ${values.length} 条记录？`, {
      title: '撤销习惯记录',
      danger: true,
    }))
  )
    return;
  if (state.snapshot?.datasetId !== datasetId || props.listId !== scope || !canWriteHabit(habit, date)) return false;
  for (const entry of values) {
    if (state.snapshot?.datasetId !== datasetId || props.section !== 'habits' || !clockActive.value)
      return false;
    const r = await props.model.removeEntity('habitEntry', entry);
    if (!r) return false;
  }
  state.notice = `已撤销「${habit.name}」${date} 的记录`;
  return true;
}
async function undoEntry(entry: ToDooEntityMap['habitEntry']) {
  if (!habitReady.value || state.busy || props.section !== 'habits' || !clockActive.value) return;
  const datasetId = state.snapshot?.datasetId;
  const scope = props.listId;
  const dialogHabit = numericDialog.value?.habit.id;
  if (
    !(await confirmAction('仅撤销这一条记录？其他记录和来源专注记录会保留，可从回收站恢复此条。', {
      title: '撤销单条习惯记录',
      danger: true,
    }))
  )
    return;
  if (state.snapshot?.datasetId !== datasetId || props.section !== 'habits' || !clockActive.value ||
    props.listId !== scope || numericDialog.value?.habit.id !== dialogHabit ||
    !habitEntries.value.some(current => current.id === entry.id && current.revision === entry.revision && !current.deletedAt)) return;
  await props.model.removeEntity('habitEntry', entry);
}
function entryTime(entry: ToDooEntityMap['habitEntry'], habit: ToDooEntityMap['habit']) {
  const timeZone = getHabitRule(habit, entry.localDate).timeZone;
  const recordedAt = new Date(entry.occurredAt);
  const clock = new Intl.DateTimeFormat('zh-CN', {
    timeZone,
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).format(recordedAt);
  const recordedDate = toDooLocalDate(recordedAt, timeZone);
  return recordedDate === entry.localDate ? clock : `记录于 ${recordedDate} ${clock}`;
}
async function recordToday(habit: ToDooEntityMap['habit']) {
  const date = habitRecordDate(habit);
  if (!canWriteHabit(habit, date) || exemptDay(habit, date) || entries(habit.id, date).some(entry => entry.skipped)) return;
  const key = quantityKey(habit),
    value =
      getHabitGoalMode(getHabitRule(habit, habitRecordDate(habit))) === 'checkin' ? 1 : quantity(habit);
  if (
    getHabitGoalMode(getHabitRule(habit, habitRecordDate(habit))) === 'checkin' &&
    amount(habit.id, habitRecordDate(habit)) > 0
  )
    return;
  if (value === '' || !Number.isFinite(value) || value <= 0) {
    quantityErrors[key] = '请输入大于 0 的数量';
    return;
  }
  if (value > 1000000) {
    quantityErrors[key] = '记录数量不能超过 1000000';
    return;
  }
  quantityErrors[key] = '';
  const result = await props.model.execute(
    {
      action: 'checkin_habit',
      payload: {
        habitId: habit.id,
        expectedHabitRevision: habit.revision,
        localDate: date,
        amount: value,
        skipped: false,
        note: '',
        sourceSessionId: null,
      },
    },
    getHabitGoalMode(getHabitRule(habit, habitRecordDate(habit))) === 'checkin'
      ? `已为「${habit.name}」打卡`
      : `已记录「${habit.name}」${value} ${getHabitRule(habit, habitRecordDate(habit)).unit}`,
  );
  if (result) revealHabitGroup(habit, date);
  if (result && quantities[key] === value) delete quantities[key];
}
async function pauseToday(habit: ToDooEntityMap['habit'], date = habitToday(habit)) {
  expandedHabitGroups.rest = true;
  if (!canWriteHabit(habit, date)) return;
  return props.model.saveEntity(
    'habit',
    {
      ...habit,
      pausedDates: habit.pausedDates.includes(date)
        ? habit.pausedDates.filter((day) => day !== date)
        : [...habit.pausedDates, date],
    },
    habit.revision,
  );
}
async function adjustHistory(action: 'undo' | 'skip' | 'rest') {
  const dialog = numericDialog.value;
  if (!dialog || state.busy || !habitReady.value) return;
  const habit = currentDialogHabit(dialog);
  if (!habit) return;
  const result =
    action === 'undo'
      ? await undo(habit, dialog.date)
      : action === 'skip'
        ? await skip(habit, dialog.date)
        : await pauseToday(habit, dialog.date);
  if (result) closeNumeric();
}
function distance(date: string, a: ToDooEntityMap['anniversary']) {
  const days = Math.round(
    (Date.parse(date + 'T12:00:00Z') - Date.parse(today.value + 'T12:00:00Z')) / 86400000,
  );
  return Math.abs(days) + (a.countMode === 'include_today' ? 1 : 0);
}
</script>
<template>
  <KeepAlive
    ><ToDooFocus
      v-if="section === 'focus'"
      :model="model"
      :occurrence-id="occurrenceId"
      :context="context"
      :contextual-navigation="contextualNavigation"
      @context-change="emit('context-change', $event)"
      :history-request="historyRequest"
      :history-range="historyRange"
      :history-session-id="historySessionId"
      @edit="(kind, entity, seed) => emit('edit', kind, entity, seed)"
      @task="(id, occurrence) => emit('task', id, occurrence)"
      @task-context-consumed="emit('task-context-consumed')"
  /></KeepAlive>
  <template v-if="section === 'habits'"
    ><ToDooPageToolbar class="todo-calendar-toolbar todo-life-toolbar" aria-controls="to-doo-habit-results">
      <ASegmented
        v-if="!contextualNavigation"
        v-model:value="habitPane"
        aria-label="习惯视图"
        :options="[
          { label: '今天', value: 'today' },
          { label: '历史', value: 'history' },
        ]"
      />
      <div v-if="habitPane === 'history'" class="todo-actions">
        <AButton type="text" class="todo-icon-button" aria-label="上一周" @click="weekOffset--">
          <ToDooIcon name="back" :size="16" />
        </AButton>
        <span class="todo-habit-history-range" aria-label="习惯历史区间">{{ weekStart }} — {{ days[6] }}</span>
        <AButton type="text" class="todo-icon-button" aria-label="下一周" @click="weekOffset++">
          <ToDooIcon name="chevron" :size="16" />
        </AButton>
        <AButton v-if="weekOffset" type="text" @click="weekOffset = 0">回到本周</AButton>
      </div>
    </ToDooPageToolbar>
    <div v-if="listId" class="todo-habit-scope" aria-label="当前习惯范围">
      <span class="todo-habit-scope-label"><ToDooListIcon v-if="scopedList" :list="scopedList" :size="16" /><span>{{ scopedList?.name || '当前清单' }} · 关联习惯</span></span>
      <AButton type="link" @click="emit('all-habits')">查看全部习惯</AButton>
      <AButton
        v-if="scopedList && !scopedList.archivedAt"
        type="link"
        @click="emit('list', scopedList.id)"
        >查看清单任务</AButton
      >
    </div>
    <AAlert v-if="habitError" type="error" :message="habitError" show-icon
      ><template #action
        ><AButton @click="loadHabitEntries">重试读取习惯记录</AButton></template
      ></AAlert
    >
    <div class="todo-habit-workspace" :class="{ 'has-detail': !!selectedHabit }">
    <div class="todo-habit-workspace-main">
      <section v-if="habitPane === 'today'" class="todo-habit-intention" aria-label="习惯行动概览">
        <div class="todo-habit-intention-copy">
          <div class="todo-habit-intention-heading"><h2><ToDooIcon name="calendar" :size="18" />{{ new Date(habitDateLabel + 'T12:00:00Z').toLocaleDateString('zh-CN', { month:'long', day:'numeric', weekday:'short', timeZone:'UTC' }) }}</h2></div>
          <div v-if="habitReady" class="todo-habit-intention-counts"><span :title="dailyPendingCount + ' 项日常行动待完成'"><ToDooIcon name="tasks" :size="18" /><strong>{{ dailyPendingCount }}</strong><small>待办</small></span><span :title="periodPendingCount + ' 个周期目标进行中'"><ToDooIcon name="repeat" :size="18" /><strong>{{ periodPendingCount }}</strong><small>周期</small></span></div>
          <p v-else role="status">{{ habitError ? '记录暂不可用，请重试' : '正在读取习惯记录…' }}</p>
        </div>
        <div class="todo-habit-date-tools">
          <AButton v-if="selectedHabitDate || weekOffset" type="text" @click="returnToHabitToday">回到今天</AButton>
          <details class="todo-habit-date-browser">
            <summary aria-label="查看其他日期" title="查看其他日期"><ToDooIcon name="calendar" :size="16" /><ToDooIcon name="chevron" :size="12" /></summary>
            <section class="todo-habit-week" aria-label="按日期查看习惯">
              <div class="todo-habit-week-heading"><span>{{ weekStart }} — {{ days[6] }}</span><div class="todo-actions">
                <AButton type="text" class="todo-icon-button" aria-label="查看上一周习惯" @click="shiftHabitWeek(-1)"><ToDooIcon name="back" :size="16" /></AButton>
                <AButton type="text" class="todo-icon-button" aria-label="查看下一周习惯" :disabled="days[6]! >= today" @click="shiftHabitWeek(1)"><ToDooIcon name="chevron" :size="16" /></AButton>
              </div></div>
              <div class="todo-habit-week-days"><button v-for="day in days" :key="day" type="button" :disabled="day > today" :aria-label="'查看 ' + day + ' 的习惯'" :aria-pressed="day === habitDateLabel" :aria-current="day === today ? 'date' : undefined" @click="selectHabitDate(day)"><span>{{ new Date(day + 'T12:00:00Z').toLocaleDateString('zh-CN', { weekday:'short', timeZone:'UTC' }) }}</span><strong>{{ day === today ? '今天' : Number(day.slice(-2)) }}</strong></button></div>
            </section>
          </details>
        </div>
      </section>
    <div v-if="habitPane === 'today'" id="to-doo-habit-results" class="todo-habit-cards" :aria-busy="habitLoading || (!habitReady && !habitError)">
      <component :is="group.folded ? 'details' : 'section'"
        v-for="group in todayHabitGroups"
        :key="group.id"
        class="todo-habit-today-group todo-habit-today-list"
        :data-group="group.id"
        :aria-label="group.label" :open="group.folded ? !!expandedHabitGroups[group.id] : undefined"
      >
        <summary v-if="group.folded" class="todo-habit-fold-heading" :aria-label="group.label" @click.prevent="expandedHabitGroups[group.id] = !expandedHabitGroups[group.id]"><ToDooIcon :name="group.id === 'periodDone' ? 'overview' : group.id === 'done' ? 'completed' : 'pause'" :size="15" />{{ group.id === 'periodDone' ? '已达标' : group.id === 'done' ? '已完成' : '休息 / 跳过' }} <small>{{ group.items.length }}</small></summary>
        <h2 v-else-if="habitReady" class="todo-habit-today-heading">
          <ToDooIcon :name="group.id === 'pending' ? 'today' : 'repeat'" :size="17" /><span>{{ group.id === 'pending' ? (selectedHabitDate ? '当日行动' : '每日行动') : group.id === 'period' ? '周期目标' : group.label }}</span> <small>{{ group.items.length }}</small>
        </h2>
        <ToDooHabitCard
          v-for="h in group.items"
          :key="h.id"
          :habit="h"
          :selected="selectedHabitId === h.id" :is-today="habitRecordDate(h) === habitToday(h)" :future="habitRecordDate(h) > habitToday(h)"
          :date="habitRecordDate(h)"
          :show-local-date="
            habitRecordDate(h) !== today || h.timeZone !== state.snapshot?.settings.timeZone
          "
          :summary="habitSummary(h, habitRecordDate(h))"
          :plan="habitPlan(h)"
          :amount="amount(h.id, habitRecordDate(h))"
          :entry-count="entries(h.id, habitRecordDate(h)).length"
          :skipped="entries(h.id, habitRecordDate(h)).some((entry) => entry.skipped)"
          :exempt="exemptDay(h, habitRecordDate(h))"
          :ready="habitReady"
          :busy="state.busy"
          :quantity="quantity(h)"
          :error="quantityErrors[quantityKey(h)]"
          :list="habitList(h)"
          @update:quantity="
            quantities[quantityKey(h)] = $event;
            quantityErrors[quantityKey(h)] = '';
          "
          @record="recordToday(h)"
          @edit="emit('edit', 'habit', h)"
          @skip="skip(h, habitRecordDate(h))"
          @undo="undo(h, habitRecordDate(h))"
          @pause="pauseToday(h, habitRecordDate(h))"
          @statistics="openHabitStatistics(h)"
          @entries="checkin(h, habitRecordDate(h))"
          @list="emit('list', $event)"
        />
      </component>
      <AEmpty v-if="!habits.length && !habitLoading && !habitError" :image="AEmpty.PRESENTED_IMAGE_SIMPLE" :description="listId ? '这个清单还没有关联习惯' : '还没有习惯'" />
    </div>
    <template v-else>
      <section ref="habitHistory" id="to-doo-habit-results" class="todo-panel todo-habit-table">
        <div v-if="habits.length" class="todo-habit-row head">
          <span>习惯</span
          ><span v-for="d in days" :key="d"
            >{{
              new Date(d + 'T12:00:00Z').toLocaleDateString('zh-CN', {
                weekday: 'short',
                timeZone: 'UTC',
              })
            }}<small>{{ d.slice(5) }}</small></span
          >
        </div>
        <div v-for="h in habits" :key="h.id" class="todo-habit-row">
          <div>
            <AButton type="text" class="todo-task-title" @click="emit('edit', 'habit', h)">
              {{ h.name }}</AButton
            ><small>{{ formatHabitSchedule(getHabitRule(h, habitToday(h))) }}</small>
          </div>
          <div v-for="d in days" :key="d" class="todo-habit-cell">
            <button
              type="button"
              class="todo-habit-check"
              :class="{
                checked:
                  getHabitRule(h, d).frequency === 'daily' &&
                  habitSummary(h, d).status === 'achieved',
              }"
              :disabled="
                state.busy ||
                !habitReady ||
                d > habitToday(h) ||
                habitSummary(h, d).status === 'inactive'
              "
              :title="
                habitSummary(h, d).start +
                ' 至 ' +
                habitSummary(h, d).endExclusive +
                '（不含）：' +
                habitSummary(h, d).amount +
                '/' +
                habitSummary(h, d).target +
                ' ' +
                habitSummary(h, d).rule.unit +
                (habitSummary(h, d).estimated ? '（历史规则估算）' : '')
              "
              :aria-label="
                h.name + ' ' + d + ' 打卡，当前 ' + amount(h.id, d) + ' ' + getHabitRule(h, d).unit
              "
              @click="checkin(h, d)"
            >
              <template
                v-if="
                  getHabitGoalMode(getHabitRule(h, d)) === 'quantity' &&
                  entries(h.id, d).some((entry) => !entry.skipped)
                "
              >
                <span>{{ amount(h.id, d) }}</span
                ><small
                  v-if="
                    getHabitRule(h, d).frequency === 'daily' &&
                    habitSummary(h, d).status === 'achieved'
                  "
                  aria-label="已达标"
                  >✓</small
                >
              </template>
              <template v-else>{{
                exemptDay(h, d)
                  ? '–'
                  : getHabitGoalMode(getHabitRule(h, d)) === 'checkin' && amount(h.id, d) > 0
                    ? '✓'
                    : entries(h.id, d).some((entry) => entry.skipped)
                      ? '跳'
                      : '＋'
              }}</template>
            </button>
          </div>
        </div>
        <AEmpty v-if="!habits.length && !habitLoading && !habitError" class="todo-empty" :image="AEmpty.PRESENTED_IMAGE_SIMPLE" description="还没有习惯记录" />
      </section></template>
    </div>
    <template v-if="selectedHabit">
      <button type="button" class="todo-habit-detail-backdrop" aria-label="收起习惯详情" @click="closeHabitStatistics" />
      <div class="todo-habit-detail-slot">
        <ToDooHabitDetail :model="model" :habit="selectedHabit" :date="habitRecordDate(selectedHabit)" :now-date="habitToday(selectedHabit)" :list="habitList(selectedHabit)" :ready="habitReady"
          @close="closeHabitStatistics" @edit="emit('edit', 'habit', selectedHabit)" @select-date="selectHabitDate($event, selectedHabit)" @record="openHabitDay(selectedHabit, $event)" @list="emit('list', $event)" @open-note="emit('open-note', $event)" @focus-session="emit('focus-session', $event)" />
      </div>
    </template>
    </div>
    </template>
  <template v-else-if="section === 'anniversaries'">
    <ToDooPageToolbar v-if="!contextualNavigation" class="todo-life-toolbar">
      <ASegmented
        v-model:value="anniversaryFilter"
        aria-label="纪念日范围"
        :options="[
          { label: '即将到来', value: 'upcoming' },
          { label: '今天', value: 'today' },
          { label: '全部', value: 'all' },
          { label: '已过去', value: 'past' },
        ]"
      />
      <AButton v-if="anniversaries.some(a => !a.next) && anniversaryFilter !== 'all'" type="text" @click="anniversaryFilter = 'all'">{{ anniversaries.filter(a => !a.next).length }} 项日期待核对</AButton>
    </ToDooPageToolbar>
    <section v-for="group in anniversaryGroups" :key="group.id" class="todo-anniversary-group">
      <ToDooSectionHeader v-if="group.label" :title="group.label" />
      <div class="todo-anniversaries">
        <article
          v-for="a in group.items"
          :key="a.entity.id"
          class="todo-anniversary todo-panel"
          :data-card-style="a.entity.appearance?.style || 'bloom'"
          :data-card-palette="a.entity.appearance?.palette || 'rose'"
          :aria-label="'纪念日 ' + a.entity.name"
        >
          <div class="todo-anniversary-face">
          <ToDooAnniversaryArt v-if="a.entity.appearance?.style === 'photo' && a.entity.appearance.image"
            :src="'/api/to-doo/anniversary-images/' + a.entity.appearance.image.hash"
            :x="a.entity.appearance.image.x" :y="a.entity.appearance.image.y" :zoom="a.entity.appearance.image.zoom" />
          <div class="todo-anniversary-heading">
            <span v-if="a.entity.category" class="todo-badge" :title="a.entity.category">{{ a.entity.category }}</span>
          </div>
          <h2 class="todo-anniversary-name" :aria-label="a.entity.name"><AButton type="text" class="todo-anniversary-title" :title="a.entity.name" :aria-label="'编辑 ' + a.entity.name" @click="emit('edit', 'anniversary', a.entity)"><span class="todo-anniversary-name-text">{{ a.entity.name }}</span></AButton></h2>
          <div class="todo-anniversary-distance">
          <p v-if="a.next === today" class="todo-anniversary-today">就是今天</p>
          <p class="todo-days" v-else-if="a.next">
            <small>{{ a.next >= today ? '还有' : '已经' }}</small
            ><span>{{ distance(a.next, a.entity) }}</span><small>天</small>
          </p>
          <p v-else class="todo-muted">暂未找到下一次日期，请检查闰月设置</p>
          </div>
          <div class="todo-anniversary-dates">
          <p v-if="a.next" class="todo-muted">
            {{
              (!a.entity.repeatYearly && a.next < today) || a.next === today
                ? '公历日期'
                : '下次公历'
            }}：<time :datetime="a.next">{{ a.next }}</time>
          </p>
          <p v-if="a.entity.calendar === 'lunar'" class="todo-muted">
            农历原日期：{{ a.entity.date }}{{ a.entity.lunarLeapMonth ? '（闰月）' : '' }}
          </p>
          </div>
          </div>
          <details
            v-if="
              a.entity.repeatYearly ||
              a.entity.description ||
              a.entity.noteRefs.length ||
              a.entity.reminders.length ||
              (a.entity.calendar !== 'lunar' && a.entity.date !== a.next)
            "
            class="todo-anniversary-details"
          >
            <summary :aria-label="a.entity.name + ' · 查看详情'">查看详情</summary>
            <div class="todo-anniversary-details-content">
              <p
                v-if="a.entity.calendar !== 'lunar' && a.entity.date !== a.next"
                class="todo-muted"
              >
                公历原日期：{{ a.entity.date }}
              </p>
              <p v-if="a.entity.repeatYearly" class="todo-muted">每年重复</p>
              <p v-if="a.entity.description">{{ a.entity.description }}</p>
              <div
                v-if="a.entity.noteRefs.length || a.entity.reminders.length"
                class="todo-actions"
              >
                <span v-if="a.entity.noteRefs.length" class="todo-badge"
                  >{{ a.entity.noteRefs.length }} 份关联资料</span
                ><span v-if="a.entity.reminders.length" class="todo-badge"
                  >{{ a.entity.reminders.length }} 个提醒</span
                >
              </div>
            </div>
          </details>
        </article>
      </div>
    </section>
    <AEmpty
      v-if="!anniversaries.length"
      class="todo-empty"
      :image="AEmpty.PRESENTED_IMAGE_SIMPLE"
      description="记得重要日子，也为它做好准备"
    />
    <AEmpty
      v-else-if="!filteredAnniversaries.length"
      class="todo-empty"
      :image="AEmpty.PRESENTED_IMAGE_SIMPLE"
      description="这个范围内还没有纪念日"
    >
      <AButton @click="anniversaryFilter = 'all'">查看全部纪念日</AButton>
    </AEmpty></template
  >
  <AModal
    wrap-class-name="todo-ant-modal"
    :open="section === 'habits' && clockActive && !!numericDialog"
    :title="ordinaryDialog ? '习惯打卡' : '记录习惯数量'"
    :ok-text="ordinaryDialog ? (dialogRecorded ? '已打卡' : '打卡') : '保存'"
    :ok-button-props="{ disabled: !habitReady || !!dialogExempt || !!dialogSkipped || (ordinaryDialog && !!dialogRecorded) || (!!numericDialog && numericDialog.date > habitToday(numericDialog.habit)) }"
    cancel-text="取消"
    :confirm-loading="state.busy"
    :cancel-button-props="{ disabled: state.busy }"
    :closable="!state.busy"
    :keyboard="!state.busy"
    :mask-closable="false"
    @ok="saveNumeric"
    @cancel="closeNumeric"
  >
    <form class="todo-form todo-habit-day-form" @submit.prevent="saveNumeric">
      <p v-if="numericDialog?.kind === 'habit'">
        {{ numericDialog.habit.name }} · {{ numericDialog.date }} ·
        {{ getHabitRule(numericDialog.habit, numericDialog.date).unit }}
      </p>
      <p v-if="numericDialog" class="todo-muted">记录时区：{{ dialogRule?.timeZone }}</p>
      <p v-if="!ordinaryDialog && dialogRule">
        已累计 {{ dialogAmount
        }}<template v-if="dialogRule.frequency === 'daily'"> / {{ dialogRule.target }}</template>
        {{ dialogRule.unit }}<span v-if="dialogSummary?.status === 'achieved'"> · 已达标</span>
      </p>
      <p v-if="dialogRule && dialogRule.frequency !== 'daily'" class="todo-muted">
        当期累计 {{ dialogSummary?.amount }} / {{ dialogRule.target }}
        {{ ordinaryDialog ? '天' : dialogRule.unit }}
      </p>

      <ul
        v-if="numericDialog && dialogEntries.length"
        class="todo-habit-entries"
        aria-label="当天记录"
      >
        <li v-for="entry in dialogEntries" :key="entry.id" :data-habit-entry-id="entry.id">
          <div>
            <time :datetime="entry.occurredAt">{{ entryTime(entry, numericDialog.habit) }}</time> ·
            <span
              >{{ entry.amount }}
              {{ getHabitRule(numericDialog.habit, entry.localDate).unit }}</span
            >
            <small v-if="entry.skipped"> · 已跳过</small>
            <small
              v-else-if="
                getHabitGoalMode(getHabitRule(numericDialog.habit, entry.localDate)) === 'checkin'
              "
            >
              · 打卡</small
            >
            <small v-if="entry.sourceSessionId"> · 来自专注</small>
            <p v-if="entry.note">{{ entry.note }}</p>
          </div>
          <AButton
            type="link"
            danger
            :disabled="state.busy || !habitReady"
            @click="undoEntry(entry)"
            >撤销此条</AButton
          >
        </li>
      </ul>
      <p v-if="dialogSkipped" class="todo-muted">这一天已跳过，可先撤销跳过记录再打卡。</p>
      <p v-else-if="dialogExempt" class="todo-muted">这一天无需记录。</p>
      <p v-else-if="ordinaryDialog">
        {{ dialogRecorded ? '这一天已打卡。' : '完成后记录一次打卡。' }}
      </p>
      <label v-else
        >本次新增
        <span class="todo-habit-entry-input"
          ><AInputNumber
            :value="numericValue"
            :min="0"
            :max="1000000"
            :disabled="state.busy || !habitReady || !!dialogExempt || !!dialogSkipped"
            aria-label="习惯数量"
            autofocus
            @update:value="numericValue = $event === null || $event === '' ? '' : Number($event)"
          /><AButton
            type="primary"
            html-type="submit"
            :loading="state.busy"
            :disabled="!habitReady || !!dialogExempt || !!dialogSkipped"
            >记录</AButton
          ></span
        >
      </label>
      <div v-if="numericDialog" class="todo-actions">
        <AButton
          v-if="ordinaryDialog && entries(numericDialog.habit.id, numericDialog.date).length"
          type="link"
          :disabled="state.busy"
          @click="adjustHistory('undo')"
          >撤销当天记录</AButton
        >
        <AButton
          v-else-if="!dialogExempt && !dialogEntries.length"
          type="link"
          :disabled="state.busy"
          @click="adjustHistory('skip')"
          >跳过这一天</AButton
        >
        <AButton
          v-if="!dialogExempt || numericDialog.habit.pausedDates.includes(numericDialog.date)"
          type="link"
          :disabled="state.busy"
          @click="adjustHistory('rest')"
          >{{
            numericDialog.habit.pausedDates.includes(numericDialog.date)
              ? '恢复这一天'
              : '这一天休息'
          }}</AButton
        >
      </div>
      <small v-if="numericDialog && !dialogExempt" class="todo-muted"
        >休息不影响连续记录；跳过按习惯的跳过规则计算。</small
      >
      <AAlert v-if="numericError" type="error" show-icon :message="numericError" />
      <AAlert v-if="state.error && state.error !== numericError" type="error" show-icon :message="state.error" />
    </form>
    <template v-if="!ordinaryDialog" #footer>
      <AButton
        v-if="numericDialog && dialogEntries.length"
        type="link"
        danger
        :disabled="state.busy"
        @click="adjustHistory('undo')"
        >撤销当天记录</AButton
      >
      <AButton :disabled="state.busy" @click="closeNumeric">关闭</AButton>
    </template>
  </AModal>
</template>

<style scoped>
.todo-habit-entry-input {
  display: flex;
  gap: 10px;
  align-items: center;
}
.todo-habit-entry-input > .ant-input-number {
  flex: 1;
  min-width: 0;
}
.todo-life-toolbar {
  flex-wrap: wrap;
  gap: var(--todo-space-12);
}
.todo-life-toolbar .todo-habit-history-range {
  color: var(--todo-muted);
  font-size: var(--todo-caption-size);
  overflow-wrap: anywhere;
}
.todo-life-toolbar .todo-actions {
  min-width: 0;
  flex-wrap: wrap;
}
.todo-habit-scope {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--todo-space-4) var(--todo-space-12);
  margin: 0 0 var(--todo-space-16);
  color: var(--todo-muted);
  font-size: var(--todo-caption-size);
}
.todo-habit-scope > span {
  min-width: 0;
  overflow-wrap: anywhere;
}
.todo-habit-scope-label {
  display: inline-flex;
  align-items: center;
  gap: var(--todo-space-8);
}
.todo-habit-scope-label > span:last-child {
  min-width: 0;
  overflow-wrap: anywhere;
}
.todo-habit-scope .ant-btn {
  height: auto;
  padding: var(--todo-space-4) 0;
  font-size: var(--todo-font-size);
}
.todo-habit-today-group {
  display: grid;
  gap: var(--todo-space-12);
  min-width: 0;
}
@container (min-width: 1440px) {
  .todo-habit-today-group {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
  .todo-habit-today-heading {
    grid-column: 1 / -1;
  }
}
.todo-habit-today-heading {
  display: flex;
  gap: 8px;
  align-items: center;
  padding: 4px 0;
}
.todo-habit-today-heading small {
  color: var(--todo-muted);
  font-size: var(--todo-caption-size);
  font-weight: 400;
}
.todo-habit-date {
  margin-inline-start: auto;
  font-size: var(--todo-caption-size);
}
.todo-anniversary-title.ant-btn {
  display: block;
  max-width: 100%;
  height: auto;
  padding: 0;
  font-size: inherit;
  font-weight: 600;
  line-height: inherit;
  white-space: normal;
  text-align: start;
  overflow-wrap: anywhere;
}
.todo-anniversary-details {
  margin-top: auto;
  color: var(--todo-muted);
  font-size: var(--todo-caption-size);
}
.todo-anniversary-details summary {
  cursor: pointer;
  width: fit-content;
}
.todo-anniversary-details summary:focus-visible {
  outline: 2px solid var(--todo-accent);
  outline-offset: 4px;
  border-radius: 2px;
}
.todo-anniversary-details-content {
  display: grid;
  gap: var(--todo-space-8);
  margin-top: var(--todo-space-12);
  padding-top: var(--todo-space-12);
  border-top: 1px solid var(--todo-line);
  color: var(--todo-ink);
}
.todo-anniversaries {
  grid-template-columns: repeat(auto-fill, minmax(min(100%, 240px), 1fr));
}
.todo-anniversary {
  min-width: 0;
}
.todo-anniversary-today {
  color: var(--todo-accent);
  font-size: var(--todo-heading-line-height);
  font-weight: 600;
  padding-block: var(--todo-space-12);
}
.todo-habit-check {
  width: auto;
  min-width: 32px;
  padding-inline: 5px;
  display: inline-flex;
  gap: 3px;
  align-items: center;
  justify-content: center;
}
.todo-habit-check small {
  font-size: 10px;
}
.todo-habit-day-form {
  gap: 12px;
}
.todo-habit-day-form > p {
  margin: 0;
}
.todo-habit-entries {
  list-style: none;
  padding: 0;
  margin: 0;
  max-height: 240px;
  overflow-y: auto;
}
.todo-habit-entries li {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  border-bottom: 1px solid var(--todo-line);
  padding-block: 8px;
}
.todo-habit-entries li > div {
  min-width: 0;
  overflow-wrap: anywhere;
}
.todo-habit-entries li .ant-btn {
  flex: none;
}
.todo-habit-entries p {
  margin: 4px 0 0;
  color: var(--todo-muted);
  font-size: 12px;
}
@media (max-width: 600px) {
  .todo-habit-cards {
    gap: 10px;
  }
}
</style>
