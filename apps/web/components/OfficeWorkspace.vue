<script setup lang="ts">
import { Alert as AAlert, Button as AButton, Spin as ASpin } from 'ant-design-vue';
import { nextTick, onBeforeUnmount, onMounted, ref, useId } from 'vue';
import { api } from '../api';
import { loadOfficeEditor, type OfficeEditor } from '../onlyoffice-editor';
import Icon from './Icon.vue';

type OfficeDocument = { id: string; name: string; sizeBytes: number; updatedAt: string };
type Session = { editorUrl: string; config: Record<string, unknown> };

const emit = defineEmits<{ back: [] }>();
const apiRoot = '/api/office';
const fileExtensions = ['.docx', '.xlsx', '.pptx', '.pdf'];
const placeholderId = `dooknow-office-editor-${useId()}`;
const dates = new Intl.DateTimeFormat('zh-CN', { dateStyle: 'medium', timeStyle: 'medium' });
const documents = ref<OfficeDocument[]>([]);
const enabled = ref<boolean>();
const selected = ref<OfficeDocument>();
const uploadInput = ref<HTMLInputElement>();
const editorTarget = ref<HTMLDivElement>();
const uploading = ref(false);
const loadingList = ref(true);
const loadingEditor = ref(false);
const checkingId = ref('');
const pageError = ref('');
const editorError = ref('');
const notice = ref('');
const localChanges = ref(false);
let editor: OfficeEditor | undefined;
let editorTimer = 0;
let edited = false;
let disposed = false;
let editorAttempt = 0;
let listAttempt = 0;

function suffix(id: string) {
  return `/documents/${encodeURIComponent(id)}`;
}

function message(error: unknown, fallback: string) {
  return error instanceof Error ? error.message : fallback;
}

function sizeLabel(bytes: number) {
  return bytes < 1024 ** 2
    ? `${Math.ceil(bytes / 1024)} KB`
    : `${(bytes / 1024 ** 2).toFixed(1)} MB`;
}

async function readDocuments() {
  const attempt = ++listAttempt;
  const result = await api<{ documents: OfficeDocument[] }>(`${apiRoot}/documents`);
  if (!disposed && attempt === listAttempt) documents.value = result.documents;
  return result.documents;
}

async function loadLibrary() {
  if (disposed) return;
  loadingList.value = true;
  pageError.value = '';
  try {
    const status = await api<{ enabled: boolean }>(`${apiRoot}/status`);
    if (disposed) return;
    enabled.value = status.enabled;
    if (status.enabled) await readDocuments();
  } catch (error) {
    if (!disposed) pageError.value = message(error, '无法读取办公文档');
  } finally {
    if (!disposed) loadingList.value = false;
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
    documents.value = [result, ...documents.value.filter((doc) => doc.id !== result.id)];
    notice.value = '文件已上传';
  } catch (error) {
    if (!disposed) pageError.value = message(error, '上传失败，请重试');
  } finally {
    if (!disposed) uploading.value = false;
  }
}

async function openDocument(doc: OfficeDocument) {
  if (selected.value || checkingId.value) return;
  const attempt = ++editorAttempt;
  const active = () => !disposed && attempt === editorAttempt;
  selected.value = doc;
  edited = false;
  localChanges.value = false;
  editorError.value = '';
  loadingEditor.value = true;
  notice.value = '';
  try {
    const { editorUrl, config } = await api<Session>(`${apiRoot}${suffix(doc.id)}/session`, 'POST');
    if (!active()) return;
    const Editor = await loadOfficeEditor(editorUrl);
    if (!active()) return;
    await nextTick();
    if (!active() || !editorTarget.value) return;
    function showError(text: string) {
      if (!active()) return;
      window.clearTimeout(editorTimer);
      loadingEditor.value = false;
      editorError.value = text;
    }
    editorTimer = window.setTimeout(
      () => showError('编辑器加载超时，请返回文档列表后重试'),
      45_000,
    );
    editor = new Editor(placeholderId, {
      ...config,
      width: '100%',
      height: '100%',
      events: {
        onDocumentReady() {
          if (!active()) return;
          window.clearTimeout(editorTimer);
          loadingEditor.value = false;
          editorError.value = '';
        },
        onDocumentStateChange(event: { data: boolean }) {
          if (!active()) return;
          localChanges.value = event.data === true;
          if (localChanges.value) edited = true;
        },
        onRequestClose() {
          if (active()) closeEditor();
        },
        onRequestRefreshFile() {
          showError('文档版本已更新，请返回文档列表后重新打开');
        },
        onError(event: { data?: { errorCode?: number } }) {
          const code = event.data?.errorCode;
          showError(`ONLYOFFICE 编辑器发生错误${Number.isInteger(code) ? `（${code}）` : ''}`);
        },
      },
    });
  } catch (error) {
    if (!active()) return;
    window.clearTimeout(editorTimer);
    editorError.value = message(error, '无法打开编辑器');
    loadingEditor.value = false;
  }
}

