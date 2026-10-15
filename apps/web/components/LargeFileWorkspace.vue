<script setup lang="ts">
import { ref, computed, watch, onBeforeUnmount } from 'vue';
import { NButton, NAlert, NModal } from 'naive-ui';
import type {
  NoteInfo,
  ReadPage,
  FileReply,
  FileOperation,
  OutlinePage,
} from '../../../shared/knowledge-contracts';
import { api, ApiError } from '../api';
import MarkdownEditor from './MarkdownEditor.vue';
import NoteOutline from './NoteOutline.vue';
import OperationStatus from './OperationStatus.vue';
import MarkdownIt from 'markdown-it';
import DOMPurify from 'dompurify';
const props = defineProps<{
  note: NoteInfo;
  initialLine?: number;
  assets?: { id: string; relativePath: string }[];
}>();
const emit = defineEmits<{ saved: [note: NoteInfo]; dirty: [value: boolean] }>();
const page = ref<ReadPage>(),
  outline = ref<OutlinePage>(),
  draft = ref(''),
  original = ref(''),
  operation = ref<FileOperation>(),
  error = ref(''),
  notice = ref(''),
  busy = ref(false),
  leaveOpen = ref(false);
const previewOpen = ref(false);
const previewAllowed = computed(() => new TextEncoder().encode(draft.value).length <= 128 * 1024);
const previewHtml = computed(() => {
  if (!previewOpen.value || !previewAllowed.value) return '';
  const md = new MarkdownIt({ html: false, linkify: true });
  const tokens = md.parse(draft.value, {});
  const visit = (items: typeof tokens) => {
    for (const token of items) {
      if (token.type === 'image' || token.type === 'link_open') {
        const attr = token.type === 'image' ? 'src' : 'href',
          url = String(token.attrGet(attr) || '');
        let mapped: string | undefined;
        try {
          const resolved = new URL(url, new URL(props.note.relativePath, 'https://local.invalid/'));
          if (
            !url.startsWith('/') &&
            !url.includes('\\') &&
            !/^[a-z][a-z0-9+.-]*:/i.test(url) &&
            !url.startsWith('#') &&
            resolved.origin === 'https://local.invalid'
          ) {
            const asset = props.assets?.find(
              (a) => a.relativePath === decodeURIComponent(resolved.pathname.slice(1)),
            );
            if (asset) mapped = '/api/assets/' + encodeURIComponent(asset.id);
          }
        } catch {}
        if (mapped) token.attrSet(attr, mapped);
        else if (token.type === 'link_open' && /^https?:\/\//i.test(url)) {
          token.attrSet('target', '_blank');
          token.attrSet('rel', 'noopener noreferrer');
        } else if (!(token.type === 'link_open' && url.startsWith('#'))) token.attrSet(attr, '');
      }
      if (token.children) visit(token.children);
    }
  };
  visit(tokens);
  return DOMPurify.sanitize(md.renderer.render(tokens, md.options, {}));
});
const dirty = computed(() => draft.value !== original.value);
watch(dirty, (v) => emit('dirty', v));
let epoch = 0,
  requestId = '',
  submittedDraft = '',
  submittedNoteId = '',
  submittedPatch: Record<string, unknown> | undefined,
  renderEpoch = 0,
  pending: (() => Promise<void>) | undefined;
