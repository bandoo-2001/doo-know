<script setup lang="ts">
import { computed } from 'vue';
import {
  Button as AButton,
  Dropdown as ADropdown,
  InputNumber as AInputNumber,
  Menu as AMenu,
  MenuItem as AMenuItem,
  Progress as AProgress,
} from 'ant-design-vue';
import type { ToDooEntityMap } from '../../../../shared/to-doo-contracts';
import type { ToDooHabitPeriodSummary } from '../../../../shared/to-doo-habits';
import { getHabitGoalMode } from '../../../../shared/to-doo-habits';
import { formatHabitSchedule } from '../../to-doo-habit-presentation';
import ToDooIcon from './ToDooIcon.vue';
import ToDooListIcon from './ToDooListIcon.vue';
import type { habitPeriodPlan } from '../../to-doo-habit-insights';
const props = defineProps<{
  habit: ToDooEntityMap['habit'];
  date: string;
  showLocalDate?: boolean;
  summary: ToDooHabitPeriodSummary;
  amount: number;
  entryCount: number;
  skipped: boolean;
  exempt: boolean;
  ready: boolean;
  busy: boolean;
  quantity: number | '';
  error?: string;
  list?: ToDooEntityMap['list'];
  selected?: boolean;
  isToday?: boolean;
  future?: boolean;
  plan?: ReturnType<typeof habitPeriodPlan>;
}>();
const emit = defineEmits<{
  'update:quantity': [value: number | ''];
  record: [];
  edit: [];
  skip: [];
  undo: [];
  pause: [];
  statistics: [];
  entries: [];
  list: [id: string];
}>();
const dayLabel = computed(() => (props.isToday === false ? '当天' : '今天'));
const period = computed(() =>
  props.isToday === false
    ? { daily: '当日', weekly: '当周', monthly: '当月' }[props.summary.rule.frequency]
    : { daily: '今日', weekly: '本周', monthly: '本月' }[props.summary.rule.frequency],
);
const resting = computed(() => props.habit.pausedDates.includes(props.date));
const disabled = computed(
  () =>
    !props.ready ||
    props.busy ||
    props.future ||
    props.exempt ||
    props.skipped ||
    resting.value ||
    props.summary.status === 'inactive',
);
const progress = computed(() => Math.min(100, (100 * props.summary.amount) / props.summary.target));
const ordinary = computed(() => getHabitGoalMode(props.summary.rule) === 'checkin');
const periodic = computed(() => props.summary.rule.frequency !== 'daily');
const planCaption = computed(() => {
  if (!props.plan || !periodic.value) return '';
  if (props.summary.status === 'inactive') return '尚未开始或已结束的安排';
  if (props.summary.status === 'achieved') return '这个周期已达标，可以按需要继续记录';
  if (props.plan.ended) return '该周期已结束，可查看或补记';
  const remaining = props.plan.remaining;
  return `还差 ${remaining} ${props.plan.remainingUnit} · ${props.plan.remainingDates ? '还有 ' + props.plan.remainingDates + ' 个可记录日' : '暂无可记录日，可调整安排'}`;
});
const checkedToday = computed(() => ordinary.value && props.amount > 0);
const cadence = computed(() => {
  const rule = props.summary.rule;
  if (rule.frequency !== 'daily') return rule.frequency === 'weekly' ? '每周' : '每月';
  if ((rule.intervalDays || 1) > 1) return `${rule.intervalDays} 天一次`;
  const weekdays = [...new Set(rule.weekdays)];
  if (!weekdays.length || weekdays.length === 7) return '每天';
  if (weekdays.length === 5 && weekdays.every((day) => day >= 1 && day <= 5)) return '工作日';
  return '周' + weekdays.map((day) => '日一二三四五六'[day]).join('、');
});
const exceptional = computed(
  () =>
    props.future ||
    resting.value ||
    props.skipped ||
    props.exempt ||
    props.summary.status === 'inactive',
);
const stateText = computed(() =>
  props.future
    ? '尚未到记录日期'
    : resting.value
      ? dayLabel.value + '休息'
      : props.skipped
        ? dayLabel.value + '已跳过'
        : props.exempt || props.summary.status === 'inactive'
          ? dayLabel.value + '无需记录'
          : checkedToday.value
            ? dayLabel.value + '已打卡'
            : dayLabel.value + '待打卡',
);
const stateIcon = computed(() => (props.future ? 'calendar' : props.skipped ? 'skip' : 'pause'));
const progressTitle = computed(
  () =>
    `${periodic.value ? period.value + '累计' : dayLabel.value} ${periodic.value ? props.summary.amount : props.amount} / ${props.summary.target} ${ordinary.value && periodic.value ? '天' : props.summary.rule.unit}`,
);
</script>
<template>
  <article
    class="todo-habit-card todo-panel"
    :class="{ 'is-checkin': ordinary, 'is-selected': selected, 'is-periodic': periodic }"
    :style="{ '--habit-color': habit.color || 'var(--todo-accent)' }"
    :aria-label="'习惯 ' + habit.name"
  >
    <div class="todo-habit-card-heading">
      <span class="todo-habit-card-icon"
        ><span v-if="habit.icon">{{ habit.icon }}</span
        ><ToDooIcon v-else name="habits" :size="22"
      /></span>
      <div class="todo-habit-card-identity">
        <AButton
          type="text"
          class="todo-task-title"
          :title="habit.name"
          :aria-pressed="!!selected"
          @click="emit('statistics')"
          ><span class="todo-habit-card-name">{{ habit.name }}</span></AButton
        >
        <div class="todo-habit-card-meta">
          <small :title="formatHabitSchedule(summary.rule)">{{ cadence }}</small>
          <AButton
            v-if="list && !list.archivedAt"
            type="text"
            class="todo-habit-list-link"
            :title="list.name"
            :aria-label="'查看 ' + list.name + ' 的任务'"
            @click="emit('list', list.id)"
          >
            <ToDooListIcon :list="list" :size="14" />
          </AButton>
          <span
            v-else-if="habit.listId"
            role="img"
            :aria-label="list ? list.name + ' · 清单已归档' : '原关联清单不可用'"
            :title="list ? list.name + ' · 清单已归档' : '原关联清单不可用'"
            ><ToDooIcon name="archive" :size="13"
          /></span>
        </div>
        <small v-if="showLocalDate" class="todo-habit-local-date"
          >记录日期 {{ date }} · {{ habit.timeZone }}</small
        >
      </div>
    </div>
    <div class="todo-habit-card-progress">
      <span v-if="!ready" role="status" aria-label="正在读取完整记录" title="正在读取完整记录"
        ><ToDooIcon name="refresh" :size="16"
      /></span>
      <template v-else>
        <p
          v-if="!ordinary || periodic"
          :class="periodic ? 'todo-habit-period-amount' : 'todo-habit-day-amount'"
          :title="progressTitle"
        >
          <ToDooIcon v-if="periodic" name="repeat" :size="12" /><span
            v-if="periodic"
            class="todo-habit-period-symbol"
            >{{ summary.rule.frequency === 'weekly' ? '周' : '月' }}</span
          >
          <strong>{{ periodic ? summary.amount : amount }}</strong
          ><span>/ {{ summary.target }}</span
          ><span
            class="todo-habit-progress-unit"
            :title="ordinary && periodic ? '天' : summary.rule.unit"
            >{{ ' ' + (ordinary && periodic ? '天' : summary.rule.unit) }}</span
          >
          <span
            v-if="summary.status === 'achieved'"
            class="todo-habit-status-marker is-achieved"
            role="img"
            :aria-label="period + '达标'"
            :title="period + '达标'"
            ><ToDooIcon name="check" :size="14"
          /></span>
        </p>
        <AProgress
          v-if="!ordinary || periodic"
          :percent="progress"
          :show-info="false"
          size="small"
          :stroke-color="summary.status === 'achieved' ? 'var(--todo-green)' : 'var(--habit-color)'"
        />
        <p
          v-if="periodic && plan && summary.status !== 'achieved' && summary.status !== 'inactive'"
          class="todo-habit-plan-caption"
          :title="planCaption"
        >
          <template v-if="!plan.ended"
            >剩 {{ plan.remaining }} {{ plan.remainingUnit
            }}<span
              class="todo-habit-opportunity"
              role="img"
              :aria-label="'还有 ' + plan.remainingDates + ' 个可记录日'"
              ><ToDooIcon name="calendar" :size="12" />{{ plan.remainingDates }} 天</span
            ></template
          >
          <span
            v-else
            role="img"
            aria-label="该周期已结束，可查看或补记"
            title="该周期已结束，可查看或补记"
            ><ToDooIcon name="archive" :size="14"
          /></span>
        </p>
        <div v-if="exceptional || summary.estimated" class="todo-habit-card-status">
          <span
            v-if="exceptional"
            class="todo-habit-status-marker"
            role="img"
            :aria-label="stateText"
            :title="stateText"
            ><ToDooIcon :name="stateIcon" :size="16"
          /></span>
          <span
            v-if="summary.estimated"
            class="todo-habit-status-marker"
            role="img"
            aria-label="历史规则估算"
            title="历史规则估算"
            ><ToDooIcon name="info" :size="14"
          /></span>
        </div>
      </template>
    </div>
    <div class="todo-habit-card-record">
      <AButton
        v-if="ordinary"
        class="todo-habit-checkin-button"
        :class="{ 'is-complete': checkedToday }"
        :type="checkedToday ? 'primary' : 'default'"
        :disabled="disabled || checkedToday"
        :aria-label="'打卡 ' + habit.name"
        :title="checkedToday ? '已打卡' : disabled ? stateText : '打卡'"
        @click="emit('record')"
      >
        <ToDooIcon v-if="checkedToday" name="check" :size="18" />
        <ToDooIcon
          v-else-if="resting || skipped || exempt || future"
          :name="stateIcon"
          :size="16"
        />
        <span class="todo-habit-action-text">{{ checkedToday ? '已打卡' : '打卡' }}</span>
      </AButton>
      <template v-else>
        <label class="todo-habit-addition"
          ><span>本次新增</span
          ><AInputNumber
            :value="quantity"
            :min="0"
            :max="1000000"
            :disabled="disabled"
            :aria-label="'记录数量 ' + habit.name"
            @update:value="
              emit('update:quantity', $event === null || $event === '' ? '' : Number($event))
            "
        /></label>
        <span class="todo-habit-unit" :title="summary.rule.unit">{{ summary.rule.unit }}</span>
        <AButton
          class="todo-habit-quantity-button"
          :type="summary.status === 'achieved' ? 'default' : 'primary'"
          :disabled="disabled"
          :aria-label="'记录数量 ' + habit.name"
          :title="summary.status === 'achieved' ? '追加记录' : '记录'"
          @click="emit('record')"
        >
          <ToDooIcon name="plus" :size="16" /><span class="todo-habit-action-text">{{
            summary.status === 'achieved' ? '追加记录' : '记录'
          }}</span>
        </AButton>
      </template>
    </div>
    <ADropdown :trigger="['click']" placement="bottomRight">
      <template #overlay
        ><AMenu>
          <AMenuItem @click="emit('edit')"><ToDooIcon name="edit" :size="14" /> 编辑习惯</AMenuItem>
          <AMenuItem @click="emit('statistics')"
            ><ToDooIcon name="trend" :size="14" /> 连续记录</AMenuItem
          >
          <AMenuItem @click="emit('entries')"
            ><ToDooIcon name="calendar" :size="14" /> 查看当天记录</AMenuItem
          >
          <AMenuItem :disabled="disabled || entryCount > 0" @click="emit('skip')"
            >跳过{{ dayLabel }}</AMenuItem
          >
          <AMenuItem :disabled="!ready || busy || future || !entryCount" @click="emit('undo')"
            >撤销{{ dayLabel }}记录</AMenuItem
          >
          <AMenuItem :disabled="busy || !ready || future" @click="emit('pause')">{{
            resting ? '恢复' + dayLabel : dayLabel + '休息'
          }}</AMenuItem>
        </AMenu></template
      >
      <AButton
        type="text"
        class="todo-icon-button todo-habit-card-menu"
        :disabled="busy || !ready"
        :aria-label="'习惯操作 ' + habit.name"
        ><ToDooIcon name="more" :size="16"
      /></AButton>
    </ADropdown>
    <p v-if="error" class="todo-error" role="alert">{{ error }}</p>
  </article>
