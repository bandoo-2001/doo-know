<script setup lang="ts">
import { computed, onUnmounted, reactive, ref, watch } from 'vue';
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
import ToDooHint from './ToDooHint.vue';
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
  habitStreak,
  getHabitRule,
  summarizeHabitPeriod,
} from '../../../../shared/to-doo-habits';
const props = defineProps<{
  model: ToDooWorkbench;
  section: 'focus' | 'habits' | 'anniversaries';
  occurrenceId?: string;
}>();
const emit = defineEmits<{
  edit: [kind: ToDooEntityKind, entity?: Record<string, any>, seed?: Record<string, any>];
  task: [id: string, occurrenceId?: string];
}>();
const confirmAction = useToDooConfirm();
const { now: tick, active: clockActive } = useToDooClock();
const state = props.model.state,
  weekOffset = ref(0);
const today = computed(() =>
  toDooLocalDate(new Date(tick.value), state.snapshot?.settings.timeZone),
);
const habits = computed(() => state.snapshot?.habits.filter((h) => !h.deletedAt) || []);
const habitPane = ref('today');
const habitEntries = ref<ToDooEntityMap['habitEntry'][]>([]);
const habitLoading = ref(false),
  habitError = ref(''),
  appliedHabitQuery = ref('');
const quantities = reactive<Record<string, number | ''>>(Object.create(null));
const quantityErrors = reactive<Record<string, string>>(Object.create(null));
let habitEpoch = 0;
const statisticsHabit = ref<ToDooEntityMap['habit']>();
const habitStatistics = ref<{
  date: string;
  count: number;
  streak: ReturnType<typeof habitStreak>;
}>();
const statisticsLoading = ref(false),
  statisticsError = ref('');
let statisticsEpoch = 0;
async function openHabitStatistics(habit: ToDooEntityMap['habit']) {
  statisticsHabit.value = habit;
  habitStatistics.value = undefined;
  statisticsError.value = '';
  statisticsLoading.value = true;
  const token = ++statisticsEpoch,
    date = habitToday(habit);
  const values: ToDooEntityMap['habitEntry'][] = [];
  let cursor: string | undefined, version: string | undefined;
  try {
    do {
      const params = new URLSearchParams({ kind: 'habitEntry', sort: 'recent', limit: '200' });
      if (cursor) params.set('cursor', cursor);
      const snapshot = await props.model.request('/api/to-doo/state?' + params);
      if (token !== statisticsEpoch) return;
      version ??= snapshot.version;
      if (version !== snapshot.version) throw Error('读取期间记录有更新，请重新读取后查看连续记录');
      values.push(
        ...snapshot.habitEntries.filter(
          (entry: ToDooEntityMap['habitEntry']) => entry.habitId === habit.id,
        ),
      );
      cursor = snapshot.page.nextCursor || undefined;
    } while (cursor);
    habitStatistics.value = {
      date,
      count: values.length,
      streak: habitStreak(habit, values, date),
    };
  } catch (cause) {
    if (token === statisticsEpoch)
      statisticsError.value = cause instanceof Error ? cause.message : String(cause);
  } finally {
    if (token === statisticsEpoch) statisticsLoading.value = false;
  }
}
function closeHabitStatistics() {
  statisticsEpoch++;
  statisticsHabit.value = undefined;
  statisticsLoading.value = false;
}
const habitToday = (habit: ToDooEntityMap['habit']) =>
  toDooLocalDate(new Date(tick.value), habit.timeZone);
