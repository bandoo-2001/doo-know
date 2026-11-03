<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue';
import {
  Alert as AAlert,
  Button as AButton,
  Checkbox as ACheckbox,
  Empty as AEmpty,
  Modal as AModal,
  Segmented as ASegmented,
} from 'ant-design-vue';
import ToDooDateField from './ToDooDateField.vue';
import ToDooDisclosure from './ToDooDisclosure.vue';
import { groupTaskItems } from '../../to-doo-task-groups';
import { useToDooClock } from '../../to-doo-time';
import {
  toDooBlockSegment,
  toDooConflictLanes,
  toDooInstantTime,
} from '../../to-doo-calendar-layout';
import { toDooCalendarRange } from '../../to-doo-presentation';
import { toDooAnniversaryDate } from '../../../../shared/to-doo-anniversaries';
import {
  shiftToDooDate,
  toDooLocalDate,
  toDooDisplayTime,
  toDooMoveBlock,
  type ToDooItem,
  type ToDooSelection,
  type ToDooWorkbench,
} from '../../to-doo-workbench';
import type { ToDooEntityKind, ToDooEntityMap } from '../../../../shared/to-doo-contracts';
const props = defineProps<{
  model: ToDooWorkbench;
  date?: string;
  view?: 'week' | 'month';
  timeline?: boolean;
}>();
const emit = defineEmits<{
  open: [item: ToDooItem];
  navigate: [selection: ToDooSelection];
  edit: [kind: ToDooEntityKind, entity?: Record<string, any>, seed?: Record<string, any>];
  'task-view': [section: 'tasks' | 'board' | 'matrix' | 'timeline'];
}>();
const state = props.model.state,
  displayOpen = ref(false),
  mobilePresentation = ref('agenda'),
  showEmptyDates = ref(false),
  showExternal = ref(true),
  showHabits = ref(!props.timeline),
  showAnniversaries = ref(true),
  planTime = ref('09:00'),
  includeDependents = ref(false);
const { now } = useToDooClock();
const today = computed(() =>
  toDooLocalDate(new Date(now.value), state.snapshot?.settings.timeZone),
);
const anchor = computed(() => props.date || today.value),
  weekStart = computed(
    () => toDooCalendarRange(anchor.value, 'week', state.snapshot?.settings.weekStartsOn ?? 1).from,
  );
const start = computed(
  () => toDooCalendarRange(anchor.value, 'month', state.snapshot?.settings.weekStartsOn ?? 1).from,
);
const days = computed(() =>
  Array.from({ length: props.view === 'week' ? 7 : 42 }, (_, i) =>
    shiftToDooDate(props.view === 'week' ? weekStart.value : start.value, i),
  ),
);
const weekDays = computed(() =>
  Array.from({ length: 7 }, (_, i) => shiftToDooDate(weekStart.value, i)),
);
const items = computed(() => props.model.items());
const taskGroups = computed(() =>
  groupTaskItems(
    items.value,
    props.model.taskDefinitions(),
    state.snapshot?.sections ?? [],
    state.filter.listIds?.length === 1 ? state.filter.listIds[0] : undefined,
  ),
);
function toggleGroup(id: string) {
  state.collapsedTaskGroups = state.collapsedTaskGroups.includes(id)
    ? state.collapsedTaskGroups.filter((value) => value !== id)
    : [...state.collapsedTaskGroups, id];
}
const hours = Array.from({ length: 24 }, (_, i) => i);
const selectedExternal = ref<ToDooEntityMap['calendarEvent']>();
const label = (date: string) =>
  new Date(date + 'T12:00:00Z').toLocaleDateString('zh-CN', {
    month: 'numeric',
    day: 'numeric',
    weekday: 'short',
    timeZone: 'UTC',
  });
