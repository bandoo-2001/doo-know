<script setup lang="ts">
import { Checkbox as ACheckbox, Input as AInput, InputNumber as AInputNumber } from 'ant-design-vue';
import { watch } from 'vue';
import type { ToDooEntityMap } from '../../../../shared/to-doo-contracts';
import { isToDooTimeZone } from '../../to-doo-presentation';
import ToDooDateField from './ToDooDateField.vue';
import ToDooTimeModeFields from './ToDooTimeModeFields.vue';
const props = defineProps<{
  block: Pick<ToDooEntityMap['timeBlock'], 'title' | 'allDay' | 'start' | 'durationMinutes' | 'dateEndExclusive'>;
  workspaceZone: string;
  disabled?: boolean;
}>();
let timedTime = props.block.allDay ? null : props.block.start.time;
let timedMode = props.block.allDay ? undefined : props.block.start.timeMode;
let allDayEnd = props.block.allDay ? props.block.dateEndExclusive : null;
watch(() => props.block, block => {
  timedTime = block.allDay ? null : block.start.time;
  timedMode = block.allDay ? undefined : block.start.timeMode;
  allDayEnd = block.allDay ? block.dateEndExclusive : null;
});
function setTime(value: string | null) {
  props.block.start.time = value || null;
  if (!props.block.start.time) {
    delete props.block.start.timeMode;
    if (!isToDooTimeZone(props.block.start.timeZone)) props.block.start.timeZone = props.workspaceZone;
  }
}
function setAllDay(checked: boolean) {
  if (checked === props.block.allDay) return;
  if (checked) {
    timedTime = props.block.start.time;
    timedMode = props.block.start.timeMode;
    setTime(null);
    props.block.dateEndExclusive = allDayEnd;
  } else {
    allDayEnd = props.block.dateEndExclusive;
    props.block.dateEndExclusive = null;
    props.block.start.time = timedTime;
    if (timedTime && timedMode) props.block.start.timeMode = timedMode;
  }
  props.block.allDay = checked;
}
</script>
<template>
  <label>安排标题<AInput v-model:value="block.title" :disabled="disabled" placeholder="给这段时间起个名字" /></label>
  <ACheckbox :checked="block.allDay" @update:checked="setAllDay" :disabled="disabled">全天安排</ACheckbox>
  <div class="todo-form-grid">
    <label>日期<ToDooDateField v-model="block.start.date" type="date" required :disabled="disabled" /></label>
    <label v-if="!block.allDay">时间<ToDooDateField :model-value="block.start.time" @update:model-value="setTime" type="time" :disabled="disabled" /></label>
    <label v-if="!block.allDay">时长（分钟）<AInputNumber v-model:value="block.durationMinutes" :min="1" :max="525600" required :disabled="disabled" aria-label="时长（分钟）" /></label>
    <label v-if="block.allDay">结束日期（不含当天）<ToDooDateField :value="block.dateEndExclusive" @change="block.dateEndExclusive = $event || null" type="date" :disabled="disabled" /></label>
  </div>
  <ToDooTimeModeFields v-if="!block.allDay && block.start.time"
    v-model:time-mode="block.start.timeMode" v-model:time-zone="block.start.timeZone"
    :workspace-zone="workspaceZone" required :disabled="disabled" />
</template>
