<script setup lang="ts">
import { computed, nextTick, onActivated, onUnmounted, ref, watch } from 'vue';
import {
  Alert as AAlert,
  Button as AButton,
  Dropdown as ADropdown,
  Menu as AMenu,
  Empty as AEmpty,
  Input as AInput,
  Progress as AProgress,
  Segmented as ASegmented,
  Statistic as AStatistic,
  Tabs as ATabs,
} from 'ant-design-vue';
import ToDooDateField from './ToDooDateField.vue';
import ToDooIcon from './ToDooIcon.vue';
import { createToDooReminderController } from '../../to-doo-reminders';
import ToDooPageToolbar from './ToDooPageToolbar.vue';
import ToDooSectionHeader from './ToDooSectionHeader.vue';
import ToDooHint from './ToDooHint.vue';
import { useToDooClock } from '../../to-doo-time';
import type { ToDooEntityKind, ToDooEntityMap } from '../../../../shared/to-doo-contracts';
import type { ToDooReminderSource } from '../../../../shared/to-doo-contracts';
import { shiftToDooDate, toDooLocalDate, type ToDooWorkbench } from '../../to-doo-workbench';
const props = defineProps<{
  model: ToDooWorkbench;
  section: 'stats' | 'notifications';
  context?: string;
  contextualNavigation?: boolean;
}>();
const emit = defineEmits<{
  'context-change': [value: string];
  edit: [kind: ToDooEntityKind, entity?: Record<string, any>, seed?: Record<string, any>];
  task: [id: string, occurrenceId?: string];
  source: [context: ToDooReminderSource];
}>();
const { now } = useToDooClock();
const state = props.model.state,
  today = computed(() => toDooLocalDate(new Date(now.value), state.snapshot?.settings.timeZone)),
  from = ref(shiftToDooDate(today.value, -6)),
  to = ref(today.value);
const customRange = ref(false);
const periodPreset = computed(() =>
  customRange.value
    ? 'custom'
    : from.value === shiftToDooDate(today.value, -6) && to.value === today.value
      ? 'week'
      : from.value === shiftToDooDate(today.value, -29) && to.value === today.value
        ? 'month'
        : 'custom',
);
async function selectPeriod(value: string | number) {
  customRange.value = value === 'custom';
  if (customRange.value) return;
  from.value = shiftToDooDate(today.value, value === 'month' ? -29 : -6);
  to.value = today.value;
  await range();
}
const lists = computed(
  () =>
    state.snapshot?.lists.filter((l) => !l.deletedAt && !l.archivedAt && l.kind === 'goal') || [],
);
const listProgress = (id: string) => {
  const item = state.snapshot?.statistics.byList[id];
  return item?.total ? Math.min(100, Math.round((item.completed / item.total) * 100)) : 0;
};
const ATabPane = ATabs.TabPane,
  AMenuItem = AMenu.Item;