function move(delta: number) {
  if (props.view === 'week' || props.timeline) {
    emit('navigate', {
      date: shiftToDooDate(anchor.value, delta * (props.timeline ? 28 : 7)),
      calendarView: props.view,
    });
    return;
  }
  const d = new Date(anchor.value + 'T12:00:00Z');
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() + delta);
  emit('navigate', { date: d.toISOString().slice(0, 10), calendarView: props.view });
}
function calendarViewChanged(value: string | number) {
  if (value === 'week' || value === 'month')
    emit('navigate', { date: anchor.value, calendarView: value });
}
function calendarDateChanged(date: string) {
  if (date) emit('navigate', { date, calendarView: props.view });
}
function blockSegment(block: ToDooEntityMap['timeBlock'], date: string) {
  return toDooBlockSegment(block, date, state.snapshot!.settings.timeZone);
}
function blocks(date: string) {
  return (
    state.snapshot?.timeBlocks.filter((block) => !block.deletedAt && blockSegment(block, date)) ||
    []
  );
}
function deadline(item: ToDooItem) {
  const value = item.occurrence?.due;
  return value ? toDooDisplayTime(value, state.snapshot!.settings.timeZone) : null;
}
function deadlineLabel(item: ToDooItem) {
  const value = deadline(item);
  return value ? value.date + ' ' + (value.time || '全天') : '';
}
function timelineBlocks(item: ToDooItem) {
  return item.blocks.flatMap((value) => {
    const block = state.snapshot?.timeBlocks.find((b) => b.id === value.id) || value;
    const occupied = timelineDays.value
      .map((day, index) => (blockSegment(block, day) ? index : -1))
      .filter((index) => index >= 0);
    if (!occupied.length) return [];
    return [
      {
        block,
        column: occupied[0]! + 1 + ' / span ' + (occupied[occupied.length - 1]! - occupied[0]! + 1),
        label:
          block.allDay || !block.start.time
            ? block.start.date + ' 全天'
            : (() => {
                const display = toDooDisplayTime(block.start, state.snapshot!.settings.timeZone);
                return display.date + ' ' + display.time + ' · ' + block.durationMinutes + ' 分钟';
              })(),
      },
    ];
  });
}
function timelineSummary(item: ToDooItem) {
  const parts: string[] = [];
  if (!timelineBlocks(item).length)
    parts.push(
      item.blocks.length ? '已知计划在当前区间外' : '当前区间无计划；其他日期需进入任务详情查看',
    );
  const due = deadline(item);
  if (due && (offset(due.date) < 0 || offset(due.date) >= 28))
    parts.push('截止在当前区间外：' + deadlineLabel(item));
  return parts.join(' · ');
}
function itemFor(id: string | null) {
  return items.value.find((i) => i.occurrence?.id === id);
}
function due(date: string) {
  return items.value.filter(
    (i) =>
      i.occurrence?.due &&
      toDooDisplayTime(i.occurrence.due, state.snapshot!.settings.timeZone).date === date,
  );
}
function external(date: string) {
  return showExternal.value
    ? state.snapshot?.calendarEvents.filter(
        (e) =>
          !e.deletedAt &&
          !e.seriesMaster &&
          e.sourceStatus !== 'CANCELLED' &&
          !!externalSegment(e, date),
      ) || []
    : [];
}
function externalSegment(event: ToDooEntityMap['calendarEvent'], date: string) {
  const zone = state.snapshot!.settings.timeZone;
  const start = event.allDay ? event.start : toDooDisplayTime(event.start, zone);
  const end = event.end ? (event.allDay ? event.end : toDooDisplayTime(event.end, zone)) : null;
  if (event.allDay || !start.time) {
    const endDate = end?.date || shiftToDooDate(start.date, 1);
    return start.date <= date && date < endDate ? { time: null, duration: 1440 } : null;
  }
  const instant = (value: ToDooEntityMap['calendarEvent']['start']) => {
    const utc = toDooDisplayTime({ ...value, time: value.time || '00:00' }, 'UTC');
    return Date.parse(utc.date + 'T' + utc.time + ':00Z');
  };
  const startsAt = instant(event.start);
  const endsAt = event.end ? instant(event.end) : startsAt + 30 * 60000;
  const dayStart = instant({ date, time: '00:00', timeZone: zone });
  const dayEnd = instant({ date: shiftToDooDate(date, 1), time: '00:00', timeZone: zone });
  const from = Math.max(startsAt, dayStart);
  const to = Math.min(endsAt, dayEnd);
  if (to <= from) return null;
  return {
    time: new Intl.DateTimeFormat('en-GB', {
      timeZone: zone,
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    }).format(new Date(from)),
    duration: (to - from) / 60000,
    endTime: toDooInstantTime(to, zone),
    from,
    to,
  };
}
const anniversaryOccurrences = computed(() => {
  const grouped = new Map<string, ToDooEntityMap['anniversary'][]>();
  if (!showAnniversaries.value || props.timeline) return grouped;
  const range = toDooCalendarRange(
    anchor.value,
    props.view || 'month',
    state.snapshot?.settings.weekStartsOn ?? 1,
  );
  for (const anniversary of state.snapshot?.anniversaries ?? []) {
    if (anniversary.deletedAt) continue;
    const date = toDooAnniversaryDate(anniversary, range.from);
    if (date && date >= range.from && date <= range.to)
      grouped.set(date, [...(grouped.get(date) ?? []), anniversary]);
  }
  return grouped;
});
const anniversaries = (date: string) => anniversaryOccurrences.value.get(date) ?? [];
const agendaDays = computed(() =>
  (props.view === 'week'
    ? weekDays.value
    : days.value.filter((day) => day.slice(0, 7) === anchor.value.slice(0, 7))
  ).filter(
    (day) =>
      showEmptyDates.value ||
      day === anchor.value ||
      day === today.value ||
      blocks(day).length > 0 ||
      due(day).length > 0 ||
      external(day).length > 0 ||
      anniversaries(day).length > 0,
  ),
);
function drag(event: DragEvent, id: string) {
  event.dataTransfer?.setData('application/x-to-doo-block', id);
}
async function drop(event: DragEvent, date: string, time?: string) {
  event.preventDefault();
  const id = event.dataTransfer?.getData('application/x-to-doo-block'),
    b = state.snapshot?.timeBlocks.find((b) => b.id === id);
  if (!b) return;
  const start = {
    ...(b.allDay ? b.start : toDooDisplayTime(b.start, state.snapshot!.settings.timeZone)),
    date,
    ...(time ? { time } : {}),
  };
  const occurrence = state.snapshot?.occurrences.find((o) => o.id === b.occurrenceId);
  if (b.occurrenceId && !occurrence) {
    state.error = '请先继续载入执行实例，再调整这项安排';
    return;
  }
  if (occurrence) {
    await props.model.execute(
      {
        action: 'preview_plan',
        payload: {
          name: '移动安排预览',
          changes: [toDooMoveBlock(b, occurrence, start)],
          includeDependents: includeDependents.value,
          reason: includeDependents.value
            ? '显式联动后续安排，确认后应用'
            : '移动原时间块，应用前核对重叠与依赖',
        },
      },
      '移动预览已生成，确认后更新日历',
    );
  } else await props.model.saveEntity('timeBlock', { ...b, start }, b.revision, '计划时间已更新');
}
async function preview() {
  const chosen = items.value
    .filter(
      (i) =>
        i.occurrence &&
        (!state.selectedIds.length || state.selectedIds.includes(i.task.id)) &&
        !['done', 'cancelled', 'skipped'].includes(i.status),
    )
    .slice(0, 20);
  let minutes = Number(planTime.value.slice(0, 2)) * 60 + Number(planTime.value.slice(3));
  const changes = chosen.map((i) => {
    const start = {
      date: shiftToDooDate(anchor.value, Math.floor(minutes / 1440)),
      time:
        String(Math.floor(minutes / 60) % 24).padStart(2, '0') +
        ':' +
        String(minutes % 60).padStart(2, '0'),
      timeZone: state.snapshot!.settings.timeZone,
    };
    const durationMinutes =
      i.task.estimateMinutes || state.snapshot!.settings.defaultDurationMinutes;
    minutes += durationMinutes;
    return {
      occurrenceId: i.occurrence!.id,
      expectedRevision: i.occurrence!.revision,
      start,
      durationMinutes,
      ...(i.blocks[0]
        ? {
            blockId: i.blocks[0].id,
            expectedBlockRevision: i.blocks[0].revision,
            allDay: false,
            dateEndExclusive: null,
          }
        : {}),
    };
  });
  if (!changes.length) {
    state.error = '当前没有可安排的未完成任务';
    return;
  }
  await props.model.execute(
    {
      action: 'preview_plan',
      payload: {
        name: anchor.value + ' 行动安排',
        includeDependents: includeDependents.value,
        changes,
        reason: '按当前任务顺序连续安排，应用前核对重叠与依赖',
      },
    },
    '安排预览已生成，尚未修改日历',
  );
}
const timelineDays = computed(() =>
  Array.from({ length: 28 }, (_, i) => shiftToDooDate(anchor.value, i)),
);
function offset(date: string) {
  return Math.round(
    (Date.parse(date + 'T12:00:00Z') - Date.parse(anchor.value + 'T12:00:00Z')) / 86400000,
  );
}
function inspectExternal(event: ToDooEntityMap['calendarEvent']) {
  if (event.readOnly) selectedExternal.value = event;
  else emit('edit', 'calendarEvent', event);
}
function weekEvents(day: string) {
  type Entry = {
    id: string;
    title: string;
    time: string;
    endTime: string;
    duration: number;
    from: number;
    to: number;
    block?: ToDooEntityMap['timeBlock'];
    event?: ToDooEntityMap['calendarEvent'];
  };
  const entries: Entry[] = [];
  for (const block of blocks(day)) {
    const segment = blockSegment(block, day);
    if (!segment?.time) continue;
    entries.push({
      ...segment,
      time: segment.time,
      endTime: segment.endTime!,
      id: block.id,
      title: itemFor(block.occurrenceId)?.title || block.title || '时间安排',
      block,
    });
  }
  for (const event of external(day)) {
    const segment = externalSegment(event, day);
    if (!segment?.time || !('from' in segment)) continue;
    entries.push({ ...segment, id: event.id, title: event.title, event });
  }
  const actual = toDooConflictLanes(entries);
  // Pack painted rectangles independently: minimum readable height is not a time conflict.
  return toDooConflictLanes(
    actual.map((entry) => {
      const drawing = eventDrawing(entry);
      return { entry, from: drawing.top, to: drawing.top + drawing.height };
    }),
  ).map(({ entry, lane, lanes }) => ({ ...entry, displayLane: lane, displayLanes: lanes }));
}
function eventDrawing(event: { time: string; duration: number }) {
  const minute = Number(event.time.slice(0, 2)) * 60 + Number(event.time.slice(3));
  return {
    top: (minute / 60) * 46,
    height: Math.max(72, (Math.min(1440 - minute, Math.max(30, event.duration)) / 60) * 46),
  };
}
function slotStyle(event: ReturnType<typeof weekEvents>[number]) {
  const drawing = eventDrawing(event);
  return {
    top: drawing.top + 'px',
    height: drawing.height + 'px',
    left: 'calc(' + (event.displayLane / event.displayLanes) * 100 + '% + 2px)',
    right: 'auto',
    width: 'calc(' + 100 / event.displayLanes + '% - 4px)',
  };
}
const readableEventIdentity = ref<{ id: string; day: string; external: boolean }>();
const readableEvent = computed(() => {
  const identity = readableEventIdentity.value;
  if (
    !identity ||
    props.timeline ||
    props.view !== 'week' ||
    !weekDays.value.includes(identity.day)
  )
    return undefined;
  return weekEvents(identity.day).find(
    (event) => event.id === identity.id && !!event.event === identity.external,
  );
});
function inspectWeekEvent(event: ReturnType<typeof weekEvents>[number], day: string) {
  readableEventIdentity.value = { id: event.id, day, external: !!event.event };
}
watch([anchor, () => props.view, () => props.timeline], () => {
  readableEventIdentity.value = undefined;
});
const weekLayout = computed(() => {
  const minimums = weekDays.value.map((day) =>
    Math.max(110, Math.max(1, ...weekEvents(day).map((event) => event.displayLanes)) * 90),
  );
  return {
    minimumWidth: Math.max(980, 42 + minimums.reduce((total, width) => total + width, 0)),
    gridTemplateColumns: '42px ' + minimums.map((width) => `minmax(${width}px, 1fr)`).join(' '),
  };
});
const weekViewport = ref<HTMLElement>();
const hasWeekAllDay = computed(() =>
  weekDays.value.some(
    (day) =>
      blocks(day).some((block) => block.allDay || block.start.time === null) ||
      external(day).some((event) => event.allDay || event.start.time === null) ||
      anniversaries(day).length > 0 ||
      due(day).length > 0,
  ),
);
let scrollRange = '',
  pendingWeekPosition = false,
  scrollRevision = 0;
