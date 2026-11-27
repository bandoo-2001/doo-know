<script setup lang="ts">
import { Alert as AAlert, Button as AButton, Spin as ASpin } from 'ant-design-vue';
import {
  computed,
  defineAsyncComponent,
  nextTick,
  onBeforeUnmount,
  onErrorCaptured,
  onMounted,
  ref,
  shallowRef,
  type Component,
} from 'vue';
import { api } from '../api';
import type { FileCommandDetail } from 'ooxml-core/embedding';
import type { OfficeDocument } from '../../../shared/office';
import Icon from './Icon.vue';

type Editor = {
  load(bytes: ArrayBuffer, name?: string): Promise<void>;
  save(): Promise<Blob>;
  markClean(): void;
  readonly element?: { commitEdit?(): boolean };
};
const props = defineProps<{ doc: OfficeDocument }>();
const emit = defineEmits<{ close: []; saved: [doc: OfficeDocument] }>();
const OfficeSlides = defineAsyncComponent(() => import('./OfficeSlides.vue'));
const OfficePdf = defineAsyncComponent(() => import('./OfficePdf.vue'));
const root = `/api/office/documents/${encodeURIComponent(props.doc.id)}`;
const editable = props.doc.fileType === 'docx' || props.doc.fileType === 'xlsx';
const component = shallowRef<Component>();
const editor = shallowRef<Editor>();
const bytes = shallowRef<ArrayBuffer>();
const editing = ref(false);
const loading = ref(true);
const saving = ref(false);
const dirty = ref(false);
const loadError = ref('');
const saveError = ref('');
const warning = ref('');
const notice = ref('');
const controller = new AbortController();
let version = '';
let disposed = false;
let editSequence = 0;
const customization = computed(() => ({
  capabilities: { edit: editing.value, open: false, share: false, settings: false },
  ribbon: { hiddenTabs: ['file'] },
}));

function errorText(error: unknown, fallback: string) {
  return error instanceof Error
    ? error.message
    : typeof error === 'string' && error
      ? error
      : fallback;
}
function failed(error: unknown) {
  if (disposed) return;
  loading.value = false;
  loadError.value = errorText(error, '文件暂时无法预览，可以下载原件');
}
async function open() {
  try {
    const response = await fetch(root + '/download', {
      cache: 'no-store',
      signal: controller.signal,
    });
    if (!response.ok)
      throw new Error((await response.json().catch(() => ({}))).error || '无法读取文件');
    version = response.headers.get('etag') ?? '';
    const content = await response.arrayBuffer();
    if (disposed) return;
    if (!editable) {
      bytes.value = content;
      return;
    }
    component.value =
      props.doc.fileType === 'docx'
        ? (await import('docx-vue-viewer')).WordEditor
        : (await import('xlsx-vue-viewer')).SpreadsheetEditor;
    await nextTick();
    if (disposed || !editor.value) return;
    await editor.value.load(content, props.doc.name);
    loading.value = false;
  } catch (error) {
    failed(error);
  }
}
function requestLeave() {
  if (saving.value) return false;
  return !dirty.value || window.confirm('修改尚未保存，确定离开吗？');
}
function changed() {
  if (!editing.value) return;
  editSequence++;
  dirty.value = true;
  notice.value = '';
}
async function save() {
  const current = editor.value;
  if (!current || saving.value || !editing.value) return;
  saving.value = true;
  saveError.value = notice.value = '';
  try {
    if (current.element?.commitEdit?.() === false) throw new Error('请先修正当前单元格的值');
    await nextTick();
    const sequence = editSequence;
    const blob = await current.save();
    const body = new FormData();
    body.append('file', blob, props.doc.name);
    const result = await api<{ document: OfficeDocument; version: string }>(root, 'PUT', body, {
      ifMatch: version,
      timeoutMs: 60_000,
    });
    if (disposed) return;
    version = result.version;
    emit('saved', result.document);
    if (sequence === editSequence) {
      current.markClean();
      dirty.value = false;
      notice.value = '已保存到知识库';
    }
  } catch (error) {
    if (!disposed) saveError.value = errorText(error, '保存失败，修改仍在当前窗口');
  } finally {
    if (!disposed) saving.value = false;
  }
}
async function downloadCopy() {
  if (!editor.value) return;
  try {
    const blob = await editor.value.save();
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = props.doc.name.replace(/(\.[^.]+)$/, '（修改副本）$1');
    link.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 30_000);
  } catch (error) {
    saveError.value = errorText(error, '无法导出修改副本');
  }
}
function fileCommand(event: CustomEvent<FileCommandDetail>) {
  const command = event.detail.command;
  if (['new', 'open', 'save', 'saveAs'].includes(command)) event.preventDefault();
  if (!editing.value || saving.value) return;
  if (command === 'save') void save();
  if (command === 'saveAs') void downloadCopy();
}
function editorError(error: unknown) {
  if (loading.value) failed(error);
  else saveError.value = errorText(error, '编辑操作未完成');
}
function editorWarning(messages: string | string[]) {
  warning.value = Array.isArray(messages) ? messages.join(' · ') : messages;
}
defineExpose({ hasUnsavedChanges: () => dirty.value || saving.value, requestLeave, save });
onErrorCaptured((error) => {
  editorError(error);
  return false;
});
onMounted(open);
onBeforeUnmount(() => {
  disposed = true;
  controller.abort();
});
</script>

