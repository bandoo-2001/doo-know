<script setup lang="ts">
import { Button as AButton } from 'ant-design-vue';
import { computed, onBeforeUnmount, reactive, ref, watch } from 'vue';
import type { ToDooAnniversaryImage } from '../../../../shared/to-doo-contracts';
import ToDooAnniversaryArt from './ToDooAnniversaryArt.vue';

type ImageFile = Pick<ToDooAnniversaryImage, 'hash' | 'name' | 'mime' | 'size'>;
type Framing = { src: string; x: number; y: number; zoom: number };
const props = defineProps<{
  modelValue?: ToDooAnniversaryImage;
  upload?: (file: File) => Promise<ImageFile>;
}>();
const emit = defineEmits<{
  'update:modelValue': [image: ToDooAnniversaryImage | undefined];
  'busy-change': [value: boolean];
  'editing-change': [value: boolean];
  'preview-change': [value: Framing | undefined];
  'show-preview': [];
}>();
const fileInput = ref<HTMLInputElement>();
const cropFrame = ref<HTMLElement>();
const editing = ref(false);
const busy = ref(false);
const imageState = ref<'loading' | 'ready' | 'error'>('loading');
const error = ref('');
const temporarySource = ref('');
const draft = reactive({ x: 50, y: 50, zoom: 1 });
const source = computed(
  () =>
    temporarySource.value ||
    (props.modelValue ? '/api/to-doo/anniversary-images/' + props.modelValue.hash : ''),
);
let pendingImage: HTMLImageElement | undefined;
let alive = true;
let selection = 0;
let drag:
  | { pointer: number; left: number; top: number; x: number; y: number; gapX: number; gapY: number }
  | undefined;

