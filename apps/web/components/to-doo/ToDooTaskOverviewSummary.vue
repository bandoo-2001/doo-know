<script setup lang="ts">
import { computed, onUnmounted, ref, watch } from 'vue';
import { Alert as AAlert, Button as AButton } from 'ant-design-vue';
import type {
  ToDooEntityMap,
  ToDooFocusHistory,
  ToDooSnapshot,
} from '../../../../shared/to-doo-contracts';
import {
  getHabitGoalMode,
  getHabitPeriod,
  summarizeHabitPeriod,
} from '../../../../shared/to-doo-habits';
import { shiftToDooDate, toDooLocalDate, type ToDooWorkbench } from '../../to-doo-workbench';
import { useToDooClock } from '../../to-doo-time';
import ToDooIcon from './ToDooIcon.vue';

const props = defineProps<{ model: ToDooWorkbench }>();
const { now, active } = useToDooClock();
const loading = ref(false),
  error = ref('');
const summary = ref<{ completed: number; total: number; minutes: number }>();
const today = computed(() =>
  toDooLocalDate(new Date(now.value), props.model.state.snapshot?.settings.timeZone),
);
const weekStart = computed(() => {
  const weekday = new Date(today.value + 'T12:00:00Z').getUTCDay();
  return shiftToDooDate(
    today.value,
    -((weekday - (props.model.state.snapshot?.settings.weekStartsOn ?? 1) + 7) % 7),
  );
});
const weekEnd = computed(() => shiftToDooDate(weekStart.value, 6));
const queryKey = computed(() =>
  JSON.stringify([
    props.model.state.snapshot?.datasetId,
    props.model.state.snapshot?.version,
    props.model.state.snapshot?.settings.timeZone,
    today.value,
    weekStart.value,
  ]),
);
const duration = computed(() => {
  const value = summary.value?.minutes ?? 0;
  if (value > 0 && value < 1) return '不足 1 分钟';
  const minutes = Math.round(value),
    hours = Math.floor(minutes / 60),
    rest = minutes % 60;
  return hours ? `${hours} 小时${rest ? ` ${rest} 分钟` : ''}` : `${minutes} 分钟`;
});
let epoch = 0,
  focusEpoch = 0,
  runningFocus = false,
  refreshingFocus = false,
  habitTimeZones: string[] = [];

function readFocus() {
  const params = new URLSearchParams({ from: weekStart.value, to: weekEnd.value, limit: '1' });
  return props.model.request('/api/to-doo/focus/history?' + params) as Promise<ToDooFocusHistory>;
}

async function refreshRunningFocus() {
  if (!active.value || !runningFocus || !summary.value || loading.value || refreshingFocus) return;
  const token = epoch,
    focusToken = ++focusEpoch,
    key = queryKey.value;
  const dataset = props.model.state.snapshot?.datasetId;
  const current = () =>
    token === epoch && focusToken === focusEpoch && active.value && key === queryKey.value;
  refreshingFocus = true;
  try {
    const focus = await readFocus();
    if (!current() || !summary.value) return;
    if (focus.datasetId !== dataset) throw Error('工作空间已变化，请重新读取概览');
    summary.value.minutes = focus.overview.filtered.minutes;
    runningFocus = focus.active?.status === 'running' && focus.active.mode !== 'break';
    error.value = '';
  } catch (cause) {
    if (current()) error.value = cause instanceof Error ? cause.message : '暂时无法更新专注概览';
  } finally {
    if (focusToken === focusEpoch) refreshingFocus = false;
  }
}

