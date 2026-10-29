<script setup lang="ts">
import { computed, onBeforeUnmount, ref } from 'vue';
const props = defineProps<{
  label: string;
  value?: string;
  aspect?: number;
  upload: (file: File) => Promise<string>;
}>();
const emit = defineEmits<{ change: [value: string] }>();
const source = ref(''),
  pending = ref(false),
  error = ref(''),
  zoom = ref(1),
  x = ref(50),
  y = ref(50);
const image = ref<HTMLImageElement>();
const naturalRatio = ref(1);
const style = computed(() => {
  const aspect = props.aspect || 16 / 9;
  const width = Math.max(1, naturalRatio.value / aspect) * zoom.value * 100;
  const height = Math.max(1, aspect / naturalRatio.value) * zoom.value * 100;
  return {
    width: `${width}%`,
    height: `${height}%`,
    left: `${((100 - width) * x.value) / 100}%`,
    top: `${((100 - height) * y.value) / 100}%`,
  };
});
function loaded() {
  if (image.value) naturalRatio.value = image.value.naturalWidth / image.value.naturalHeight;
}
function clear() {
  if (source.value) URL.revokeObjectURL(source.value);
  source.value = '';
}
let active = true;
onBeforeUnmount(() => {
  active = false;
  clear();
});
function choose(event: Event) {
  const file = (event.target as HTMLInputElement).files?.[0];
  (event.target as HTMLInputElement).value = '';
  if (!file) return;
  error.value = '';
  if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type)) {
    error.value = '请选择 JPEG、PNG 或 WebP 图片。';
    return;
  }
  if (file.size > 10 * 1024 * 1024) {
    error.value = '图片不能超过 10 MB。';
    return;
  }
  clear();
  source.value = URL.createObjectURL(file);
  zoom.value = 1;
  x.value = y.value = 50;
}
async function save() {
  const img = image.value;
  if (!img?.naturalWidth || pending.value) return;
  pending.value = true;
  error.value = '';
  try {
    const aspect = props.aspect || 16 / 9;
    let width = img.naturalWidth,
      height = width / aspect;
    if (height > img.naturalHeight) {
      height = img.naturalHeight;
      width = height * aspect;
    }
    width /= zoom.value;
    height /= zoom.value;
    const canvas = document.createElement('canvas');
    canvas.width = Math.min(1600, Math.round(width));
    canvas.height = Math.round(canvas.width / aspect);
    const context = canvas.getContext('2d');
    if (!context) throw Error('浏览器暂不支持图片裁切');
    context.drawImage(
      img,
      ((img.naturalWidth - width) * x.value) / 100,
      ((img.naturalHeight - height) * y.value) / 100,
      width,
      height,
      0,
      0,
      canvas.width,
      canvas.height,
    );
    const blob = await new Promise<Blob>((resolve, reject) =>
      canvas.toBlob(
        (value) => (value ? resolve(value) : reject(Error('图片处理失败'))),
        'image/webp',
        0.9,
      ),
    );
    if (!active) return;
    const result = await props.upload(new File([blob], 'blog-image.webp', { type: 'image/webp' }));
    if (!active) return;
    emit('change', result);
    clear();
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : String(cause);
  } finally {
    pending.value = false;
  }
}
</script>
<template>
  <div class="blog-image-editor">
    <div class="blog-image-toolbar">
      <strong>{{ label }}</strong
      ><label class="blog-button blog-upload-label"
        >选择图片<input
          type="file"
          accept="image/jpeg,image/png,image/webp"
          :aria-label="'选择' + label + '图片'"
          :disabled="pending"
          @change="choose" /></label
      ><button
        v-if="value"
        type="button"
        class="blog-text-button"
        :disabled="pending"
        @click="emit('change', '')"
      >
        移除
      </button>
    </div>
    <p class="blog-image-help">
      支持 JPEG、PNG、WebP，最大 10 MB。{{
        aspect === 1
          ? '头像将裁切为正方形。'
          : aspect === 3
            ? '横幅将裁切为 3:1。'
            : '选择后可调整裁切范围。'
      }}
    </p>
    <div
      v-if="source"
      class="blog-crop-editor"
      role="region"
      :aria-label="label + '图片裁切'"
      :aria-busy="pending"
    >
      <p class="blog-image-help">调整缩放和位置，确认画面后上传。</p>
      <div class="blog-crop-window" :style="{ aspectRatio: aspect || 16 / 9 }">
        <img ref="image" :src="source" :style="style" alt="裁切预览" @load="loaded" />
      </div>
      <label
        >缩放<input
          v-model.number="zoom"
          type="range"
          min="1"
          max="3"
          step=".05"
          :disabled="pending"
      /></label>
      <div class="blog-form-row">
        <label
          >水平位置<input
            v-model.number="x"
            type="range"
            min="0"
            max="100"
            :disabled="pending" /></label
        ><label
          >垂直位置<input v-model.number="y" type="range" min="0" max="100" :disabled="pending"
        /></label>
      </div>
      <div class="blog-image-toolbar">
        <button type="button" class="blog-button primary" :disabled="pending" @click="save">
          {{ pending ? '正在上传…' : '裁切并上传' }}</button
        ><button type="button" class="blog-button" :disabled="pending" @click="clear">
          取消裁切
        </button>
      </div>
    </div>
    <p v-if="pending" class="blog-media-selected" role="status">正在处理并上传图片，请稍候…</p>
    <p v-else-if="value && !source" class="blog-media-selected" role="status">已选择图片</p>
    <p v-if="error" class="blog-alert error" role="alert">{{ error }}</p>
  </div>
</template>