watch(busy, (value) => emit('busy-change', value));
watch(editing, (value) => emit('editing-change', value));
watch(
  () => [editing.value, source.value, draft.x, draft.y, draft.zoom],
  () => {
    emit(
      'preview-change',
      editing.value && source.value ? { src: source.value, ...draft } : undefined,
    );
  },
);
function clearTemporary() {
  if (temporarySource.value) URL.revokeObjectURL(temporarySource.value);
  temporarySource.value = '';
  pendingImage = undefined;
}
function cancel() {
  if (busy.value) return;
  selection++;
  editing.value = false;
  clearTemporary();
  error.value = '';
}
function recrop() {
  if (!props.modelValue || busy.value) return;
  clearTemporary();
  Object.assign(draft, {
    x: props.modelValue.x,
    y: props.modelValue.y,
    zoom: props.modelValue.zoom,
  });
  error.value = '';
  editing.value = true;
}
function resetFraming() {
  if (!busy.value) Object.assign(draft, { x: 50, y: 50, zoom: 1 });
}
async function selectFile(event: Event) {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  input.value = '';
  if (!file || busy.value) return;
  error.value = '';
  if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type)) {
    error.value = '请选择 PNG、JPEG 或 WebP 图片。';
    return;
  }
  if (!file.size || file.size > 10 * 1024 * 1024) {
    error.value = '图片大小需在 10 MB 以内。';
    return;
  }
  const current = ++selection;
  const url = URL.createObjectURL(file);
  busy.value = true;
  try {
    const image = new Image();
    await new Promise<void>((resolve, reject) => {
      image.onload = () => resolve();
      image.onerror = () =>
        reject(new Error('无法读取这张图片，请换一张 PNG、JPEG 或 WebP 图片。'));
      image.src = url;
    });
    if (
      !image.naturalWidth ||
      !image.naturalHeight ||
      image.naturalWidth * image.naturalHeight > 80_000_000
    )
      throw new Error('图片尺寸过大，请选择较小的图片。');
    if (!alive || current !== selection) return;
    clearTemporary();
    pendingImage = image;
    temporarySource.value = url;
    Object.assign(draft, { x: 50, y: 50, zoom: 1 });
    editing.value = true;
  } catch (cause) {
    if (alive && current === selection)
      error.value = cause instanceof Error ? cause.message : '图片读取失败，请重试。';
  } finally {
    if (temporarySource.value !== url) URL.revokeObjectURL(url);
    if (alive) busy.value = false;
  }
}
async function confirm() {
  if (!editing.value || busy.value || imageState.value !== 'ready') return;
  busy.value = true;
  error.value = '';
  try {
    let image: ImageFile | undefined = props.modelValue;
    if (pendingImage) {
      if (!props.upload) throw new Error('图片上传暂不可用，请稍后再试。');
      // Keep the whole image so the framing can be changed after saving.
      const ratio = Math.min(
        1,
        2400 / Math.max(pendingImage.naturalWidth, pendingImage.naturalHeight),
      );
      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.round(pendingImage.naturalWidth * ratio));
      canvas.height = Math.max(1, Math.round(pendingImage.naturalHeight * ratio));
      const context = canvas.getContext('2d');
      if (!context) throw new Error('暂时无法处理图片，请重试。');
      context.drawImage(pendingImage, 0, 0, canvas.width, canvas.height);
      const blob = await new Promise<Blob>((resolve, reject) =>
        canvas.toBlob(
          (result) => (result ? resolve(result) : reject(new Error('图片处理失败，请重试。'))),
          'image/webp',
          0.9,
        ),
      );
      if (!alive) return;
      if (blob.size > 10 * 1024 * 1024) throw new Error('处理后的图片仍然过大，请选择较小的图片。');
      const extension = blob.type === 'image/webp' ? 'webp' : 'png';
      image = await props.upload(new File([blob], 'anniversary.' + extension, { type: blob.type }));
    }
    if (!alive) return;
    if (!image) throw new Error('请先选择图片。');
    emit('update:modelValue', { ...image, ...draft });
    editing.value = false;
    clearTemporary();
  } catch (cause) {
    if (alive)
      error.value = cause instanceof Error ? cause.message : '图片上传失败，取景已保留，请重试。';
  } finally {
    if (alive) busy.value = false;
  }
}
const bounded = (value: number) => Math.min(100, Math.max(0, value));
function startDrag(event: PointerEvent) {
  if (busy.value || event.button !== 0) return;
  const frame = cropFrame.value;
  const image = frame?.querySelector('img');
  if (!frame || !image?.naturalWidth) return;
  const bounds = frame.getBoundingClientRect();
  const cover =
    Math.max(bounds.width / image.naturalWidth, bounds.height / image.naturalHeight) * draft.zoom;
  drag = {
    pointer: event.pointerId,
    left: event.clientX,
    top: event.clientY,
    x: draft.x,
    y: draft.y,
    gapX: Math.max(0, image.naturalWidth * cover - bounds.width),
    gapY: Math.max(0, image.naturalHeight * cover - bounds.height),
  };
  frame.setPointerCapture(event.pointerId);
  event.preventDefault();
}
function moveDrag(event: PointerEvent) {
  if (!drag || busy.value || drag.pointer !== event.pointerId) return;
  if (drag.gapX > 0)
    draft.x = Math.round(bounded(drag.x - ((event.clientX - drag.left) / drag.gapX) * 100));
  if (drag.gapY > 0)
    draft.y = Math.round(bounded(drag.y - ((event.clientY - drag.top) / drag.gapY) * 100));
}
function finishDrag(event: PointerEvent) {
  if (drag?.pointer !== event.pointerId) return;
  if (cropFrame.value?.hasPointerCapture(event.pointerId))
    cropFrame.value.releasePointerCapture(event.pointerId);
  drag = undefined;
}
function escape(event: KeyboardEvent) {
  if (event.key !== 'Escape' || (!editing.value && !busy.value)) return;
  event.stopPropagation();
  event.preventDefault();
  cancel();
}
onBeforeUnmount(() => {
  alive = false;
  selection++;
  clearTemporary();
  emit('busy-change', false);
  emit('editing-change', false);
  emit('preview-change', undefined);
});
defineExpose({ cancelFraming: cancel });
</script>

