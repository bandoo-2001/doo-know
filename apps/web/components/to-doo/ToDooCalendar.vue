<script setup lang="ts">
import { computed, ref } from 'vue';
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
}>();
const state = props.model.state,
  showExternal = ref(true),
  showHabits = ref(true),
  showAnniversaries = ref(true),
  planTime = ref('09:00'),
  includeDependents = ref(false);
const today = computed(() => toDooLocalDate(new Date(), state.snapshot?.settings.timeZone));
const anchor = computed(() => props.date || today.value),
  weekStart = computed(() => {
    const day = new Date(anchor.value + 'T12:00:00Z').getUTCDay();
    return shiftToDooDate(
      anchor.value,
      -((day - (state.snapshot?.settings.weekStartsOn ?? 1) + 7) % 7),
    );
  });
const monthStart = computed(() => anchor.value.slice(0, 7) + '-01');
const start = computed(() => {
  const day = new Date(monthStart.value + 'T12:00:00Z').getUTCDay();
  return shiftToDooDate(
    monthStart.value,
    -((day - (state.snapshot?.settings.weekStartsOn ?? 1) + 7) % 7),
  );
});
const days = computed(() =>
  Array.from({ length: props.view === 'week' ? 7 : 42 }, (_, i) =>
    shiftToDooDate(props.view === 'week' ? weekStart.value : start.value, i),
  ),
);
const weekDays = computed(() =>
  Array.from({ length: 7 }, (_, i) => shiftToDooDate(weekStart.value, i)),
);
const items = computed(() => props.model.items());
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
function blocks(date: string) {
  return (
    state.snapshot?.timeBlocks
      .filter((b) => !b.deletedAt)
      .map((b) => ({
        ...b,
        start: b.allDay ? b.start : toDooDisplayTime(b.start, state.snapshot!.settings.timeZone),
      }))
      .filter(
        (b) =>
          b.start.date === date ||
          (b.allDay && b.start.date < date && !!b.dateEndExclusive && b.dateEndExclusive > date),
      ) || []
  );
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
          (e.allDay ? e.start : toDooDisplayTime(e.start, state.snapshot!.settings.timeZone))
            .date === date,
      ) || []
    : [];
}
function anniversaries(date: string) {
  return showAnniversaries.value
    ? state.snapshot?.anniversaries.filter(
        (a) =>
          !a.deletedAt &&
          a.calendar === 'gregorian' &&
          (a.repeatYearly ? a.date.slice(5) === date.slice(5) : a.date === date),
      ) || []
    : [];
}
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
    duration: number;
    block?: ToDooEntityMap['timeBlock'];
    event?: ToDooEntityMap['calendarEvent'];
    lane: number;
    lanes: number;
  };
  const entries: Entry[] = [];
  for (const block of blocks(day)) {
    if (block.allDay || block.start.time === null) continue;
    entries.push({
      id: block.id,
      title: itemFor(block.occurrenceId)?.title || block.title || '时间安排',
      time: block.start.time,
      duration: block.durationMinutes,
      block,
      lane: 0,
      lanes: 1,
    });
  }
  for (const event of external(day)) {
    const start = toDooDisplayTime(event.start, state.snapshot!.settings.timeZone);
    if (event.allDay || !start.time) continue;
    const end = event.end ? toDooDisplayTime(event.end, state.snapshot!.settings.timeZone) : null;
    const duration = end
      ? Math.max(
          15,
          (Date.parse(end.date + 'T' + (end.time || '00:00') + ':00Z') -
            Date.parse(start.date + 'T' + start.time + ':00Z')) /
            60000,
        )
      : 30;
    entries.push({
      id: event.id,
      title: event.title,
      time: start.time,
      duration,
      event,
      lane: 0,
      lanes: 1,
    });
  }
  entries.sort((a, b) => a.time.localeCompare(b.time));
  const ends: number[] = [];
  let max = 1;
  for (const entry of entries) {
    const start = Number(entry.time.slice(0, 2)) * 60 + Number(entry.time.slice(3));
    let lane = ends.findIndex((end) => end <= start);
    if (lane < 0) lane = ends.length;
    ends[lane] = start + entry.duration;
    entry.lane = lane;
    max = Math.max(max, ends.length);
  }
  return entries.map((entry) => ({ ...entry, lanes: max }));
}
function slotStyle(event: ReturnType<typeof weekEvents>[number]) {
  const minute = Number(event.time.slice(0, 2)) * 60 + Number(event.time.slice(3));
  return {
    top: (minute / 60) * 46 + 'px',
    height: (Math.min(1440 - minute, Math.max(30, event.duration)) / 60) * 46 + 'px',
    minHeight: '24px',
    left: 'calc(' + (event.lane / event.lanes) * 100 + '% + 2px)',
    right: 'auto',
    width: 'calc(' + 100 / event.lanes + '% - 4px)',
  };
}
</script>
<template>
  <div class="todo-calendar-toolbar">
    <div class="todo-actions">
      <button class="todo-icon-button" type="button" aria-label="上一周期" @click="move(-1)">
        ‹
      </button>
      <h2>
        {{
          timeline
            ? anchor + ' 起的 4 周'
            : view === 'week'
              ? label(weekStart) + ' — ' + label(shiftToDooDate(weekStart, 6))
              : anchor.slice(0, 4) + ' 年 ' + Number(anchor.slice(5, 7)) + ' 月'
        }}
      </h2>
      <button class="todo-icon-button" type="button" aria-label="下一周期" @click="move(1)">
        ›</button
      ><button
        class="todo-button"
        type="button"
        @click="emit('navigate', { date: today, calendarView: view })"
      >
        今天
      </button>
    </div>
    <div class="todo-actions">
      <input
        type="date"
        aria-label="跳转日期"
        :value="anchor"
        @change="
          emit('navigate', { date: ($event.target as HTMLInputElement).value, calendarView: view })
        "
      /><template v-if="!timeline"
        ><button
          class="todo-button"
          :class="{ 'todo-primary': view === 'week' }"
          type="button"
          @click="emit('navigate', { date: anchor, calendarView: 'week' })"
        >
          周</button
        ><button
          class="todo-button"
          :class="{ 'todo-primary': view !== 'week' }"
          type="button"
          @click="emit('navigate', { date: anchor, calendarView: 'month' })"
        >
          月
        </button></template
      ><button
        class="todo-button todo-primary"
        type="button"
        @click="
          emit('edit', 'timeBlock', undefined, {
            start: {
              date: anchor,
              time: '09:00',
              timeZone: state.snapshot?.settings.timeZone || 'UTC',
            },
          })
        "
      >
        ＋ 时间安排
      </button>
    </div>
  </div>
  <div class="todo-calendar-options">
    <span>显示时区：{{ state.snapshot?.settings.timeZone }}</span
    ><label class="todo-checkbox"><input v-model="showExternal" type="checkbox" />外部日历</label
    ><label class="todo-checkbox"><input v-model="showHabits" type="checkbox" />习惯</label
    ><label class="todo-checkbox"><input v-model="showAnniversaries" type="checkbox" />纪念日</label
    ><span class="todo-spacer"></span><span>计划与截止分别显示</span>
  </div>
  <div v-if="state.preview" class="todo-plan-preview todo-panel">
    <div class="todo-panel-header">
      <h2>{{ state.preview.name }}</h2>
      <span class="todo-badge">{{ state.preview.changes.length }} 项安排待确认</span>
    </div>
    <div class="todo-pad">
      <p v-for="conflict in state.preview.conflicts" :key="conflict" class="todo-warning">
        {{ conflict }}
      </p>
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
        <button
          class="todo-button todo-primary"
          type="button"
          :disabled="state.busy || !!state.preview.conflicts.length"
          @click="
            model
              .execute({ action: 'apply_plan', payload: { plan: state.preview! } }, '安排已应用')
              .then((r) => r && (state.preview = null))
          "
        >
          确认应用安排</button
        ><button class="todo-button" type="button" @click="state.preview = null">取消</button>
      </div>
    </div>
  </div>
  <template v-if="timeline"
    ><div class="todo-timeline todo-panel">
      <div class="todo-timeline-row todo-timeline-header">
        <span>任务 / 计划与截止</span>
        <div class="todo-timeline-track">
          <span v-for="i in [0, 7, 14, 21]" :key="i" :style="{ gridColumn: i + 1 + ' / span 7' }">{{
            timelineDays[i]?.slice(5)
          }}</span>
        </div>
      </div>
      <div v-for="item in items" :key="item.key" class="todo-timeline-row">
        <button class="todo-task-body" type="button" @click="emit('open', item)">
          {{ item.title }}<small>{{ item.list?.name || '收集箱' }}</small>
        </button>
        <div class="todo-timeline-track">
          <button
            v-for="b in item.blocks.filter(
              (b) => offset(b.start.date) >= 0 && offset(b.start.date) < 28,
            )"
            :key="b.id"
            type="button"
            class="todo-timeline-bar"
            :style="{
              gridColumn:
                offset(b.start.date) +
                1 +
                ' / span ' +
                Math.max(
                  1,
                  Math.min(28 - offset(b.start.date), Math.ceil(b.durationMinutes / 1440)),
                ),
            }"
            :aria-label="b.start.date + ' ' + item.title"
            @click="emit('edit', 'timeBlock', b)"
          >
            {{ b.start.time || '全天' }}</button
          ><button
            v-if="
              item.occurrence?.due &&
              offset(item.occurrence.due.date) >= 0 &&
              offset(item.occurrence.due.date) < 28
            "
            class="todo-deadline"
            type="button"
            :style="{ gridColumn: offset(item.occurrence.due.date) + 1 }"
            :aria-label="'截止 ' + item.occurrence.due.date + ' ' + item.title"
            @click="emit('open', item)"
          >
            ◆</button
          ><span v-if="!item.blocks.length && !item.occurrence?.due" class="todo-unscheduled"
            >未安排</span
          >
        </div>
      </div>
      <p v-if="!items.length" class="todo-empty">为行动安排第一段时间，时间线会在这里展开。</p>
    </div>
    <p class="todo-muted todo-small">
      紫色区段代表计划；◆ 代表截止。点击区段调整时间，任务详情可设置前置依赖。
    </p></template
  >
  <template v-else
    ><div v-if="view !== 'week'" class="todo-month">
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
          {{ Number(day.slice(-2)) }}</button
        ><button
          v-for="b in blocks(day)"
          :key="b.id"
          type="button"
          draggable="true"
          class="todo-calendar-event"
          @dragstart="drag($event, b.id)"
          @click="emit('edit', 'timeBlock', b)"
        >
          {{ b.start.time || '全天' }}
          {{ itemFor(b.occurrenceId)?.title || b.title || '时间安排' }}</button
        ><button
          v-for="item in due(day)"
          :key="item.key"
          class="todo-calendar-event deadline"
          type="button"
          @click="emit('open', item)"
        >
          ◆ {{ item.title }}</button
        ><button
          v-for="e in external(day)"
          :key="e.id"
          type="button"
          class="todo-calendar-event external"
          @click="inspectExternal(e)"
        >
          {{ e.start.time || '全天' }} {{ e.title }} · {{ e.readOnly ? '只读' : '外部' }}</button
        ><span v-for="a in anniversaries(day)" :key="a.id" class="todo-calendar-event anniversary"
          >◇ {{ a.name }}</span
        >
      </div>
    </div>
    <div v-else class="todo-week">
      <div class="todo-week-head">
        <span></span>
        <div v-for="day in weekDays" :key="day" :class="{ 'is-today': day === today }">
          {{ label(day) }}
          <button
            v-for="block in blocks(day).filter((b) => b.allDay || b.start.time === null)"
            :key="block.id"
            type="button"
            class="todo-calendar-event"
            @click="emit('edit', 'timeBlock', block)"
          >
            全天 · {{ itemFor(block.occurrenceId)?.title || block.title || '时间安排' }}</button
          ><button
            v-for="event in external(day).filter((e) => e.allDay || e.start.time === null)"
            :key="event.id"
            type="button"
            class="todo-calendar-event external"
            @click="inspectExternal(event)"
          >
            全天 · {{ event.title }}
          </button>
          <div v-for="item in due(day)" :key="item.key">
            <button type="button" class="todo-calendar-event deadline" @click="emit('open', item)">
              ◆ {{ item.title }}
            </button>
          </div>
        </div>
      </div>
      <div class="todo-week-body">
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
            :title="event.title + ' · ' + event.time"
            @dragstart="event.block && drag($event, event.block.id)"
            @click="
              event.block
                ? emit('edit', 'timeBlock', event.block)
                : event.event && inspectExternal(event.event)
            "
          >
            {{ event.title }}<small>{{ event.time }} · {{ event.duration }} 分钟</small>
          </button>
        </div>
      </div>
    </div>
    <div class="todo-mobile-agenda">
      <section
        v-for="day in view === 'week'
          ? weekDays
          : days.filter((d) => d.slice(0, 7) === anchor.slice(0, 7))"
        :key="day"
        class="todo-panel"
      >
        <h3 class="todo-panel-header">{{ label(day) }}{{ day === today ? ' · 今天' : '' }}</h3>
        <button
          v-for="b in blocks(day)"
          :key="b.id"
          class="todo-saved-row todo-text-button"
          type="button"
          @click="emit('edit', 'timeBlock', b)"
        >
          <span>{{ b.start.time || '全天' }}</span
          ><span
            >{{ itemFor(b.occurrenceId)?.title || b.title || '时间安排'
            }}<small>{{ b.durationMinutes }} 分钟</small></span
          ></button
        ><button
          v-for="item in due(day)"
          :key="item.key"
          type="button"
          class="todo-saved-row todo-text-button"
          @click="emit('open', item)"
        >
          ◆ 截止 · {{ item.title }}
        </button>
        <button
          v-for="e in external(day)"
          :key="e.id"
          type="button"
          class="todo-saved-row todo-text-button"
          @click="inspectExternal(e)"
        >
          {{ e.title }} · {{ e.readOnly ? '只读事件' : '日历事件' }}
        </button>
        <button
          type="button"
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
        >
          ＋ 添加安排
        </button>
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
  <div v-if="selectedExternal" class="todo-modal-backdrop">
    <section class="todo-modal" role="dialog" aria-modal="true" aria-label="外部日历事件">
      <div class="todo-between">
        <h2>{{ selectedExternal.title }}</h2>
        <button
          type="button"
          class="todo-icon-button"
          aria-label="关闭事件详情"
          @click="selectedExternal = undefined"
        >
          ×
        </button>
      </div>
      <p>
        {{ selectedExternal.start.date }} {{ selectedExternal.start.time || '全天' }} ·
        {{ selectedExternal.start.timeZone }}
      </p>
      <p v-if="selectedExternal.end">
        结束：{{ selectedExternal.end.date }} {{ selectedExternal.end.time || '全天' }}
      </p>
      <p>{{ selectedExternal.description || '来源未提供说明' }}</p>
      <span class="todo-badge">外部只读来源，变更需在原日历完成</span
      ><button class="todo-button" type="button" @click="selectedExternal = undefined">关闭</button>
    </section>
  </div>
  <div class="todo-plan-tools">
    <label class="todo-checkbox"
      ><input v-model="includeDependents" type="checkbox" />联动调整后续安排</label
    ><span class="todo-muted todo-small"
      >拖动先预览，确认后更新。按当前任务顺序安排至 {{ anchor }}，最多 20 项</span
    ><input v-model="planTime" type="time" aria-label="连续安排开始时间" /><button
      class="todo-button"
      type="button"
      :disabled="state.busy"
      @click="preview"
    >
      预览连续安排
    </button>
  </div>
</template>