const quantityKey = (habit: ToDooEntityMap['habit']) => habit.id + ':' + habitToday(habit);
const quantity = (habit: ToDooEntityMap['habit']) =>
  quantities[quantityKey(habit)] ??
  (getHabitRule(habit, habitToday(habit)).frequency === 'daily'
    ? Math.max(
        0,
        getHabitRule(habit, habitToday(habit)).target - amount(habit.id, habitToday(habit)),
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
const habitRange = computed(() => {
  const periods = habits.value
    .flatMap((habit) =>
      [habitToday(habit), ...days.value].map((date) => getHabitPeriod(habit, date)),
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
const habitQueryKey = computed(() => JSON.stringify([habitRange.value, state.snapshot?.version]));
const habitReady = computed(
  () => !habitLoading.value && !habitError.value && appliedHabitQuery.value === habitQueryKey.value,
);
async function loadHabitEntries() {
  if (!clockActive.value || props.section !== 'habits') return;
  const token = ++habitEpoch,
    key = habitQueryKey.value;
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
      habitLoading.value = false;
      closeHabitStatistics();
    }
  },
  { immediate: true },
);
watch(
  quantities,
  () => {
    state.externalDirty.habits = Object.keys(quantities).length > 0;
  },
  { deep: true },
);
onUnmounted(() => {
  habitEpoch++;
  statisticsEpoch++;
  delete state.externalDirty.habits;
});
const anniversaries = computed(
  () =>
    state.snapshot?.anniversaries
      .filter((a) => !a.deletedAt)
      .map((a) => ({ entity: a, next: nextToDooAnniversary(a, today.value) }))
      .sort((a, b) => (a.next || '9999').localeCompare(b.next || '9999')) || [],
);
const anniversaryGroups = computed(() => {
  const bucket = (next: string | null) =>
    !next
      ? 'invalid'
      : next < today.value
        ? 'past'
        : next <= shiftToDooDate(today.value, 30)
          ? 'soon'
          : 'later';
  return [
    { id: 'soon', label: '未来 30 天' },
    { id: 'later', label: '更远的日子' },
    { id: 'past', label: '已经过去' },
    { id: 'invalid', label: '待核对日期' },
  ]
    .map((group) => ({
      ...group,
      items: anniversaries.value.filter((row) => bucket(row.next) === group.id),
    }))
    .filter((group) => group.items.length);
});
const entries = (habitId: string, date: string) =>
  habitEntries.value.filter((e) => !e.deletedAt && e.habitId === habitId && e.localDate === date) ||
  [];
const amount = (habitId: string, date: string) =>
  entries(habitId, date)
    .filter((e) => !e.skipped)
    .reduce((n, e) => n + e.amount, 0);
const summaries = computed(
  () =>
    new Map(
      habits.value.map((habit) => {
        const values = habitEntries.value.filter((e) => e.habitId === habit.id);
        return [
          habit.id,
          {
            days: new Map(
              [...new Set([...days.value, habitToday(habit)])].map((date) => [
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
async function skip(habit: ToDooEntityMap['habit'], date: string) {
  if (!habitReady.value || state.busy) return;
  return props.model.execute(
    {
      action: 'checkin_habit',
      payload: {
        habitId: habit.id,
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
type NumericDialog = { kind: 'habit'; habit: ToDooEntityMap['habit']; date: string };
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
const dialogExempt = computed(
  () => numericDialog.value && exemptDay(numericDialog.value.habit, numericDialog.value.date),
);
const numericValue = ref<number | ''>('');
const numericError = ref('');
function closeNumeric() {
  if (state.busy) return;
  numericDialog.value = null;
  numericError.value = '';
}
function checkin(habit: ToDooEntityMap['habit'], date: string) {
  if (!habitReady.value || state.busy) return;
  const rule = getHabitRule(habit, date);
  numericValue.value =
    rule.frequency === 'daily' ? Math.max(0, rule.target - amount(habit.id, date)) || '' : 1;
  numericError.value = '';
  numericDialog.value = { kind: 'habit', habit, date };
}
async function saveNumeric() {
  const dialog = numericDialog.value;
  if (!dialog || state.busy || dialogExempt.value || (ordinaryDialog.value && dialogRecorded.value))
    return;
  const value =
    getHabitGoalMode(getHabitRule(dialog.habit, dialog.date)) === 'checkin'
      ? 1
      : numericValue.value;
  if (value === '' || !Number.isFinite(value) || value <= 0) {
    numericError.value = '请输入大于 0 的数量';
    return;
  }
  const result = await props.model.execute(
    {
      action: 'checkin_habit',
      payload: {
        habitId: dialog.habit.id,
        localDate: dialog.date,
        amount: value,
        note: '',
        skipped: false,
        sourceSessionId: null,
      },
    },
    '习惯记录已保存',
  );
  if (result) {
    numericDialog.value = null;
    numericError.value = '';
  }
}
async function undo(habit: ToDooEntityMap['habit'], date: string) {
  if (!habitReady.value || state.busy) return;
  const values = entries(habit.id, date);
  if (!values.length) return;
  if (
    !(await confirmAction(`撤销 ${date}「${habit.name}」的 ${values.length} 条记录？`, {
      title: '撤销习惯记录',
      danger: true,
    }))
  )
    return;
  for (const entry of values) {
    const r = await props.model.removeEntity('habitEntry', entry);
    if (!r) return false;
  }
  return true;
}
async function undoEntry(entry: ToDooEntityMap['habitEntry']) {
  if (!habitReady.value || state.busy) return;
  if (
    !(await confirmAction('仅撤销这一条记录？其他记录和来源专注记录会保留，可从回收站恢复此条。', {
      title: '撤销单条习惯记录',
      danger: true,
    }))
  )
    return;
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
  if (!habitReady.value || state.busy) return;
  const key = quantityKey(habit),
    value =
      getHabitGoalMode(getHabitRule(habit, habitToday(habit))) === 'checkin' ? 1 : quantity(habit);
  if (
    getHabitGoalMode(getHabitRule(habit, habitToday(habit))) === 'checkin' &&
    amount(habit.id, habitToday(habit)) > 0
  )
    return;
  if (value === '' || !Number.isFinite(value) || value <= 0) {
    quantityErrors[key] = '请输入大于 0 的数量';
    return;
  }
  quantityErrors[key] = '';
  const result = await props.model.execute(
    {
      action: 'checkin_habit',
      payload: {
        habitId: habit.id,
        localDate: habitToday(habit),
        amount: value,
        skipped: false,
        note: '',
        sourceSessionId: null,
      },
    },
    '习惯记录已保存',
  );
  if (result && quantities[key] === value) delete quantities[key];
}
async function pauseToday(habit: ToDooEntityMap['habit'], date = habitToday(habit)) {
  if (state.busy) return;
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
  if (!dialog || state.busy) return;
  const result =
    action === 'undo'
      ? await undo(dialog.habit, dialog.date)
      : action === 'skip'
        ? await skip(dialog.habit, dialog.date)
        : await pauseToday(dialog.habit, dialog.date);
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
      @edit="(kind, entity, seed) => emit('edit', kind, entity, seed)"
      @task="(id, occurrence) => emit('task', id, occurrence)"
  /></KeepAlive>
  <template v-if="section === 'habits'"
    ><ToDooPageToolbar class="todo-calendar-toolbar">
      <ASegmented
        v-model:value="habitPane"
        aria-label="习惯视图"
        :options="[
          { label: '今天', value: 'today' },
          { label: '历史', value: 'history' },
        ]"
      />
      <span v-if="habitPane === 'today'" class="todo-muted">{{ today }}</span>
      <div v-else class="todo-actions">
        <AButton type="text" class="todo-icon-button" aria-label="上一周" @click="weekOffset--">
          ‹
        </AButton>
        <h2>{{ weekStart }} — {{ days[6] }}</h2>
        <AButton type="text" class="todo-icon-button" aria-label="下一周" @click="weekOffset++">
          ›
        </AButton>
      </div>
    </ToDooPageToolbar>
    <AAlert v-if="habitError" type="error" :message="habitError" show-icon
      ><template #action
        ><AButton @click="loadHabitEntries">重试读取习惯记录</AButton></template
      ></AAlert
    >
    <div v-if="habitPane === 'today'" class="todo-habit-cards" :aria-busy="habitLoading">
      <ToDooHabitCard
        v-for="h in habits"
        :key="h.id"
        :habit="h"
        :date="habitToday(h)"
        :show-local-date="
          habitToday(h) !== today || h.timeZone !== state.snapshot?.settings.timeZone
        "
        :summary="habitSummary(h, habitToday(h))"
        :amount="amount(h.id, habitToday(h))"
        :entry-count="entries(h.id, habitToday(h)).length"
        :skipped="entries(h.id, habitToday(h)).some((entry) => entry.skipped)"
        :exempt="exemptDay(h, habitToday(h))"
        :ready="habitReady"
        :busy="state.busy"
        :quantity="quantity(h)"
        :error="quantityErrors[quantityKey(h)]"
        @update:quantity="
          quantities[quantityKey(h)] = $event;
          quantityErrors[quantityKey(h)] = '';
        "
        @record="recordToday(h)"
        @edit="emit('edit', 'habit', h)"
        @skip="skip(h, habitToday(h))"
        @undo="undo(h, habitToday(h))"
        @pause="pauseToday(h)"
        @statistics="openHabitStatistics(h)"
        @entries="checkin(h, habitToday(h))"
      />
      <AEmpty v-if="!habits.length" description="从一件小事开始，记录每一次积累。" />
    </div>
    <template v-else>
      <ToDooHint :model="model" hint-id="habit-calendar-edit" class="todo-top-gap"
        >点击日期补记或调整记录。周／月累计请在“今天”查看。</ToDooHint
      >
      <section class="todo-panel todo-habit-table">
        <div class="todo-habit-row head">
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
        <AEmpty
          v-if="!habits.length"
          class="todo-empty"
          description="让一个小行动重复发生，习惯以真实数量记录，中断一天也可以继续。"
        >
          <AButton type="default" class="todo-button" @click="emit('edit', 'habit')"
            >新建习惯</AButton
          >
        </AEmpty>
      </section></template
    ></template
  >
  <template v-else-if="section === 'anniversaries'">
    <section v-for="group in anniversaryGroups" :key="group.id" class="todo-anniversary-group">
      <ToDooSectionHeader :title="group.label" />
      <div class="todo-anniversaries">
        <article
          v-for="a in group.items"
          :key="a.entity.id"
          class="todo-anniversary todo-panel"
          :data-card-style="a.entity.appearance?.style || 'bloom'"
          :data-card-palette="a.entity.appearance?.palette || 'rose'"
          :aria-label="'纪念日 ' + a.entity.name"
        >
          <div class="todo-between todo-anniversary-heading">
            <span v-if="a.entity.category" class="todo-badge">{{ a.entity.category }}</span
            ><AButton
              type="text"
              class="todo-icon-button"
              :aria-label="'编辑 ' + a.entity.name"
              @click="emit('edit', 'anniversary', a.entity)"
            >
              ⋯
            </AButton>
          </div>
          <h2>{{ a.entity.name }}</h2>
          <p v-if="a.next === today" class="todo-anniversary-today">就是今天</p>
          <p class="todo-days" v-else-if="a.next">
            <small>{{ a.next >= today ? '还有' : '已经' }}</small
            >{{ distance(a.next, a.entity) }}<small>天</small>
          </p>
          <p v-else class="todo-muted">暂未找到下一次日期，请检查闰月设置</p>
          <p v-if="a.entity.calendar === 'lunar'" class="todo-muted">
            农历原日期：{{ a.entity.date }}{{ a.entity.lunarLeapMonth ? '（闰月）' : '' }}
          </p>
          <p v-if="a.next" class="todo-muted">
            {{
              (!a.entity.repeatYearly && a.next < today) || a.next === today
                ? '公历日期'
                : '下次公历'
            }}：{{ a.next }}
          </p>
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
      class="todo-empty todo-panel"
      description="记得重要日子，也为它做好准备"
    >
      <AButton type="default" class="todo-button" @click="emit('edit', 'anniversary')">
        新建纪念日
      </AButton>
    </AEmpty></template
  >
  <AModal
    :open="!!statisticsHabit"
    :title="(statisticsHabit?.name || '') + ' · 连续记录'"
    :footer="null"
    wrap-class-name="todo-ant-modal"
    @cancel="closeHabitStatistics"
  >
    <p v-if="statisticsLoading" role="status">正在读取全部记录…</p>
    <AAlert v-if="statisticsError" type="error" :message="statisticsError" show-icon />
    <div v-if="habitStatistics" class="todo-form">
      <p>已读取 {{ habitStatistics.count }} 条记录 · 截至 {{ habitStatistics.date }}</p>
      <p>
        当前连续 {{ habitStatistics.streak.current }} 期 · 最长连续
        {{ habitStatistics.streak.longest }} 期
      </p>
      <ToDooHint :model="model" hint-id="habit-statistics-rules"
        >按记录当天的规则和日／周／月周期计算；暂停与跳过使用当期规则。</ToDooHint
      >
      <AAlert
        v-if="habitStatistics.streak.estimated"
        type="info"
        :message="
          habitStatistics.streak.truncated
            ? '超过 5000 个周期，连续结果仅供参考'
            : '旧记录缺少完整规则版本，结果包含历史规则估算'
        "
      />
    </div>
    <AButton
      v-if="statisticsError && statisticsHabit"
      :loading="statisticsLoading"
      @click="openHabitStatistics(statisticsHabit)"
      >重新读取连续记录</AButton
    >
  </AModal>
  <AModal
    wrap-class-name="todo-ant-modal"
    :open="clockActive && !!numericDialog"
    :title="ordinaryDialog ? '习惯打卡' : '记录习惯数量'"
    :ok-text="ordinaryDialog ? (dialogRecorded ? '已打卡' : '打卡') : '保存'"
    :ok-button-props="{ disabled: !!dialogExempt || (ordinaryDialog && !!dialogRecorded) }"
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
      <ToDooHint
        :model="model"
        :hint-id="ordinaryDialog ? 'habit-checkin-save' : 'habit-quantity-save'"
        >{{
          ordinaryDialog ? '点击打卡后保存本次记录' : '点击保存后记录本次新增'
        }}；关闭会放弃本次输入，已保存记录保留。</ToDooHint
      >
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
      <p v-if="dialogExempt" class="todo-muted">这一天无需记录。</p>
      <p v-else-if="ordinaryDialog">
        {{ dialogRecorded ? '这一天已打卡。' : '完成后记录一次打卡。' }}
      </p>
      <label v-else
        >本次新增
        <AInputNumber
          :value="numericValue"
          :min="0"
          :disabled="state.busy || !!dialogExempt"
          aria-label="习惯数量"
          autofocus
          @update:value="numericValue = $event === null || $event === '' ? '' : Number($event)"
        />
      </label>
      <div v-if="numericDialog" class="todo-actions">
        <AButton
          v-if="entries(numericDialog.habit.id, numericDialog.date).length"
          type="link"
          :disabled="state.busy"
          @click="adjustHistory('undo')"
          >撤销当天记录</AButton
        >
        <AButton
          v-else-if="!dialogExempt"
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
    </form>
  </AModal>
</template>

<style scoped>
.todo-anniversary-heading > .ant-btn {
  margin-left: auto;
}
.todo-anniversary-details {
  margin-top: auto;
  color: var(--todo-muted);
  font-size: 12px;
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
  gap: 10px;
  margin-top: 12px;
  padding-top: 12px;
  border-top: 1px solid var(--todo-line);
  color: var(--todo-ink);
}
.todo-anniversaries {
  grid-template-columns: repeat(auto-fill, minmax(min(100%, 260px), 340px));
}
.todo-anniversary {
  min-width: 0;
}
.todo-anniversary-today {
  color: var(--todo-accent);
  font-size: 28px;
  font-weight: 650;
  padding-block: 12px;
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
