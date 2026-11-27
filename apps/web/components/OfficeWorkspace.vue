<script setup lang="ts">
import { Alert as AAlert, Button as AButton } from 'ant-design-vue';
import { onBeforeUnmount, onMounted, ref } from 'vue';
import { api } from '../api';
import type { OfficeDocument } from '../office';
import OfficeFileView from './OfficeFileView.vue';
import Icon from './Icon.vue';

const emit = defineEmits<{ back: [] }>();
const apiRoot = '/api/office';
const fileExtensions = ['.docx', '.xlsx', '.pptx', '.pdf'];
const dates = new Intl.DateTimeFormat('zh-CN', { dateStyle: 'medium', timeStyle: 'medium' });
const documents = ref<OfficeDocument[]>([]);
const selected = ref<OfficeDocument>();
const fileView = ref<InstanceType<typeof OfficeFileView>>();
const uploadInput = ref<HTMLInputElement>();
const uploading = ref(false);
const loadingList = ref(true);
const pageError = ref('');
const notice = ref('');
let disposed = false;
let listAttempt = 0;
function message(error: unknown, fallback: string) {
  return error instanceof Error ? error.message : fallback;
}
function sizeLabel(bytes: number) {
  return bytes < 1024 ** 2
    ? `${Math.ceil(bytes / 1024)} KB`
    : `${(bytes / 1024 ** 2).toFixed(1)} MB`;
}
async function loadLibrary() {
  const attempt = ++listAttempt;
  loadingList.value = true;
  pageError.value = '';
  try {
    const result = await api<{ documents: OfficeDocument[] }>(apiRoot + '/documents');
    if (!disposed && listAttempt === attempt) documents.value = result.documents;
  } catch (error) {
    if (!disposed && listAttempt === attempt) pageError.value = message(error, '无法读取办公文档');
  } finally {
    if (!disposed && listAttempt === attempt) loadingList.value = false;
  }
}
async function upload(event: Event) {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  input.value = '';
  if (!file || uploading.value) return;
  notice.value = '';
  pageError.value = '';
  const fileName = file.name.toLowerCase();
  if (!fileExtensions.some((extension) => fileName.endsWith(extension))) {
    pageError.value = '请选择 .docx、.xlsx、.pptx 或 .pdf 文件';
    return;
  }
  uploading.value = true;
  try {
    const body = new FormData();
    body.append('file', file);
    const result = await api<OfficeDocument>(`${apiRoot}/documents`, 'POST', body, {
      timeoutMs: 60_000,
    });
    if (disposed) return;
    listAttempt++;
    loadingList.value = false;
    documents.value = [result, ...documents.value.filter((doc) => doc.id !== result.id)];
    notice.value = '文件已上传';
  } catch (error) {
    if (!disposed) pageError.value = message(error, '上传失败，请重试');
  } finally {
    if (!disposed) uploading.value = false;
  }
}

function updateDocument(doc: OfficeDocument) {
  listAttempt++;
  loadingList.value = false;
  documents.value = [doc, ...documents.value.filter((item) => item.id !== doc.id)];
  notice.value = '已保存到知识库';
}
defineExpose({
  hasUnsavedChanges: () => fileView.value?.hasUnsavedChanges() ?? false,
  requestLeave: () => fileView.value?.requestLeave() ?? true,
});
onMounted(loadLibrary);
onBeforeUnmount(() => {
  disposed = true;
});
</script>

<template>
  <OfficeFileView
    v-if="selected"
    :key="selected.id"
    ref="fileView"
    :doc="selected"
    @close="selected = undefined"
    @saved="updateDocument"
  />
  <section v-else class="office-workspace" aria-labelledby="office-title">
    <header class="office-header">
      <AButton @click="emit('back')"><Icon name="back" :size="15" /> 返回应用</AButton>
      <h1 id="office-title">办公文档</h1>
    </header>
    <div class="office-actions">
      <input
        ref="uploadInput"
        type="file"
        :accept="fileExtensions.join(',')"
        aria-label="上传文件"
        hidden
        @change="upload"
      />
      <AButton type="primary" :loading="uploading" @click="uploadInput?.click()"
        ><Icon name="upload" :size="15" /> 上传文件</AButton
      >
      <AButton :loading="loadingList" @click="loadLibrary"
        ><Icon name="refresh" :size="15" /> 刷新列表</AButton
      >
    </div>
    <AAlert v-if="pageError" type="error" :message="pageError" show-icon />
    <p v-if="notice" class="office-help" role="status">{{ notice }}</p>
    <p v-if="loadingList && !documents.length" class="office-empty" role="status">
      正在读取办公文档
    </p>
    <p v-else-if="!documents.length && !pageError" class="office-empty">
      上传 Word、Excel、PPT 或 PDF 文件即可打开。
    </p>
    <ul v-if="documents.length" class="office-library" aria-label="办公文档列表">
      <li v-for="doc in documents" :key="doc.id" class="office-file">
        <Icon name="file" :size="24" />
        <div class="office-file-info">
          <h2>{{ doc.name }}</h2>
          <p>
            {{ sizeLabel(doc.sizeBytes) }} · 更新于
            <time :datetime="doc.updatedAt">{{ dates.format(new Date(doc.updatedAt)) }}</time>
          </p>
        </div>
        <div class="office-file-actions">
          <AButton @click="selected = doc">打开</AButton>
          <AButton :href="`/api/office/documents/${doc.id}/download`" aria-label="下载原文件"
            >下载</AButton
          >
        </div>
      </li>
    </ul>
  </section>
</template>

<style scoped>
.office-workspace {
  display: flex;
  flex-direction: column;
  gap: 16px;
  min-width: 0;
  padding: 24px;
  color: var(--text);
  background: var(--panel);
}
.office-header,
.office-actions,
.office-file,
.office-file-actions {
  display: flex;
  align-items: center;
  gap: 10px;
}
.office-header,
.office-actions {
  flex-wrap: wrap;
}
.office-header h1 {
  min-width: 0;
  margin: 0;
  font-size: 22px;
  overflow-wrap: anywhere;
}
.office-help,
.office-empty {
  margin: 0;
  color: var(--muted);
}
.office-library {
  list-style: none;
  margin: 0;
  padding: 0;
  border: 1px solid var(--border);
  border-radius: var(--ui-radius, 8px);
}
.office-file {
  flex-wrap: wrap;
  min-width: 0;
  padding: 12px 14px;
}
.office-file + .office-file {
  border-top: 1px solid var(--border);
}
.office-file > svg {
  flex-shrink: 0;
  color: var(--blue);
}
.office-file-info {
  flex: 1 1 180px;
  min-width: 0;
  overflow-wrap: anywhere;
}
.office-file-info h2,
.office-file-info p {
  margin: 0;
  font-size: 14px;
}
.office-file-info p {
  color: var(--muted);
  font-size: 13px;
}
@media (max-width: 600px) {
  .office-workspace {
    padding: 12px;
  }
  .office-file-actions {
    width: 100%;
    justify-content: flex-end;
  }
}
</style>
