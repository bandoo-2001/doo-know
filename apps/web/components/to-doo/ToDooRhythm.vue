<script setup lang="ts">
import { computed, onUnmounted, ref, watch } from 'vue';
import {
  Alert as AAlert,
  Button as AButton,
  Empty as AEmpty,
  Input,
  InputNumber as AInputNumber,
  Modal as AModal,
  Segmented as ASegmented,
} from 'ant-design-vue';
import ToDooSelect from './ToDooSelect.vue';
import { useToDooConfirm } from '../../to-doo-controls';
import type { ToDooEntityKind, ToDooEntityMap } from '../../../../shared/to-doo-contracts';
import {
  focusElapsed,
  nextToDooAnniversary,
  shiftToDooDate,
  toDooLocalDate,
  type ToDooWorkbench,
} from '../../to-doo-workbench';
import { getHabitRule, summarizeHabitPeriod, habitStreak } from '../../../../shared/to-doo-habits';
const ATextarea = Input.TextArea;
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
const state = props.model.state,
  tick = ref(Date.now()),
  mode = ref<'pomodoro' | 'stopwatch' | 'break'>('pomodoro'),
  target = ref<number | ''>(state.snapshot?.settings.focusMinutes || 25),
  chosen = ref(props.occurrenceId || ''),
  weekOffset = ref(0),
  note = ref('');
const timer = setInterval(() => (tick.value = Date.now()), 1000);
onUnmounted(() => {
  clearInterval(timer);
  delete state.externalDirty.focus;
});
watch(note, (value) => (state.externalDirty.focus = !!value), { immediate: true });
watch(
  () => props.occurrenceId,
  (id) => {
    if (!active.value) chosen.value = id || '';
  },
);
const today = computed(() =>
  toDooLocalDate(new Date(tick.value), state.snapshot?.settings.timeZone),
);
const active = computed(
  () =>
    state.snapshot?.focusSessions
      .filter((s) => !s.deletedAt && ['running', 'paused'].includes(s.status))
      .sort(
        (a, b) =>
          Number(b.status === 'running') - Number(a.status === 'running') ||
          b.updatedAt.localeCompare(a.updatedAt),
      )[0],
);
const elapsed = computed(() => (active.value ? focusElapsed(active.value, tick.value) : 0));
const displayed = computed(() => {
  const seconds = active.value
    ? active.value.targetMinutes === null
      ? elapsed.value
      : Math.max(0, active.value.targetMinutes * 60 - elapsed.value)
    : mode.value === 'stopwatch'
      ? 0
      : Number(target.value) * 60;
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
const progress = computed(() =>
  active.value?.targetMinutes
    ? Math.min(100, (elapsed.value / (active.value.targetMinutes * 60)) * 100)
    : 0,
);
const sessions = computed(
  () =>
    state.snapshot?.focusSessions
      .filter(
        (s) =>
          !s.deletedAt &&
          toDooLocalDate(new Date(s.createdAt), state.snapshot?.settings.timeZone) === today.value,
      )
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt)) || [],
);
const habits = computed(() => state.snapshot?.habits.filter((h) => !h.deletedAt) || []);
const weekStart = computed(() => {
  const date = shiftToDooDate(today.value, weekOffset.value * 7),
    weekday = new Date(date + 'T12:00:00Z').getUTCDay();
  return shiftToDooDate(date, -((weekday - (state.snapshot?.settings.weekStartsOn ?? 1) + 7) % 7));
});
const days = computed(() =>
  Array.from({ length: 7 }, (_, i) => shiftToDooDate(weekStart.value, i)),
);
const anniversaries = computed(
  () =>
    state.snapshot?.anniversaries
      .filter((a) => !a.deletedAt)
      .map((a) => ({ entity: a, next: nextToDooAnniversary(a, today.value) }))
      .sort((a, b) => (a.next || '9999').localeCompare(b.next || '9999')) || [],
);
const entries = (habitId: string, date: string) =>
  state.snapshot?.habitEntries.filter(
    (e) => !e.deletedAt && e.habitId === habitId && e.localDate === date,
  ) || [];
