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
import ToDooIcon from './ToDooIcon.vue';
const props = defineProps<{
  habit: ToDooEntityMap['habit'];
  date: string;
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
}>();
const period = computed(
  () => ({ daily: '今日', weekly: '本周', monthly: '本月' })[props.summary.rule.frequency],
);
const disabled = computed(
  () => !props.ready || props.busy || props.exempt || props.summary.status === 'inactive',
);
const progress = computed(() => Math.min(100, (100 * props.summary.amount) / props.summary.target));
</script>
<template>
  <article class="todo-habit-card todo-panel" :aria-label="'习惯 ' + habit.name">
    <div class="todo-habit-card-heading">
      <span class="todo-habit-card-icon"><ToDooIcon name="habits" :size="24" /></span>
      <div>
        <AButton type="text" class="todo-task-title" @click="emit('edit')">{{ habit.name }}</AButton
        ><small
          >{{ date }} · {{ summary.rule.target }} {{ summary.rule.unit }} /
          {{ { daily: '日', weekly: '周', monthly: '月' }[summary.rule.frequency] }}</small
        >
      </div>
      <ADropdown :trigger="['click']" placement="bottomRight">
        <template #overlay
          ><AMenu>
            <AMenuItem @click="emit('edit')">编辑习惯</AMenuItem>
            <AMenuItem @click="emit('statistics')">连续记录</AMenuItem>
            <AMenuItem :disabled="disabled || entryCount > 0" @click="emit('skip')"
              >跳过今天</AMenuItem
            >
            <AMenuItem :disabled="!ready || busy || !entryCount" @click="emit('undo')"
              >撤销今天记录</AMenuItem
            >
            <AMenuItem :disabled="busy" @click="emit('pause')">{{
              habit.pausedDates.includes(date) ? '恢复今天' : '暂停今天'
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
        <p>
          今天 {{ amount
          }}<template v-if="summary.rule.frequency === 'daily'"> / {{ summary.target }}</template>
          {{ summary.rule.unit }}
        </p>
        <p v-if="summary.rule.frequency !== 'daily'" class="todo-muted">
          {{ period }}累计 {{ summary.amount }} / {{ summary.target }} {{ summary.rule.unit }}
        </p>
        <AProgress :percent="progress" :show-info="false" size="small" />
        <div class="todo-habit-card-status">
          <ATag v-if="habit.pausedDates.includes(date)" :bordered="false">今天已暂停</ATag>
          <ATag v-else-if="skipped" :bordered="false">今天已跳过</ATag>
          <ATag v-else-if="exempt || summary.status === 'inactive'" :bordered="false"
            >今天无需记录</ATag
          >
          <ATag v-if="summary.status === 'achieved'" color="success" :bordered="false"
            >{{ period }}达标</ATag
          >
          <small v-if="summary.estimated" class="todo-muted">历史规则估算</small>
        </div>
      </template>
    </div>
    <div class="todo-habit-card-record">
      <AInputNumber
        :value="quantity"
        :min="0"
        :disabled="disabled"
        :aria-label="'记录数量 ' + habit.name"
        @update:value="
          emit('update:quantity', $event === null || $event === '' ? '' : Number($event))
        "
      />
      <span>{{ summary.rule.unit }}</span>
      <AButton
        type="primary"
        :disabled="disabled"
        :aria-label="'记录数量 ' + habit.name"
        @click="emit('record')"
        >{{ amount ? '继续记录' : '记录数量' }}</AButton
      >
    </div>
    <p v-if="error" class="todo-error" role="alert">{{ error }}</p>
  </article>
</template>
