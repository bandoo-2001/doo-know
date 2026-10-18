<script setup lang="ts">
import { ref, watch } from 'vue';
import { Button as AButton, Alert as AAlert } from 'ant-design-vue';
import { api, ApiError } from '../api';
import type { TreeEntry } from '../../../shared/contracts';
const props = defineProps<{ destination?: string }>();
const emit = defineEmits<{
  busy: [value: boolean];
  imported: [value: { id: string; relativePath: string }];
}>();
const file = ref<File>(),
  fileInput = ref<HTMLInputElement>(),
  busy = ref(false),
  error = ref(''),
  imported = ref('');
watch(busy, (value) => emit('busy', value));
let requestId = crypto.randomUUID();
watch(
  () => props.destination,
  () => {
    requestId = crypto.randomUUID();
    error.value = '';
    imported.value = '';
  },
);
function select(event: Event) {
  file.value = (event.target as HTMLInputElement).files?.[0];
  requestId = crypto.randomUUID();
  error.value = '';
  imported.value = '';
}
async function upload() {
  const source = file.value;
  if (!source || busy.value) return;
  error.value = '';
  imported.value = '';
  if (!source.name.toLowerCase().endsWith('.md')) {
    error.value = '请选择 Markdown 文件（文件名以 .md 结尾）。';
    return;
  }
  if (source.size > 256 * 1024) {
    error.value = '这个入口支持不超过 256 KiB 的文件。较大的资料可稍后放入知识库文件夹。';
    return;
  }
  busy.value = true;
  try {
    let content: string;
    try {
      content = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(
        await source.arrayBuffer(),
      );
    } catch {
      error.value = '无法读取这个文件的文字，请先将文件另存为 UTF-8 格式。原文件不会被修改。';
      return;
    }
    const tree = await api<TreeEntry[]>('/api/tree');
    const destination = props.destination ?? '40-Resources';
    if (
      destination === '40-Resources' &&
      !tree.some((entry) => entry.type === 'folder' && entry.path === '40-Resources')
    ) {
      try {
        await api('/api/folders', 'POST', { parent: '', name: '40-Resources' });
      } catch (e) {
        // Another import may have created the folder while this request was in flight.
        const current = await api<TreeEntry[]>('/api/tree');
        if (!current.some((entry) => entry.type === 'folder' && entry.path === '40-Resources'))
          throw e;
      }
    }
    const created = await api('/api/notes', 'POST', {
      folderPath: destination,
      fileName: source.name,
      content,
      requestId,
    });
    imported.value = source.name;
    emit('imported', { id: created.id, relativePath: created.relativePath });
    file.value = undefined;
    if (fileInput.value) fileInput.value.value = '';
  } catch (e) {
    if (e instanceof ApiError && e.status >= 400 && e.status < 500) requestId = crypto.randomUUID();
    error.value =
      e instanceof ApiError && (e.status === 409 || String(e.message).includes('存在'))
        ? '已有同名文件，没有覆盖。请修改文件名后重新选择。'
        : '暂时没能导入。请检查连接后重试，原文件不会被修改。';
  } finally {
    busy.value = false;
  }
}
</script>
<template>
  <div class="setup-import">
    <p>
      从当前电脑或手机选择一个 Markdown 文件，复制到{{
        props.destination === undefined
          ? '“40-Resources”资料文件夹'
          : props.destination || '知识库根目录'
      }}。原文件保持不变，不会覆盖同名资料。
    </p>
    <label
      >选择 Markdown 文件<input
        ref="fileInput"
        type="file"
        accept=".md,text/markdown"
        :disabled="busy"
        aria-label="选择 Markdown 文件"
        aria-describedby="import-limits"
        @change="select"
    /></label>
    <p id="import-limits" class="hint">
      单个文件不超过 256 KiB。文中的图片和附件不会随文件一起导入。
    </p>
    <p v-if="file" class="import-selection">
      已选择 {{ file.name }} · {{ (file.size / 1024).toFixed(1) }} KiB
    </p>
    <AButton :loading="busy" :disabled="!file || busy" @click="upload">确认导入</AButton>
    <AAlert v-if="error" type="error" show-icon role="alert" :message="error" />
    <AAlert
      v-if="imported"
      type="success"
      show-icon
      role="status"
      :message="`${imported} 已导入，进入工作区后可以查看。`"
    />
  </div>
</template>
<style scoped>
.setup-import {
  min-width: 0;
  padding-top: 2px;
  color: #6c7482;
  font-size: 13px;
}
p {
  margin: 12px 0;
  line-height: 1.85;
  overflow-wrap: anywhere;
}
label {
  display: block;
  margin: 16px 0 12px;
  padding: 16px;
  border: 1px dashed #d5dbe6;
  border-radius: 7px;
  background: var(--surface-soft, #fafbfc);
  color: var(--text, #262b36);
  font-size: 13px;
  font-weight: 500;
}
label:focus-within {
  outline: 2px solid var(--focus, #4566c6);
  outline-offset: 2px;
}
input {
  display: block;
  width: 100%;
  min-width: 0;
  margin-top: 12px;
  color: #6c7482;
  font-size: 12px;
}
input::file-selector-button {
  margin-right: 10px;
  padding: 7px 10px;
  border: 1px solid var(--border, #e3e6ec);
  border-radius: 5px;
  background: white;
  color: var(--text, #262b36);
  font: inherit;
  cursor: pointer;
}
input:disabled::file-selector-button {
  cursor: default;
  opacity: 0.6;
}
.hint {
  margin-bottom: 16px;
  color: var(--muted, #7a8190);
  font-size: 12px;
}
.ant-alert {
  margin-top: 14px;
  overflow-wrap: anywhere;
}
@media (max-width: 600px) {
  label {
    padding: 13px;
  }
}
</style>