function disposeEditor() {
  editorAttempt++;
  window.clearTimeout(editorTimer);
  editor?.destroyEditor();
  editor = undefined;
  localChanges.value = false;
}

async function checkWriteback(doc: OfficeDocument) {
  checkingId.value = doc.id;
  try {
    const until = Date.now() + 22_000;
    do {
      const latest = (await readDocuments()).find((item) => item.id === doc.id);
      if (disposed) return;
      if (latest && latest.updatedAt !== doc.updatedAt) {
        notice.value = '原文件更新时间已刷新';
        return;
      }
      if (Date.now() >= until) break;
      await new Promise<void>((resolve) => window.setTimeout(resolve, 1000));
    } while (!disposed);
    if (!disposed) notice.value = '暂未观察到文件更新，可以刷新列表核对';
  } catch (error) {
    if (!disposed) pageError.value = message(error, '无法核对原文件是否更新');
  } finally {
    if (!disposed) checkingId.value = '';
  }
}

function closeEditor() {
  const doc = selected.value;
  disposeEditor();
  selected.value = undefined;
  if (doc && edited) void checkWriteback(doc);
}

function requestEditorClose() {
  if (editor && !loadingEditor.value && !editorError.value) editor.requestClose();
  else if (confirmLeave()) closeEditor();
}

function confirmLeave() {
  return !localChanges.value || window.confirm('编辑器仍有未提交的修改。确定要离开吗？');
}

defineExpose({
  hasUnsavedChanges: () => localChanges.value,
  requestLeave: confirmLeave,
});

onMounted(loadLibrary);
onBeforeUnmount(() => {
  disposed = true;
  disposeEditor();
});
</script>

<template>
  <section
    class="office-workspace"
    :class="{ 'office-editing': selected }"
    aria-labelledby="office-title"
  >
    <header class="office-header">
      <AButton v-if="selected" @click="requestEditorClose">
        <Icon name="back" :size="15" /> 返回文档列表
      </AButton>
      <AButton v-else @click="emit('back')"><Icon name="back" :size="15" /> 返回应用</AButton>
      <h1 id="office-title">{{ selected?.name ?? '办公文档' }}</h1>
      <p v-if="selected && !editorError && !loadingEditor" class="office-help">
        使用编辑器中的保存按钮将修改写回原文件。
      </p>
    </header>

    <template v-if="selected">
      <AAlert v-if="editorError" type="error" :message="editorError" show-icon />
      <div class="office-editor">
        <div v-if="loadingEditor" class="office-loading" role="status" aria-live="polite">
          <ASpin size="small" /> 正在打开编辑器
        </div>
        <div :id="placeholderId" ref="editorTarget"></div>
      </div>
    </template>

    <template v-else>
      <div v-if="enabled || pageError" class="office-actions">
        <template v-if="enabled">
          <input
            ref="uploadInput"
            type="file"
            :accept="fileExtensions.join(',')"
            aria-label="上传文件"
            hidden
            @change="upload"
          />
          <AButton type="primary" :loading="uploading" @click="uploadInput?.click()">
            <Icon name="upload" :size="15" /> 上传文件
          </AButton>
        </template>
        <AButton :loading="loadingList" @click="loadLibrary">
          <Icon name="refresh" :size="15" /> 刷新列表
        </AButton>
      </div>
      <AAlert v-if="pageError" type="error" :message="pageError" show-icon />
      <p v-if="notice || checkingId" class="office-help" role="status">
        {{ checkingId ? '正在核对原文件是否更新' : notice }}
      </p>
      <p v-if="enabled === false && !pageError" class="office-empty">
        当前实例尚未启用 ONLYOFFICE。
      </p>
      <p v-else-if="loadingList && !documents.length" class="office-empty" role="status">
        正在读取办公文档
      </p>
      <p v-else-if="enabled && !documents.length && !pageError" class="office-empty">
        上传一个 .docx、.xlsx、.pptx 或 .pdf 文件开始编辑。
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
            <AButton :disabled="!!checkingId" @click="openDocument(doc)">打开编辑</AButton>
            <AButton :href="`${apiRoot}${suffix(doc.id)}/download`" aria-label="下载原文件"
              >下载</AButton
            >
          </div>
        </li>
      </ul>
    </template>
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
.office-editing {
  gap: 8px;
  padding: 12px;
}
.office-editor {
  flex: 1;
  position: relative;
  min-height: max(500px, calc(100dvh - 175px));
  border: 1px solid var(--border);
  border-radius: var(--ui-radius, 8px);
  overflow: hidden;
}
.office-editor :deep(iframe) {
  position: absolute;
  inset: 0;
  border: 0;
}
.office-loading {
  position: absolute;
  z-index: 1;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  background: var(--panel);
}
@media (max-width: 600px) {
  .office-workspace {
    padding: 12px;
  }
  .office-file-actions {
    justify-content: flex-end;
    width: 100%;
  }
}
</style>
