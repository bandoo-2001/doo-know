<script setup lang="ts">
import { computed, h, ref, useAttrs, watch, type VNode } from 'vue';
import { DatePicker as ADatePicker, TimePicker as ATimePicker } from 'ant-design-vue';
import { normalizeToDooDateValue, validateToDooDateInput } from '../../to-doo-controls';
defineOptions({ inheritAttrs: false });
const props = withDefaults(
  defineProps<{
    modelValue?: string | null;
    value?: string | null;
    type?: 'date' | 'time' | 'datetime-local';
    disabled?: boolean;
    required?: boolean;
    allowClear?: boolean;
    min?: string;
    max?: string;
  }>(),
  { type: 'date', allowClear: true },
);
const emit = defineEmits<{
  'update:modelValue': [value: string];
  'update:value': [value: string];
  change: [value: string];
  input: [value: string];
}>();
const attrs = useAttrs();
function pickerAttrs() {
  const forwarded = { ...attrs };
  for (const key of ['aria-label', 'aria-labelledby', 'aria-describedby', 'aria-required'])
    delete forwarded[key];
  return { ...forwarded, inputRender: renderInput };
}
const invalid = ref('');
let editedInput: HTMLInputElement | undefined;
function syncInputLabel(input: HTMLInputElement) {
  if (attrs['aria-label'] || attrs['aria-labelledby']) return;
  const label = input.closest('label');
  if (!label) return;
  const copy = label.cloneNode(true) as HTMLElement;
  copy.querySelectorAll('.ant-picker').forEach((picker) => picker.remove());
  const text = (copy.textContent || '').replace(/\s+/g, ' ').trim();
  if (text) input.setAttribute('aria-label', text);
}
function clearValidation() {
  invalid.value = '';
  editedInput?.setCustomValidity('');
}
function renderInput(input: Record<string, any>) {
  return h('input', {
    ...input,
    required: props.required,
    'aria-required': props.required || undefined,
    'aria-invalid': !!invalid.value,
    onVnodeMounted(node: VNode) {
      syncInputLabel(node.el as HTMLInputElement);
    },
    onVnodeUpdated(node: VNode) {
      syncInputLabel(node.el as HTMLInputElement);
    },
    onInput(event: Event) {
      editedInput = event.target as HTMLInputElement;
      invalid.value = validateToDooDateInput(editedInput.value, props);
      editedInput.setCustomValidity(invalid.value);
      input.onInput?.(event);
      if (!editedInput.value && props.allowClear && !props.required) change('');
    },
    onKeydown(event: KeyboardEvent) {
      input.onKeydown?.(event);
      if (event.key === 'Escape') clearValidation();
    },
    ...(attrs['aria-label'] ? { 'aria-label': attrs['aria-label'] } : {}),
    ...(attrs['aria-labelledby'] ? { 'aria-labelledby': attrs['aria-labelledby'] } : {}),
    ...(attrs['aria-describedby'] ? { 'aria-describedby': attrs['aria-describedby'] } : {}),
  });
}
const value = computed(
  () =>
    normalizeToDooDateValue(props.modelValue !== undefined ? props.modelValue : props.value) ||
    undefined,
);
watch(value, clearValidation);
function change(next: unknown) {
  clearValidation();
  const normalized = normalizeToDooDateValue(next);
  emit('update:modelValue', normalized);
  emit('update:value', normalized);
  emit('change', normalized);
  emit('input', normalized);
}
function disabledDate(day: { format(format: string): string }) {
  const date = day.format('YYYY-MM-DD');
  return !!((props.min && date < props.min) || (props.max && date > props.max));
}
</script>
<template>
  <ATimePicker
    v-if="type === 'time'"
    v-bind="pickerAttrs()"
    class="todo-ant-date"
    :value="value"
    value-format="HH:mm"
    format="HH:mm"
    :disabled="disabled"
    :allow-clear="allowClear && !required"
    :input-read-only="false"
    :status="invalid ? 'error' : undefined"
    :title="invalid || undefined"
    popup-class-name="todo-ant-popup"
    @keydown.enter.prevent.stop
    @change="change"
  />
  <ADatePicker
    v-else
    v-bind="pickerAttrs()"
    class="todo-ant-date"
    :value="value"
    :value-format="type === 'datetime-local' ? 'YYYY-MM-DD[T]HH:mm' : 'YYYY-MM-DD'"
    :format="type === 'datetime-local' ? 'YYYY-MM-DD HH:mm' : 'YYYY-MM-DD'"
    :show-time="type === 'datetime-local' ? { format: 'HH:mm' } : false"
    :disabled="disabled"
    :allow-clear="allowClear && !required"
    :disabled-date="disabledDate"
    :input-read-only="false"
    :status="invalid ? 'error' : undefined"
    :title="invalid || undefined"
    popup-class-name="todo-ant-popup"
    @keydown.enter.prevent.stop
    @change="change"
  />
</template>
