<script setup lang="ts">
import { ref, watch } from 'vue';
import { NButton, NAlert } from 'naive-ui';
import { api, ApiError } from '../api';
import type { TreeEntry } from '../../../shared/contracts';
const emit = defineEmits<{ busy: [value: boolean] }>();
const file = ref<File>(),
  busy = ref(false),
  error = ref(''),
  imported = ref('');
watch(busy, (value) => emit('busy', value));
let requestId = crypto.randomUUID();
function select(event: Event) {
  file.value = (event.target as HTMLInputElement).files?.[0];
  requestId = crypto.randomUUID();
  error.value = '';
  imported.value = '';
}
async function upload() {
  const source = file.value;
  if (!source) return;
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
    if (!tree.some((entry) => entry.type === 'folder' && entry.path === '40-Resources')) {
      try {
        await api('/api/folders', 'POST', { parent: '', name: '40-Resources' });
      } catch (e) {
        // Another import may have created the folder while this request was in flight.
        const current = await api<TreeEntry[]>('/api/tree');
        if (!current.some((entry) => entry.type === 'folder' && entry.path === '40-Resources'))
          throw e;
      }
    }
    await api('/api/notes', 'POST', {
      folderPath: '40-Resources',
      fileName: source.name,
      content,
      requestId,
    });
    imported.value = source.name;
    file.value = undefined;
  } catch (e) {
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
      从当前电脑或手机选择一个 Markdown
      文件，复制到知识库的“40-Resources”资料文件夹。原文件保持不变，不会覆盖同名资料。
    </p>
    <label
      >选择 Markdown 文件<input
        type="file"
        accept=".md,text/markdown"
        :disabled="busy"
        aria-label="选择 Markdown 文件"
        @change="select"
    /></label>
    <p class="hint">单个文件不超过 256 KiB。文中的图片和附件不会随文件一起导入。</p>
    <NButton :loading="busy" :disabled="!file || busy" @click="upload">确认导入</NButton>
    <NAlert v-if="error" type="error" role="alert">{{ error }}</NAlert>
    <p v-if="imported" role="status">{{ imported }} 已导入，进入工作区后可以查看。</p>
  </div>
</template>
<style scoped>
p {
  line-height: 1.8;
}
label {
  display: block;
  font-weight: 500;
  margin: 14px 0;
}
input {
  display: block;
  margin-top: 10px;
  max-width: 100%;
  font-size: 14px;
}
.hint {
  font-size: 12px;
  color: #5c6e83;
}
.n-alert {
  margin-top: 12px;
}
[role='status'] {
  color: #26784e;
}
</style>
