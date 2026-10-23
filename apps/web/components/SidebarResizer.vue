<script setup lang="ts">
import { ref } from 'vue';
const props = withDefaults(defineProps<{
  modelValue: number;
  side?: 'left' | 'right';
  min?: number;
  max?: number;
  defaultWidth?: number;
  label?: string;
  controls?: string;
}>(), { side: 'left', min: 240, max: 400, defaultWidth: 260,
  label: '调整侧栏宽度', controls: 'notebook-navigation' });
const emit = defineEmits<{ 'update:modelValue': [width: number]; commit: [] }>();
const dragging = ref(false);
let startX = 0,
  startWidth = 0;
function update(width: number) {
  emit('update:modelValue', Math.max(props.min, Math.min(props.max, Math.round(width))));
}
function start(event: PointerEvent) {
  if (event.button !== 0) return;
  startX = event.clientX;
  startWidth = props.modelValue;
  dragging.value = true;
  (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
  event.preventDefault();
}
function finish() {
  if (!dragging.value) return;
  dragging.value = false;
  emit('commit');
}
function key(event: KeyboardEvent) {
  const width =
    event.key === 'Home'
      ? props.min
      : event.key === 'End'
        ? props.max
        : event.key === 'ArrowLeft'
          ? props.modelValue + (props.side === 'right' ? 16 : -16)
          : event.key === 'ArrowRight'
            ? props.modelValue + (props.side === 'right' ? -16 : 16)
            : undefined;
  if (width === undefined) return;
  event.preventDefault();
  update(width);
  emit('commit');
}
</script>
<template>
  <div
    class="sidebar-resizer"
    :class="{ dragging, 'outline-resizer': side === 'right' }"
    role="separator"
    tabindex="0"
    :aria-label="label"
    aria-orientation="vertical"
    :aria-valuenow="modelValue"
    :aria-valuemin="min"
    :aria-valuemax="max"
    :aria-controls="controls"
    title="拖动调整目录宽度，双击还原"
    @pointerdown="start"
    @pointermove="dragging && update(startWidth + ($event.clientX - startX) * (side === 'right' ? -1 : 1))"
    @pointerup="finish"
    @pointercancel="finish"
    @lostpointercapture="finish"
    @keydown="key"
    @dblclick="
      update(defaultWidth);
      emit('commit');
    "
  ></div>
</template>
