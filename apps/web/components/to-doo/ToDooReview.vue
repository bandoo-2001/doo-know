<script setup lang="ts">
import { computed, nextTick, onActivated, onUnmounted, ref, watch } from 'vue';
import {
  Alert as AAlert,
  Button as AButton,
  Dropdown as ADropdown,
  Menu as AMenu,
  Popover as APopover,
  Empty as AEmpty,
  Input as AInput,
  Progress as AProgress,
  Segmented as ASegmented,
  Statistic as AStatistic,
  Tabs as ATabs,
} from 'ant-design-vue';
import ToDooDateField from './ToDooDateField.vue';
import { createToDooPopupEscapeBoundary } from '../../to-doo-controls';
import ToDooIcon from './ToDooIcon.vue';
import ToDooListIcon from './ToDooListIcon.vue';
import { createToDooReminderController } from '../../to-doo-reminders';
import ToDooPageToolbar from './ToDooPageToolbar.vue';
import ToDooSectionHeader from './ToDooSectionHeader.vue';
import { useToDooClock } from '../../to-doo-time';
import type { ToDooEntityKind, ToDooEntityMap } from '../../../../shared/to-doo-contracts';
import type { ToDooReminderSource } from '../../../../shared/to-doo-contracts';
import {
  shiftToDooDate,
  toDooLocalDate,
  type ToDooWorkbench,
  type ToDooCreateSeed,
} from '../../to-doo-workbench';
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
  navigate: [section: 'tasks'];
  completed: [];
  history: [section: 'focus' | 'habits', range: { from: string; to: string }];
  list: [id: string];
  'create-task': [seed: ToDooCreateSeed];
}>();
const { now } = useToDooClock();
const state = props.model.state,
  today = computed(() => toDooLocalDate(new Date(now.value), state.snapshot?.settings.timeZone)),
  from = ref(shiftToDooDate(today.value, -6)),
  to = ref(today.value);
