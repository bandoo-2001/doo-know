<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { trackImageRequest } from '../../image-requests';

const props = withDefaults(
  defineProps<{
    src?: string;
    x?: number;
    y?: number;
    zoom?: number;
    eager?: boolean;
  }>(),
  { x: 50, y: 50, zoom: 1, eager: false },
);
type LoadState = 'loading' | 'ready' | 'error';
const emit = defineEmits<{ 'load-state': [state: LoadState] }>();
const frame = ref<HTMLElement>();
const picture = ref<HTMLImageElement>();
const loadState = ref<LoadState>('loading');
const ready = computed(() => loadState.value === 'ready');
let visible = false;
let observer: IntersectionObserver | undefined;
let release: ReturnType<typeof trackImageRequest> | undefined;
const bounded = (value: number, min: number, max: number, fallback: number) =>
  Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : fallback;
const imageStyle = computed(() => {
  const position = `${bounded(props.x, 0, 100, 50)}% ${bounded(props.y, 0, 100, 50)}%`;
  return {
    objectPosition: position,
    transformOrigin: position,
    transform: `scale(${bounded(props.zoom, 1, 3, 1)})`,
  };
});
function updateLoadState(state: LoadState) {
  loadState.value = state;
  emit('load-state', state);
}
function connect() {
  release?.();
  release = undefined;
  updateLoadState('loading');
  const image = picture.value;
  if (!image) return;
  image.removeAttribute('src');
  if (!visible || !props.src) return;
  if (props.src.startsWith('blob:')) image.src = props.src;
  else if (/^\/api\/to-doo\/anniversary-images\/[a-f0-9]{64}$/.test(props.src))
    release = trackImageRequest(image, () => ({ src: props.src || null }), {
      onError: () => updateLoadState('error'),
    });
  else updateLoadState('error');
}
function observe() {
  observer?.disconnect();
  release?.();
  release = undefined;
  updateLoadState('loading');
  if (!frame.value) return;
  if (props.eager || visible || typeof IntersectionObserver === 'undefined') {
    visible = true;
    connect();
    return;
  }
  observer = new IntersectionObserver(
    (entries) => {
      if (!entries.some((entry) => entry.isIntersecting)) return;
      visible = true;
      observer?.disconnect();
      connect();
    },
    { rootMargin: '180px' },
  );
  observer.observe(frame.value);
}
onMounted(observe);
watch(() => props.src, observe, { flush: 'post' });
onBeforeUnmount(() => {
  observer?.disconnect();
  release?.();
});
</script>

<template>
  <div
    v-if="src"
    ref="frame"
    class="todo-anniversary-art"
    :data-image-ready="ready"
    :data-image-state="loadState"
    :aria-hidden="loadState !== 'error'"
  >
    <img
      ref="picture"
      class="todo-anniversary-photo"
      alt=""
      draggable="false"
      :style="imageStyle"
      :class="{ 'is-ready': ready }"
      decoding="async"
      @load="updateLoadState('ready')"
      @error="updateLoadState('error')"
    />
    <span class="todo-anniversary-photo-shade" />
    <span v-if="loadState === 'error'" class="todo-anniversary-photo-error">照片暂时无法显示</span>
  </div>
</template>

<style scoped>
.todo-anniversary-art {
  position: relative;
  width: 100%;
  aspect-ratio: 4 / 5;
  overflow: hidden;
  pointer-events: none;
}
.todo-anniversary-photo {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  object-fit: cover;
  opacity: 0;
}
.todo-anniversary-photo.is-ready {
  opacity: 1;
}
.todo-anniversary-photo-shade {
  position: absolute;
  inset: 0;
  background:
    linear-gradient(90deg, #07101a94, #07101a70),
    linear-gradient(180deg, #07101a52 0%, #07101a08 48%, #07101a26 68%, #07101ac7 100%);
}
.todo-anniversary-photo-error {
  position: absolute;
  inset: auto 8px 8px;
  border-radius: 4px;
  padding: 3px 6px;
  background: #07101acc;
  color: #e4edff;
  font-size: 11px;
  line-height: 1.5;
  text-align: center;
}
</style>
