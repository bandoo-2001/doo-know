<script setup lang="ts">
import { Input as AInput } from 'ant-design-vue';
import { computed, ref, useId, watchPostEffect } from 'vue';
import type { ToDooDateTime } from '../../../../shared/to-doo-contracts';
import { isToDooTimeZone } from '../../to-doo-presentation';
import ToDooSelect from './ToDooSelect.vue';

type TimeMode = NonNullable<ToDooDateTime['timeMode']>;
const props = withDefaults(
  defineProps<{
    timeMode?: TimeMode;
    timeZone?: string;
    workspaceZone: string;
    defaultZone?: string;
    label?: string;
    disabled?: boolean;
    required?: boolean;
  }>(),
  { label: '' },
);
const emit = defineEmits<{
  'update:timeMode': [value: TimeMode];
  'update:timeZone': [value: string];
}>();
const zoneOptionsId = 'todo-time-zones-' + useId();
const zoneField = ref<HTMLLabelElement>();
const invalidZone = computed(() => !!props.timeZone && !isToDooTimeZone(props.timeZone));
watchPostEffect(() => {
  zoneField.value
    ?.querySelector('input')
    ?.setCustomValidity(invalidZone.value ? '请输入有效的时区，例如 Asia/Shanghai' : '');
});
const timeZones = [
  ...new Set([
    'UTC',
    'Asia/Shanghai',
    'Asia/Tokyo',
    'Europe/London',
    'America/New_York',
    ...(typeof Intl.supportedValuesOf === 'function' ? Intl.supportedValuesOf('timeZone') : []),
  ]),
];
function setMode(value: string) {
  if (value !== 'floating' && value !== 'fixed') return;
  if (value === 'floating' && props.required && (!props.timeZone || invalidZone.value))
    emit('update:timeZone', props.workspaceZone);
  emit('update:timeMode', value);
}
</script>

<template>
  <div class="todo-form-grid">
    <label>
      {{ label }}时间方式
      <ToDooSelect
        :value="timeMode ?? 'fixed'"
        :disabled="disabled"
        :show-search="false"
        :aria-label="label + '时间方式'"
        @change="setMode"
      >
        <option value="fixed">固定时区</option>
        <option value="floating">固定时间</option>
      </ToDooSelect>
    </label>
    <small v-if="timeMode === 'floating'" class="todo-form-help">
      按 To Doo 当前时区 {{ workspaceZone }} 保持上面填写的时间。
    </small>
    <label v-else ref="zoneField">
      {{ label }}时区
      <AInput
        :value="timeZone"
        :placeholder="defaultZone || workspaceZone"
        :list="zoneOptionsId"
        :aria-label="label + '时区'"
        :aria-invalid="invalidZone || undefined"
        :disabled="disabled"
        :required="required"
        @update:value="emit('update:timeZone', $event)"
      />
      <datalist :id="zoneOptionsId">
        <option v-for="zone in timeZones" :key="zone" :value="zone" />
      </datalist>
    </label>
  </div>
</template>
