<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { blogAttachmentPath, type BlogWorkbench } from '../../blog-workbench';
import BlogImageEditor from './BlogImageEditor.vue';
const props = defineProps<{
  model: BlogWorkbench;
  postId: string;
  noteId: string;
  notePath?: string;
  value: string | null;
}>();
const emit = defineEmits<{ change: [postId: string, value: string | null] }>();
const assets = ref<{ id: string; relativePath: string; mime: string; markdownPath?: string }[]>([]),
  loading = ref(false),
  error = ref(''),
  opened = ref(false);
let generation = 0;
watch(
  () => props.noteId,
  () => {
    ++generation;
    assets.value = [];
    opened.value = false;
    loading.value = false;
    error.value = '';
  },
);
const images = computed(() =>
  assets.value.filter((asset) =>
    ['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(asset.mime),
  ),
);
async function load() {
  const current = ++generation;
  loading.value = true;
  error.value = '';
  opened.value = true;
  try {
    const result = await props.model.noteAssets(props.noteId);
    if (current === generation) assets.value = result;
  } catch (cause) {
    if (current === generation)
      error.value = cause instanceof Error ? cause.message : String(cause);
  } finally {
    if (current === generation) loading.value = false;
  }
}
function relative(path: string) {
  return blogAttachmentPath(props.notePath || '', path);
}
async function upload(file: File) {
  const id = props.noteId,
    result = await props.model.uploadCover(id, file);
  if (props.noteId !== id) throw Error('文章已切换，请返回原文章选择刚上传的封面。');
  return result.markdownPath;
}
</script>
<template>
  <div class="blog-cover-picker">
    <BlogImageEditor
      label="上传并裁切封面"
      :value="value || ''"
      :aspect="16 / 9"
      :upload="upload"
      @change="emit('change', postId, $event || null)"
    /><button type="button" class="blog-text-button" :disabled="loading" @click="load">
      {{ loading ? '正在读取附件…' : '从原稿附件中选择封面' }}
    </button>
    <p v-if="error" class="blog-alert error" role="alert">{{ error }}</p>
    <div v-if="opened" class="blog-cover-assets">
      <p v-if="!loading && !images.length" class="blog-muted">
        这篇笔记还没有图片附件，可在上方上传。
      </p>
      <button
        v-for="asset in images"
        :key="asset.id"
        type="button"
        :aria-label="'选择封面 ' + asset.relativePath"
        :aria-pressed="value === (asset.markdownPath || relative(asset.relativePath))"
        @click="emit('change', postId, asset.markdownPath || relative(asset.relativePath))"
      >
        <img :src="'/api/assets/' + encodeURIComponent(asset.id)" alt="" loading="lazy" /><span>{{
          asset.relativePath.split('/').at(-1)
        }}</span>
      </button>
    </div>
  </div>
</template>
