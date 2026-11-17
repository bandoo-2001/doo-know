<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue';
import { Alert as AAlert, Button as AButton, Progress as AProgress } from 'ant-design-vue';
import type { ToDooEntityMap } from '../../../../shared/to-doo-contracts';
import {
  getHabitGoalMode,
  getHabitPeriod,
  getHabitRule,
  habitStreak,
  summarizeHabitPeriod,
  sumHabitAmounts,
} from '../../../../shared/to-doo-habits';
import { shiftToDooDate, toDooLocalDate, type ToDooWorkbench } from '../../to-doo-workbench';
import { formatHabitSchedule } from '../../to-doo-habit-presentation';
import { buildHabitTrend, habitPeriodPlan } from '../../to-doo-habit-insights';
import ToDooIcon from './ToDooIcon.vue';
import ToDooListIcon from './ToDooListIcon.vue';

type HabitEntry = ToDooEntityMap['habitEntry'];
const props = defineProps<{
  model: ToDooWorkbench;
  habit: ToDooEntityMap['habit'];
  date: string;
  nowDate: string;
  list?: ToDooEntityMap['list'];
  ready?: boolean;
}>();
const emit = defineEmits<{
  close: [];
  edit: [];
  'select-date': [date: string];
  record: [date: string];
  list: [id: string];
  'open-note': [id: string];
  'focus-session': [id: string];
}>();
const values = ref<HabitEntry[]>([]);
const loading = ref(false);
const error = ref('');
const month = ref(props.date.slice(0, 7));
const body = ref<HTMLElement>();
let epoch = 0;
const dataKey = computed(() =>
  JSON.stringify([
    props.model.state.snapshot?.datasetId,
    props.model.state.snapshot?.version,
    props.habit.id,
    props.habit.revision,
    props.nowDate,
  ]),
);
async function loadEntries() {
  const token = ++epoch;
  const key = dataKey.value;
  const habitId = props.habit.id;
  const datasetId = props.model.state.snapshot?.datasetId;
  loading.value = true;
  error.value = '';
  const records: HabitEntry[] = [];
  let cursor: string | undefined;
  let version: string | undefined;
  const current = () => token === epoch && key === dataKey.value;
  try {
    do {
      const query = new URLSearchParams({ kind: 'habitEntry', sort: 'recent', limit: '200' });
      if (cursor) query.set('cursor', cursor);
      const snapshot = await props.model.request('/api/to-doo/state?' + query);
      if (!current()) return;
      if (datasetId && snapshot.datasetId !== datasetId)
        throw Error('数据空间已变化，请刷新页面后再查看习惯记录。');
      version ??= snapshot.version;
      if (snapshot.version !== version) throw Error('读取期间记录有更新，请重新读取后查看。');
      records.push(
        ...snapshot.habitEntries.filter(
          (entry: HabitEntry) => entry.habitId === habitId && !entry.deletedAt,
        ),
      );
      cursor = snapshot.page?.nextCursor || undefined;
    } while (cursor);
    if (current()) values.value = records;
  } catch (cause) {
    if (current()) error.value = cause instanceof Error ? cause.message : String(cause);
  } finally {
    if (current()) loading.value = false;
  }
}
watch(
  dataKey,
  () => {
    void loadEntries();
  },
  { immediate: true },
);
watch(
  () => props.date,
  (date) => {
    month.value = date.slice(0, 7);
  },
);
watch(
  () => props.habit.id,
  () => {
    values.value = [];
    month.value = props.date.slice(0, 7);
    if (body.value) body.value.scrollTop = 0;
  },
);
onBeforeUnmount(() => {
  epoch++;
});

