<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue';

const props = defineProps<{
  html: string;
  device: string;
  title: string;
  captureEscape?: boolean;
}>();
const emit = defineEmits<{ escape: [] }>();
const host = ref<HTMLElement>();
const frame = ref<HTMLIFrameElement>();
let previewDocument: Document | null = null;
function onFrameKeydown(event: KeyboardEvent) {
  if (event.key === 'Escape') {
    event.preventDefault();
    emit('escape');
  }
}
function clearFrameKeys() {
  previewDocument?.removeEventListener('keydown', onFrameKeydown);
  previewDocument = null;
}
function bindFrameKeys() {
  clearFrameKeys();
  if (!props.captureEscape) return;
  // Keyboard events in a sandboxed frame do not reach the parent dialog.
  // The parent owns this listener; scripts within the preview remain disabled.
  previewDocument = frame.value?.contentDocument || null;
  previewDocument?.addEventListener('keydown', onFrameKeydown);
}
onBeforeUnmount(clearFrameKeys);
const bounds = ref({ width: 0, height: 600 });
const width = computed(() => (props.device === 'mobile' ? 375 : 1100));
const border = computed(() => (props.device === 'mobile' ? 6 : 1));
const scale = computed(() =>
  Math.min(
    1,
    Math.max(1, (bounds.value.width || width.value + border.value * 2) - border.value * 2) /
      width.value,
  ),
);
const deviceStyle = computed(() => ({
  width: `${width.value * scale.value + border.value * 2}px`,
}));
const frameStyle = computed(() => ({
  width: `${width.value}px`,
  height: `${Math.max(1, bounds.value.height - border.value * 2) / scale.value}px`,
  transform: `scale(${scale.value})`,
}));
watch(
  host,
  (element, _previous, onCleanup) => {
    if (!element) return;
    const measure = () => {
      bounds.value = { width: element.clientWidth, height: element.clientHeight };
    };
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    measure();
    onCleanup(() => observer.disconnect());
  },
  { flush: 'post' },
);
</script>

<template>
  <div ref="host" class="blog-preview-host">
    <div class="blog-preview-device" :class="device" :style="deviceStyle">
      <iframe
        v-if="html"
        ref="frame"
        :srcdoc="html"
        :style="frameStyle"
        sandbox="allow-same-origin"
        :title="title"
        referrerpolicy="no-referrer"
        @load="bindFrameKeys"
      />
      <slot v-else />
    </div>
  </div>
</template>
