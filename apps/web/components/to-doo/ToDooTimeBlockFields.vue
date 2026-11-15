<script setup lang="ts">
import { Checkbox as ACheckbox, Input as AInput, InputNumber as AInputNumber } from 'ant-design-vue';
import type { ToDooEntityMap } from '../../../../shared/to-doo-contracts';
import ToDooDateField from './ToDooDateField.vue';
defineProps<{ block: Pick<ToDooEntityMap['timeBlock'], 'title' | 'allDay' | 'start' | 'durationMinutes' | 'dateEndExclusive'>; disabled?: boolean }>();
</script>
<template>
  <label>安排标题<AInput v-model:value="block.title" :disabled="disabled" placeholder="给这段时间起个名字" /></label>
  <ACheckbox v-model:checked="block.allDay" :disabled="disabled">全天安排</ACheckbox>
  <div class="todo-form-grid">
    <label>日期<ToDooDateField v-model="block.start.date" type="date" required :disabled="disabled" /></label>
    <label v-if="!block.allDay">时间<ToDooDateField v-model="block.start.time" type="time" :disabled="disabled" /></label>
    <label v-if="!block.allDay">时长（分钟）<AInputNumber v-model:value="block.durationMinutes" :min="1" :max="525600" required :disabled="disabled" aria-label="时长（分钟）" /></label>
    <label v-if="block.allDay">结束日期（不含当天）<ToDooDateField v-model="block.dateEndExclusive" type="date" :disabled="disabled" /></label>
  </div>
  <label>时区<AInput v-model:value="block.start.timeZone" required :disabled="disabled" /></label>
</template>
