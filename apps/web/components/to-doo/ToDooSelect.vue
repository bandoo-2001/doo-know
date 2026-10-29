<script setup lang="ts">
import { onMounted, onUpdated, useAttrs, useId, useSlots } from 'vue';
import { Select as ASelect } from 'ant-design-vue';
import {
  prepareToDooSelectOptions,
  toDooSelectKey,
  type ToDooControlOption,
} from '../../to-doo-controls';
defineOptions({ inheritAttrs: false });
const props = withDefaults(
  defineProps<{
    modelValue?: any;
    value?: any;
    multiple?: boolean;
    options?: ToDooControlOption[];
    disabled?: boolean;
    required?: boolean;
    placeholder?: string;
    showSearch?: boolean;
    allowClear?: boolean;
  }>(),
  { showSearch: true },
);
const emit = defineEmits<{
  'update:modelValue': [value: any];
  'update:value': [value: any];
  change: [value: any];
}>();
const attrs = useAttrs(),
  slots = useSlots();
const generatedId = 'to-doo-select-' + useId();
function inputId() {
  return String(attrs.id || generatedId);
}
function selectAttrs() {
  const forwarded = { ...attrs };
  for (const key of ['aria-label', 'aria-labelledby', 'aria-describedby', 'aria-required'])
    delete forwarded[key];
  return forwarded;
}
function syncInputAccessibility() {
  const input = document.getElementById(inputId());
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
  // Ant's combobox input needs its own stable name; selected tags are not label text.
  if (label) input.setAttribute('aria-label', label);
  for (const key of ['aria-labelledby', 'aria-describedby']) {
    if (attrs[key]) input.setAttribute(key, String(attrs[key]));
  }
  const required =
    props.required || attrs['aria-required'] === true || attrs['aria-required'] === 'true';
  input.setAttribute('aria-required', String(required));
}
onMounted(syncInputAccessibility);
onUpdated(syncInputAccessibility);
// Slot VNodes can depend on their parent's asynchronous data. Read them in render,
// rather than caching a slot invocation outside the render effect.
function control() {
  const prepared = prepareToDooSelectOptions(slots.default?.() || [], props.options);
  const raw = props.modelValue !== undefined ? props.modelValue : props.value;
  const selected = props.multiple ? (Array.isArray(raw) ? raw : []) : [raw];
  for (const item of selected) {
    const key = toDooSelectKey(item);
    if (item !== undefined && !prepared.values.has(key)) {
      prepared.values.set(key, item);
      prepared.options.push({ value: key, label: '当前选项（尚未载入）', disabled: true });
    }
  }
  return {
    ...prepared,
    value: props.multiple
      ? selected.map(toDooSelectKey)
      : raw === undefined && !prepared.values.has(toDooSelectKey(raw))
        ? undefined
        : toDooSelectKey(raw),
  };
}
function change(value: unknown, values: Map<string, unknown>) {
  const keys = Array.isArray(value) ? value : [value];
  if (keys.some((key) => key !== undefined && !values.has(String(key)))) return;
  const raw = props.multiple
    ? keys.filter((key) => key !== undefined).map((key) => values.get(String(key)))
    : value === undefined
      ? ''
      : values.get(String(value));
  emit('update:modelValue', raw);
  emit('update:value', raw);
  emit('change', raw);
}
</script>
<template>
  <template v-for="data in [control()]" :key="0">
    <ASelect
      v-bind="selectAttrs()"
      :id="inputId()"
      class="todo-ant-select"
      :value="data.value"
      :options="data.options"
      :mode="multiple ? 'multiple' : undefined"
      :disabled="disabled"
      :placeholder="placeholder"
      :show-search="showSearch"
      :allow-clear="allowClear"
      :aria-required="required || undefined"
      option-filter-prop="label"
      dropdown-class-name="todo-ant-popup"
      @click.prevent
      @change="change($event, data.values)"
    />
  </template>
</template>