<template>
  <section class="todo-anniversary-image-editor" aria-label="照片设置" @keydown="escape">
    <div class="todo-photo-editor-heading">
      <h4>图片</h4>
      <span>{{ editing ? '调整后请确认取景' : modelValue ? '已添加图片' : '选择自己的照片' }}</span>
    </div>
    <div class="todo-photo-actions">
      <input
        ref="fileInput"
        class="todo-photo-file-input"
        style="display: none"
        type="file"
        accept="image/png,image/jpeg,image/webp"
        aria-label="选择纪念日图片"
        :disabled="busy"
        @change="selectFile"
      />
      <AButton
        html-type="button"
        :type="modelValue ? 'default' : 'primary'"
        :disabled="busy"
        @click="fileInput?.click()"
        >{{ modelValue ? '更换图片' : '上传图片' }}</AButton
      >
      <AButton v-if="modelValue && !editing" html-type="button" :disabled="busy" @click="recrop"
        >重新取景</AButton
      >
      <AButton
        v-if="modelValue && !editing"
        html-type="button"
        type="text"
        danger
        :disabled="busy"
        @click="emit('update:modelValue', undefined)"
        >移除图片</AButton
      >
    </div>
    <p class="todo-form-help">PNG、JPEG、WebP，最大 10 MB。支持拖动和缩放，取景比例为 4:5。</p>
    <section
      v-if="editing"
      class="todo-photo-framing"
      role="region"
      aria-label="图片取景"
      tabindex="-1"
    >
      <div
        ref="cropFrame"
        class="todo-photo-crop-frame"
        @pointerdown="startDrag"
        @pointermove="moveDrag"
        @pointerup="finishDrag"
        @pointercancel="finishDrag"
        @lostpointercapture="drag = undefined"
      >
        <ToDooAnniversaryArt
          :src="source"
          :x="draft.x"
          :y="draft.y"
          :zoom="draft.zoom"
          eager
          @load-state="imageState = $event"
        />
        <span class="todo-photo-crop-grid" aria-hidden="true" />
      </div>
      <div class="todo-photo-framing-controls">
        <p v-if="imageState === 'error'" class="todo-error" role="alert">
          图片暂未加载，请取消取景后重试，或更换图片。原取景会保留。
        </p>
        <p class="todo-form-help">拖动照片调整位置，或使用下方滑块取景。</p>
        <label class="todo-photo-slider-field"
          ><span>缩放</span><output>{{ draft.zoom.toFixed(2) }}×</output>
          <input
            v-model.number="draft.zoom"
            type="range"
            aria-label="缩放"
            min="1"
            max="3"
            step="0.05"
            :disabled="busy"
          />
        </label>
        <label class="todo-photo-slider-field"
          ><span>水平取景</span><output>{{ draft.x }}%</output>
          <input
            v-model.number="draft.x"
            type="range"
            aria-label="水平取景"
            min="0"
            max="100"
            step="1"
            :disabled="busy"
          />
        </label>
        <label class="todo-photo-slider-field"
          ><span>垂直取景</span><output>{{ draft.y }}%</output>
          <input
            v-model.number="draft.y"
            type="range"
            aria-label="垂直取景"
            min="0"
            max="100"
            step="1"
            :disabled="busy"
          />
        </label>
        <AButton
          html-type="button"
          class="todo-photo-reset"
          type="text"
          :disabled="busy"
          @click="resetFraming"
          >居中重置</AButton
        >
      </div>
      <div class="todo-photo-framing-footer">
        <p class="todo-form-help">确认取景后，再保存纪念日。取消取景会保留原来的图片设置。</p>
        <div class="todo-photo-actions">
          <AButton
            html-type="button"
            class="todo-photo-preview-link"
            type="text"
            @click="emit('show-preview')"
            >对照卡片</AButton
          >
          <span class="todo-photo-action-spacer" />
          <AButton html-type="button" :disabled="busy" @click="cancel">取消取景</AButton>
          <AButton
            html-type="button"
            type="primary"
            :disabled="busy || imageState !== 'ready'"
            @click="confirm"
            >{{ busy ? '正在处理图片…' : '确认取景' }}</AButton
          >
        </div>
      </div>
    </section>
    <p v-if="error" class="todo-error" role="alert">{{ error }}</p>
  </section>
</template>