async function wait(op: FileOperation, current: number) {
  operation.value = op;
  while (['queued', 'running', 'committing'].includes(operation.value.status)) {
    await new Promise((r) => setTimeout(r, 1000));
    if (current !== epoch) throw new Error('页面已切换');
    operation.value = await api<FileOperation>(`/api/operations/${op.operationId}`);
  }
  if (operation.value.kind === 'patch' && ['failed', 'cancelled'].includes(operation.value.status))
    requestId = '';
  if (operation.value.status !== 'succeeded')
    throw new Error(
      operation.value.status === 'needs_reconciliation'
        ? '保存结果需要核对，请保留草稿'
        : operation.value.status === 'cancelled'
          ? '任务已取消'
          : '处理失败，请保留草稿',
    );
  return operation.value;
}
async function load(input: Record<string, unknown> = {}) {
  const current = epoch;
  busy.value = true;
  error.value = '';
  try {
    let r = await api<FileReply<ReadPage>>(`/api/notes/${props.note.id}/read`, 'POST', {
      maxBytes: 128 * 1024,
      ...input,
    });
    if (r.kind === 'accepted') {
      await wait(r.operation, current);
      r = await api(`/api/notes/${props.note.id}/read`, 'POST', { maxBytes: 128 * 1024, ...input });
    }
    if (current !== epoch) return;
    if (r.kind !== 'ready') throw new Error('正文仍在准备');
    page.value = r.data;
    renderEpoch++;
    draft.value = r.data.content;
    original.value = r.data.content;
  } catch (e) {
    if (current === epoch) error.value = (e as Error).message;
  } finally {
    if (current === epoch) busy.value = false;
  }
}
async function loadOutline(cursor?: string) {
  try {
    const r = await api<FileReply<OutlinePage>>(
      `/api/notes/${props.note.id}/outline${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ''}`,
    );
    if (r.kind === 'ready') outline.value = r.data;
  } catch {}
}
async function save() {
  if (!page.value || busy.value) return;
  if (requestId) {
    await check();
    return;
  }
  const current = epoch;
  busy.value = true;
  error.value = '';
  notice.value = '';
  try {
    if (new TextEncoder().encode(draft.value).length > 128 * 1024)
      throw new Error('片段超过 128 KiB，请分次修改');
    const nextRequestId = crypto.randomUUID();
    const p = page.value;
    submittedDraft = draft.value;
    const payload = {
      snapshotId: p.snapshotId,
      expectedModifiedAt: p.modifiedAt,
      expectedContentHash: p.sourceHash,
      requestId: nextRequestId,
      edits: [
        {
          type: 'replace_range',
          startByte: p.startByte,
          endByte: p.endByte,
          expectedRangeHash: p.rangeHash,
          insert: draft.value,
        },
      ],
    };
    if (new TextEncoder().encode(JSON.stringify(payload)).length > 512 * 1024)
      throw new Error('修改请求过大，请分次修改');
    requestId = nextRequestId;
    submittedNoteId = props.note.id;
    submittedPatch = payload;
    const r = await api<FileReply<unknown>>(`/api/notes/${props.note.id}/patch`, 'POST', payload);
    if (r.kind === 'accepted') await wait(r.operation, current);
    if (current !== epoch) return;
    original.value = draft.value;
    requestId = '';
    submittedPatch = undefined;
    notice.value = '片段已保存';
    emit('saved', await api<NoteInfo>(`/api/notes/${props.note.id}/meta`));
    busy.value = false;
    await load({ range: { startLine: p.startLine, lineByteOffset: p.lineByteOffset } });
    await loadOutline();
  } catch (e) {
    if (e instanceof ApiError && e.status >= 400 && e.status < 500) requestId = '';
    if (current === epoch) error.value = (e as Error).message;
  } finally {
    if (current === epoch) busy.value = false;
  }
}
async function check() {
  if (!requestId) return;
  const current = epoch,
    noteId = submittedNoteId || props.note.id;
  busy.value = true;
  error.value = '';
  try {
    let op: FileOperation;
    try {
      op = await api<FileOperation>(`/api/operations?requestId=${encodeURIComponent(requestId)}`);
    } catch (e) {
      if (!(e instanceof ApiError) || e.status !== 404 || !submittedPatch || current !== epoch)
        throw e;
      const retry = await api<FileReply<unknown>>(
        `/api/notes/${noteId}/patch`,
        'POST',
        submittedPatch,
      );
      if (retry.kind !== 'accepted') throw new Error('保存状态尚未确认，请保留草稿');
      op = retry.operation;
    }
    await wait(op, current);
    if (current !== epoch) return;
    original.value = submittedDraft;
    requestId = '';
    submittedPatch = undefined;
    notice.value = '片段已保存';
    emit('saved', await api<NoteInfo>(`/api/notes/${props.note.id}/meta`));
    const p = page.value;
    await load(p ? { range: { startLine: p.startLine, lineByteOffset: p.lineByteOffset } } : {});
  } catch (e) {
    error.value = (e as Error).message;
  } finally {
    busy.value = false;
  }
}
async function cancel() {
  if (operation.value)
    operation.value = await api(
      `/api/operations/${operation.value.operationId}/cancel`,
      'POST',
      {},
    );
}
async function navigate(fn: () => Promise<void>) {
  if (dirty.value) {
    pending = fn;
    leaveOpen.value = true;
  } else await fn();
}
async function leave(action: 'save' | 'discard' | 'cancel') {
  if (action === 'cancel') {
    leaveOpen.value = false;
    pending = undefined;
    return;
  }
  if (action === 'save') {
    await save();
    if (dirty.value) return;
  } else draft.value = original.value;
  leaveOpen.value = false;
  const fn = pending;
  pending = undefined;
  if (fn) await fn();
}
function applyChanges(edits: { from: number; to: number; insert: string }[]) {
  let value = draft.value;
  for (const e of [...edits].reverse())
    value = value.slice(0, e.from) + e.insert + value.slice(e.to);
  draft.value = value;
}
function discard() {
  draft.value = original.value;
}
watch(
  () => props.note.id,
  async () => {
    epoch++;
    draft.value = '';
    original.value = '';
    page.value = undefined;
    operation.value = undefined;
    outline.value = undefined;
    requestId = '';
    submittedPatch = undefined;
    submittedNoteId = '';
    previewOpen.value = false;
    if (props.note.editorMode !== 'metadata') {
      await load(props.initialLine ? { range: { startLine: props.initialLine } } : {});
      await loadOutline();
    }
  },
  { immediate: true },
);
onBeforeUnmount(() => epoch++);
async function reload() {
  await load();
  await loadOutline();
}
defineExpose({ save, discard, reload });
</script>
<template>
  <section class="large-workspace">
    <NAlert type="info">大文件模式</NAlert>
    <p>仅编辑已加载片段。正文上限 20 MiB，每次加载最多 128 KiB。</p>
    <NAlert v-if="error" type="error"
      >{{ error }} <NButton v-if="requestId" @click="check">核对保存结果</NButton></NAlert
    >
    <p v-if="notice" role="status">{{ notice }}</p>
    <OperationStatus :operation="operation" @cancel="cancel" @check="check" />
    <p v-if="note.editorMode === 'metadata'">文件超过 20 MiB，当前仅显示元数据。</p>
    <template v-else
      ><NoteOutline
        :outline="outline"
        @select="(line) => navigate(() => load({ range: { startLine: line } }))"
        @next="loadOutline" />
      <p v-if="page">
        第 {{ page.startLine }}–{{ page.endLine }} 行 · {{ page.startByte }}–{{ page.endByte }} 字节
        · {{ dirty ? '未保存' : '已保存' }}
      </p>
      <div v-if="page" class="large-editor">
        <MarkdownEditor
          :model-value="original"
          :incremental="true"
          :wrap="false"
          :read-only="busy || !!requestId"
          @changes="applyChanges"
          :key="`${page.snapshotId}:${page.startByte}:${renderEpoch}`"
        />
      </div>
      <div class="large-actions">
        <NButton :disabled="!page || !previewAllowed" @click="previewOpen = !previewOpen">{{
          previewOpen ? '关闭片段预览' : '预览当前片段'
        }}</NButton>
        <NButton type="primary" :loading="busy" :disabled="!page" @click="save">保存片段</NButton
        ><NButton
          :disabled="!page?.hasMore || busy"
          @click="navigate(() => load({ cursor: page!.nextCursor }))"
          >下一片段</NButton
        ><NButton :disabled="busy" @click="navigate(() => load())">重新读取</NButton
        ><a
          v-if="page"
          :href="`/api/notes/${note.id}/download?snapshotId=${encodeURIComponent(page.snapshotId)}`"
          >下载完整文件</a
        >
      </div>
      <div v-if="previewOpen" class="markdown large-preview" v-html="previewHtml"></div></template
    ><NModal v-model:show="leaveOpen" preset="card" title="片段尚未保存" style="max-width: 420px"
      ><p>保存或放弃当前修改后再切换。</p>
      <NButton @click="leave('save')">保存</NButton><NButton @click="leave('discard')">放弃</NButton
      ><NButton @click="leave('cancel')">取消</NButton></NModal
    >
  </section>
</template>
<style scoped>
.large-workspace {
  padding: 20px;
  overflow: auto;
  flex: 1;
  min-height: 0;
}
.large-editor {
  height: 50vh;
  min-height: 220px;
  border: 1px solid #dbe4eb;
}
.large-actions {
  display: flex;
  gap: 12px;
  align-items: center;
  flex-wrap: wrap;
  margin-top: 16px;
}
.note-outline {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
  margin: 12px 0;
}
</style>