async function readPages<K extends 'habit' | 'habitEntry'>(
  kind: K,
  dataset: string,
  current: () => boolean,
  range: { from?: string; to?: string } = {},
  version?: string,
) {
  const items: ToDooEntityMap[K][] = [],
    seen = new Set<string>();
  let cursor: string | undefined;
  do {
    const params = new URLSearchParams({ kind, limit: '200', ...range });
    if (cursor) params.set('cursor', cursor);
    const snapshot = (await props.model.request('/api/to-doo/state?' + params)) as ToDooSnapshot;
    if (!current()) throw Error('概览已切换');
    if (snapshot.datasetId !== dataset) throw Error('工作空间已变化，请重新读取概览');
    version ??= snapshot.version;
    if (snapshot.version !== version) throw Error('读取期间记录有更新，请重新读取概览');
    const collection = kind === 'habit' ? 'habits' : 'habitEntries';
    items.push(...(snapshot[collection] as ToDooEntityMap[K][]));
    cursor = snapshot.page.nextCursor || undefined;
    if (cursor && seen.has(cursor)) throw Error('概览记录尚未读取完整，请重试');
    if (cursor) seen.add(cursor);
  } while (cursor);
  return { items, version };
}

async function load() {
  const dataset = props.model.state.snapshot?.datasetId;
  if (!active.value || !dataset) return;
  const token = ++epoch,
    key = queryKey.value;
  focusEpoch++;
  refreshingFocus = false;
  runningFocus = false;
  const current = () => token === epoch && active.value && queryKey.value === key;
  loading.value = true;
  error.value = '';
  summary.value = undefined;
  try {
    const [habitPage, focus] = await Promise.all([
      readPages('habit', dataset, current),
      readFocus(),
    ]);
    if (!current()) return;
    if (focus.datasetId !== dataset) throw Error('工作空间已变化，请重新读取概览');
    const habits = habitPage.items.filter((habit) => !habit.deletedAt);
    habitTimeZones = [...new Set(habits.map((habit) => habit.timeZone))];
    const dates = habits.map((habit) => ({
      habit,
      date: toDooLocalDate(new Date(now.value), habit.timeZone),
    }));
    const periods = dates.map(({ habit, date }) => getHabitPeriod(habit, date));
    const scheduled = dates.filter(({ date }, index) =>
      periods[index]!.scheduledDates.includes(date),
    );
    let entries: ToDooEntityMap['habitEntry'][] = [];
    if (scheduled.length) {
      const range = periods.reduce(
        (value, period) => ({
          from: period.start < value.from ? period.start : value.from,
          to:
            shiftToDooDate(period.endExclusive, -1) > value.to
              ? shiftToDooDate(period.endExclusive, -1)
              : value.to,
        }),
        { from: today.value, to: today.value },
      );
      entries = (await readPages('habitEntry', dataset, current, range, habitPage.version)).items;
    }
    if (!current()) return;
    let completed = 0,
      total = 0;
    for (const { habit, date } of scheduled) {
      const period = summarizeHabitPeriod(habit, entries, date);
      if (period.status === 'inactive' || period.status === 'exempt') continue;
      total++;
      const achieved =
        getHabitGoalMode(period.rule) === 'checkin'
          ? entries.some(
              (entry) =>
                entry.habitId === habit.id &&
                !entry.deletedAt &&
                !entry.skipped &&
                entry.localDate === date &&
                entry.amount > 0,
            )
          : period.status === 'achieved';
      if (achieved) completed++;
    }
    summary.value = { completed, total, minutes: focus.overview.filtered.minutes };
    runningFocus = focus.active?.status === 'running' && focus.active.mode !== 'break';
  } catch (cause) {
    if (current()) error.value = cause instanceof Error ? cause.message : '暂时无法读取概览';
  } finally {
    if (current()) loading.value = false;
  }
}
watch(
  [queryKey, active],
  () => {
    if (active.value) void load();
    else {
      epoch++;
      focusEpoch++;
      refreshingFocus = false;
      runningFocus = false;
      loading.value = false;
    }
  },
  { immediate: true },
);
watch(now, (current, previous) => {
  const zone = props.model.state.snapshot?.settings.timeZone;
  if (
    toDooLocalDate(new Date(current), zone) === toDooLocalDate(new Date(previous), zone) &&
    habitTimeZones.some(
      (habitZone) =>
        toDooLocalDate(new Date(current), habitZone) !==
        toDooLocalDate(new Date(previous), habitZone),
    )
  )
    void load();
  else if (toDooLocalDate(new Date(current), zone) === toDooLocalDate(new Date(previous), zone))
    void refreshRunningFocus();
});
onUnmounted(() => {
  epoch++;
  focusEpoch++;
});
</script>