<style scoped>
.todo-anniversary-image-editor {
  display: grid;
  gap: 10px;
  min-width: 0;
  padding: 14px;
  border: 1px solid var(--todo-line);
  border-radius: 10px;
  background: var(--todo-paper);
}
.todo-photo-actions {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
  min-width: 0;
}
.todo-photo-editor-heading {
  display: flex;
  align-items: center;
  justify-content: space-between;
  flex-wrap: wrap;
  gap: 8px;
}
.todo-photo-editor-heading h4 {
  margin: 0;
  font-size: 12px;
  font-weight: 550;
}
.todo-photo-editor-heading > span {
  color: var(--todo-muted);
  font-size: 11px;
}
.todo-photo-file-input {
  display: none;
}
.todo-anniversary-image-editor p {
  margin: 0;
  overflow-wrap: anywhere;
}
.todo-photo-framing {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
  gap: 16px;
  min-width: 0;
  align-items: start;
  scroll-margin-block: 12px;
}
.todo-photo-framing:focus {
  outline: none;
}
.todo-photo-framing-footer {
  grid-column: 1 / -1;
  display: grid;
  gap: 12px;
  padding-top: 12px;
  border-top: 1px solid var(--todo-line);
}
.todo-photo-action-spacer {
  flex: 1;
}
.todo-photo-preview-link {
  display: none;
}
.todo-photo-reset {
  justify-self: start;
}
.todo-photo-crop-frame {
  position: relative;
  overflow: hidden;
  width: 100%;
  max-width: 280px;
  aspect-ratio: 4 / 5;
  border-radius: 8px;
  background: #17212e;
  touch-action: none;
  cursor: grab;
}
.todo-photo-crop-frame:active {
  cursor: grabbing;
}
.todo-photo-crop-grid {
  position: absolute;
  inset: 0;
  pointer-events: none;
  background:
    linear-gradient(
      90deg,
      transparent calc(100% / 3 - 0.5px),
      #ffffff3d calc(100% / 3),
      transparent calc(100% / 3 + 0.5px),
      transparent calc(200% / 3 - 0.5px),
      #ffffff3d calc(200% / 3),
      transparent calc(200% / 3 + 0.5px)
    ),
    linear-gradient(
      transparent calc(100% / 3 - 0.5px),
      #ffffff3d calc(100% / 3),
      transparent calc(100% / 3 + 0.5px),
      transparent calc(200% / 3 - 0.5px),
      #ffffff3d calc(200% / 3),
      transparent calc(200% / 3 + 0.5px)
    );
  box-shadow: inset 0 0 0 1px #ffffff66;
  border-radius: inherit;
}
.todo-photo-framing-controls {
  display: grid;
  gap: 12px;
  min-width: 0;
}
.todo-anniversary-image-editor .todo-photo-framing-controls label.todo-photo-slider-field {
  display: grid;
  grid-template-columns: 1fr auto;
  align-items: center;
  gap: 6px;
  font-size: 12px;
}
.todo-photo-framing-controls output {
  color: var(--todo-muted);
  font-variant-numeric: tabular-nums;
  font-size: 12px;
  line-height: 18px;
}
.todo-anniversary-image-editor .todo-photo-framing-controls input[type='range'] {
  grid-column: 1 / -1;
  width: 100%;
  min-width: 0;
  margin: 0;
  padding: 0;
  border: 0;
  background: transparent;
  accent-color: var(--todo-accent);
  min-height: 28px;
}
.todo-photo-crop-frame :deep(.todo-anniversary-photo-shade) {
  display: none;
}
@media (max-width: 800px) {
  .todo-photo-preview-link {
    display: inline-flex;
  }
  .todo-photo-framing-footer .todo-photo-actions {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
  .todo-photo-framing-footer .todo-photo-actions > .ant-btn {
    min-width: 0;
    min-height: 36px;
    height: auto;
    padding-block: 8px;
    white-space: normal;
  }
  .todo-photo-framing-footer .todo-photo-preview-link {
    grid-column: 1 / -1;
    justify-self: start;
  }
  .todo-photo-framing-footer .todo-photo-action-spacer {
    display: none;
  }
}
@media (max-width: 480px) {
  .todo-photo-framing {
    grid-template-columns: minmax(0, 1fr);
  }
  .todo-photo-crop-frame {
    max-width: 220px;
    justify-self: center;
  }
}
</style>