<template>
  <section class="office-open" :aria-label="doc.name">
    <header>
      <AButton :disabled="saving" @click="emit('close')"
        ><Icon name="back" :size="15" /> 返回目录</AButton
      >
      <h1>{{ doc.name }}</h1>
      <span v-if="dirty" class="office-status" role="status">有未保存的修改</span>
      <AButton v-if="editable && !editing && !loadError" :disabled="loading" @click="editing = true"
        >编辑</AButton
      >
      <AButton v-if="editing" type="primary" :loading="saving" @click="save">保存到知识库</AButton>
      <AButton v-if="editing && !dirty && !saving" @click="editing = false">返回预览</AButton>
      <AButton v-if="saveError && dirty" @click="downloadCopy">下载修改副本</AButton>
      <AButton :href="root + '/download'">下载原件</AButton>
    </header>
    <p v-if="notice" class="office-status" role="status">{{ notice }}</p>
    <AAlert v-if="warning" type="warning" :message="warning" show-icon />
    <AAlert
      v-if="loadError || saveError"
      type="error"
      :message="loadError || saveError"
      show-icon
    />
    <div v-if="!loadError" class="office-surface" :inert="saving">
      <div v-if="loading" role="status" class="office-loading">
        <ASpin size="small" /> 正在打开文件
      </div>
      <component
        v-if="component"
        :is="component"
        ref="editor"
        class="office-content"
        :file-name="doc.name"
        locale="zh-CN"
        :read-only="!editing"
        :show-toolbar="editing"
        :customization="customization"
        @document-change="changed"
        @workbook-change="changed"
        @input.capture="changed"
        @document-warning="editorWarning"
        @workbook-warning="editorWarning"
        @dirty-change="dirty = Boolean($event)"
        @document-error="editorError"
        @workbook-error="editorError"
        @file-command="fileCommand"
      />
      <OfficeSlides
        v-else-if="doc.fileType === 'pptx' && bytes"
        :bytes="bytes"
        :name="doc.name"
        @ready="loading = false"
        @error="failed"
      />
      <OfficePdf
        v-else-if="doc.fileType === 'pdf' && bytes"
        :bytes="bytes"
        @ready="loading = false"
        @error="failed"
      />
    </div>
  </section>
</template>

<style scoped>
.office-open {
  display: flex;
  flex-direction: column;
  min-width: 0;
  padding: 12px;
  gap: 10px;
  color: var(--text);
}
.office-open header {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
}
.office-open h1 {
  flex: 1 1 170px;
  min-width: 0;
  overflow-wrap: anywhere;
  margin: 0;
  font-size: 20px;
}
.office-status {
  color: var(--muted);
  margin: 0;
  font-size: 13px;
}
.office-surface {
  position: relative;
  height: max(480px, calc(100dvh - 160px));
  border: 1px solid var(--border);
  border-radius: 8px;
  overflow: hidden;
  background: var(--panel);
}
.office-content {
  width: 100%;
  height: 100%;
}
.office-loading {
  position: absolute;
  inset: 0;
  z-index: 2;
  background: var(--panel);
  display: flex;
  justify-content: center;
  align-items: center;
  gap: 8px;
}
</style>