function cancelWeekPosition() {
  pendingWeekPosition = false;
  scrollRevision += 1;
}
watch(
  [
    () => props.view,
    () => props.timeline,
    weekStart,
    () => state.loading,
    () => state.snapshot,
    () => state.query?.from,
    () => state.query?.to,
  ],
  async () => {
    const range = props.timeline || props.view !== 'week' ? '' : weekStart.value;
    if (scrollRange !== range) {
      scrollRange = range;
      pendingWeekPosition = !!range;
      scrollRevision += 1;
    }
    const revision = scrollRevision;
    await nextTick();
    if (
      !pendingWeekPosition ||
      revision !== scrollRevision ||
      state.loading ||
      state.error ||
      !state.snapshot ||
      !weekViewport.value ||
      (state.query?.from && state.query.from !== range) ||
      (state.query?.to && state.query.to !== shiftToDooDate(range, 6))
    )
      return;
    const eventHours = weekDays.value.flatMap((day) =>
      weekEvents(day).map((event) => Number(event.time.slice(0, 2))),
    );
    const hour = eventHours.length ? Math.max(0, Math.min(...eventHours) - 1) : 8;
    pendingWeekPosition = false;
    weekViewport.value.scrollTop = hour * 46;
  },
  { immediate: true, flush: 'post' },
);
</script>
<template>
  <div class="todo-calendar-toolbar">
    <div class="todo-actions">
      <AButton
        class="todo-icon-button"
        html-type="button"
        aria-label="上一周期"
        @click="move(-1)"
        type="text"
      >
        ‹
      </AButton>
      <h2>
        {{
          timeline
            ? anchor + ' 起的 4 周'
            : view === 'week'
              ? label(weekStart) + ' — ' + label(shiftToDooDate(weekStart, 6))
              : anchor.slice(0, 4) + ' 年 ' + Number(anchor.slice(5, 7)) + ' 月'
        }}
      </h2>
      <AButton
        class="todo-icon-button"
        html-type="button"
        aria-label="下一周期"
        @click="move(1)"
        type="text"
      >
        ›</AButton
      ><AButton
        class="todo-button"
        html-type="button"
        @click="emit('navigate', { date: today, calendarView: view })"
        type="default"
      >
        今天
      </AButton>
    </div>
    <div class="todo-actions">
      <ASegmented
        v-if="!timeline"
        aria-label="日历视图"
        :value="view === 'week' ? 'week' : 'month'"
        :options="[
          { label: '周', value: 'week' },
          { label: '月', value: 'month' },
        ]"
        @change="calendarViewChanged"
      />
      <AButton
        html-type="button"
        type="default"
        class="todo-button"
        :aria-expanded="displayOpen"
        @click="displayOpen = !displayOpen"
        >显示内容</AButton
      >
      <AButton
        class="todo-button todo-primary"
        html-type="button"
        @click="
          emit('edit', 'timeBlock', undefined, {
            start: {
              date: anchor,
              time: '09:00',
              timeZone: state.snapshot?.settings.timeZone || 'UTC',
            },
          })
        "
        type="primary"
      >
        ＋ 时间安排
      </AButton>
    </div>
  </div>
  <div v-if="displayOpen" class="todo-calendar-options todo-calendar-display-panel">
    <label class="todo-calendar-jump"
      >跳转日期<ToDooDateField
        type="date"
        aria-label="跳转日期"
        :value="anchor"
        :allow-clear="false"
        @change="calendarDateChanged"
    /></label>
    <div class="todo-calendar-layers">
      <ACheckbox v-if="!timeline" v-model:checked="showExternal" class="todo-checkbox"
        >外部日历</ACheckbox
      >
      <ACheckbox v-model:checked="showHabits" class="todo-checkbox">习惯</ACheckbox>
      <ACheckbox v-if="!timeline" v-model:checked="showAnniversaries" class="todo-checkbox"
        >纪念日</ACheckbox
      >
    </div>
    <span>显示时区：{{ state.snapshot?.settings.timeZone }}</span>
  </div>
  <div v-if="state.preview" class="todo-plan-preview todo-panel">
    <div class="todo-panel-header">
      <h2>{{ state.preview.name }}</h2>
      <span class="todo-badge">{{ state.preview.changes.length }} 项安排待确认</span>
    </div>
    <div class="todo-pad">
      <AAlert
        v-for="conflict in state.preview.conflicts"
        :key="conflict"
        type="warning"
        :message="conflict"
        show-icon
      />
      <div
        v-for="change in state.preview.changes"
        :key="change.occurrenceId"
        class="todo-saved-row"
      >
        <span
          >{{
            itemFor(change.occurrenceId)?.title ||
            state.snapshot?.tasks.find(
              (t) =>
                t.id ===
                state.snapshot?.occurrences.find((o) => o.id === change.occurrenceId)?.taskId,
            )?.title ||
            '关联行动'
          }}<small
            >{{ change.start.date }} {{ change.start.time }} ·
            {{ change.durationMinutes }} 分钟</small
          ></span
        >
      </div>
      <div class="todo-actions">
        <AButton
          class="todo-button todo-primary"
          html-type="button"
          :disabled="state.busy || !!state.preview.conflicts.length"
          :loading="state.busy"
          @click="
            model
              .execute({ action: 'apply_plan', payload: { plan: state.preview! } }, '安排已应用')
              .then((r) => r && (state.preview = null))
          "
          type="primary"
        >
          确认应用安排</AButton
        ><AButton
          class="todo-button"
          html-type="button"
          @click="state.preview = null"
          type="default"
          >取消</AButton
        >
      </div>
    </div>
  </div>
  <template v-if="timeline">
    <div class="todo-task-toolbar">
      <ASegmented
        aria-label="任务展示方式"
        value="timeline"
        :options="[
          { value: 'tasks', label: '列表' },
          { value: 'board', label: '看板' },
          { value: 'matrix', label: '四象限' },
          { value: 'timeline', label: '时间线' },
        ]"
        @change="emit('task-view', $event as 'tasks' | 'board' | 'matrix' | 'timeline')"
      />
    </div>
    <div
      class="todo-timeline-scroll"
      role="region"
      aria-label="任务时间线，可横向滚动"
      tabindex="0"
    >
      <div class="todo-timeline todo-panel">
        <div class="todo-timeline-row todo-timeline-header">
          <span>任务 / 计划与截止</span>
          <div class="todo-timeline-track">
            <span v-for="day in timelineDays" :key="day" :title="day">{{ day.slice(5) }}</span>
          </div>
        </div>
        <template v-for="group in taskGroups" :key="group.id">
          <div v-if="group.showHeader" class="todo-timeline-group-heading">
            <AButton
              type="text"
              :aria-label="
                (state.collapsedTaskGroups.includes(group.id) ? '展开分组 ' : '折叠分组 ') +
                group.name
              "
              @click="toggleGroup(group.id)"
              >{{ state.collapsedTaskGroups.includes(group.id) ? '›' : '⌄' }} {{ group.name }}
              <small>{{ group.items.length }}</small></AButton
            >
          </div>
          <template v-if="!state.collapsedTaskGroups.includes(group.id)">
            <div v-for="item in group.items" :key="item.key" class="todo-timeline-row">
              <AButton
                class="todo-task-body"
                html-type="button"
                @click="emit('open', item)"
                type="text"
              >
                {{ item.title
                }}<small v-if="!state.filter.listIds?.length">{{
                  item.list?.name || '收集箱'
                }}</small>
              </AButton>
              <div class="todo-timeline-track">
                <button
                  v-for="entry in timelineBlocks(item)"
                  :key="entry.block.id"
                  type="button"
                  class="todo-timeline-bar"
                  :style="{ gridColumn: entry.column }"
                  :aria-label="entry.label + ' ' + item.title"
                  :title="entry.label + ' · ' + item.title"
                  @click="emit('edit', 'timeBlock', entry.block)"
                >
                  {{ entry.label }}</button
                ><button
                  v-if="
                    deadline(item) &&
                    offset(deadline(item)!.date) >= 0 &&
                    offset(deadline(item)!.date) < 28
                  "
                  class="todo-deadline"
                  type="button"
                  :style="{ gridColumn: offset(deadline(item)!.date) + 1 }"
                  :aria-label="'截止 ' + deadlineLabel(item) + ' ' + item.title"
                  :title="'截止 ' + deadlineLabel(item) + ' · ' + item.title"
                  @click="emit('open', item)"
                >
                  ◆ {{ deadline(item)?.date.slice(5)
                  }}<small>{{ deadline(item)?.time || '全天' }}</small></button
                ><span v-if="timelineSummary(item)" class="todo-unscheduled">{{
                  timelineSummary(item)
                }}</span>
              </div>
            </div>
          </template>
        </template>
        <AEmpty
          v-if="!items.length"
          class="todo-empty"
          description="为行动安排第一段时间，时间线会在这里展开。"
          :image="AEmpty.PRESENTED_IMAGE_SIMPLE"
        />
      </div>
    </div>
    <p class="todo-muted todo-small">
      紫色区段代表计划；◆ 代表截止。点击区段调整时间，任务详情可设置前置依赖。
    </p></template
  >
  <template v-else>
    <div class="todo-mobile-calendar-choice">
      <ASegmented
        aria-label="手机日历展示"
        v-model:value="mobilePresentation"
        :options="[
          { label: '议程', value: 'agenda' },
          { label: '网格', value: 'grid' },
        ]"
      />
    </div>
    <div
      class="todo-calendar-grid-scroll"
      :class="{ 'is-mobile-grid': mobilePresentation === 'grid' }"
      role="region"
      aria-label="日历网格，可横向滚动"
      tabindex="0"
    >
      <div v-if="view !== 'week'" class="todo-month">
        <div v-for="d in days.slice(0, 7)" :key="d" class="todo-weekday">
          {{
            new Date(d + 'T12:00:00Z').toLocaleDateString('zh-CN', {
              weekday: 'short',
              timeZone: 'UTC',
            })
          }}
        </div>
        <div
          v-for="day in days"
          :key="day"
          class="todo-month-day"
          :class="{ 'is-today': day === today, outside: day.slice(0, 7) !== anchor.slice(0, 7) }"
          @dragover.prevent
          @drop="drop($event, day)"
        >
          <button
            type="button"
            class="todo-day-number"
            :aria-label="'在 ' + day + ' 添加安排'"
            @click="
              emit('edit', 'timeBlock', undefined, {
                start: {
                  date: day,
                  time: '09:00',
                  timeZone: state.snapshot?.settings.timeZone || 'UTC',
                },
              })
            "
          >
            {{ day.slice(0, 7) !== anchor.slice(0, 7) ? Number(day.slice(5, 7)) + '/' : ''
            }}{{ Number(day.slice(-2)) }}</button
          ><button
            v-for="b in blocks(day)"
            :key="b.id"
            type="button"
            draggable="true"
            class="todo-calendar-event"
            @dragstart="drag($event, b.id)"
            @click="emit('edit', 'timeBlock', b)"
          >
            {{ blockSegment(b, day)?.time || '全天' }}
            {{ itemFor(b.occurrenceId)?.title || b.title || '时间安排' }}</button
          ><button
            v-for="item in due(day)"
            :key="item.key"
            class="todo-calendar-event deadline"
            type="button"
            @click="emit('open', item)"
          >
            ◆ {{ deadlineLabel(item) }} · {{ item.title }}</button
          ><button
            v-for="e in external(day)"
            :key="e.id"
            type="button"
            class="todo-calendar-event external"
            @click="inspectExternal(e)"
          >
            {{ externalSegment(e, day)?.time || '全天' }} {{ e.title }} ·
            {{ e.readOnly ? '只读' : '外部' }}</button
          ><span
            v-for="a in anniversaries(day)"
            :key="a.id"
            class="todo-calendar-event anniversary"
            :data-anniversary-id="a.id"
            :data-date="day"
            >◇ {{ a.name }}</span
          >
        </div>
      </div>
      <div v-else class="todo-week" :style="{ minWidth: weekLayout.minimumWidth + 'px' }">
        <div
          ref="weekViewport"
          class="todo-week-viewport"
          role="region"
          aria-label="每周时间安排，包含全部 24 小时"
          tabindex="0"
          @wheel.passive="cancelWeekPosition"
          @touchstart.passive="cancelWeekPosition"
          @pointerdown="cancelWeekPosition"
          @keydown="cancelWeekPosition"
          @scroll.passive="cancelWeekPosition"
        >
          <div class="todo-week-head">
            <div
              class="todo-week-labels"
              :style="{ gridTemplateColumns: weekLayout.gridTemplateColumns }"
            >
              <span></span>
              <div v-for="day in weekDays" :key="day" :class="{ 'is-today': day === today }">
                {{ label(day) }}
              </div>
            </div>
            <div
              v-if="hasWeekAllDay"
              class="todo-week-allday"
              role="region"
              aria-label="全天安排与截止"
              tabindex="0"
            >
              <div
                class="todo-week-all-day-grid"
                :style="{ gridTemplateColumns: weekLayout.gridTemplateColumns }"
              >
                <span></span>
                <div v-for="day in weekDays" :key="day" :class="{ 'is-today': day === today }">
                  <button
                    v-for="block in blocks(day).filter((b) => b.allDay || b.start.time === null)"
                    :key="block.id"
                    type="button"
                    class="todo-calendar-event"
                    @click="emit('edit', 'timeBlock', block)"
                  >
                    全天 ·
                    {{ itemFor(block.occurrenceId)?.title || block.title || '时间安排' }}</button
                  ><button
                    v-for="event in external(day).filter((e) => e.allDay || e.start.time === null)"
                    :key="event.id"
                    type="button"
                    class="todo-calendar-event external"
                    @click="inspectExternal(event)"
                  >
                    全天 · {{ event.title }}
                  </button>
                  <span
                    v-for="a in anniversaries(day)"
                    :key="a.id"
                    class="todo-calendar-event anniversary"
                    :data-anniversary-id="a.id"
                    :data-date="day"
                    >◇ {{ a.name }}</span
                  >
                  <div v-for="item in due(day)" :key="item.key">
                    <button
                      type="button"
                      class="todo-calendar-event deadline"
                      @click="emit('open', item)"
                    >
                      ◆ {{ deadlineLabel(item) }} · {{ item.title }}
                    </button>
                  </div>
                </div>
              </div>
            </div>
          </div>
          <div
            class="todo-week-body"
            :style="{ gridTemplateColumns: weekLayout.gridTemplateColumns }"
          >
            <div class="todo-hour-labels">
              <span v-for="hour in hours" :key="hour">{{ String(hour).padStart(2, '0') }}:00</span>
            </div>
            <div v-for="day in weekDays" :key="day" class="todo-week-lane">
              <div
                v-for="hour in hours"
                :key="hour"
                class="todo-week-slot"
                @dragover.prevent
                @drop="drop($event, day, String(hour).padStart(2, '0') + ':00')"
              ></div>
              <button
                v-for="event in weekEvents(day)"
                :key="event.id"
                type="button"
                class="todo-week-event"
                :class="{ external: !!event.event }"
                :draggable="!!event.block"
                :style="slotStyle(event)"
                :aria-label="event.title + ' ' + event.time + ' ' + event.duration + '分钟'"
                :title="
                  event.title +
                  ' · ' +
                  event.time +
                  '—' +
                  event.endTime +
                  ' · ' +
                  event.duration +
                  ' 分钟'
                "
                @focus="inspectWeekEvent(event, day)"
                @mouseenter="inspectWeekEvent(event, day)"
                @dragstart="event.block && drag($event, event.block.id)"
                @click="
                  event.block
                    ? emit('edit', 'timeBlock', event.block)
                    : event.event && inspectExternal(event.event)
                "
              >
                <span class="todo-week-event-title">{{ event.title }}</span
                ><small>{{ event.time }}—{{ event.endTime }} · {{ event.duration }} 分钟</small>
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
    <p v-if="readableEvent" class="todo-calendar-event-detail" role="status">
      {{ readableEvent.title }} · {{ readableEvent.time }}—{{ readableEvent.endTime }} ·
      {{ readableEvent.duration }} 分钟
    </p>
    <div class="todo-mobile-agenda" :class="{ 'is-mobile-grid': mobilePresentation === 'grid' }">
      <div class="todo-agenda-toolbar">
        <AButton
          html-type="button"
          type="text"
          :aria-label="showEmptyDates ? '隐藏空白日期' : '显示空白日期'"
          :aria-pressed="showEmptyDates"
          @click="showEmptyDates = !showEmptyDates"
          >{{ showEmptyDates ? '隐藏空白日期' : '显示空白日期' }}</AButton
        >
      </div>
      <section
        v-for="day in agendaDays"
        :key="day"
        class="todo-panel todo-agenda-day"
        :data-date="day"
      >
        <h3 class="todo-panel-header">{{ label(day) }}{{ day === today ? ' · 今天' : '' }}</h3>
        <AButton
          v-for="b in blocks(day)"
          :key="b.id"
          class="todo-saved-row todo-text-button"
          html-type="button"
          @click="emit('edit', 'timeBlock', b)"
          type="text"
        >
          <span>{{ blockSegment(b, day)?.time || '全天' }}</span
          ><span
            >{{ itemFor(b.occurrenceId)?.title || b.title || '时间安排'
            }}<small>{{ blockSegment(b, day)?.duration }} 分钟</small></span
          ></AButton
        ><AButton
          v-for="item in due(day)"
          :key="item.key"
          html-type="button"
          class="todo-saved-row todo-text-button"
          @click="emit('open', item)"
          type="text"
        >
          ◆ 截止 {{ deadlineLabel(item) }} · {{ item.title }}
        </AButton>
        <AButton
          v-for="e in external(day)"
          :key="e.id"
          html-type="button"
          class="todo-saved-row todo-text-button"
          @click="inspectExternal(e)"
          type="text"
        >
          <span
            >{{ e.title }} · {{ e.readOnly ? '只读事件' : '日历事件'
            }}<small
              >{{ externalSegment(e, day)?.time || '全天'
              }}<template v-if="externalSegment(e, day)?.time"
                >—{{ externalSegment(e, day)?.endTime }} ·
                {{ externalSegment(e, day)?.duration }} 分钟</template
              ></small
            ></span
          >
        </AButton>
        <AButton
          v-for="a in anniversaries(day)"
          :key="a.id"
          type="text"
          class="todo-saved-row todo-text-button"
          :data-anniversary-id="a.id"
          :data-date="day"
          @click="emit('edit', 'anniversary', a)"
          >◇ {{ a.name }} · 纪念日</AButton
        >
        <AButton
          html-type="button"
          class="todo-link todo-pad"
          @click="
            emit('edit', 'timeBlock', undefined, {
              start: {
                date: day,
                time: '09:00',
                timeZone: state.snapshot?.settings.timeZone || 'UTC',
              },
            })
          "
          type="link"
        >
          ＋ 添加安排
        </AButton>
      </section>
    </div>
  </template>
  <div
    v-if="showHabits && state.snapshot?.habits.some((h) => !h.deletedAt)"
    class="todo-calendar-habits todo-panel"
  >
    <h3>每日习惯</h3>
    <span
      v-for="h in state.snapshot.habits.filter((h) => !h.deletedAt)"
      :key="h.id"
      class="todo-badge"
      >↻ {{ h.name }} · {{ h.target }} {{ h.unit }}/{{
        { daily: '日', weekly: '周', monthly: '月' }[h.frequency]
      }}</span
    >
  </div>
  <AModal
    :open="!!selectedExternal"
    title="外部日历事件"
    :footer="null"
    :mask-closable="true"
    :focus-trigger-after-close="true"
    @cancel="selectedExternal = undefined"
  >
    <template v-if="selectedExternal">
      <h2>{{ selectedExternal.title }}</h2>
      <p>
        {{ selectedExternal.start.date }} {{ selectedExternal.start.time || '全天' }} ·
        {{ selectedExternal.start.timeZone }}
      </p>
      <p v-if="selectedExternal.end">
        结束：{{ selectedExternal.end.date }} {{ selectedExternal.end.time || '全天' }}
      </p>
      <p>{{ selectedExternal.description || '来源未提供说明' }}</p>
      <AAlert type="info" message="外部只读来源，变更需在原日历完成" show-icon />
      <div class="todo-actions todo-top-gap">
        <AButton html-type="button" @click="selectedExternal = undefined">关闭</AButton>
      </div>
    </template>
  </AModal>
  <ToDooDisclosure class="todo-plan-disclosure">
    <template #header
      ><span>安排任务</span><small class="todo-muted">连续安排与联动调整</small></template
    >
    <div class="todo-plan-tools">
      <ACheckbox v-model:checked="includeDependents" class="todo-checkbox"
        >联动调整后续安排</ACheckbox
      ><span class="todo-muted todo-small"
        >拖动先预览，确认后更新。按当前任务顺序安排至 {{ anchor }}，最多 20 项</span
      ><ToDooDateField v-model="planTime" type="time" aria-label="连续安排开始时间" /><AButton
        class="todo-button"
        html-type="button"
        :disabled="state.busy || !planTime"
        :loading="state.busy"
        @click="preview"
        type="default"
      >
        预览连续安排
      </AButton>
    </div>
  </ToDooDisclosure>
