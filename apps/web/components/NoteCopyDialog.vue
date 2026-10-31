<script setup lang="ts">
import { ref, watch } from 'vue';
import { NModal } from 'naive-ui';
import { Button as AButton, Input as AInput, Alert as AAlert } from 'ant-design-vue';
import DirectoryTreeSelect from './DirectoryTreeSelect.vue';
import { api } from '../api';
import type { NoteInfo } from '../../../shared/knowledge-contracts';
import { fileBaseline } from '../diagrams/file-baseline';
import { withOperationPreviews } from '../diagrams/operation-previews';
const props = defineProps<{
  show: boolean;
  noteId?: string;
  relativePath?: string;
  folders: { label: string; value: string }[];
}>();
const emit = defineEmits<{
  'update:show': [value: boolean];
  copied: [result: { id: string; relativePath: string }];
}>();
const folder = ref(''),
  name = ref(''),
  busy = ref(false),
  loading = ref(false),
  error = ref('');
let baseline: NoteInfo | undefined,
  requestId = crypto.randomUUID(),
  generation = 0;
watch([folder, name], () => {
  requestId = crypto.randomUUID();
  error.value = '';
});
watch(
  () => [props.show, props.noteId] as const,
  async ([shown, id]) => {
    const current = ++generation;
    baseline = undefined;
    error.value = '';
    if (!shown || !id) return;
    loading.value = true;
    requestId = crypto.randomUUID();
    try {
      const meta = await fileBaseline(id, () => current === generation);
      if (!meta || current !== generation) return;
      baseline = meta;
      folder.value = meta.relativePath.includes('/')
        ? meta.relativePath.slice(0, meta.relativePath.lastIndexOf('/'))
        : '';
      name.value =
        meta.relativePath
          .split('/')
          .at(-1)!
          .replace(/\.(?:md|excalidraw)$/i, '') + '-副本.md';
    } catch (cause) {
      if (current === generation) error.value = (cause as Error).message;
    } finally {
      if (current === generation) loading.value = false;
    }
  },
);
async function copy() {
  if (busy.value || !baseline || !name.value.trim()) return;
  busy.value = true;
  error.value = '';
  const input = {
    folderPath: folder.value,
    fileName: /\.md$/i.test(name.value) ? name.value : name.value + '.md',
    expectedModifiedAt: baseline.modifiedAt,
    expectedContentHash: baseline.contentHash!,
    requestId,
  };
  try {
    const result = await withOperationPreviews(() =>
      api<{ id: string; relativePath: string }>(
        '/api/notes/' + encodeURIComponent(baseline!.id) + '/copy',
        'POST',
        input,
      ),
    );
    emit('update:show', false);
    emit('copied', result);
  } catch (cause) {
    error.value = (cause as Error).message;
  } finally {
    busy.value = false;
  }
}
</script>
<template>
  <NModal
    :show="show"
    preset="card"
    class="dialog-card"
    title="创建文档副本"
    aria-label="创建文档副本"
    :mask-closable="!busy"
    :close-on-esc="!busy"
    :closable="!busy"
    @update:show="emit('update:show', $event)"
  >
    <p class="muted">复制已保存的版本，分配新的文档身份。当前未保存的草稿仍保留。</p>
    <AAlert v-if="error" type="error" :message="error" role="alert" />
    <p v-if="loading" role="status">正在核对原文版本…</p>
    <form @submit.prevent="copy">
      <label>副本目录</label
      ><DirectoryTreeSelect
        v-model:value="folder"
        :folders="folders"
        label="副本目录"
        :disabled="busy || loading"
      />
      <label for="copy-document-name">副本文件名</label
      ><AInput id="copy-document-name" v-model:value="name" :disabled="busy || loading" />
      <div class="dialog-actions">
        <AButton :disabled="busy" @click="emit('update:show', false)">取消</AButton
        ><AButton
          type="primary"
          html-type="submit"
          :loading="busy"
          :disabled="busy || loading || !baseline || !name.trim()"
          >创建副本</AButton
        >
      </div>
    </form>
  </NModal>
</template>