const customRange = ref(false);
const localStatisticsView = ref('overview');
const statisticsView = computed(() =>
  props.context === undefined
    ? localStatisticsView.value
    : ['goals', 'reviews'].includes(props.context) ? props.context : 'overview',
);
function selectStatisticsView(value: string | number) {
  const next = String(value);
  if (!['overview', 'goals', 'reviews'].includes(next)) return;
  localStatisticsView.value = next;
  if (props.context !== undefined) emit('context-change', next);
}
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
const goalTotals = computed(() => lists.value.reduce((total, list) => {
  const progress = state.snapshot?.statistics.byList[list.id];
  total.actions += progress?.total || 0;
  total.completed += progress?.completed || 0;
  return total;
}, { actions: 0, completed: 0 }));
function goalRemaining(id: string) {
  const progress = state.snapshot?.statistics.byList[id];
  return Math.max(0, (progress?.total || 0) - (progress?.completed || 0));
}
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
  { value: 'unread', label: '未读' },
  { value: 'all', label: '全部' },
  { value: 'read', label: '已读' },
  { value: 'acknowledged', label: '已确认' },
  { value: 'snoozed', label: '稍后' },
  { value: 'dismissed', label: '忽略' },
];
const primaryNotificationTabs = notificationTabs.slice(0, 2);
const additionalNotificationStates = notificationTabs.slice(2);
const notificationFilter = computed<ReminderState | 'all'>(() => {
  if (props.context === undefined) return state.query.reminderStates?.[0] ?? 'all';
  return notificationTabs.find((tab) => tab.value === props.context)?.value ?? 'all';
});
const notificationSearch = ref(state.query.filter?.query ?? '');
const notificationFrom = ref(state.query.from ?? '');
const notificationTo = ref(state.query.to ?? '');
const notificationFiltersOpen = ref(false);
const notificationFilterTrigger = ref<InstanceType<typeof AButton>>();
const notificationFilterPanel = ref<HTMLFormElement>();
const notificationFilterError = ref('');
const notificationFilterCount = computed(() =>
  [state.query.filter?.query, state.query.from, state.query.to].filter(Boolean).length,
);
function closeNotificationFilters(restoreFocus = false) {
  notificationFiltersOpen.value = false;
  if (restoreFocus) void nextTick(() => notificationFilterTrigger.value?.$el?.focus?.());
}
async function notificationFiltersChanged(open: boolean) {
  notificationFiltersOpen.value = open;
  if (open) {
    await nextTick();
    notificationFilterPanel.value?.querySelector?.<HTMLInputElement>('input')?.focus?.();
  }
}
function notificationFilterKeydown(event: KeyboardEvent) {
  if (event.key !== 'Escape' || event.defaultPrevented) return;
  notificationEscape.bubble(event);
  if (event.cancelBubble) return;
  event.preventDefault();
  event.stopPropagation();
  closeNotificationFilters(true);
}
const notificationEscape = createToDooPopupEscapeBoundary();
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
    notificationFilterError.value = state.error = '结束日期不能早于开始日期';
    return;
  }
  ++sourceRequest;
  notificationFilterError.value = '';
  await props.model.load({
    ...state.query,
    from: notificationFrom.value || undefined,
    to: notificationTo.value || undefined,
    filter: { ...state.query.filter, query: notificationSearch.value.trim() || undefined },
    cursor: undefined,
  });
  notificationFilterError.value = state.error;
  if (!state.error) closeNotificationFilters(true);
}
async function clearNotificationFilters() {
  notificationSearch.value = '';
  notificationFrom.value = '';
  notificationTo.value = '';
  await applyNotificationFilters();
}
const statisticsSurface = ref<HTMLElement>();
async function scrollStatisticsContext() {
  if (props.section !== 'stats' || !props.contextualNavigation || props.context === undefined) return;
  await nextTick();
  statisticsSurface.value?.scrollIntoView?.({ block: 'start', behavior: 'auto' });
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
  if (props.context !== undefined) {
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
    if (props.section !== 'notifications' || props.context === undefined) return;
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
function reviewSummary(review: ToDooEntityMap['review']) {
  const content = review.content.split('\n')
    .map(line => line.replace(/^\s*(?:#{1,6}\s+|[-*>]\s+|\d+[.)]\s+)/, '').trim())
    .filter(line => line && !['本期收获', '遇到的阻碍', '下一步行动'].includes(line))
    .join(' ');
  return content ? content.slice(0, 240) + (content.length > 240 ? '…' : '') : '尚未填写正文，打开后记录收获与下一步。';
}
function reviewCapturedDate(review: ToDooEntityMap['review']) {
  const date = new Date(review.capturedAt);
  return Number.isFinite(date.getTime()) ? toDooLocalDate(date, state.snapshot?.settings.timeZone) : '';
}
function reviewMetrics(review: ToDooEntityMap['review']) {
  return [
    { key: 'completed', label: '完成行动', unit: '项' },
    { key: 'focusMinutes', label: '专注时长', unit: '分钟' },
    { key: 'outcomes', label: '沉淀成果', unit: '份' },
  ].filter(item => typeof review.metrics?.[item.key] === 'number')
    .map(item => ({ ...item, value: Math.round(review.metrics[item.key]) }));
}
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
    name: `复盘 ${appliedFrom.value} — ${appliedTo.value}`,
    content: '本期收获\n\n\n遇到的阻碍\n\n\n下一步行动\n',
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
function createNextTask(review: ToDooEntityMap['review']) {
  emit('create-task', {
    title: '',
    description:
      `来自复盘「${review.name}」\n复盘区间：${review.from} — ${review.to}` +
      (review.content.trim() ? '\n\n' + review.content.trim().slice(0, 2000) : ''),
    listId: review.listId,
  });
}
defineExpose({ createReview, markAll, markingAll, actingReminder });
</script>
<template>
  <div v-if="section === 'stats'" class="todo-review">
    <ATabs
      v-if="!contextualNavigation"
      class="todo-review-view-tabs"
      aria-label="统计内容"
      :active-key="statisticsView"
      @change="selectStatisticsView"
    >
      <ATabPane key="overview" tab="概览" />
      <ATabPane key="goals" tab="目标进展" />
      <ATabPane key="reviews" tab="历史复盘" />
    </ATabs>
    <div ref="statisticsSurface" class="todo-review-result-surface" role="region" aria-label="统计结果" :data-view="statisticsView">
    <h2 v-if="contextualNavigation" class="todo-review-current-title">{{ { overview: '概览', goals: '目标进展', reviews: '历史复盘' }[statisticsView] }}</h2>
    <ToDooPageToolbar
      v-show="statisticsView !== 'goals'"
      tag="form"
      class="todo-calendar-toolbar todo-review-period-toolbar"
      aria-label="统计区间"
      :aria-controls="'to-doo-stats-' + statisticsView"
      @submit.prevent="range"
    >
      <div class="todo-actions">
        <span class="todo-review-range-label">{{ statisticsView === 'reviews' ? '复盘覆盖区间' : '统计区间' }}</span>
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
      <span class="todo-review-applied-range">{{ appliedFrom }} — {{ appliedTo }}</span>
      <span v-if="statisticsView === 'reviews'" class="todo-review-result-count">当前区间 {{ reviews.length }} 篇复盘</span>
    </ToDooPageToolbar>
    <div
      v-show="statisticsView === 'overview'"
      id="to-doo-stats-overview"
      class="todo-review-statistics todo-review-anchor"
      role="group"
      aria-label="区间统计"
    >
      <AStatistic title="完成行动" :value="state.snapshot?.statistics.completed || 0" suffix="项" />
      <AStatistic
        title="专注时长"
        :value="Math.round(state.snapshot?.statistics.focusMinutes || 0)"
        suffix="分钟"
      />
      <AStatistic title="沉淀成果" :value="state.snapshot?.statistics.outcomes || 0" suffix="份" />
    </div>
    <nav v-show="statisticsView === 'overview'" class="todo-review-sources" aria-label="查看复盘资料">
      <AButton type="link" @click="emit('completed')">查看全部已完成任务</AButton>
      <AButton type="link" @click="emit('history', 'focus', { from: appliedFrom, to: appliedTo })"
        >查看专注记录</AButton
      >
      <AButton type="link" @click="emit('history', 'habits', { from: appliedFrom, to: appliedTo })"
        >查看习惯记录</AButton
      >
    </nav>

    <div class="todo-review-grid todo-review-tabs-content">
      <section v-show="statisticsView === 'overview'" class="todo-panel todo-review-trend">
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
        v-show="statisticsView === 'goals'"
        id="to-doo-stats-goals"
        class="todo-panel todo-review-goals todo-review-anchor"
        aria-label="目标进展"
      >
        <div class="todo-review-goal-tools">
          <p class="todo-review-goal-scope">查看目标内行动的累计完成情况，不受概览日期区间影响。重复任务按每次执行计数。</p>
          <span class="todo-review-scope-pill">累计进度</span>
          <AButton v-if="lists.length" html-type="button" aria-label="添加目标" @click="emit('edit', 'list', undefined, { kind: 'goal' })"><ToDooIcon name="plus" :size="14" />新建目标</AButton>
        </div>
        <div v-if="lists.length" class="todo-goal-summary" aria-label="当前目标汇总">
          <div><span>当前目标</span><strong>{{ lists.length }}<small>个</small></strong></div>
          <div><span>已完成行动</span><strong>{{ goalTotals.completed }}<small>项</small></strong></div>
          <div><span>待完成行动</span><strong>{{ Math.max(0, goalTotals.actions - goalTotals.completed) }}<small>项</small></strong></div>
        </div>
        <div class="todo-goal-progress-list">
        <div v-for="l in lists" :key="l.id" class="todo-progress-row">
          <div class="todo-between todo-review-goal-heading">
            <AButton
              type="link"
              class="todo-review-goal-link"
              :aria-label="'查看目标任务 ' + l.name"
              @click="emit('list', l.id)"
              ><ToDooListIcon :list="l" :size="18" /><span>{{ l.name }}</span></AButton
            ><span class="todo-review-goal-count"
              :aria-label="'已完成 ' + (state.snapshot?.statistics.byList[l.id]?.completed || 0) + ' 项，共 ' + (state.snapshot?.statistics.byList[l.id]?.total || 0) + ' 项'"
              >{{ state.snapshot?.statistics.byList[l.id]?.completed || 0 }}/{{
                state.snapshot?.statistics.byList[l.id]?.total || 0
              }}</span
            >
          </div>
          <p v-if="l.description" class="todo-review-goal-description">{{ l.description }}</p>
          <div class="todo-review-goal-progress-meta">
            <span>{{ state.snapshot?.statistics.byList[l.id]?.total ? '已完成 ' + listProgress(l.id) + '%' : '尚未添加行动' }}</span>
            <span v-if="state.snapshot?.statistics.byList[l.id]?.total">剩余 {{ goalRemaining(l.id) }} 项</span>
          </div>
          <AProgress
            :percent="listProgress(l.id)"
            :show-info="false"
            :stroke-color="l.color"
            :aria-label="l.name + '完成进度'"
          />
        </div>
        </div>
        <AEmpty v-if="!lists.length" class="todo-empty todo-review-explained-empty" description="还没有目标">
          <p>目标是用来持续推进一件事的清单，例如「完成一门课程」。<br />普通清单不会出现在这里；创建目标并加入行动后，就能看到进度。</p>
          <AButton type="primary" @click="emit('edit', 'list', undefined, { kind: 'goal' })">新建目标</AButton>
        </AEmpty>
      </section>
      <section
        v-show="statisticsView === 'reviews'"
        id="to-doo-stats-reviews"
        class="todo-panel todo-review-records todo-review-anchor"
        aria-label="历史复盘"
      >
        <p class="todo-review-scope-help">显示复盘日期与 {{ appliedFrom }} — {{ appliedTo }} 相交的记录；指标保留保存时的快照。</p>
        <div class="todo-review-entry-list">
        <article
          v-for="r in reviews"
          :key="r.id"
          class="todo-review-entry"
          :aria-label="'复盘 ' + r.name"
        >
          <AButton
            type="text"
            class="todo-saved-row todo-text-button"
            :aria-label="'打开复盘 ' + r.name"
            @click="emit('edit', 'review', r)"
          >
            <span
              class="todo-review-entry-copy"><strong>{{ r.name }}</strong
              ><small class="todo-review-entry-range"><ToDooIcon name="calendar" :size="14" />复盘区间 {{ r.from }} — {{ r.to }}</small>
              <p>{{ reviewSummary(r) }}</p></span
            ><ToDooIcon name="chevron" :size="16" />
          </AButton>
          <div v-if="reviewMetrics(r).length" class="todo-review-snapshot" aria-label="保存时的统计快照">
            <span class="todo-review-snapshot-label">保存时</span>
            <span v-for="metric in reviewMetrics(r)" :key="metric.key">{{ metric.label }} <strong>{{ metric.value }}</strong> {{ metric.unit }}</span>
          </div>
          <div class="todo-review-entry-footer">
          <small v-if="reviewCapturedDate(r)" class="todo-review-captured-date">保存于 {{ reviewCapturedDate(r) }}</small>
          <AButton
            type="link"
            class="todo-review-next-task"
            aria-label="＋ 添加下一步任务"
            :disabled="state.busy"
            @click="createNextTask(r)"
            ><ToDooIcon name="plus" :size="14" />添加下一步任务</AButton
          >
          </div>
        </article>
        </div>
        <AEmpty
          v-if="!reviews.length && !outcomes.length"
          class="todo-empty todo-review-explained-empty"
          description="还没有复盘记录"
        >
          <p>复盘用于记录一段时间内做对的事、遇到的阻碍和下一步。<br />完成任务或专注计时不会自动生成复盘，可以先写下这一期的收获。</p>
          <AButton type="primary" html-type="button" @click="createReview">写第一篇复盘</AButton>
        </AEmpty>
        <section v-if="outcomes.length" class="todo-review-outcomes" aria-label="成果与证据">
        <ToDooSectionHeader title="成果与证据"><small>{{ outcomes.length }} 份已保存成果</small></ToDooSectionHeader>
        <p class="todo-review-scope-help">成果与复盘分别保存，可打开查看交付内容和关联证据。</p>
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
          ></AButton>
        </section>
        <AButton type="link" class="todo-link todo-pad" aria-label="＋ 新增推进记录" @click="emit('edit', 'record')">
          <ToDooIcon name="plus" :size="14" />新增推进记录
        </AButton>
      </section>
    </div>
    </div>
  </div>
  <div v-else class="todo-review">
    <ToDooPageToolbar
      class="todo-calendar-toolbar todo-notification-toolbar"
      aria-label="通知范围与筛选"
    >
      <ATabs
        v-if="!contextualNavigation"
        class="todo-notification-tabs"
        :active-key="['unread', 'all'].includes(notificationFilter) ? notificationFilter : ''"
        @change="notificationFilterChanged"
        ><ATabPane
          v-for="tab in primaryNotificationTabs"
          :key="tab.value"
          :tab="tab.label"
          :disabled="markingAll || state.loading || !!actingReminder"
      /></ATabs>
      <div class="todo-actions todo-notification-tools">
        <ADropdown v-if="!contextualNavigation" :trigger="['click']" overlay-class-name="todo-ant-popup">
          <AButton :disabled="state.loading || markingAll || !!actingReminder" aria-label="其他通知状态">
            {{ additionalNotificationStates.find(tab => tab.value === notificationFilter)?.label || '其他状态' }}
          </AButton>
          <template #overlay>
            <AMenu aria-label="其他通知状态" :selected-keys="[notificationFilter]" @click="notificationFilterChanged($event.key)">
              <AMenuItem v-for="tab in additionalNotificationStates" :key="tab.value">{{ tab.label }}</AMenuItem>
            </AMenu>
          </template>
        </ADropdown>
        <APopover
          :open="notificationFiltersOpen"
          :trigger="['click']"
          placement="bottomRight"
          overlay-class-name="todo-ant-popup todo-notification-filter-popup"
          @open-change="notificationFiltersChanged"
        >
          <AButton ref="notificationFilterTrigger" aria-label="打开通知筛选" :aria-expanded="notificationFiltersOpen">
            <ToDooIcon name="filter" :size="16" />筛选{{ notificationFilterCount ? ' · ' + notificationFilterCount : '' }}
          </AButton>
          <template #content>
            <form
              ref="notificationFilterPanel"
              class="todo-notification-filter-form todo-form"
              aria-label="通知筛选"
              @submit.prevent="applyNotificationFilters"
              @keydown.capture="notificationEscape.capture"
              @keydown="notificationFilterKeydown"
            >
              <AAlert v-if="notificationFilterError" type="error" :message="notificationFilterError" show-icon />
              <label>搜索<AInput
                v-model:value="notificationSearch"
                type="search"
                class="todo-notification-search"
                aria-label="搜索通知"
                placeholder="搜索通知…"
                :maxlength="500"
                :disabled="state.loading || markingAll || !!actingReminder"
              /></label>
              <div class="todo-form-grid">
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
              </div>
              <div class="todo-actions">
        <AButton type="primary" html-type="submit" :disabled="state.loading || markingAll || !!actingReminder"
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
              <AButton html-type="button" @click="closeNotificationFilters(true)">关闭</AButton>
              </div>
            </form>
          </template>
        </APopover>
      </div>
    </ToDooPageToolbar>
    <section
      class="todo-panel todo-notifications-panel"
      :aria-label="notificationTabs.find((tab) => tab.value === notificationFilter)?.label + '提醒'"
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
          <span class="todo-notification-icon"><ToDooIcon name="notifications" :size="18" /></span>
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
                  : { task: '任务提醒', habit: '习惯提醒', anniversary: '纪念日提醒' }[r.sourceType]
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
                title="确认仅处理提醒，不会自动完成对应事项。"
                aria-description="确认仅处理提醒，不会自动完成对应事项。"
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
        <AButton
          v-if="notificationFilter !== 'all'"
          :disabled="state.loading || markingAll || !!actingReminder"
          @click="notificationFilterChanged('all')"
          >查看全部提醒</AButton
        >
        <AButton v-else @click="emit('navigate', 'tasks')">查看任务</AButton>
      </AEmpty>
    </section>
  </div>
</template>
<style src="../../to-doo-management-layout.css"></style>
<style src="../../to-doo-review-layout.css"></style>
<style scoped>
.todo-review-sources {
  display: flex;
  flex-wrap: wrap;
  gap: var(--todo-space-4) var(--todo-space-16);
  margin: 0 0 var(--todo-space-12);
}
.todo-review-sources .ant-btn {
  height: auto;
  padding: var(--todo-space-4) 0;
  font-size: var(--todo-font-size);
}
.todo-review-goal-link.ant-btn {
  display: inline-flex;
  align-items: center;
  justify-content: flex-start;
  gap: var(--todo-space-8);
  min-width: 0;
  height: auto;
  min-height: 0;
  padding: 0;
  color: var(--todo-accent);
  font-size: inherit;
  white-space: normal;
  text-align: left;
  overflow-wrap: anywhere;
}
.todo-review-goal-link > span:last-child {
  min-width: 0;
  overflow-wrap: anywhere;
}
.todo-review-goal-heading {
  display: grid;
  grid-template-columns: minmax(0, 1fr) max-content;
  gap: var(--todo-space-12);
}
.todo-review-goal-count {
  white-space: nowrap;
  text-align: end;
  font-variant-numeric: tabular-nums;
}
.todo-progress-row :deep(.ant-progress-line) {
  display: block;
  margin-inline-end: 0;
}
.todo-review-entry .todo-saved-row > svg {
  flex: 0 0 auto;
}
.todo-review-entry {
  min-width: 0;
  border-bottom: 1px solid var(--todo-line);
}
.todo-review-entry .todo-saved-row {
  border-bottom: 0;
}
.todo-review-entry p {
  white-space: pre-line;
}
.todo-review-next-task.ant-btn {
  height: auto;
  margin: 0 var(--todo-space-16) var(--todo-space-12);
  padding: var(--todo-space-4) 0;
  font-size: var(--todo-font-size);
}
</style>