</template>
<style scoped>
.todo-calendar-display-panel {
  gap: 16px 24px;
  padding: 12px 14px;
  border: 1px solid var(--todo-line);
  border-radius: 8px;
  background: var(--todo-paper);
}
.todo-calendar-jump {
  display: flex;
  align-items: center;
  gap: 8px;
}
.todo-calendar-jump :deep(.ant-picker) {
  width: 145px;
}
.todo-calendar-layers {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
}
.todo-week-viewport {
  max-height: min(65dvh, 620px);
  overflow-y: auto;
  overscroll-behavior: contain;
  scrollbar-gutter: stable;
}
.todo-week-viewport:focus-visible {
  outline: 2px solid var(--todo-accent);
  outline-offset: -2px;
}
.todo-week-lane {
  padding-bottom: 72px;
}
.todo-week-event:hover,
.todo-week-event:focus-visible {
  z-index: 3;
}
.todo-week-event-title {
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}
.todo-week-head {
  display: block;
  position: sticky;
  top: 0;
  z-index: 2;
  background: var(--todo-paper);
}
.todo-week-head > div {
  padding: 0;
  border: 0;
}
.todo-week-labels,
.todo-week-all-day-grid {
  display: grid;
  grid-template-columns: 42px repeat(7, minmax(0, 1fr));
}
.todo-week-labels > div,
.todo-week-all-day-grid > div {
  padding: 9px 3px;
  min-width: 0;
  text-align: center;
  color: var(--todo-muted);
  font-size: 10px;
  border-left: 1px solid var(--todo-line);
  border-bottom: 1px solid var(--todo-line);
}
.todo-week-labels > span,
.todo-week-all-day-grid > span {
  border-bottom: 1px solid var(--todo-line);
}
.todo-week-labels > div.is-today,
.todo-week-all-day-grid > div.is-today {
  color: var(--todo-accent);
  background: var(--todo-tint);
}
.todo-week-allday {
  max-height: min(22dvh, 180px);
  overflow-y: auto;
  overscroll-behavior: contain;
  scrollbar-width: thin;
}
.todo-week-allday:focus-visible {
  outline: 2px solid var(--todo-accent);
  outline-offset: -2px;
}
.todo-agenda-toolbar {
  display: flex;
  justify-content: flex-end;
}
.todo-agenda-toolbar .ant-btn {
  font-size: 11px;
  color: var(--todo-muted);
}
@container (max-width: 650px) {
  .todo-calendar-toolbar > .todo-actions {
    gap: 8px;
  }
  .todo-calendar-display-panel {
    align-items: flex-start;
    flex-direction: column;
    gap: 12px;
  }
}
</style>
