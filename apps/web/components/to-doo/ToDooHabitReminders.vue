<script setup lang="ts">
import { computed } from 'vue';
import { Button as AButton } from 'ant-design-vue';
import type { ToDooTask } from '../../../../shared/to-doo-contracts';
import ToDooDateField from './ToDooDateField.vue';
import ToDooDisclosure from './ToDooDisclosure.vue';
import ToDooReminders from './ToDooReminders.vue';
type Rule = ToDooTask['reminders'][number];
const props = defineProps<{ modelValue: Rule[] }>();
const emit = defineEmits<{ 'update:modelValue': [value: Rule[]] }>();
const basic = (rule: Rule) => rule.anchor === 'occurrence' && rule.offsetMinutes === 0;
const times = computed(() =>
  props.modelValue.map((rule, index) => ({ rule, index })).filter(({ rule }) => basic(rule)),
);
const custom = computed(() => props.modelValue.filter((rule) => !basic(rule)).length);
function update(index: number, time: string) {
  emit(
    'update:modelValue',
    props.modelValue.map((rule, i) => (i === index ? { ...rule, allDayTime: time } : rule)),
  );
}
function add() {
  emit('update:modelValue', [
    ...props.modelValue,
    {
      id: crypto.randomUUID(),
      anchor: 'occurrence',
      offsetMinutes: 0,
      allDayTime: '09:00',
    },
  ]);
}
</script>

<template>
  <div class="todo-habit-reminders todo-form-field">
    <span>提醒 <small class="todo-muted">在需要打卡的日子提醒</small></span>
    <div
      v-for="({ rule, index }, position) in times"
      :key="rule.id"
      class="todo-habit-reminder-time"
    >
      <label
        >提醒时间 {{ position + 1
        }}<ToDooDateField
          type="time"
          :model-value="rule.allDayTime"
          required
          :aria-label="'提醒时间 ' + (position + 1)"
          @update:model-value="update(index, $event)"
      /></label>
      <AButton
        type="text"
        :aria-label="'移除提醒时间 ' + (position + 1)"
        @click="
          emit(
            'update:modelValue',
            modelValue.filter((_, i) => i !== index),
          )
        "
        >×</AButton
      >
    </div>
    <AButton
      type="link"
      class="todo-link"
      aria-label="添加提醒"
      :disabled="modelValue.length >= 20"
      @click="add"
      >＋ 添加提醒</AButton
    >
    <ToDooDisclosure v-if="custom">
      <template #header
        ><span>自定义提醒</span><small class="todo-muted">{{ custom }} 条</small></template
      >
      <ToDooReminders
        :model-value="modelValue"
        @update:model-value="emit('update:modelValue', $event)"
      />
    </ToDooDisclosure>
  </div>
</template>