const recordsByDate = computed(() => {
  const dates = new Map<string, HabitEntry[]>();
  for (const record of values.value) {
    const date = dates.get(record.localDate) || [];
    date.push(record);
    dates.set(record.localDate, date);
  }
  return dates;
});
const ordinaryRecords = computed(() =>
  values.value.filter(
    (entry) => !entry.skipped && entry.amount > 0 && entry.localDate <= props.nowDate,
  ),
);
const totalDays = computed(
  () => new Set(ordinaryRecords.value.map((entry) => entry.localDate)).size,
);
const monthDays = computed(
  () =>
    new Set(
      ordinaryRecords.value
        .filter((entry) => entry.localDate.startsWith(month.value + '-'))
        .map((entry) => entry.localDate),
    ).size,
);
const selectedSummary = computed(() => selectedPlan.value.summary);
const selectedRule = computed(() => getHabitRule(props.habit, props.date));
const selectedPlan = computed(() =>
  habitPeriodPlan(props.habit, values.value, props.date, props.nowDate),
);
const trend = computed(() => buildHabitTrend(props.habit, values.value, props.nowDate, 14));
const trendMaximum = computed(() => Math.max(1, ...trend.value.days.map((day) => day.amount)));
const selectedDayAmount = computed(() => {
  const records = selectedEntries.value.filter((entry) => !entry.skipped && entry.amount > 0);
  return getHabitGoalMode(selectedRule.value) === 'checkin'
    ? Number(records.length > 0)
    : sumHabitAmounts(records.map(entry => entry.amount));
});
const dayUnit = computed(() =>
  getHabitGoalMode(selectedRule.value) === 'checkin' ? '次' : selectedRule.value.unit,
);
const actionState = computed(() => {
  if (props.date > props.nowDate) return '未来日期';
  if (props.habit.pausedDates.includes(props.date)) return '这一天休息';
  if (selectedEntries.value.some((entry) => entry.skipped)) return '这一天已跳过';
  if (
    selectedSummary.value.status === 'inactive' ||
    !getHabitPeriod(props.habit, props.date).scheduledDates.includes(props.date)
  )
    return '这一天无需记录';
  if (getHabitGoalMode(selectedRule.value) === 'checkin')
    return selectedDayAmount.value ? '已打卡' : '还未打卡';
  return selectedDayAmount.value ? '已记录' : '还未记录';
});
const nextStep = computed(() => {
  if (!ready.value) return '';
  if (recordDisabled.value) return actionState.value;
  const plan = selectedPlan.value;
  if (plan.remaining <= 0)
    return selectedRule.value.frequency === 'daily'
      ? '这一天的目标已达成。'
      : '所选周期的目标已达成，可以按自己的节奏继续。';
  if (plan.ended)
    return `这个周期还差 ${plan.remaining} ${plan.remainingUnit}；需要时可以补记实际完成的内容。`;
  if (selectedRule.value.frequency === 'daily')
    return `距离当天目标还差 ${plan.remaining} ${plan.remainingUnit}。`;
  return `本周期还差 ${plan.remaining} ${plan.remainingUnit}，剩 ${plan.remainingDates} 个可记录日。`;
});
const trendComparison = computed(() => {
  const change = trend.value.delta;
  if (!trend.value.comparable || change === null)
    return '计量方式有变化，按有记录的日期查看这两周。';
  if (!trend.value.current.activeDays && !trend.value.previous.activeDays)
    return '完成一次后，就能在这里看到实际记录的变化。';
  if (change === 0) return '两段时间的实际记录量相同。';
  return `最近 7 天比前 7 天${change > 0 ? '多' : '少'} ${Math.abs(change)} ${trend.value.unit}。`;
});
const streak = computed(() => habitStreak(props.habit, values.value, props.nowDate));
const streakUnit = computed(() => {
  const frequencies = new Set(props.habit.ruleVersions.map((rule) => rule.frequency));
  frequencies.add(props.habit.frequency);
  return frequencies.size > 1
    ? '个周期'
    : { daily: '天', weekly: '周', monthly: '月' }[props.habit.frequency];
});
const periodLabel = computed(
  () =>
    ({ daily: '所选日进度', weekly: '所选周进度', monthly: '所选月进度' })[
      selectedRule.value.frequency
    ],
);
const periodUnit = computed(() =>
  getHabitGoalMode(selectedRule.value) === 'checkin' ? '天' : selectedRule.value.unit,
);
const progress = computed(() =>
  Math.min(100, (selectedSummary.value.amount / selectedSummary.value.target) * 100),
);
const ready = computed(() => !loading.value && !error.value);
const recordDisabled = computed(() => {
  const period = getHabitPeriod(props.habit, props.date);
  return (
    !ready.value ||
    props.ready === false ||
    props.model.state.busy ||
    props.date > props.nowDate ||
    selectedSummary.value.status === 'inactive' ||
    !period.scheduledDates.includes(props.date)
  );
});
const selectedEntries = computed(() =>
  (recordsByDate.value.get(props.date) || [])
    .slice()
    .sort((a, b) => b.occurredAt.localeCompare(a.occurredAt)),
);
const periodCaption = computed(() =>
  selectedRule.value.frequency === 'daily'
    ? formatHabitSchedule(selectedRule.value)
    : `${selectedSummary.value.start} — ${shiftToDooDate(selectedSummary.value.endExclusive, -1)} · ${formatHabitSchedule(selectedRule.value)}`,
);
const weekStartsOn = computed(() => props.model.state.snapshot?.settings.weekStartsOn ?? 1);
const weekdays = computed(() =>
  Array.from({ length: 7 }, (_, index) => '日一二三四五六'[(weekStartsOn.value + index) % 7]),
);
const monthLabel = computed(
  () => `${Number(month.value.slice(0, 4))} 年 ${Number(month.value.slice(5))} 月`,
);
function moveMonth(offset: number) {
  const [year, calendarMonth] = month.value.split('-').map(Number);
  const index = year! * 12 + calendarMonth! - 1 + offset;
  if (index < 12 || index >= 120000) return;
  month.value = `${String(Math.floor(index / 12)).padStart(4, '0')}-${String((index % 12) + 1).padStart(2, '0')}`;
}
const calendarDays = computed(() => {
  const first = month.value + '-01';
  const weekday = new Date(first + 'T12:00:00Z').getUTCDay();
  const start = shiftToDooDate(first, -((weekday - weekStartsOn.value + 7) % 7));
  return Array.from({ length: 42 }, (_, index) => {
    const date = shiftToDooDate(start, index);
    const records = recordsByDate.value.get(date) || [];
    const period = getHabitPeriod(props.habit, date);
    const summary = summarizeHabitPeriod(props.habit, values.value, date);
    const recorded = records.some((entry) => !entry.skipped && entry.amount > 0);
    const state =
      date > props.nowDate
        ? 'future'
        : summary.status === 'inactive'
          ? 'inactive'
          : recorded && period.rule.frequency === 'daily' && summary.status === 'achieved'
            ? 'achieved'
            : recorded
              ? 'recorded'
              : records.some((entry) => entry.skipped)
                ? 'skipped'
                : !period.scheduledDates.includes(date)
                  ? 'rest'
                  : 'pending';
    const label = {
      future: '未来日期',
      inactive: '未安排',
      achieved: '已达标',
      recorded: '已记录',
      skipped: '已跳过',
      rest: '休息',
      pending: '未记录',
    }[state];
    return {
      date,
      number: Number(date.slice(-2)),
      outside: !date.startsWith(month.value),
      state,
      label,
    };
  });
});
function entryTime(entry: HabitEntry) {
  const zone = getHabitRule(props.habit, entry.localDate).timeZone;
  const instant = new Date(entry.occurredAt);
  const time = new Intl.DateTimeFormat('zh-CN', {
    timeZone: zone,
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).format(instant);
  const actualDate = toDooLocalDate(instant, zone);
  return actualDate === entry.localDate ? time : `${actualDate} ${time}`;
}
function escape(event: KeyboardEvent) {
  if (event.key !== 'Escape' || event.isComposing) return;
  event.preventDefault();
  event.stopPropagation();
  emit('close');
}
</script>

<template>
  <section
    class="todo-habit-detail"
    role="region"
    :aria-label="'习惯详情 ' + habit.name"
    :style="{ '--habit-detail-accent': habit.color || 'var(--todo-accent)' }"
    @keydown="escape"
  >
    <header class="todo-habit-detail-header">
      <span class="todo-habit-detail-icon" aria-hidden="true"
        ><span v-if="habit.icon">{{ habit.icon }}</span
        ><ToDooIcon v-else name="habits" :size="22"
      /></span>
      <div class="todo-habit-detail-heading">
        <h2 :title="habit.name">{{ habit.name }}</h2>
        <p><ToDooIcon name="repeat" :size="12" />{{ formatHabitSchedule(selectedRule) }}</p>
        <p
          v-if="habit.timeZone !== model.state.snapshot?.settings.timeZone"
          class="todo-habit-detail-zone"
        >
          记录时区 {{ habit.timeZone }}
        </p>
      </div>
      <AButton
        html-type="button"
        type="text"
        class="todo-habit-detail-edit"
        aria-label="编辑习惯"
        title="编辑习惯"
        @click="emit('edit')"
        ><ToDooIcon name="edit" :size="16"
      /></AButton>
      <AButton
        html-type="button"
        type="text"
        class="todo-icon-button"
        aria-label="关闭习惯详情"
        title="关闭"
        @click="emit('close')"
        ><ToDooIcon name="close" :size="16"
      /></AButton>
    </header>
    <div ref="body" class="todo-habit-detail-body" :aria-busy="loading">
      <AAlert
        v-if="model.state.error && !error"
        class="todo-habit-context-error"
        type="error"
        show-icon
        :message="model.state.error"
      />
      <AAlert v-if="error" type="error" show-icon :message="error"
        ><template #action
          ><AButton html-type="button" @click="loadEntries">重新读取</AButton></template
        ></AAlert
      >
      <p v-if="loading" class="todo-habit-detail-loading" role="status">正在读取完整记录…</p>
      <section
        class="todo-habit-detail-log todo-habit-detail-action"
        :aria-label="date + ' 习惯记录'"
      >
        <header>
          <div>
            <h3>
              <ToDooIcon name="calendar" :size="13" /><time :datetime="date" :title="date">{{
                date === nowDate ? '今天' : date
              }}</time>
            </h3>
          </div>
          <AButton
            html-type="button"
            type="primary"
            :disabled="recordDisabled"
            aria-label="记录这一天"
            :title="date < nowDate ? '补记这一天' : '记录这一天'"
            @click="emit('record', date)"
            ><ToDooIcon name="plus" :size="14" />{{ date < nowDate ? '补记' : '记录' }}</AButton
          >
        </header>
        <div class="todo-habit-detail-day-value" :title="nextStep">
          <strong>{{ ready ? selectedDayAmount : '—' }}</strong
          ><span v-if="selectedRule.frequency === 'daily'" class="todo-habit-detail-value-target"
            >/ {{ selectedSummary.target }}</span
          ><span>{{ dayUnit }}</span
          ><small v-if="ready" role="img" :aria-label="actionState" :title="actionState"
            ><ToDooIcon
              :name="
                actionState === '未来日期'
                  ? 'calendar'
                  : habit.pausedDates.includes(date) || actionState === '这一天无需记录'
                    ? 'pause'
                    : actionState === '这一天已跳过'
                      ? 'chevron'
                      : selectedSummary.status === 'achieved'
                        ? 'check'
                        : selectedDayAmount
                          ? 'note'
                          : 'habits'
              "
              :size="15"
          /></small>
        </div>
        <div
          v-if="selectedRule.frequency !== 'daily'"
          class="todo-habit-detail-period-progress"
          :title="periodCaption"
        >
          <span
            ><ToDooIcon name="repeat" :size="12" />{{
              selectedRule.frequency === 'weekly' ? '当周' : '当月'
            }}</span
          ><span
            >{{ ready ? selectedSummary.amount : '—' }} / {{ selectedSummary.target }}
            {{ periodUnit }}</span
          >
        </div>
        <AProgress
          v-if="ready"
          :percent="progress"
          :show-info="false"
          size="small"
          :stroke-color="habit.color"
          :aria-label="nextStep"
        />
        <p
          v-if="ready && selectedRule.frequency !== 'daily' && selectedPlan.remaining > 0"
          class="todo-habit-detail-next-step"
          :title="nextStep"
        >
          <ToDooIcon name="overview" :size="12" />余 {{ selectedPlan.remaining }}
          {{ selectedPlan.remainingUnit
          }}<span v-if="!selectedPlan.ended"> · {{ selectedPlan.remainingDates }} 天可记</span>
        </p>
        <ul v-if="ready && selectedEntries.length" class="todo-habit-detail-entries">
          <li v-for="entry in selectedEntries" :key="entry.id" :data-habit-entry-id="entry.id">
            <div>
              <span class="todo-habit-detail-entry-mark">{{
                entry.skipped
                  ? '已跳过'
                  : getHabitGoalMode(getHabitRule(habit, entry.localDate)) === 'checkin'
                    ? '已打卡'
                    : `${entry.amount} ${getHabitRule(habit, entry.localDate).unit}`
              }}</span
              ><span class="todo-habit-detail-entry-meta"
                ><time :datetime="entry.occurredAt">{{ entryTime(entry) }}</time
                ><AButton
                  v-if="entry.sourceSessionId"
                  html-type="button"
                  type="text"
                  class="todo-habit-detail-source"
                  aria-label="查看来源专注记录"
                  title="查看来源专注记录"
                  @click="emit('focus-session', entry.sourceSessionId)"
                  ><ToDooIcon name="focus" :size="14" /></AButton
              ></span>
            </div>
            <details v-if="entry.note" class="todo-habit-entry-note">
              <summary aria-label="展开记录备注" title="展开记录备注">
                <ToDooIcon name="note" :size="13" />备注
              </summary>
              <p>{{ entry.note }}</p>
            </details>
          </li>
        </ul>
      </section>
      <section class="todo-habit-detail-reflection" aria-label="最近两周回顾">
        <header>
          <h3><ToDooIcon name="trend" :size="14" />最近两周</h3>
          <span>{{ trend.days[0]?.date.slice(5) }} — {{ nowDate.slice(5) }}</span>
          <span
            class="todo-habit-detail-info"
            role="img"
            aria-label="图表口径"
            title="柱高表示当天实际记录量；周、月目标仍按周期累计。"
            ><ToDooIcon name="info" :size="14"
          /></span>
        </header>
        <div class="todo-habit-detail-trend" role="group" aria-label="最近两周实际记录">
          <button
            v-for="day in trend.days"
            :key="day.date"
            type="button"
            class="todo-habit-detail-trend-day"
            :class="{
              'is-recorded': ready && day.recorded,
              'is-selected': date === day.date,
              'is-rest': !day.scheduled,
            }"
            :disabled="!ready"
            :aria-label="day.date + ' · ' + day.amount + ' ' + day.unit"
            :aria-pressed="day.date === date"
            :title="
              day.date +
              ' · ' +
              day.amount +
              ' ' +
              day.unit +
              (day.skipped ? ' · 已跳过' : day.paused ? ' · 休息' : '')
            "
            @click="emit('select-date', day.date)"
          >
            <span class="todo-habit-detail-trend-track"
              ><span
                class="todo-habit-detail-trend-bar"
                :style="{
                  height:
                    ready && day.recorded
                      ? (trend.comparable ? Math.max(8, (day.amount / trendMaximum) * 100) : 55) +
                        '%'
                      : '3px',
                }"
            /></span>
            <span>{{ Number(day.date.slice(-2)) }}</span>
          </button>
        </div>
        <div class="todo-habit-detail-trend-summary">
          <div :title="trend.current.activeDays + ' 天有记录'">
            <span>最近 7 天</span
            ><strong
              >{{ ready ? (trend.comparable ? trend.current.total : trend.current.activeDays) : '—'
              }}<small>{{ trend.comparable ? trend.unit : '天有记录' }}</small></strong
            >
          </div>
          <div :title="trend.previous.activeDays + ' 天有记录'">
            <span>前 7 天</span
            ><strong
              >{{
                ready ? (trend.comparable ? trend.previous.total : trend.previous.activeDays) : '—'
              }}<small>{{ trend.comparable ? trend.unit : '天有记录' }}</small></strong
            >
          </div>
        </div>
        <p
          v-if="ready && trend.comparable && trend.delta !== null && trend.delta !== 0"
          class="todo-habit-detail-trend-delta"
          :title="trendComparison"
        >
          <ToDooIcon name="trend" :size="13" />{{ trend.delta > 0 ? '+' : '' }}{{ trend.delta }}
          {{ trend.unit }}<span>较前 7 天</span>
        </p>
        <p v-else-if="ready && !trend.comparable" class="todo-habit-detail-help">
          <ToDooIcon name="info" :size="12" />计量变化，按记录日对比
        </p>
        <p v-if="ready && trend.estimated" class="todo-habit-detail-help">
          <ToDooIcon name="info" :size="12" />含历史规则估算
        </p>
      </section>
      <section
        v-if="list || habit.noteRefs.length"
        class="todo-habit-detail-connections"
        aria-label="关联目标与资料"
      >
        <h3><ToDooIcon name="link" :size="14" />关联</h3>
        <AButton
          v-if="list"
          html-type="button"
          type="text"
          class="todo-habit-detail-connection"
          :disabled="!!list.archivedAt"
          :title="list.name"
          :aria-label="(list.kind === 'goal' ? '查看目标 ' : '查看清单 ') + list.name"
          @click="emit('list', list.id)"
          ><ToDooListIcon :list="list" :size="14" /><span
            class="todo-habit-detail-connection-label"
            >{{ list.name }}</span
          ><small v-if="list.archivedAt">已归档</small><ToDooIcon v-else name="external" :size="12"
        /></AButton>
        <AButton
          v-for="(note, index) in habit.noteRefs"
          :key="note.noteId"
          html-type="button"
          type="text"
          class="todo-habit-detail-connection"
          :aria-label="'打开关联资料 ' + (note.title || index + 1)"
          @click="emit('open-note', note.noteId)"
          ><ToDooIcon name="note" :size="14" /><span class="todo-habit-detail-connection-label">{{
            note.title || '关联资料 ' + (index + 1)
          }}</span
          ><ToDooIcon name="external" :size="12"
        /></AButton>
      </section>
      <details class="todo-habit-detail-calendar-disclosure">
        <summary aria-label="按日期查记录" title="按日期查记录">
          <ToDooIcon name="calendar" :size="14" /><span>日历</span>
        </summary>
        <section class="todo-habit-detail-calendar" aria-label="习惯月历">
          <header class="todo-habit-detail-month">
            <AButton
              html-type="button"
              type="text"
              class="todo-icon-button"
              aria-label="习惯月历上一月"
              @click="moveMonth(-1)"
              ><ToDooIcon name="back" :size="14"
            /></AButton>
            <h3>{{ monthLabel }}</h3>
            <AButton
              html-type="button"
              type="text"
              class="todo-icon-button"
              aria-label="习惯月历下一月"
              @click="moveMonth(1)"
              ><ToDooIcon name="chevron" :size="14"
            /></AButton>
          </header>
          <div class="todo-habit-detail-weekdays" aria-hidden="true">
            <span v-for="weekday in weekdays" :key="weekday">{{ weekday }}</span>
          </div>
          <div class="todo-habit-detail-calendar-grid">
            <button
              v-for="day in calendarDays"
              :key="day.date"
              type="button"
              class="todo-habit-detail-day"
              :class="[
                'is-' + day.state,
                {
                  'is-outside': day.outside,
                  'is-selected': day.date === date,
                  'is-today': day.date === nowDate,
                },
              ]"
              :disabled="!ready || day.date > nowDate"
              :aria-label="day.date + ' · ' + day.label"
              :aria-pressed="day.date === date"
              :title="day.date + ' · ' + day.label"
              @click="emit('select-date', day.date)"
            >
              <span class="todo-habit-detail-day-number">{{ day.number }}</span
              ><span class="todo-habit-detail-day-dot" aria-hidden="true"
                ><ToDooIcon v-if="ready && day.state === 'achieved'" name="check" :size="13" /><span
                  v-else-if="ready && day.state === 'recorded'"
                  class="todo-habit-detail-recorded-dot"
                /><span v-else-if="ready && day.state === 'skipped'">−</span></span
              >
            </button>
          </div>
          <div class="todo-habit-detail-legend">
            <span><i class="is-achieved" />已达标</span><span><i class="is-recorded" />已记录</span
            ><span><i class="is-rest" />休息 / 跳过</span>
          </div>
          <p v-if="selectedRule.frequency !== 'daily'" class="todo-habit-detail-help">
            周、月目标按周期累计；月历只标记实际记录的日期。
          </p>
        </section>
      </details>
      <details class="todo-habit-detail-statistics">
        <summary aria-label="更多统计" title="更多统计">
          <ToDooIcon name="stats" :size="14" /><span>统计</span>
        </summary>
        <dl class="todo-habit-detail-metrics" aria-label="习惯统计">
          <div>
            <dt>
              <ToDooIcon name="calendar" :size="13" />{{
                month === nowDate.slice(0, 7) ? '本月打卡' : '所选月打卡'
              }}
            </dt>
            <dd>{{ ready ? monthDays : '—' }}<span>天</span></dd>
          </div>
          <div>
            <dt><ToDooIcon name="completed" :size="13" />累计打卡</dt>
            <dd>{{ ready ? totalDays : '—' }}<span>天</span></dd>
          </div>
          <div>
            <dt><ToDooIcon name="repeat" :size="13" />当前连续</dt>
            <dd>
              {{ ready && !streak.truncated ? streak.current : '—' }}<span>{{ streakUnit }}</span>
            </dd>
          </div>
        </dl>
        <p class="todo-habit-detail-help" title="打卡天数按有记录的日期统计，连续按目标周期计算。">
          共 {{ values.length }} 条记录
        </p>
        <p
          v-if="ready && (streak.estimated || selectedSummary.estimated)"
          class="todo-habit-detail-help"
        >
          含历史规则估算
        </p>
        <p v-if="ready && streak.truncated" class="todo-habit-detail-help">连续次数暂未完整计算</p>
      </details>
      <details v-if="habit.description" class="todo-habit-detail-description">
        <summary><ToDooIcon name="note" :size="14" /><span>说明</span></summary>
        <p>{{ habit.description }}</p>
      </details>
    </div>
  </section>