<template>
  <section class="todo-overview-summary" aria-label="习惯与专注概览" :aria-busy="loading">
    <dl>
      <div
        class="todo-overview-summary-metric"
        title="仅计今天需记录的习惯；打卡按今天记录，数量目标按当前周期达标计。"
      >
        <ToDooIcon name="habits" :size="26" />
        <dt>今日习惯</dt>
        <dd v-if="summary">
          <strong>{{ summary.completed }}</strong> / {{ summary.total }}
        </dd>
        <dd v-else aria-label="今日习惯尚未读取">—</dd>
      </div>
      <div
        class="todo-overview-summary-metric"
        :title="`${weekStart} 至 ${weekEnd}，按工作空间时区统计实际专注时间，不含休息。`"
      >
        <ToDooIcon name="focus" :size="26" />
        <dt>本周专注</dt>
        <dd v-if="summary">
          <strong>{{ duration }}</strong>
        </dd>
        <dd v-else aria-label="本周专注尚未读取">—</dd>
      </div>
    </dl>
    <p v-if="loading" class="todo-overview-summary-status" role="status">正在读取习惯与专注…</p>
    <AAlert
      v-else-if="error"
      class="todo-overview-summary-status todo-overview-summary-error"
      type="error"
      role="alert"
    >
      <template #message>
        <span>{{ error }}</span>
        <AButton html-type="button" type="link" aria-label="重试读取习惯与专注概览" @click="load">
          重试
        </AButton>
      </template>
    </AAlert>
  </section>
</template>

<style scoped>
.todo-overview-summary {
  box-sizing: border-box;
  min-height: 68px;
  margin: 0;
  padding: 16px 28px;
  border: 1px solid var(--todo-line);
  border-radius: 10px;
  background: color-mix(in srgb, var(--todo-accent) 3%, var(--todo-paper));
}
.todo-overview-summary dl {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
  margin: 0;
}
.todo-overview-summary-metric {
  display: flex;
  gap: 10px;
  align-items: center;
  min-width: 0;
  font-size: 20px;
  line-height: 28px;
}
.todo-overview-summary-metric + .todo-overview-summary-metric {
  padding-left: 28px;
  border-left: 1px solid var(--todo-line);
}
.todo-overview-summary-metric :deep(svg) {
  color: var(--todo-accent);
  flex-shrink: 0;
}
.todo-overview-summary dt {
  font-weight: 600;
}
.todo-overview-summary dd {
  min-width: 0;
  margin: 0;
  overflow-wrap: anywhere;
}
.todo-overview-summary strong {
  color: var(--todo-accent);
  font-size: 24px;
  font-weight: 650;
}
.todo-overview-summary-status {
  margin: 10px 0 0;
  font-size: 12px;
  color: var(--todo-muted);
}
.todo-overview-summary-error :deep(.ant-alert-message) {
  display: flex;
  gap: 12px;
  align-items: center;
  flex-wrap: wrap;
}
@media (max-width: 600px) {
  .todo-overview-summary {
    padding: 12px;
  }
  .todo-overview-summary-metric {
    gap: 7px;
    flex-wrap: wrap;
    font-size: 13px;
    line-height: 20px;
  }
  .todo-overview-summary-metric :deep(svg) {
    width: 22px;
    height: 22px;
  }
  .todo-overview-summary-metric + .todo-overview-summary-metric {
    padding-left: 12px;
  }
  .todo-overview-summary strong {
    font-size: 15px;
  }
  .todo-overview-summary dd {
    box-sizing: border-box;
    flex-basis: 100%;
    padding-left: 29px;
  }
}
</style>
