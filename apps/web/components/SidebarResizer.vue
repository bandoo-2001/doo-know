<script setup lang="ts">
import { ref } from 'vue';
const props = defineProps<{ modelValue: number }>();
const emit = defineEmits<{ 'update:modelValue': [width: number]; commit: [] }>();
const dragging = ref(false);
let startX = 0,
  startWidth = 0;
function update(width: number) {
  emit('update:modelValue', Math.max(240, Math.min(400, Math.round(width))));
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
      ? 240
      : event.key === 'End'
        ? 400
        : event.key === 'ArrowLeft'
          ? props.modelValue - 16
          : event.key === 'ArrowRight'
            ? props.modelValue + 16
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
    :class="{ dragging }"
    role="separator"
    tabindex="0"
    aria-label="调整侧栏宽度"
    aria-orientation="vertical"
    :aria-valuenow="modelValue"
    :aria-valuemin="240"
    :aria-valuemax="400"
    aria-controls="notebook-navigation"
    title="拖动调整目录宽度，双击还原"
    @pointerdown="start"
    @pointermove="dragging && update(startWidth + $event.clientX - startX)"
    @pointerup="finish"
    @pointercancel="finish"
    @lostpointercapture="finish"
    @keydown="key"
    @dblclick="
      update(280);
      emit('commit');
    "
  ></div>
</template>