const reminderController = createToDooReminderController(props.model.request);
const actingReminder = computed(() => reminderController.state.busy);
onUnmounted(() => {
  ++sourceRequest;
  reminderController.dispose();
});
type ReminderState = ToDooEntityMap['reminderEvent']['userState'];
const notificationTabs: { value: ReminderState | 'all'; label: string }[] = [
  { value: 'all', label: '全部' },
  { value: 'unread', label: '未读' },
  { value: 'read', label: '已读' },
  { value: 'acknowledged', label: '已确认' },
  { value: 'snoozed', label: '稍后' },
  { value: 'dismissed', label: '忽略' },
];
const notificationFilter = computed<ReminderState | 'all'>(() => {
  if (!props.contextualNavigation) return state.query.reminderStates?.[0] ?? 'all';
  return notificationTabs.find((tab) => tab.value === props.context)?.value ?? 'all';
});
const notificationSearch = ref(state.query.filter?.query ?? '');
const notificationFrom = ref(state.query.from ?? '');
const notificationTo = ref(state.query.to ?? '');
watch(
  () => state.query.filter?.query,
  (value) => {
    notificationSearch.value = value ?? '';
  },
);
watch(
  () => state.query.from,
  (value) => {
    notificationFrom.value = value ?? '';
  },
);
watch(
  () => state.query.to,
  (value) => {
    notificationTo.value = value ?? '';
  },
);
const hasNotificationFilters = computed(
  () => !!(notificationSearch.value || notificationFrom.value || notificationTo.value),
);
async function applyNotificationFilters() {
  if (state.loading || state.busy || markingAll.value || actingReminder.value) return;
  if (
    notificationFrom.value &&
    notificationTo.value &&
    notificationFrom.value > notificationTo.value
  ) {
    state.error = '结束日期不能早于开始日期';
    return;
  }
  ++sourceRequest;
  await props.model.load({
    ...state.query,
    from: notificationFrom.value || undefined,
    to: notificationTo.value || undefined,
    filter: { ...state.query.filter, query: notificationSearch.value.trim() || undefined },
    cursor: undefined,
  });
}
async function clearNotificationFilters() {
  notificationSearch.value = '';
  notificationFrom.value = '';
  notificationTo.value = '';
  await applyNotificationFilters();
}
const statisticsOverview = ref<HTMLElement>();
const statisticsGoals = ref<HTMLElement>();
const statisticsReviews = ref<HTMLElement>();
async function scrollStatisticsContext() {
  if (props.section !== 'stats' || !props.contextualNavigation) return;
  await nextTick();
  const target =
    props.context === 'goals'
      ? statisticsGoals.value
      : props.context === 'reviews'
        ? statisticsReviews.value
        : statisticsOverview.value;
  target?.scrollIntoView?.({
    block: props.context === 'goals' || props.context === 'reviews' ? 'start' : 'nearest',
    behavior: 'auto',
  });
}
watch(
  () => [props.section, props.context, props.contextualNavigation],
  () => void scrollStatisticsContext(),
  { immediate: true, flush: 'post' },
);
onActivated(() => void scrollStatisticsContext());
const isHistorySummary = (event: ToDooEntityMap['reminderEvent']) =>
  event.sourceType === 'habit' &&
  event.occurrenceKey?.startsWith('history:') &&
  event.ruleId?.startsWith('history_');