</template>

<style scoped>
.todo-habit-card.todo-panel {
  display: grid;
  grid-template-columns: minmax(180px, 1fr) minmax(140px, 220px) auto 32px;
  align-items: center;
  gap: 12px;
  min-width: 0;
  min-height: 100px;
  padding: 16px;
  border-color: transparent;
  border-radius: var(--todo-radius);
  background: color-mix(in srgb, var(--todo-soft) 80%, var(--todo-paper));
  overflow-wrap: anywhere;
}
.todo-habit-card.todo-panel.is-selected {
  border-color: var(--todo-accent);
  background: color-mix(in srgb, var(--todo-accent) 4%, var(--todo-paper));
}
.todo-habit-card.is-periodic {
  background: linear-gradient(
    105deg,
    color-mix(in srgb, var(--habit-color) 4%, var(--todo-paper)),
    var(--todo-soft)
  );
}
.todo-habit-card .todo-habit-plan-caption {
  margin-top: 4px;
  font-size: 12px;
  color: var(--todo-muted);
  overflow-wrap: anywhere;
}
.todo-habit-card.is-periodic .todo-habit-card-progress {
  min-width: 0;
}
.todo-habit-card .todo-habit-card-heading {
  grid-column: auto;
  display: flex;
  align-items: center;
  gap: 12px;
  min-width: 0;
}
.todo-habit-card .todo-habit-card-icon {
  flex: 0 0 44px;
  width: 44px;
  height: 44px;
  font-size: 25px;
  border-radius: var(--todo-radius);
  color: var(--habit-color);
  background: color-mix(in srgb, var(--habit-color) 9%, var(--todo-paper));
}
.todo-habit-card .todo-habit-card-identity {
  min-width: 0;
}
.todo-habit-card .todo-habit-card-heading .todo-task-title.ant-btn {
  display: block;
  width: 100%;
  height: auto;
  min-height: 0;
  padding: 0;
  border: 0;
  line-height: 1.5;
  text-align: start;
  color: var(--todo-ink);
  background: transparent;
  font-size: 15px;
  font-weight: 550;
}
.todo-habit-card .todo-task-title > .todo-habit-card-name {
  display: -webkit-box;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 2;
  overflow: hidden;
  white-space: normal;
  overflow-wrap: anywhere;
}
.todo-habit-card-meta {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 3px 8px;
  min-width: 0;
  margin-top: 3px;
}
.todo-habit-card .todo-habit-card-meta > small,
.todo-habit-card .todo-habit-local-date {
  margin: 0;
  font-size: 12px;
  line-height: 1.5;
  color: var(--todo-muted);
}
.todo-habit-card .todo-habit-card-meta > span {
  display: inline-flex;
  align-items: center;
  color: var(--todo-muted);
}
.todo-habit-card .todo-habit-card-heading .todo-habit-list-link.ant-btn {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  min-width: 0;
  width: fit-content;
  max-width: 180px;
  height: 24px;
  min-height: 24px;
  margin: 0;
  padding: 4px;
  border: 0;
  border-radius: var(--todo-control-radius);
  font-size: 12px;
  line-height: 1.5;
  color: var(--todo-accent);
}
.todo-habit-card .todo-habit-list-link > span:last-child {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.todo-habit-card .todo-habit-card-progress {
  grid-column: auto;
  min-width: 0;
  font-size: 12px;
}
.todo-habit-card .todo-habit-card-progress > p {
  margin: 0;
  line-height: 1.5;
}
.todo-habit-card-progress strong {
  font-size: 16px;
  font-weight: 600;
  color: var(--todo-ink);
}
.todo-habit-day-amount,
.todo-habit-period-amount {
  display: flex;
  align-items: baseline;
  flex-wrap: wrap;
  gap: 0 3px;
}
.todo-habit-period-symbol {
  font-size: 11px;
  color: var(--todo-muted);
  margin-inline-end: 4px;
}
.todo-habit-card .todo-habit-plan-caption {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 10px;
  margin-top: 6px;
}
.todo-habit-opportunity {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  color: var(--todo-muted);
}
.todo-habit-status-marker {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  color: var(--todo-muted);
}
.todo-habit-status-marker.is-achieved {
  color: var(--todo-green);
  margin-inline-start: 4px;
}
.todo-habit-progress-unit {
  display: inline-block;
  max-width: 8em;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  vertical-align: bottom;
}
.todo-habit-card .todo-habit-card-progress :deep(.ant-progress) {
  display: block;
  margin: 4px 0 0;
  line-height: 1;
}
.todo-habit-card .todo-habit-card-status {
  display: flex;
  min-height: 0;
  gap: 4px;
  margin-top: 3px;
}
.todo-habit-card .todo-habit-card-status:empty {
  display: none;
}
.todo-habit-card-status :deep(.ant-tag) {
  margin: 0;
  font-size: 10px;
  line-height: 16px;
}
.todo-habit-card .todo-habit-card-record {
  grid-column: auto;
  display: flex;
  align-items: center;
  justify-content: flex-end;
  flex-wrap: nowrap;
  gap: 4px;
  min-width: 0;
  max-width: 100%;
  padding: 4px;
  border: 1px solid var(--todo-line);
  border-radius: var(--todo-control-radius);
  background: var(--todo-paper);
}
.is-checkin .todo-habit-card-record {
  padding: 0;
  border: 0;
  background: transparent;
}
.todo-habit-card-record:has(input:focus-visible) {
  outline: 2px solid var(--todo-accent);
  outline-offset: 2px;
}
.todo-habit-card .todo-habit-addition {
  display: grid;
  flex: 0 0 64px;
  width: 64px;
  gap: 2px;
  margin: 0;
}
.todo-habit-card .todo-habit-addition > span {
  position: absolute;
  width: 1px;
  height: 1px;
  overflow: hidden;
  clip-path: inset(50%);
  white-space: nowrap;
}
.todo-habit-card .todo-habit-card-record .todo-habit-addition .ant-input-number {
  width: 64px;
  min-width: 0;
  flex: 0 0 64px;
  border: 0;
  background: transparent;
  box-shadow: none;
}
.todo-habit-card .todo-habit-addition :deep(.ant-input-number-input) {
  font-size: 13px;
}
.todo-habit-card .todo-habit-card-record > .todo-habit-unit {
  flex: 0 1 auto;
  max-width: 6em;
  min-width: 0;
  margin-bottom: 0;
  font-size: 12px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  line-height: 18px;
}
.todo-habit-card .todo-habit-card-record > .ant-btn {
  margin: 0;
  flex: 0 0 36px;
  width: 36px;
  height: 36px;
  min-width: 36px;
  padding: 0;
  border-radius: 50%;
  display: inline-flex;
  align-items: center;
  justify-content: center;
}
.todo-habit-card .todo-habit-checkin-button.ant-btn {
  border-width: 2px;
  border-color: var(--todo-line);
  background: transparent;
  color: var(--todo-muted);
}
.todo-habit-card .todo-habit-checkin-button.is-complete.ant-btn {
  border-color: var(--habit-color);
  background: var(--habit-color);
  color: white;
}
.todo-habit-card .todo-habit-checkin-button.ant-btn:disabled:not(.is-complete) {
  color: var(--todo-muted);
  background: var(--todo-soft);
}
.todo-habit-card .todo-habit-card-menu.ant-btn {
  grid-column: 4;
  padding: 0;
  width: 32px;
  min-width: 32px;
  height: 32px;
}
.todo-habit-action-text {
  position: absolute;
  width: 1px;
  height: 1px;
  margin: -1px;
  padding: 0;
  overflow: hidden;
  clip-path: inset(50%);
  white-space: nowrap;
}
.todo-habit-card > .todo-error {
  margin: 0;
  grid-column: 1 / -1;
  font-size: 12px;
}

@container (max-width: 740px) {
  .todo-habit-card.todo-panel {
    grid-template-columns: minmax(0, 1fr) auto 28px;
    gap: 12px;
    padding: 16px;
  }
  .todo-habit-card .todo-habit-card-heading {
    grid-column: 1 / 3;
    grid-row: 1;
  }
  .todo-habit-card .todo-habit-card-menu.ant-btn {
    grid-column: 3;
    grid-row: 1;
    width: 28px;
    min-width: 28px;
  }
  .todo-habit-card .todo-habit-card-progress {
    grid-column: 1;
    grid-row: 2;
    margin-inline-start: 56px;
  }
  .todo-habit-card .todo-habit-card-record {
    grid-column: 2 / 4;
    grid-row: 2;
    margin: 0;
    justify-self: end;
  }
  .todo-habit-card.is-checkin .todo-habit-card-heading {
    grid-column: 1;
  }
  .todo-habit-card.is-checkin .todo-habit-card-record {
    grid-column: 2;
    grid-row: 1 / 3;
    align-self: center;
  }
  .todo-habit-card.is-checkin .todo-habit-card-menu.ant-btn {
    grid-row: 1 / 3;
  }
}
@container (max-width: 440px) {
  .todo-habit-card.todo-panel {
    padding: 14px;
    gap: 10px 8px;
  }
  .todo-habit-card .todo-habit-card-heading {
    grid-column: 1 / 3;
  }
  .todo-habit-card .todo-habit-card-icon {
    width: 38px;
    height: 38px;
    flex-basis: 38px;
    font-size: 23px;
  }
  .todo-habit-card .todo-habit-card-progress {
    grid-column: 1 / -1;
    margin-inline-start: 0;
  }
  .todo-habit-card .todo-habit-card-record {
    grid-column: 1 / -1;
    grid-row: 3;
  }
  .todo-habit-card.is-checkin .todo-habit-card-heading {
    grid-column: 1;
  }
  .todo-habit-card.is-checkin .todo-habit-card-progress {
    grid-column: 1;
    margin-inline-start: 50px;
  }
  .todo-habit-card.is-checkin .todo-habit-card-record {
    grid-column: 2;
    grid-row: 1 / 3;
  }
}
@media (max-width: 600px) {
  .todo-habit-card.todo-panel {
    grid-template-columns: minmax(0, 1fr) auto 28px;
    padding: 14px;
    gap: 10px 8px;
  }
  .todo-habit-card .todo-habit-card-heading {
    grid-column: 1 / 3;
    grid-row: 1;
  }
  .todo-habit-card .todo-habit-card-menu.ant-btn {
    grid-column: 3;
    grid-row: 1;
    width: 28px;
    min-width: 28px;
  }
  .todo-habit-card .todo-habit-card-progress {
    grid-column: 1 / -1;
    grid-row: 2;
    margin: 0;
  }
  .todo-habit-card .todo-habit-card-record {
    grid-column: 1 / -1;
    grid-row: 3;
    margin: 0;
    justify-self: end;
  }
  .todo-habit-card.is-checkin .todo-habit-card-heading {
    grid-column: 1;
  }
  .todo-habit-card.is-checkin .todo-habit-card-progress {
    grid-column: 1;
    margin-inline-start: 50px;
  }
  .todo-habit-card.is-checkin .todo-habit-card-record {
    grid-column: 2;
    grid-row: 1 / 3;
    align-self: center;
  }
  .todo-habit-card.is-checkin .todo-habit-card-menu.ant-btn {
    grid-row: 1 / 3;
  }
}
</style>
