<script setup lang="ts">
import { Button as AButton, InputNumber as AInputNumber } from 'ant-design-vue';
import ToDooSelect from './ToDooSelect.vue';
import ToDooDateField from './ToDooDateField.vue';
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
          >提醒依据<ToDooSelect
            :value="rule.anchor"
            @change="update(i, { anchor: $event as Rule['anchor'] })"
          >
            <option v-if="!dateBased" value="due">截止时间</option>
            <option v-if="!dateBased" value="plan">计划时间</option>
            <option value="occurrence">当天</option>
            <option value="absolute">指定时间</option>
          </ToDooSelect></label
        ><AButton
          type="text"
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
        </AButton>
      </div>
      <div class="todo-form-grid">
        <label v-if="rule.anchor !== 'absolute'"
          >提前或延后（分钟）<AInputNumber
            aria-label="提前或延后（分钟）"
            :value="rule.offsetMinutes"
            @update:value="update(i, { offsetMinutes: $event === null ? 0 : Number($event) })"
          /><small>负数提前，正数延后</small></label
        ><label v-if="rule.anchor !== 'absolute'"
          >全天事项提醒时间<ToDooDateField
            type="time"
            :value="rule.allDayTime"
            @input="update(i, { allDayTime: $event })" /></label
        ><label v-else
          >指定日期与时间<ToDooDateField
            type="datetime-local"
            :value="
              rule.at
                ? new Date(Date.parse(rule.at) - new Date().getTimezoneOffset() * 60000)
                    .toISOString()
                    .slice(0, 16)
                : ''
            "
            @change="update(i, { at: $event ? new Date($event).toISOString() : undefined })"
        /></label>
      </div>
    </div>
    <AButton type="link" class="todo-link" :disabled="modelValue.length >= 20" @click="add">
      ＋ 添加提醒
    </AButton>
  </fieldset>
</template>
