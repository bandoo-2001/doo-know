<script setup lang="ts">
import type { ToDooTask } from '../../../../shared/to-doo-contracts';
type Rule = ToDooTask['reminders'][number];
const props = withDefaults(defineProps<{ modelValue: Rule[]; dateBased?: boolean }>(), {
  dateBased: true,
});
const emit = defineEmits<{ 'update:modelValue': [value: Rule[]] }>();
function update(index: number, patch: Partial<Rule>) {
  emit(
    'update:modelValue',
    props.modelValue.map((r, i) => (i === index ? { ...r, ...patch } : r)),
  );
}
function add() {
  emit('update:modelValue', [
    ...props.modelValue,
    {
      id: crypto.randomUUID(),
      anchor: props.dateBased ? 'occurrence' : 'due',
      offsetMinutes: 0,
      allDayTime: '09:00',
    },
  ]);
}
</script>
<template>
  <fieldset class="todo-fieldset">
    <legend>提醒</legend>
    <div v-for="(rule, i) in modelValue" :key="rule.id" class="todo-reminder-editor">
      <div class="todo-between">
        <label
          >提醒依据<select
            :value="rule.anchor"
            @change="
              update(i, { anchor: ($event.target as HTMLSelectElement).value as Rule['anchor'] })
            "
          >
            <option v-if="!dateBased" value="due">截止时间</option>
            <option v-if="!dateBased" value="plan">计划时间</option>
            <option value="occurrence">当天</option>
            <option value="absolute">指定时间</option>
          </select></label
        ><button
          type="button"
          class="todo-icon-button"
          aria-label="移除这一条提醒"
          @click="
            emit(
              'update:modelValue',
              modelValue.filter((_, j) => j !== i),
            )
          "
        >
          ×
        </button>
      </div>
      <div class="todo-form-grid">
        <label v-if="rule.anchor !== 'absolute'"
          >提前或延后（分钟）<input
            type="number"
            :value="rule.offsetMinutes"
            @input="update(i, { offsetMinutes: Number(($event.target as HTMLInputElement).value) })"
          /><small>负数提前，正数延后</small></label
        ><label v-if="rule.anchor !== 'absolute'"
          >全天事项提醒时间<input
            type="time"
            :value="rule.allDayTime"
            @input="update(i, { allDayTime: ($event.target as HTMLInputElement).value })" /></label
        ><label v-else
          >指定日期与时间<input
            type="datetime-local"
            :value="
              rule.at
                ? new Date(Date.parse(rule.at) - new Date().getTimezoneOffset() * 60000)
                    .toISOString()
                    .slice(0, 16)
                : ''
            "
            @change="
              update(i, { at: new Date(($event.target as HTMLInputElement).value).toISOString() })
            "
        /></label>
      </div>
    </div>
    <button type="button" class="todo-link" :disabled="modelValue.length >= 20" @click="add">
      ＋ 添加提醒
    </button>
  </fieldset>
</template>