const amount = (habitId: string, date: string) =>
  entries(habitId, date)
    .filter((e) => !e.skipped)
    .reduce((n, e) => n + e.amount, 0);
const summaries = computed(
  () =>
    new Map(
      habits.value.map((habit) => {
        const values = (state.snapshot?.habitEntries || []).filter((e) => e.habitId === habit.id);
        return [
          habit.id,
          {
            days: new Map(
              days.value.map((date) => [date, summarizeHabitPeriod(habit, values, date)]),
            ),
            streak: habitStreak(habit, values, today.value),
          },
        ] as const;
      }),
    ),
);
const habitSummary = (habit: ToDooEntityMap['habit'], date: string) =>
  summaries.value.get(habit.id)!.days.get(date)!;
const streak = (habit: ToDooEntityMap['habit']) => summaries.value.get(habit.id)!.streak;
const exemptDay = (habit: ToDooEntityMap['habit'], date: string) => {
  const rule = getHabitRule(habit, date);
  return (
    habit.pausedDates.includes(date) ||
    (!!rule.weekdays.length && !rule.weekdays.includes(new Date(date + 'T12:00:00Z').getUTCDay()))
  );
};
async function skip(habit: ToDooEntityMap['habit'], date: string) {
  await props.model.execute(
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
function taskName(occurrenceId: string | null) {
  const occurrence = state.snapshot?.occurrences.find((o) => o.id === occurrenceId);
  return state.snapshot?.tasks.find((t) => t.id === occurrence?.taskId)?.title || '未关联任务';
}
async function start() {
  if (
    mode.value !== 'stopwatch' &&
    (target.value === '' || target.value < 1 || target.value > 1440)
  ) {
    state.error = '请输入 1 到 1440 分钟的专注时长';
    return;
  }
  await props.model.execute(
    {
      action: 'start_focus',
      payload: {
        mode: mode.value,
        occurrenceId: chosen.value || null,
        targetMinutes: mode.value === 'stopwatch' ? null : Number(target.value),
        listId:
          state.snapshot?.tasks.find(
            (t) => t.id === state.snapshot?.occurrences.find((o) => o.id === chosen.value)?.taskId,
          )?.listId || null,
      },
    },
    '专注已开始',
  );
}
async function control(operation: 'pause' | 'resume' | 'finish' | 'cancel') {
  const session = active.value;
  if (!session) return;
  const result = await props.model.execute(
    {
      action: 'control_focus',
      payload: {
        id: session.id,
        expectedRevision: session.revision,
        operation,
        ...(operation === 'finish' ? { note: note.value } : {}),
      },
    },
    operation === 'finish'
      ? '本次专注已保存'
      : operation === 'cancel'
        ? '已取消本次专注'
        : '专注状态已保存',
  );
  if (result && operation === 'finish') note.value = '';
}
type NumericDialog =
  | { kind: 'habit'; habit: ToDooEntityMap['habit']; date: string }
  | { kind: 'focus'; session: ToDooEntityMap['focusSession'] };
const numericDialog = ref<NumericDialog | null>(null);
const numericValue = ref<number | ''>('');
const numericError = ref('');
function closeNumeric() {
  if (state.busy) return;
  numericDialog.value = null;
  numericError.value = '';
}
function checkin(habit: ToDooEntityMap['habit'], date: string) {
  numericValue.value = getHabitRule(habit, date).target;
  numericError.value = '';
  numericDialog.value = { kind: 'habit', habit, date };
}
async function saveNumeric() {
  const dialog = numericDialog.value;
  if (!dialog || state.busy) return;
  const value = numericValue.value;
  if (
    value === '' ||
    !Number.isFinite(value) ||
    (dialog.kind === 'habit' ? value <= 0 : value < 0)
  ) {
    numericError.value = dialog.kind === 'habit' ? '请输入大于 0 的数量' : '请输入有效的非负分钟数';
    return;
  }
  const result = await props.model.execute(
    dialog.kind === 'habit'
      ? {
          action: 'checkin_habit',
          payload: {
            habitId: dialog.habit.id,
            localDate: dialog.date,
            amount: value,
            note: '',
            skipped: false,
            sourceSessionId: null,
          },
        }
      : {
          action: 'control_focus',
          payload: {
            id: dialog.session.id,
            expectedRevision: dialog.session.revision,
            operation: 'correct',
            correctedMinutes: value,
          },
        },
    dialog.kind === 'habit' ? '习惯记录已保存' : '实际专注时间已修正',
  );
  if (result) {
    numericDialog.value = null;
    numericError.value = '';
  }
}
async function undo(habit: ToDooEntityMap['habit'], date: string) {
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
    if (!r) break;
  }
}
function correct(session: ToDooEntityMap['focusSession']) {
  numericValue.value = Math.round(focusElapsed(session, tick.value) / 60);
  numericError.value = '';
  numericDialog.value = { kind: 'focus', session };
}
async function takeover(session: ToDooEntityMap['focusSession']) {
  await props.model.execute(
    {
      action: 'control_focus',
      payload: { id: session.id, expectedRevision: session.revision, operation: 'takeover' },
    },
    '计时已接管，开始新的时间段',
  );
}
function distance(date: string, a: ToDooEntityMap['anniversary']) {
  const days = Math.round(
    (Date.parse(date + 'T12:00:00Z') - Date.parse(today.value + 'T12:00:00Z')) / 86400000,
  );
  return Math.abs(days) + (a.countMode === 'include_today' ? 1 : 0);
}
</script>
<template>
  <template v-if="section === 'focus'"
    ><div class="todo-focus-grid">
      <section class="todo-panel">
        <div class="todo-focus-center">
          <ASegmented
            :value="mode"
            :disabled="!!active"
            :options="[
              { label: '番茄钟', value: 'pomodoro' },
              { label: '正计时', value: 'stopwatch' },
              { label: '休息', value: 'break' },
            ]"
            @change="
              (value) => {
                mode = value as typeof mode;
                target =
                  value === 'break'
                    ? state.snapshot?.settings.shortBreakMinutes || 5
                    : state.snapshot?.settings.focusMinutes || 25;
              }
            "
          />
          <div class="todo-focus-ring" :style="{ '--focus-progress': progress + '%' }">
            <div>
              <div class="todo-focus-digits" role="timer" aria-label="专注计时">
                {{ displayed }}
              </div>
              <p>
                {{
                  active?.status === 'paused'
                    ? '已暂停'
                    : active
                      ? '只专注眼前这一件事'
                      : '给一个行动，一段完整的时间'
                }}
              </p>
            </div>
          </div>
          <div class="todo-actions">
            <template v-if="active"
              ><AButton
                type="primary"
                class="todo-button todo-primary"
                :disabled="state.busy"
                @click="control(active.status === 'paused' ? 'resume' : 'pause')"
              >
                {{ active.status === 'paused' ? '继续' : '暂停' }}</AButton
              ><AButton
                type="default"
                class="todo-button"
                :disabled="state.busy"
                @click="control('finish')"
              >
                结束并保存</AButton
              ><AButton
                type="link"
                class="todo-link"
                :disabled="state.busy"
                @click="control('cancel')"
              >
                取消
              </AButton></template
            ><AButton
              type="primary"
              v-else
              class="todo-button todo-primary"
              :disabled="state.busy"
              @click="start"
            >
              开始专注
            </AButton>
          </div>
          <label v-if="!active && mode !== 'stopwatch'" class="todo-inline-label"
            >本次时长<AInputNumber
              :value="target"
              :min="1"
              :max="1440"
              aria-label="本次时长"
              @update:value="target = $event === null || $event === '' ? '' : Number($event)"
            />分钟</label
          >
        </div>
        <div class="todo-pad todo-form">
          <label
            >关联行动<ToDooSelect v-model="chosen" :disabled="!!active">
              <option value="">不关联任务</option>
              <option
                v-for="o in state.snapshot?.occurrences.filter(
                  (o) => !o.deletedAt && !['done', 'cancelled', 'skipped'].includes(o.status),
                )"
                :key="o.id"
                :value="o.id"
              >
                {{ taskName(o.id) }} · {{ o.scheduledDate || o.due?.date || '普通任务' }}
              </option>
            </ToDooSelect></label
          >
          <p v-if="active" class="todo-muted">正在推进：{{ taskName(active.occurrenceId) }}</p>
          <label v-if="active"
            >结束时留下的记录<ATextarea
              v-model:value="note"
              :rows="3"
              placeholder="完成了什么？下一步是什么？"
            ></ATextarea>
          </label>
        </div>
      </section>
      <aside class="todo-panel">
        <div class="todo-panel-header">
          <h2>今天的专注记录</h2>
          <span class="todo-badge"
            >{{ sessions.filter((s) => s.status === 'finished').length }} 次完成</span
          >
        </div>
        <div v-for="s in sessions" :key="s.id" class="todo-saved-row">
          <span
            ><strong>{{ taskName(s.occurrenceId) }}</strong
            ><small
              >{{
                new Date(s.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
              }}
              ·
              {{
                {
                  running: '进行中',
                  paused: '已暂停',
                  finished: '已完成',
                  cancelled: '已取消',
                  interrupted: '已中断',
                }[s.status]
              }}</small
            ></span
          ><span>{{ Math.round(focusElapsed(s, tick) / 60) }} 分钟</span
          ><AButton type="link" class="todo-link" :disabled="state.busy" @click="correct(s)">
            修正</AButton
          ><AButton
            type="link"
            v-if="s.status === 'interrupted'"
            class="todo-link"
            :disabled="state.busy"
            @click="takeover(s)"
          >
            接管计时</AButton
          ><AButton
            type="link"
            class="todo-link"
            @click="
              emit('edit', 'record', undefined, {
                content: s.note,
                sourceSessionId: s.id,
                occurrenceId: s.occurrenceId,
                minutes: Math.round(focusElapsed(s, tick) / 60),
              })
            "
          >
            记录
          </AButton>
        </div>
        <AEmpty
          v-if="!sessions.length"
          class="todo-empty"
          description="开始第一段专注，记录真实投入。"
        />
      </aside></div
  ></template>
  <template v-else-if="section === 'habits'"
    ><div class="todo-calendar-toolbar">
      <div class="todo-actions">
        <AButton type="text" class="todo-icon-button" aria-label="上一周" @click="weekOffset--">
          ‹
        </AButton>
        <h2>{{ weekStart }} — {{ days[6] }}</h2>
        <AButton type="text" class="todo-icon-button" aria-label="下一周" @click="weekOffset++">
          ›
        </AButton>
      </div>
      <AButton type="primary" class="todo-button todo-primary" @click="emit('edit', 'habit')">
        ＋ 新建习惯
      </AButton>
    </div>
    <AAlert
      class="todo-top-gap"
      type="info"
      show-icon
      message="日历格按当时规则与所属周期累计判断。暂停日免除打卡；跳过按该期规则决定是否中断连续达标。历史未读完时，连续记录仅按已载入数据计算。"
    />
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
          ><small
            >{{ h.target }} {{ h.unit }}/{{
              { daily: '日', weekly: '周', monthly: '月' }[h.frequency]
            }}</small
          ><small
            >已载入记录：连续 {{ streak(h).current }} 期 · 最长 {{ streak(h).longest }} 期{{
              streak(h).estimated ? '（含估算）' : ''
            }}</small
          ><AButton
            type="link"
            class="todo-link todo-small"
            @click="
              model.saveEntity(
                'habit',
                {
                  ...h,
                  pausedDates: h.pausedDates.includes(today)
                    ? h.pausedDates.filter((d) => d !== today)
                    : [...h.pausedDates, today],
                },
                h.revision,
              )
            "
          >
            {{ h.pausedDates.includes(today) ? '恢复今天' : '暂停今天' }}
          </AButton>
        </div>
        <div v-for="d in days" :key="d" class="todo-habit-cell">
          <button
            type="button"
            class="todo-habit-check"
            :class="{ checked: habitSummary(h, d).status === 'achieved' }"
            :disabled="
              state.busy || d > today || habitSummary(h, d).status === 'inactive' || exemptDay(h, d)
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
            :aria-label="h.name + ' ' + d + ' 打卡，当前 ' + amount(h.id, d) + ' ' + h.unit"
            @click="checkin(h, d)"
          >
            {{
              exemptDay(h, d)
                ? '–'
                : habitSummary(h, d).status === 'achieved'
                  ? '✓'
                  : habitSummary(h, d).status === 'skipped'
                    ? '跳'
                    : amount(h.id, d) || '＋'
            }}</button
          ><AButton
            type="link"
            v-if="
              !entries(h.id, d).length &&
              d <= today &&
              !exemptDay(h, d) &&
              habitSummary(h, d).status !== 'inactive'
            "
            class="todo-link todo-small"
            :disabled="state.busy"
            :aria-label="'跳过 ' + h.name + ' ' + d"
            @click="skip(h, d)"
          >
            跳过</AButton
          ><AButton
            type="link"
            v-if="entries(h.id, d).length"
            class="todo-link todo-small"
            :aria-label="'撤销 ' + h.name + ' ' + d"
            @click="undo(h, d)"
          >
            撤销
          </AButton>
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
  >
  <template v-else
    ><div class="todo-section-title">
      <p class="todo-muted">重要日期与计数方式分别保存，农历日期按所选农历年月日计算。</p>
      <AButton type="primary" class="todo-button todo-primary" @click="emit('edit', 'anniversary')">
        ＋ 新建纪念日
      </AButton>
    </div>
    <div class="todo-anniversaries">
      <article v-for="a in anniversaries" :key="a.entity.id" class="todo-anniversary todo-panel">
        <div class="todo-between">
          <span class="todo-badge">{{ a.entity.category || '重要日子' }}</span
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
        <p class="todo-days" v-if="a.next">
          <small>{{ a.next >= today ? '还有' : '已经' }}</small
          >{{ distance(a.next, a.entity) }}<small>天</small>
        </p>
        <p v-else class="todo-muted">暂未找到下一次日期，请检查闰月设置</p>
        <p class="todo-muted">
          {{ a.next || a.entity.date }} · {{ a.entity.calendar === 'lunar' ? '农历' : '公历'
          }}{{ a.entity.repeatYearly ? ' · 每年重复' : '' }}
        </p>
        <p v-if="a.entity.description">{{ a.entity.description }}</p>
        <div class="todo-actions">
          <span class="todo-badge">{{ a.entity.noteRefs.length }} 份关联资料</span
          ><span class="todo-badge">{{ a.entity.reminders.length }} 个提醒</span>
        </div>
      </article>
    </div>
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
    wrap-class-name="todo-ant-modal"
    :open="!!numericDialog"
    :title="numericDialog?.kind === 'habit' ? '记录习惯数量' : '修正实际专注时间'"
    ok-text="保存"
    cancel-text="取消"
    :confirm-loading="state.busy"
    :cancel-button-props="{ disabled: state.busy }"
    :closable="!state.busy"
    :keyboard="!state.busy"
    :mask-closable="false"
    @ok="saveNumeric"
    @cancel="closeNumeric"
  >
    <form class="todo-form" @submit.prevent="saveNumeric">
      <p v-if="numericDialog?.kind === 'habit'">
        {{ numericDialog.habit.name }} · {{ numericDialog.date }} ·
        {{ getHabitRule(numericDialog.habit, numericDialog.date).unit }}
      </p>
      <label
        >{{ numericDialog?.kind === 'habit' ? '本次数量' : '实际分钟数' }}
        <AInputNumber
          :value="numericValue"
          :min="0"
          :disabled="state.busy"
          :aria-label="numericDialog?.kind === 'habit' ? '习惯数量' : '实际专注分钟数'"
          autofocus
          @update:value="numericValue = $event === null || $event === '' ? '' : Number($event)"
        />
      </label>
      <AAlert v-if="numericError" type="error" show-icon :message="numericError" />
    </form>
  </AModal>
</template>