const markingAll = ref(false);
const reminders = computed(() =>
  (state.snapshot?.reminderEvents ?? [])
    .filter(
      (event) =>
        !event.deletedAt &&
        (event.firstRaisedAt ||
          event.scheduledAt <= (state.snapshot?.now ?? new Date().toISOString())) &&
        (notificationFilter.value === 'all' || event.userState === notificationFilter.value),
    )
    .sort((a, b) =>
      (b.firstRaisedAt ?? b.scheduledAt).localeCompare(a.firstRaisedAt ?? a.scheduledAt),
    ),
);
const notificationGroups = computed(() => {
  const groups = new Map<string, ToDooEntityMap['reminderEvent'][]>();
  for (const event of reminders.value) {
    const date = toDooLocalDate(
        new Date(event.firstRaisedAt ?? event.scheduledAt),
        state.snapshot?.settings.timeZone,
      ),
      rows = groups.get(date) ?? [];
    rows.push(event);
    groups.set(date, rows);
  }
  return [...groups].map(([date, items]) => ({
    date,
    label: date === today.value ? '今天' : date,
    items,
  }));
});
async function notificationFilterChanged(value: string | number) {
  if (markingAll.value || actingReminder.value) return;
  const key = notificationTabs.find((tab) => tab.value === value)?.value ?? 'all';
  if (props.contextualNavigation) {
    emit('context-change', key);
    return;
  }
  await loadNotificationFilter(key);
}
async function loadNotificationFilter(key: ReminderState | 'all') {
  ++sourceRequest;
  await props.model.load({
    ...state.query,
    reminderStates: key === 'all' ? undefined : [key],
    cursor: undefined,
  });
}
let sourceRequest = 0;
// The workspace supplies the first status query. Reconcile later route/back changes
// only when the parent has not already applied that query.
watch(
  () => [props.section, props.context, props.contextualNavigation],
  () => {
    if (props.section !== 'notifications' || !props.contextualNavigation) return;
    const current = state.query.reminderStates;
    if ((current?.[0] ?? 'all') !== notificationFilter.value || (current?.length ?? 0) > 1)
      void loadNotificationFilter(notificationFilter.value);
  },
  { immediate: true, flush: 'post' },
);
async function openReminder(event: ToDooEntityMap['reminderEvent']) {
  const ticket = ++sourceRequest;
  try {
    const card = (await props.model.request(
      '/api/to-doo/reminders/' + encodeURIComponent(event.id) + '/source',
    )) as ToDooReminderSource;
    if (ticket !== sourceRequest || (state.query.view && state.query.view !== 'notifications'))
      return;
    if (card.taskId) emit('task', card.taskId, card.occurrenceId);
    else emit('source', card);
  } catch (cause) {
    state.error = cause instanceof Error ? cause.message : String(cause);
  }
}
const appliedFrom = computed(() => state.snapshot?.statistics.from ?? from.value);
const appliedTo = computed(() => state.snapshot?.statistics.to ?? to.value);
const bucketDays = computed(() =>
  Math.max(
    1,
    Math.ceil(
      (Math.floor((Date.parse(appliedTo.value) - Date.parse(appliedFrom.value)) / 86400000) + 1) /
        31,
    ),
  ),
);
const daily = computed(() => {
  const days = Math.max(
    0,
    Math.floor((Date.parse(appliedTo.value) - Date.parse(appliedFrom.value)) / 86400000) + 1,
  );
  const totals = state.snapshot?.statistics.completedByDay ?? {};
  const step = bucketDays.value;
  return Array.from({ length: Math.ceil(days / step) }, (_, i) => {
    const date = shiftToDooDate(appliedFrom.value, i * step);
    const end = shiftToDooDate(appliedFrom.value, Math.min(days - 1, (i + 1) * step - 1));
    return {
      date,
      end,
      total: Object.entries(totals).reduce(
        (count, [day, amount]) => count + (day >= date && day <= end ? amount : 0),
        0,
      ),
    };
  });
});
const trendDescription = computed(
  () =>
    `${appliedFrom.value} — ${appliedTo.value}，共${daily.value.reduce((total, row) => total + row.total, 0)}项；` +
    daily.value
      .map((row) => `${row.date}${row.end === row.date ? '' : '—' + row.end} ${row.total}项`)
      .join('，'),
);
const reviews = computed(() => state.snapshot?.reviews.filter((r) => !r.deletedAt) || []);
const outcomes = computed(() => state.snapshot?.outcomes.filter((r) => !r.deletedAt) || []);
async function range() {
  if (!from.value || !to.value) {
    state.error = '请选择开始日期和结束日期';
    return;
  }
  if (from.value > to.value) {
    state.error = '结束日期不能早于开始日期';
    return;
  }
  await props.model.load({
    ...state.query,
    view: 'stats',
    from: from.value,
    to: to.value,
    cursor: undefined,
  });
}
function notifyReminderChange() {
  if (typeof window !== 'undefined')
    window.dispatchEvent(
      new CustomEvent('dooknow-to-doo-changed', { detail: { workspaceAlreadyLoaded: true } }),
    );
}
const snoozeMinutes = [5, 15, 30, 60];
async function reminder(
  id: string,
  action: 'read' | 'unread' | 'acknowledge' | 'dismiss' | 'snooze',
  minutes = 15,
) {
  const event = state.snapshot?.reminderEvents.find((row) => row.id === id);
  if (!event || actingReminder.value || markingAll.value || state.busy) return;
  state.error = '';
  const saved = await reminderController.act(
    { event, section: 'notifications', completion: 'open' },
    action,
    { minutes },
  );
  if (!saved) {
    state.error = reminderController.state.error;
    return;
  }
  await props.model.load();
  notifyReminderChange();
  state.notice = '提醒已更新';
}
let readQueue: { datasetId: string; ids: string[]; offset: number; changed: number } | undefined;
async function markAll() {
  if (markingAll.value || state.busy || actingReminder.value) return;
  markingAll.value = true;
  state.error = '';
  try {
    if (
      !readQueue &&
      state.pendingMutation?.action === 'read_reminders' &&
      !(await props.model.retryPending())
    )
      return;
    if (!readQueue) {
      const datasetId = state.snapshot?.datasetId;
      const ids = new Set<string>(),
        seen = new Set<string>();
      let cursor: string | null = null;
      do {
        const params = new URLSearchParams({
          kind: 'reminderEvent',
          sort: 'recent',
          raisedOnly: 'true',
          reminderStates: 'unread',
          limit: '500',
        });
        if (cursor) params.set('cursor', cursor);
        const page = await props.model.request('/api/to-doo/state?' + params);
        if (datasetId !== page.datasetId) throw Error('数据集已变化，请重新核对提醒');
        for (const event of page.reminderEvents) ids.add(event.id);
        cursor = page.page.nextCursor;
        if (cursor && seen.has(cursor)) throw Error('通知分页已变化，请重新读取后重试');
        if (cursor) seen.add(cursor);
      } while (cursor);
      readQueue = { datasetId: datasetId!, ids: [...ids], offset: 0, changed: 0 };
    }
    while (readQueue.offset < readQueue.ids.length) {
      if (state.snapshot?.datasetId !== readQueue.datasetId)
        throw Error('数据集已变化，请重新核对提醒');
      const ids = readQueue.ids.slice(readQueue.offset, readQueue.offset + 500);
      const result = await props.model.execute({
        action: 'read_reminders',
        payload: { ids, datasetId: readQueue.datasetId },
      });
      if (!result) return;
      readQueue.offset += ids.length;
      readQueue.changed += result.changed.filter((item) => item.kind === 'reminderEvent').length;
    }
    const count = readQueue.changed;
    readQueue = undefined;
    await props.model.load();
    notifyReminderChange();
    state.notice = count ? `已将 ${count} 条提醒标为已读` : '当前没有未读提醒';
  } catch (cause) {
    state.error = cause instanceof Error ? cause.message : String(cause);
  } finally {
    markingAll.value = false;
  }
}
function createReview() {
  const metrics = state.snapshot?.statistics;
  emit('edit', 'review', undefined, {
    from: appliedFrom.value,
    to: appliedTo.value,
    capturedAt: metrics?.asOf ?? new Date().toISOString(),
    metrics: {
      completed: metrics?.completed ?? 0,
      focusMinutes: metrics?.focusMinutes ?? 0,
      outcomes: metrics?.outcomes ?? 0,
    },
  });
}
defineExpose({ createReview, markAll, markingAll, actingReminder });
</script>
<template>
  <template v-if="section === 'stats'"
    ><ToDooPageToolbar
      tag="form"
      class="todo-calendar-toolbar"
      aria-label="统计区间"
      @submit.prevent="range"
    >
      <div class="todo-actions">
        <ASegmented
          :value="periodPreset"
          :options="[
            { label: '近 7 天', value: 'week' },
            { label: '近 30 天', value: 'month' },
            { label: '自定义', value: 'custom' },
          ]"
          :disabled="state.busy"
          @change="selectPeriod"
        />
        <div v-show="customRange" class="todo-actions">
          <label class="todo-inline-label"
            >从<ToDooDateField
              v-model="from"
              type="date"
              required
              aria-label="统计开始日期"
              :disabled="!customRange || state.busy"
              :max="to || undefined" /></label
          ><label class="todo-inline-label"
            >到<ToDooDateField
              v-model="to"
              type="date"
              required
              aria-label="统计结束日期"
              :disabled="!customRange || state.busy"
              :min="from || undefined" /></label
          ><AButton type="default" html-type="submit" class="todo-button">查看区间</AButton>
        </div>
      </div>
    </ToDooPageToolbar>
    <div class="todo-review-statistics" role="group" aria-label="区间统计">
      <AStatistic title="完成行动" :value="state.snapshot?.statistics.completed || 0" suffix="项" />
      <AStatistic
        title="专注时长"
        :value="Math.round(state.snapshot?.statistics.focusMinutes || 0)"
        suffix="分钟"
      />
      <AStatistic title="沉淀成果" :value="state.snapshot?.statistics.outcomes || 0" suffix="份" />
    </div>
    <ToDooHint :model="model" hint-id="review-statistics-policy">
      {{ appliedFrom }} — {{ appliedTo }} ·
      {{ bucketDays > 1 ? '每 ' + bucketDays + ' 天汇总' : '按天统计' }}
      · 历史完成保留归档行动的已完成记录；目标进展为当前未归档行动的累计执行次数，
      不含父行动、取消和跳过的执行。已保存复盘保留保存时的指标。
    </ToDooHint>
    <div class="todo-review-grid">
      <section class="todo-panel todo-review-trend">
        <ToDooSectionHeader title="完成趋势"><small>单位：项</small></ToDooSectionHeader>
        <div class="todo-completion-chart" role="img" :aria-label="trendDescription">
          <div
            v-for="(d, index) in daily"
            :key="d.date"
            :title="d.date + (d.end === d.date ? '' : ' — ' + d.end) + '：' + d.total + '项'"
          >
            <span>{{ d.total }}</span
            ><i
              :style="{
                height:
                  (d.total
                    ? Math.max(6, (d.total / Math.max(1, ...daily.map((v) => v.total))) * 100)
                    : 0) + 'px',
              }"
            ></i
            ><small>{{
              index % Math.max(1, Math.ceil(daily.length / 6)) === 0 || index === daily.length - 1
                ? d.date.slice(5)
                : ' '
            }}</small>
          </div>
        </div>
      </section>
      <section class="todo-panel todo-review-goals">
        <ToDooSectionHeader title="目标进展"><small>累计</small></ToDooSectionHeader>
        <div v-for="l in lists" :key="l.id" class="todo-progress-row">
          <div class="todo-between">
            <span>{{ l.name }}</span
            ><span
              >{{ state.snapshot?.statistics.byList[l.id]?.completed || 0 }}/{{
                state.snapshot?.statistics.byList[l.id]?.total || 0
              }}</span
            >
          </div>
          <AProgress
            :percent="listProgress(l.id)"
            :show-info="false"
            :aria-label="l.name + '完成进度'"
          />
        </div>
        <AEmpty
          v-if="!lists.length"
          class="todo-empty"
          description="创建目标后，在这里回顾进展。"
        />
      </section>
      <section class="todo-panel todo-review-records">
        <ToDooSectionHeader title="复盘与成果" />
        <AButton
          type="text"
          v-for="r in reviews"
          :key="r.id"
          class="todo-saved-row todo-text-button"
          @click="emit('edit', 'review', r)"
        >
          <span
            ><strong>{{ r.name }}</strong
            ><small>{{ r.from }} — {{ r.to }}</small>
            <p>{{ r.content.slice(0, 160) }}</p></span
          ><span>↗</span>
        </AButton>
        <AEmpty
          v-if="!reviews.length && !outcomes.length"
          class="todo-empty"
          description="写下做对的事与下一次调整，让记录成为下一步的依据。"
        />
        <AButton
          type="text"
          v-for="o in outcomes"
          :key="o.id"
          class="todo-saved-row todo-text-button"
          @click="emit('edit', 'outcome', o)"
        >
          <span
            >{{ o.summary
            }}<small
              >{{
                {
                  self_assessed: '自评',
                  practice: '练习验证',
                  reviewed: '经过评审',
                  delivered: '已交付',
                }[o.verification]
              }}
              <template v-if="o.evidenceRefs.length">
                · {{ o.evidenceRefs.length }} 份证据</template
              ></small
            ></span
          ></AButton
        ><AButton type="link" class="todo-link todo-pad" @click="emit('edit', 'record')">
          ＋ 新增推进记录
        </AButton>
      </section>
    </div></template
  >
  <template v-else
    ><ToDooPageToolbar class="todo-calendar-toolbar" aria-label="通知筛选">
      <ATabs
        class="todo-notification-tabs"
        :active-key="notificationFilter"
        @change="notificationFilterChanged"
        ><ATabPane
          v-for="tab in notificationTabs"
          :key="tab.value"
          :tab="tab.label"
          :disabled="markingAll || state.loading || !!actingReminder"
      /></ATabs>
    </ToDooPageToolbar>
    <ToDooHint :model="model" hint-id="notification-actions">
      确认提醒只更新通知状态，不会自动完成任务或习惯；完成事项请查看来源。误操作可在更多提醒操作中恢复未读。
    </ToDooHint>
    <section class="todo-panel">
      <section
        v-for="group in notificationGroups"
        :key="group.date"
        class="todo-notification-group"
      >
        <div class="todo-actions">
          <ASegmented
            :value="periodPreset"
            :options="[
              { label: '近 7 天', value: 'week' },
              { label: '近 30 天', value: 'month' },
              { label: '自定义', value: 'custom' },
            ]"
            :disabled="state.busy"
            @change="selectPeriod"
          />
          <div v-show="customRange" class="todo-actions">
            <label class="todo-inline-label"
              >从<ToDooDateField
                v-model="from"
                type="date"
                required
                aria-label="统计开始日期"
                :disabled="!customRange || state.busy"
                :max="to || undefined" /></label
            ><label class="todo-inline-label"
              >到<ToDooDateField
                v-model="to"
                type="date"
                required
                aria-label="统计结束日期"
                :disabled="!customRange || state.busy"
                :min="from || undefined" /></label
            ><AButton type="default" html-type="submit" class="todo-button">查看区间</AButton>
          </div>
        </div>
      </ToDooPageToolbar>
      <div
        id="to-doo-stats-overview"
        ref="statisticsOverview"
        class="todo-review-statistics todo-review-anchor"
        role="group"
        aria-label="区间统计"
      >
        <AStatistic
          title="完成行动"
          :value="state.snapshot?.statistics.completed || 0"
          suffix="项"
        />
        <AStatistic title="待办执行" :value="state.snapshot?.statistics.pending || 0" suffix="项" />
        <AStatistic
          title="专注时长"
          :value="Math.round(state.snapshot?.statistics.focusMinutes || 0)"
          suffix="分钟"
        />
        <AStatistic
          title="沉淀成果"
          :value="state.snapshot?.statistics.outcomes || 0"
          suffix="份"
        />
      </div>
      <ToDooHint :model="model" hint-id="review-statistics-policy">
        {{ appliedFrom }} — {{ appliedTo }} ·
        {{ bucketDays > 1 ? '每 ' + bucketDays + ' 天汇总' : '按天统计' }}
        · 历史完成保留归档行动的已完成记录；目标进展为当前未归档行动的累计执行次数，
        不含父行动、取消和跳过的执行。已保存复盘保留保存时的指标。
      </ToDooHint>
      <div class="todo-review-grid">
        <section class="todo-panel todo-review-trend">
          <ToDooSectionHeader title="完成趋势"><small>单位：项</small></ToDooSectionHeader>
          <div class="todo-completion-chart" role="img" :aria-label="trendDescription">
            <div
              v-for="(d, index) in daily"
              :key="d.date"
              :title="d.date + (d.end === d.date ? '' : ' — ' + d.end) + '：' + d.total + '项'"
            >
              <span>{{ d.total }}</span
              ><i
                :style="{
                  height:
                    (d.total
                      ? Math.max(6, (d.total / Math.max(1, ...daily.map((v) => v.total))) * 100)
                      : 0) + 'px',
                }"
              ></i
              ><small>{{
                index % Math.max(1, Math.ceil(daily.length / 6)) === 0 || index === daily.length - 1
                  ? d.date.slice(5)
                  : ' '
              }}</small>
            </div>
          </div>
        </section>
        <section
          id="to-doo-stats-goals"
          ref="statisticsGoals"
          class="todo-panel todo-review-goals todo-review-anchor"
          aria-label="目标进展"
        >
          <ToDooSectionHeader title="目标进展"><small>累计</small></ToDooSectionHeader>
          <div v-for="l in lists" :key="l.id" class="todo-progress-row">
            <div class="todo-between">
              <span>{{ l.name }}</span
              ><span
                >{{ state.snapshot?.statistics.byList[l.id]?.completed || 0 }}/{{
                  state.snapshot?.statistics.byList[l.id]?.total || 0
                }}</span
              >
            </div>
            <AProgress
              :percent="listProgress(l.id)"
              :show-info="false"
              :aria-label="l.name + '完成进度'"
            />
          </div>
          <AEmpty
            v-if="!lists.length"
            class="todo-empty"
            description="创建目标后，在这里回顾进展。"
          />
        </section>
        <section
          id="to-doo-stats-reviews"
          ref="statisticsReviews"
          class="todo-panel todo-review-records todo-review-anchor"
          aria-label="历史复盘与成果"
        >
          <ToDooSectionHeader title="复盘与成果" />
          <AButton
            type="text"
            v-for="r in reviews"
            :key="r.id"
            class="todo-saved-row todo-text-button"
            @click="emit('edit', 'review', r)"
          >
            <span
              ><strong>{{ r.name }}</strong
              ><small>{{ r.from }} — {{ r.to }}</small>
              <p>{{ r.content.slice(0, 160) }}</p></span
            ><span>↗</span>
          </AButton>
          <AEmpty
            v-if="!reviews.length && !outcomes.length"
            class="todo-empty"
            description="写下做对的事与下一次调整，让记录成为下一步的依据。"
          />
          <AButton
            type="text"
            v-for="o in outcomes"
            :key="o.id"
            class="todo-saved-row todo-text-button"
            @click="emit('edit', 'outcome', o)"
          >
            <span
              >{{ o.summary
              }}<small
                >{{
                  {
                    self_assessed: '自评',
                    practice: '练习验证',
                    reviewed: '经过评审',
                    delivered: '已交付',
                  }[o.verification]
                }}
                <template v-if="o.evidenceRefs.length">
                  · {{ o.evidenceRefs.length }} 份证据</template
                ></small
              ></span
            ></AButton
          ><AButton type="link" class="todo-link todo-pad" @click="emit('edit', 'record')">
            ＋ 新增推进记录
          </AButton>
        </section>
      </div></template
    >
    <template v-else
      ><ToDooPageToolbar
        tag="form"
        class="todo-calendar-toolbar todo-notification-toolbar"
        aria-label="通知筛选"
        @submit.prevent="applyNotificationFilters"
      >
        <ATabs
          v-if="!contextualNavigation"
          class="todo-notification-tabs"
          :active-key="notificationFilter"
          @change="notificationFilterChanged"
          ><ATabPane
            v-for="tab in notificationTabs"
            :key="tab.value"
            :tab="tab.label"
            :disabled="markingAll || state.loading || !!actingReminder"
        /></ATabs>
        <div class="todo-notification-query-controls">
          <AInput
            v-model:value="notificationSearch"
            type="search"
            class="todo-notification-search"
            aria-label="搜索通知"
            placeholder="搜索通知…"
            :maxlength="500"
            :disabled="state.loading || markingAll || !!actingReminder"
          />
          <label class="todo-inline-label"
            >从<ToDooDateField
              v-model="notificationFrom"
              type="date"
              aria-label="通知开始日期"
              :max="notificationTo || undefined"
              :disabled="state.loading || markingAll || !!actingReminder"
          /></label>
          <label class="todo-inline-label"
            >到<ToDooDateField
              v-model="notificationTo"
              type="date"
              aria-label="通知结束日期"
              :min="notificationFrom || undefined"
              :disabled="state.loading || markingAll || !!actingReminder"
          /></label>
          <AButton html-type="submit" :disabled="state.loading || markingAll || !!actingReminder"
            >筛选通知</AButton
          >
          <AButton
            v-if="hasNotificationFilters"
            html-type="button"
            type="link"
            :disabled="state.loading || markingAll || !!actingReminder"
            @click="clearNotificationFilters"
            >清除通知筛选</AButton
          >
        </div>
      </ToDooPageToolbar>
      <ToDooHint :model="model" hint-id="notification-actions">
        确认提醒只更新通知状态，不会自动完成任务或习惯；完成事项请查看来源。误操作可在更多提醒操作中恢复未读。
      </ToDooHint>
      <section
        class="todo-panel todo-notifications-panel"
        :aria-label="
          notificationTabs.find((tab) => tab.value === notificationFilter)?.label + '提醒'
        "
      >
        <section
          v-for="group in notificationGroups"
          :key="group.date"
          class="todo-notification-group"
        >
          <ToDooSectionHeader :title="group.label" />
          <article
            v-for="r in group.items"
            :key="r.id"
            class="todo-notification"
            :data-reminder-id="r.id"
          >
            <span class="todo-notification-icon"
              ><ToDooIcon name="notifications" :size="18"
            /></span>
            <div class="todo-notification-body">
              <div class="todo-between todo-notification-heading">
                <h2>{{ r.title || '行动提醒' }}</h2>
                <span
                  v-if="notificationFilter === 'all'"
                  class="todo-badge"
                  :class="{ accent: r.userState === 'unread' }"
                  >{{
                    {
                      unread: '未读',
                      read: '已读',
                      acknowledged: '已确认',
                      dismissed: '已忽略',
                      snoozed: '稍后提醒',
                    }[r.userState]
                  }}</span
                >
              </div>
              <p v-if="r.message?.trim() && r.message.trim() !== (r.title || '行动提醒').trim()">
                {{ r.message }}
              </p>
              <small class="todo-muted"
                >{{
                  isHistorySummary(r)
                    ? '历史汇总提醒'
                    : { task: '任务提醒', habit: '习惯提醒', anniversary: '纪念日提醒' }[
                        r.sourceType
                      ]
                }}
                ·
                {{
                  new Date(r.scheduledAt).toLocaleString('zh-CN', {
                    timeZone: state.snapshot?.settings.timeZone,
                  })
                }}{{
                  r.snoozedUntil
                    ? ' · 稍后 ' +
                      new Date(r.snoozedUntil).toLocaleString('zh-CN', {
                        timeZone: state.snapshot?.settings.timeZone,
                      })
                    : ''
                }}</small
              >
              <div class="todo-actions todo-top-gap todo-notification-actions">
                <AButton
                  v-if="!isHistorySummary(r)"
                  type="link"
                  class="todo-link"
                  :disabled="markingAll || !!actingReminder"
                  @click="openReminder(r)"
                  >{{
                    { task: '查看任务', habit: '查看习惯', anniversary: '查看纪念日' }[r.sourceType]
                  }}</AButton
                >
                <AButton
                  v-if="r.userState === 'unread' || r.userState === 'read'"
                  type="link"
                  class="todo-link"
                  :disabled="state.loading || markingAll || !!actingReminder"
                  @click="reminder(r.id, 'acknowledge')"
                  >确认提醒</AButton
                >
                <ADropdown :trigger="['click']" overlay-class-name="todo-ant-popup"
                  ><AButton
                    type="text"
                    size="small"
                    aria-label="更多提醒操作"
                    :disabled="state.loading || markingAll || !!actingReminder"
                    ><ToDooIcon name="more" :size="17" /></AButton
                  ><template #overlay
                    ><AMenu
                      ><AMenuItem v-if="r.userState === 'unread'" @click="reminder(r.id, 'read')"
                        >标为已读</AMenuItem
                      ><AMenuItem v-if="r.userState !== 'unread'" @click="reminder(r.id, 'unread')"
                        >恢复未读</AMenuItem
                      ><AMenuItem
                        v-for="minutes in snoozeMinutes"
                        :key="minutes"
                        @click="reminder(r.id, 'snooze', minutes)"
                        >{{ minutes }} 分钟后提醒</AMenuItem
                      ><AMenuItem @click="reminder(r.id, 'dismiss')">忽略提醒</AMenuItem></AMenu
                    ></template
                  ></ADropdown
                >
              </div>
            </div>
          </article>
        </section>
        <AEmpty
          v-if="!reminders.length"
          class="todo-empty"
          :description="
            notificationFilter === 'unread' ? '当前没有未读提醒' : '这个状态下暂时没有提醒'
          "
        >
          <p class="todo-muted">为任务、习惯或重要日子添加提醒，到时会集中显示。</p>
        </AEmpty>
      </section></template
    >
  </div>
</template>
<style src="../../to-doo-management-layout.css"></style>
