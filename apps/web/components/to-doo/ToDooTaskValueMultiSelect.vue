<script setup lang="ts">
import { computed, h, onMounted, onUpdated, useAttrs, useId } from 'vue';
import { Select as ASelect } from 'ant-design-vue';
import {
  isToDooTaskValue,
  toDooTaskValueOptions,
  type ToDooTaskValueKind,
} from '../../to-doo-task-values';
import ToDooTaskValueLabel from './ToDooTaskValueLabel.vue';
import { createToDooPopupEscapeBoundary } from '../../to-doo-controls';

defineOptions({ inheritAttrs: false });
const props = withDefaults(
  defineProps<{
    kind: ToDooTaskValueKind;
    modelValue?: string[];
    value?: string[];
    disabled?: boolean;
    showSearch?: boolean;
    required?: boolean;
  }>(),
  { showSearch: true, disabled: undefined },
);
const emit = defineEmits<{
  'update:modelValue': [value: string[]];
  'update:value': [value: string[]];
  change: [value: string[]];
}>();
const attrs = useAttrs();
const popupEscape = createToDooPopupEscapeBoundary();
const generatedId = 'todo-task-values-' + useId();
const inputId = computed(() => String(attrs.id || generatedId));
const selected = computed(() =>
  props.modelValue !== undefined ? props.modelValue : props.value || [],
);
const options = computed(() =>
  toDooTaskValueOptions(props.kind).map((option) => ({
    ...option,
    title: option.label,
    selectedLabel: h(ToDooTaskValueLabel, { kind: props.kind, value: option.value }),
  })),
);
function selectAttrs() {
  const result = { ...attrs };
  for (const key of ['aria-label', 'aria-labelledby', 'aria-describedby', 'aria-required'])
    delete result[key];
  return result;
}
function syncAccessibility() {
  const input = document.getElementById(inputId.value);
  if (!input) return;
  let label = String(attrs['aria-label'] || '');
  if (!label) {
    const container = input.closest('label');
    if (container) {
      const copy = container.cloneNode(true) as HTMLElement;
      copy.querySelectorAll('.ant-select').forEach((control) => control.remove());
      label = (copy.textContent || '').replace(/\s+/g, ' ').trim();
    }
  }
  if (label) input.setAttribute('aria-label', label);
  for (const key of ['aria-labelledby', 'aria-describedby'])
    if (attrs[key]) input.setAttribute(key, String(attrs[key]));
  input.setAttribute(
    'aria-required',
    String(props.required || attrs['aria-required'] === true || attrs['aria-required'] === 'true'),
  );
}
onMounted(syncAccessibility);
onUpdated(syncAccessibility);
function change(value: unknown) {
  if (
    props.disabled ||
    !Array.isArray(value) ||
    value.some((item) => !isToDooTaskValue(props.kind, item))
  )
    return;
  const next = [...new Set(value)] as string[];
  emit('update:modelValue', next);
  emit('update:value', next);
  emit('change', next);
}
</script>

<template>
  <ASelect
    v-bind="selectAttrs()"
    :id="inputId"
    class="todo-ant-select todo-task-value-select todo-task-value-multi-select"
    mode="multiple"
    :value="selected"
    :options="options"
    :disabled="disabled"
    :show-search="showSearch"
    option-filter-prop="label"
    option-label-prop="selectedLabel"
    :aria-required="required || undefined"
    popup-class-name="todo-ant-popup todo-task-values-popup"
    @click.prevent
    @keydown.capture="popupEscape.capture"
    @keydown="popupEscape.bubble"
    @change="change"
  >
    <template #option="option"><ToDooTaskValueLabel :kind="kind" :value="option.value" /></template>
  </ASelect>
</template>