</template>

<style scoped>
.todo-habit-context-error {
  display: none;
}
@media (max-width: 1100px) {
  .todo-habit-context-error {
    display: block;
  }
}
.todo-habit-detail {
  display: flex;
  flex-direction: column;
  min-width: 0;
  min-height: 0;
  height: 100%;
  overflow: hidden;
  border: 1px solid color-mix(in srgb, var(--todo-line) 85%, var(--todo-paper));
  border-radius: calc(var(--todo-radius) + 4px);
  background: var(--todo-paper);
  color: var(--todo-ink);
  box-shadow: 0 10px 32px color-mix(in srgb, var(--todo-ink) 5%, transparent);
}
.todo-habit-detail-header {
  display: flex;
  align-items: center;
  gap: 12px;
  flex: 0 0 auto;
  padding: 20px 18px;
  border-bottom: 1px solid color-mix(in srgb, var(--todo-line) 70%, transparent);
  background: linear-gradient(
    125deg,
    color-mix(in srgb, var(--habit-detail-accent) 8%, var(--todo-paper)),
    var(--todo-paper)
  );
}
.todo-habit-detail-icon {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 44px;
  height: 44px;
  flex: 0 0 44px;
  border: 1px solid color-mix(in srgb, var(--habit-detail-accent) 12%, transparent);
  border-radius: calc(var(--todo-radius) + 4px);
  background: color-mix(in srgb, var(--habit-detail-accent) 12%, var(--todo-paper));
  color: var(--habit-detail-accent);
  font-size: 25px;
}
.todo-habit-detail-heading {
  flex: 1;
  min-width: 0;
}
.todo-habit-detail-heading h2 {
  display: -webkit-box;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 2;
  overflow: hidden;
  margin: 0;
  font-size: 16px;
  font-weight: 600;
  line-height: 1.5;
  overflow-wrap: anywhere;
}
.todo-habit-detail-heading p {
  display: flex;
  align-items: center;
  gap: 5px;
  margin: 4px 0 0;
  color: var(--todo-muted);
  font-size: 12px;
  line-height: 1.5;
  overflow-wrap: anywhere;
}
.todo-habit-detail-heading .todo-habit-detail-zone {
  font-size: 11px;
}
.todo-habit-detail-header > .ant-btn {
  flex: 0 0 32px;
  border-radius: var(--todo-radius);
  background: color-mix(in srgb, var(--todo-paper) 70%, transparent);
}
.todo-habit-detail-header > .todo-habit-detail-edit.ant-btn {
  display: grid;
  place-items: center;
  flex-basis: 32px;
  padding: 0;
  background: transparent;
  color: var(--todo-muted);
  font-size: 12px;
}
.todo-habit-detail-body {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  overscroll-behavior: contain;
  scrollbar-gutter: stable;
  padding: 18px 18px 22px;
}
.todo-habit-detail-toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  min-width: 0;
  padding-block: 12px;
  font-size: 11px;
  color: var(--todo-muted);
}
.todo-habit-detail-toolbar > .ant-btn {
  padding-inline: 8px;
  font-size: 12px;
}
.todo-habit-detail-list {
  display: flex;
  align-items: center;
  gap: 5px;
  min-width: 0;
  color: var(--todo-muted);
}
.todo-habit-detail-list > span {
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}
.todo-habit-detail-loading {
  margin: 8px 0;
  font-size: 12px;
  color: var(--todo-muted);
}
.todo-habit-detail h3 {
  display: flex;
  align-items: center;
  gap: 6px;
  margin: 0;
  font-size: 13px;
  font-weight: 600;
  line-height: 1.5;
}
.todo-habit-detail-help {
  margin: 8px 0 0;
  color: var(--todo-muted);
  font-size: 12px;
  line-height: 1.6;
  overflow-wrap: anywhere;
}
.todo-habit-detail-action {
  margin-top: 0;
  padding: 18px;
  border: 1px solid color-mix(in srgb, var(--habit-detail-accent) 16%, var(--todo-line));
  border-radius: calc(var(--todo-radius) + 4px);
  background: linear-gradient(
    150deg,
    color-mix(in srgb, var(--habit-detail-accent) 6%, var(--todo-paper)),
    var(--todo-paper) 80%
  );
}
.todo-habit-detail-log > header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}
.todo-habit-detail-action > header > div {
  min-width: 0;
}
.todo-habit-detail-action > header h3 {
  font-size: 12px;
  color: var(--todo-muted);
  font-weight: 400;
  font-variant-numeric: tabular-nums;
}
.todo-habit-detail-action .ant-btn-primary:not(:disabled) {
  color: var(--todo-on-accent);
}
.todo-habit-detail-action > header > .ant-btn {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  flex: 0 0 auto;
  height: 34px;
  padding-inline: 12px;
  border-radius: var(--todo-control-radius);
  font-size: 12px;
  box-shadow: none;
}
.todo-habit-detail-kicker {
  margin: 0 0 4px;
  font-size: 13px;
  font-weight: 550;
  color: var(--todo-ink);
}
.todo-habit-detail-day-value {
  display: flex;
  align-items: baseline;
  flex-wrap: wrap;
  gap: 7px;
  margin-block: 16px 14px;
  font-variant-numeric: tabular-nums;
}
.todo-habit-detail-day-value > strong {
  font-size: 40px;
  font-weight: 600;
  line-height: 1.1;
  letter-spacing: -0.035em;
  overflow-wrap: anywhere;
}
.todo-habit-detail-day-value > span {
  color: var(--todo-muted);
  font-size: 12px;
  overflow-wrap: anywhere;
}
.todo-habit-detail-day-value > .todo-habit-detail-value-target {
  font-size: 20px;
  font-weight: 400;
}
.todo-habit-detail-day-value > small {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  margin-inline-start: auto;
  width: 28px;
  height: 28px;
  padding: 4px;
  border-radius: 20px;
  background: color-mix(in srgb, var(--habit-detail-accent) 9%, var(--todo-paper));
  color: var(--todo-ink);
  font-size: 11px;
  overflow-wrap: anywhere;
}
.todo-habit-detail-period-progress {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  flex-wrap: wrap;
  gap: 4px 8px;
  font-size: 12px;
  line-height: 1.5;
  overflow-wrap: anywhere;
}
.todo-habit-detail-period-progress > span:first-child {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  color: var(--todo-muted);
}
.todo-habit-detail-action :deep(.ant-progress) {
  margin-top: 7px;
}
.todo-habit-detail-action :deep(.ant-progress-inner) {
  background: color-mix(in srgb, var(--habit-detail-accent) 10%, var(--todo-paper));
}
.todo-habit-detail-next-step {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 3px;
  margin: 10px 0 0;
  font-size: 12px;
  line-height: 1.6;
  overflow-wrap: anywhere;
}
.todo-habit-detail-action > .todo-habit-detail-help {
  font-size: 11px;
}
.todo-habit-detail-empty {
  margin: 14px 0 0;
  padding: 14px 10px;
  border: 1px dashed color-mix(in srgb, var(--habit-detail-accent) 24%, var(--todo-line));
  border-radius: var(--todo-radius);
  background: color-mix(in srgb, var(--todo-paper) 70%, transparent);
  color: var(--todo-muted);
  font-size: 12px;
  text-align: center;
}
.todo-habit-detail-entries {
  display: grid;
  gap: 0;
  list-style: none;
  margin: 14px 0 0;
  padding: 0;
}
.todo-habit-detail-entries li {
  position: relative;
  padding: 8px 0 8px 15px;
  min-width: 0;
  border-top: 1px solid color-mix(in srgb, var(--habit-detail-accent) 10%, var(--todo-line));
}
.todo-habit-detail-entries li::before {
  content: '';
  position: absolute;
  top: 18px;
  left: 0;
  width: 5px;
  height: 5px;
  border-radius: 50%;
  background: color-mix(in srgb, var(--habit-detail-accent) 60%, var(--todo-paper));
}
.todo-habit-detail-entries li > div {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 8px;
  font-size: 12px;
}
.todo-habit-detail-entry-mark {
  color: var(--todo-ink);
  font-weight: 550;
  overflow-wrap: anywhere;
}
.todo-habit-detail-entries time {
  flex: 0 0 auto;
  color: var(--todo-muted);
  font-size: 11px;
  font-variant-numeric: tabular-nums;
}
.todo-habit-detail-entry-meta {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  flex: 0 0 auto;
}
.todo-habit-detail-entries p {
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  margin: 3px 0 0;
  color: var(--todo-muted);
  font-size: 12px;
  line-height: 1.6;
}
.todo-habit-detail .todo-habit-detail-source.ant-btn {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  justify-content: center;
  width: 24px;
  min-height: 24px;
  height: 24px;
  padding: 0;
  color: var(--todo-accent);
  font-size: 11px;
}
.todo-habit-detail-reflection {
  display: grid;
  gap: 10px;
  margin-top: 16px;
  padding: 14px;
  border: 1px solid var(--todo-line);
  border-radius: calc(var(--todo-radius) + 4px);
  background: var(--todo-paper);
}
.todo-habit-detail-reflection > header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 8px;
}
.todo-habit-detail-reflection > header > h3 {
  font-size: 14px;
}
.todo-habit-detail-reflection > header > span {
  font-size: 11px;
  color: var(--todo-muted);
  font-variant-numeric: tabular-nums;
}
.todo-habit-detail-reflection > header > span:first-of-type {
  margin-inline-start: auto;
}
.todo-habit-detail-info {
  display: inline-flex;
  align-items: center;
  flex: 0 0 auto;
  color: var(--todo-muted);
}
.todo-habit-detail-trend-delta {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 5px;
  margin: 0;
  color: var(--habit-detail-accent);
  font-size: 13px;
  font-weight: 550;
}
.todo-habit-detail-trend-delta > span {
  color: var(--todo-muted);
  font-size: 11px;
  font-weight: 400;
}
.todo-habit-detail-reflection > .todo-habit-detail-help {
  margin-top: 0;
}
.todo-habit-detail-trend {
  display: grid;
  grid-template-columns: repeat(14, minmax(0, 1fr));
  gap: 3px;
  min-width: 0;
  margin-top: 2px;
}
.todo-habit-detail-trend-day {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 7px;
  min-width: 0;
  padding: 5px 1px;
  border: 1px solid transparent;
  border-radius: 6px;
  background: transparent;
  color: var(--todo-muted);
  cursor: pointer;
  font-size: 11px;
  font-variant-numeric: tabular-nums;
}
.todo-habit-detail-trend-track {
  display: flex;
  align-items: flex-end;
  justify-content: center;
  width: 100%;
  height: 72px;
}
.todo-habit-detail-trend-bar {
  display: block;
  width: min(100%, 12px);
  border-radius: 4px 4px 2px 2px;
  background: var(--todo-line);
}
.todo-habit-detail-trend-day.is-recorded .todo-habit-detail-trend-bar {
  background: var(--habit-detail-accent);
}
.todo-habit-detail-trend-day:nth-child(-n + 7).is-recorded .todo-habit-detail-trend-bar {
  background: color-mix(in srgb, var(--habit-detail-accent) 50%, var(--todo-paper));
}
.todo-habit-detail-trend-day.is-selected {
  background: color-mix(in srgb, var(--habit-detail-accent) 7%, var(--todo-paper));
  border-color: color-mix(in srgb, var(--habit-detail-accent) 26%, var(--todo-line));
  color: var(--todo-ink);
}
.todo-habit-detail-trend-day:disabled {
  cursor: default;
}
.todo-habit-detail-trend-day:focus-visible {
  outline: 2px solid var(--todo-accent);
  outline-offset: 1px;
}
.todo-habit-detail-trend-summary {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 10px;
}
.todo-habit-detail-trend-summary > div {
  display: grid;
  gap: 5px;
  min-width: 0;
  padding: 10px;
  border-radius: var(--todo-radius);
  background: var(--todo-soft);
}
.todo-habit-detail-trend-summary > div:first-child {
  background: color-mix(in srgb, var(--habit-detail-accent) 7%, var(--todo-paper));
}
.todo-habit-detail-trend-summary span,
.todo-habit-detail-trend-summary small {
  font-size: 11px;
  font-weight: 400;
  color: var(--todo-muted);
}
.todo-habit-detail-trend-summary strong {
  display: flex;
  align-items: baseline;
  flex-wrap: wrap;
  gap: 4px;
  font-size: 22px;
  font-weight: 600;
  line-height: 1.3;
  overflow-wrap: anywhere;
  letter-spacing: -0.02em;
}
.todo-habit-detail-connections {
  display: grid;
  gap: 8px;
  margin-top: 16px;
}
.todo-habit-detail-connections h3 {
  margin-bottom: 3px;
}
.todo-habit-detail .todo-habit-detail-connection.ant-btn {
  display: flex;
  justify-content: flex-start;
  align-items: center;
  gap: 9px;
  width: 100%;
  min-width: 0;
  height: auto;
  padding: 11px 12px;
  border: 1px solid var(--todo-line);
  border-radius: var(--todo-radius);
  background: color-mix(in srgb, var(--todo-soft) 65%, var(--todo-paper));
  font-size: 12px;
}
.todo-habit-detail .todo-habit-detail-connection.ant-btn:not(:disabled):hover {
  border-color: color-mix(in srgb, var(--todo-accent) 30%, var(--todo-line));
  background: color-mix(in srgb, var(--todo-accent) 5%, var(--todo-paper));
}
.todo-habit-detail-connection > .todo-habit-detail-connection-label {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  text-align: start;
}
.todo-habit-detail-connection > small {
  flex: 0 0 auto;
  color: var(--todo-muted);
  font-size: 11px;
}
.todo-habit-detail-calendar-disclosure,
.todo-habit-detail-statistics,
.todo-habit-detail-description {
  margin-top: 12px;
  padding: 0 14px;
  border: 1px solid var(--todo-line);
  border-radius: var(--todo-radius);
  background: var(--todo-paper);
}
.todo-habit-detail-calendar-disclosure > summary,
.todo-habit-detail-statistics > summary,
.todo-habit-detail-description > summary {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 13px 0;
  cursor: pointer;
  font-size: 12px;
  font-weight: 550;
  line-height: 1.6;
  list-style: none;
}
.todo-habit-detail-calendar-disclosure > summary::-webkit-details-marker,
.todo-habit-detail-statistics > summary::-webkit-details-marker,
.todo-habit-detail-description > summary::-webkit-details-marker {
  display: none;
}
.todo-habit-detail-calendar-disclosure > summary::before,
.todo-habit-detail-statistics > summary::before,
.todo-habit-detail-description > summary::before {
  content: '';
  width: 6px;
  height: 6px;
  border-right: 1.5px solid var(--todo-muted);
  border-bottom: 1.5px solid var(--todo-muted);
  transform: rotate(-45deg);
  order: 3;
  margin-inline-start: auto;
}
.todo-habit-detail-calendar-disclosure[open] > summary::before,
.todo-habit-detail-statistics[open] > summary::before,
.todo-habit-detail-description[open] > summary::before {
  transform: rotate(45deg);
}
.todo-habit-detail-calendar-disclosure[open],
.todo-habit-detail-statistics[open],
.todo-habit-detail-description[open] {
  padding-bottom: 14px;
}
.todo-habit-detail-calendar-disclosure > summary:focus-visible,
.todo-habit-detail-statistics > summary:focus-visible,
.todo-habit-detail-description > summary:focus-visible {
  outline: 2px solid var(--todo-accent);
  outline-offset: 2px;
  border-radius: 2px;
}
.todo-habit-detail-calendar {
  margin-top: 8px;
}
.todo-habit-detail-month {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  margin-bottom: 12px;
}
.todo-habit-detail-weekdays,
.todo-habit-detail-calendar-grid {
  display: grid;
  grid-template-columns: repeat(7, minmax(0, 1fr));
  gap: 4px;
}
.todo-habit-detail-weekdays {
  margin-bottom: 6px;
  color: var(--todo-muted);
  text-align: center;
  font-size: 11px;
}
.todo-habit-detail-day {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 4px;
  min-width: 0;
  min-height: 52px;
  padding: 3px 0;
  border: 1px solid transparent;
  border-radius: 8px;
  background: transparent;
  color: var(--todo-ink);
  cursor: pointer;
}
.todo-habit-detail-day-number {
  font-size: 11px;
  line-height: 15px;
  font-variant-numeric: tabular-nums;
}
.todo-habit-detail-day-dot {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 24px;
  flex: 0 0 24px;
  border: 2px solid color-mix(in srgb, var(--todo-muted) 20%, var(--todo-paper));
  border-radius: 50%;
  color: var(--todo-muted);
  font-size: 14px;
}
.todo-habit-detail-day.is-achieved .todo-habit-detail-day-dot {
  border-color: var(--habit-detail-accent);
  background: var(--habit-detail-accent);
  color: white;
}
.todo-habit-detail-day.is-recorded .todo-habit-detail-day-dot {
  border-color: var(--habit-detail-accent);
  color: var(--habit-detail-accent);
}
.todo-habit-detail-recorded-dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: currentColor;
}
.todo-habit-detail-day:is(.is-rest, .is-inactive, .is-skipped) .todo-habit-detail-day-dot {
  border-style: dashed;
  border-width: 1px;
  background: color-mix(in srgb, var(--todo-muted) 5%, transparent);
}
.todo-habit-detail-day.is-today .todo-habit-detail-day-number {
  color: var(--todo-accent);
  font-weight: 650;
}
.todo-habit-detail-day.is-selected {
  border-color: color-mix(in srgb, var(--todo-accent) 28%, var(--todo-line));
  background: color-mix(in srgb, var(--todo-accent) 8%, var(--todo-paper));
}
.todo-habit-detail-day.is-outside {
  opacity: 0.45;
}
.todo-habit-detail-day:disabled {
  cursor: default;
  opacity: 0.35;
}
.todo-habit-detail-day:focus-visible {
  outline: 2px solid var(--todo-accent);
  outline-offset: 1px;
}
.todo-habit-detail-legend {
  display: flex;
  flex-wrap: wrap;
  justify-content: center;
  gap: 10px;
  margin: 12px 0 0;
  color: var(--todo-muted);
  font-size: 11px;
}
.todo-habit-detail-legend > span {
  display: inline-flex;
  align-items: center;
  gap: 4px;
}
.todo-habit-detail-legend i {
  width: 7px;
  height: 7px;
  border-radius: 50%;
}
.todo-habit-detail-legend .is-achieved {
  background: var(--habit-detail-accent);
}
.todo-habit-detail-legend .is-recorded {
  border: 1px solid var(--habit-detail-accent);
}
.todo-habit-detail-legend .is-rest {
  border: 1px dashed var(--todo-muted);
}
.todo-habit-detail-metrics {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 8px;
  margin: 8px 0 0;
}
.todo-habit-detail-metrics > div {
  min-width: 0;
  padding: 12px 8px;
  border-radius: var(--todo-radius);
  background: var(--todo-soft);
}
.todo-habit-detail-metrics dt {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 5px;
  color: var(--todo-muted);
  font-size: 11px;
}
.todo-habit-detail-metrics dt svg {
  color: var(--habit-detail-accent);
}
.todo-habit-detail-metrics dd {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: 4px;
  margin: 7px 0 0;
  font-size: 22px;
  line-height: 1.25;
  font-weight: 600;
  font-variant-numeric: tabular-nums;
  overflow-wrap: anywhere;
}
.todo-habit-detail-metrics dd > span {
  font-size: 11px;
  font-weight: 400;
  color: var(--todo-muted);
}
.todo-habit-detail-metrics dd.todo-habit-detail-metric-progress {
  font-size: 20px;
}
.todo-habit-detail-description p {
  margin: 8px 0 0;
  color: var(--todo-muted);
  font-size: 12px;
  line-height: 1.7;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
@media (max-width: 400px) {
  .todo-habit-detail-header {
    padding: 16px 14px;
    gap: 10px;
  }
  .todo-habit-detail-icon {
    width: 40px;
    height: 40px;
    flex-basis: 40px;
    font-size: 24px;
    border-radius: var(--todo-radius);
  }
  .todo-habit-detail-body {
    padding-inline: 14px;
  }
  .todo-habit-detail-action,
  .todo-habit-detail-reflection {
    padding: 14px;
  }
  .todo-habit-detail-day-value > strong {
    font-size: 36px;
  }
  .todo-habit-detail-trend {
    gap: 2px;
  }
  .todo-habit-detail-trend-summary {
    gap: 8px;
  }
  .todo-habit-detail-trend-summary > div {
    padding: 10px;
  }
  .todo-habit-detail-trend-summary strong {
    font-size: 20px;
  }
  .todo-habit-detail-calendar-grid {
    gap: 2px;
  }
  .todo-habit-detail-day {
    min-height: 48px;
  }
}
.todo-habit-entry-note {
  margin-top: 6px;
}
.todo-habit-entry-note > summary {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  cursor: pointer;
  font-size: 11px;
  color: var(--todo-muted);
  list-style: none;
}
.todo-habit-entry-note > summary::-webkit-details-marker {
  display: none;
}
.todo-habit-entry-note > p {
  margin-top: 6px;
}
</style>
