<script setup lang="ts">
import { computed } from 'vue';
import {
  Button as AButton,
  Dropdown as ADropdown,
  InputNumber as AInputNumber,
  Menu as AMenu,
  MenuItem as AMenuItem,
  Progress as AProgress,
  Tag as ATag,
} from 'ant-design-vue';
import type { ToDooEntityMap } from '../../../../shared/to-doo-contracts';
import type { ToDooHabitPeriodSummary } from '../../../../shared/to-doo-habits';
import { getHabitGoalMode } from '../../../../shared/to-doo-habits';
import { formatHabitSchedule } from '../../to-doo-habit-presentation';
import ToDooIcon from './ToDooIcon.vue';
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
}>();
const period = computed(
  () => ({ daily: '今日', weekly: '本周', monthly: '本月' })[props.summary.rule.frequency],
);
const disabled = computed(
  () => !props.ready || props.busy || props.exempt || props.summary.status === 'inactive',
);
const progress = computed(() => Math.min(100, (100 * props.summary.amount) / props.summary.target));
const ordinary = computed(() => getHabitGoalMode(props.summary.rule) === 'checkin');
const checkedToday = computed(() => ordinary.value && props.amount > 0);
</script>
<template>
  <article
    class="todo-habit-card todo-panel"
    :class="{ 'is-checkin': ordinary }"
    :aria-label="'习惯 ' + habit.name"
  >
    <div class="todo-habit-card-heading">
      <span class="todo-habit-card-icon"
        ><span v-if="habit.icon">{{ habit.icon }}</span
        ><ToDooIcon v-else name="habits" :size="24"
      /></span>
      <div>
        <AButton type="text" class="todo-task-title" @click="emit('edit')">{{ habit.name }}</AButton
        ><small>{{ formatHabitSchedule(summary.rule) }}</small>
        <small v-if="showLocalDate">记录日期 {{ date }} · {{ habit.timeZone }}</small>
      </div>
      <ADropdown :trigger="['click']" placement="bottomRight">
        <template #overlay
          ><AMenu>
            <AMenuItem @click="emit('edit')">编辑习惯</AMenuItem>
            <AMenuItem @click="emit('statistics')">连续记录</AMenuItem>
            <AMenuItem @click="emit('entries')">查看当天记录</AMenuItem>
            <AMenuItem :disabled="disabled || entryCount > 0" @click="emit('skip')"
              >跳过今天</AMenuItem
            >
            <AMenuItem :disabled="!ready || busy || !entryCount" @click="emit('undo')"
              >撤销今天记录</AMenuItem
            >
            <AMenuItem :disabled="busy" @click="emit('pause')">{{
              habit.pausedDates.includes(date) ? '恢复今天' : '今天休息'
            }}</AMenuItem>
          </AMenu></template
        >
        <AButton
          type="text"
          class="todo-icon-button"
          :disabled="busy || !ready"
          :aria-label="'习惯操作 ' + habit.name"
          >⋯</AButton
        >
      </ADropdown>
    </div>
    <div class="todo-habit-card-progress">
      <p v-if="!ready" class="todo-muted">正在读取完整记录…</p>
      <template v-else>
        <p v-if="ordinary">
          {{
            checkedToday
              ? '今天已打卡'
              : exempt || summary.status === 'inactive'
                ? '今天无需记录'
                : '今天待打卡'
          }}
        </p>
        <p v-else>
          今天 {{ amount
          }}<template v-if="summary.rule.frequency === 'daily'"> / {{ summary.target }}</template>
          {{ summary.rule.unit }}
        </p>
        <p v-if="summary.rule.frequency !== 'daily'" class="todo-muted">
          {{ period }}累计 {{ summary.amount }} / {{ summary.target }}
          {{ ordinary ? '天' : summary.rule.unit }}
        </p>
        <AProgress
          v-if="!ordinary || summary.rule.frequency !== 'daily'"
          :percent="progress"
          :show-info="false"
          size="small"
        />
        <div class="todo-habit-card-status">
          <ATag v-if="habit.pausedDates.includes(date)" :bordered="false">今天休息</ATag>
          <ATag v-else-if="skipped" :bordered="false">今天已跳过</ATag>
          <ATag v-else-if="exempt || summary.status === 'inactive'" :bordered="false"
            >今天无需记录</ATag
          >
          <ATag
            v-if="
              summary.status === 'achieved' && (!ordinary || summary.rule.frequency !== 'daily')
            "
            color="success"
            :bordered="false"
            >{{ period }}达标</ATag
          >
          <small v-if="summary.estimated" class="todo-muted">历史规则估算</small>
        </div>
      </template>
    </div>
    <div class="todo-habit-card-record">
      <AButton
        v-if="ordinary"
        :type="checkedToday ? 'default' : 'primary'"
        :disabled="disabled || checkedToday"
        :aria-label="'打卡 ' + habit.name"
        @click="emit('record')"
        >{{ checkedToday ? '已打卡' : '打卡' }}</AButton
      >
      <template v-else>
        <label class="todo-habit-addition"
          ><span>本次新增</span
          ><AInputNumber
            :value="quantity"
            :min="0"
            :disabled="disabled"
            :aria-label="'记录数量 ' + habit.name"
            @update:value="
              emit('update:quantity', $event === null || $event === '' ? '' : Number($event))
            "
        /></label>
        <span>{{ summary.rule.unit }}</span>
        <AButton
          :type="summary.status === 'achieved' ? 'default' : 'primary'"
          :disabled="disabled"
          :aria-label="'记录数量 ' + habit.name"
          @click="emit('record')"
          >{{ summary.status === 'achieved' ? '追加记录' : '记录' }}</AButton
        >
      </template>
    </div>
    <p v-if="error" class="todo-error" role="alert">{{ error }}</p>
  </article>
</template>

<style scoped>
@media (max-width: 600px) {
  .todo-habit-card,
  .todo-habit-card.is-checkin {
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto;
    gap: 8px 10px;
    padding: 12px;
    align-items: center;
  }
  .todo-habit-card-heading {
    grid-column: 1 / -1;
    gap: 8px;
  }
  .todo-habit-card-icon {
    width: 32px;
    height: 32px;
    flex-basis: 32px;
    font-size: 20px;
  }
  .todo-habit-card-heading small {
    margin-top: 1px;
  }
  .todo-habit-card-heading .todo-task-title {
    padding: 0;
    min-height: 26px;
    height: auto;
  }
  .todo-habit-card-progress {
    grid-column: 1 / -1;
  }
  .is-checkin .todo-habit-card-progress {
    grid-column: 1;
  }
  .todo-habit-card-status:empty {
    display: none;
  }
  .todo-habit-card-record {
    grid-column: 1 / -1;
    align-items: center;
  }
  .is-checkin .todo-habit-card-record {
    grid-column: 2;
    grid-row: 2;
  }
  .todo-habit-addition {
    display: flex;
    align-items: center;
    gap: 6px;
    width: auto;
  }
  .todo-habit-addition > span {
    flex: none;
  }
  .todo-habit-addition .ant-input-number {
    width: 64px;
  }
}
</style>
