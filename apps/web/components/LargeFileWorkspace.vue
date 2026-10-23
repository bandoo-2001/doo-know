<script setup lang="ts">
import { deferImageSource } from '../image-requests';
import {markdownTasks} from '../../../shared/markdown-tasks';
import {knowledgeMarkdown} from '../../../shared/knowledge-markdown';

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
import DraftRecovery from './DraftRecovery.vue';
import {
  createDraftStore,
  noteDraftBase,
  type DraftRecord,
  type DraftScope,
  type DraftStore,
} from '../drafts';
import MarkdownIt from 'markdown-it';
import { markdownStyles } from '../../../shared/markdown-styles';
import DOMPurify from 'dompurify';
const props = defineProps<{
  note: NoteInfo;
  initialLine?: number;
  assets?: { id: string; relativePath: string }[];
  draftScope?: DraftScope;
  serviceUnavailable?: string;
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
const editorContent = ref(''),
  recovery = ref<DraftRecord>(),
  localError = ref(''),
  localStatus = ref('');
let draftStore: DraftStore | undefined, localDraft: DraftRecord | undefined;
let localTimer: ReturnType<typeof setTimeout> | undefined;
let localWrite: Promise<void> = Promise.resolve();
const recoveryBaseChanged = computed(() => {
  const r = recovery.value,
    p = page.value;
  return (
    !!r &&
    (!p ||
      r.baseRevision !== noteDraftBase({ modifiedAt: p.modifiedAt, contentHash: p.sourceHash }) ||
      !r.range ||
      r.range.startByte !== p.startByte ||
      r.range.endByte !== p.endByte ||
      r.range.rangeHash !== p.rangeHash)
  );
});
function stopLocalTimer() {
  if (localTimer) clearTimeout(localTimer);
  localTimer = undefined;
}
function persistLocalDraft(): Promise<void> {
  const p = page.value,
    store = draftStore,
    current = epoch,
    noteId = props.note.id;
  if (!store || !p || recovery.value) return localWrite;
  const content = draft.value,
    isDirty = content !== original.value;
  const input = {
    noteId,
    kind: 'fragment' as const,
    content,
    baseRevision: noteDraftBase({ modifiedAt: p.modifiedAt, contentHash: p.sourceHash }),
    range: {
      startLine: p.startLine,
      endLine: p.endLine,
      lineByteOffset: p.lineByteOffset,
      startByte: p.startByte,
      endByte: p.endByte,
      rangeHash: p.rangeHash,
    },
  };
  localWrite = localWrite.then(async () => {
    try {
      if (isDirty) {
        const saved = await store.put(input);
        if (current === epoch) {
          localDraft = saved;
          localStatus.value = '本地草稿已保存';
          localError.value = '';
        }
      } else if (localDraft?.noteId === noteId) {
        await store.remove(noteId, localDraft.version);
        if (current === epoch) {
          localDraft = undefined;
          localStatus.value = '';
        }
      }
    } catch (e) {
      if (current === epoch) {
        localError.value = (e as Error).message;
        localStatus.value = '';
      }
    }
  });
  return localWrite;
}
async function flushLocalDraft() {
  stopLocalTimer();
  await persistLocalDraft();
}
watch(draft, () => {
  stopLocalTimer();
  if ((dirty.value || localDraft) && draftStore && !recovery.value)
    localTimer = setTimeout(() => void persistLocalDraft(), 400);
});
async function removeLocalVersion(version?: string) {
  if (!draftStore || !version) return;
  try {
    const removed = await draftStore.remove(props.note.id, version);
    if (removed && localDraft?.version === version) {
      localDraft = undefined;
      localStatus.value = '';
    }
  } catch (e) {
    localError.value = (e as Error).message;
  }
}
function recoverLocalDraft() {
  if (!recovery.value || recovery.value.kind !== 'fragment' || recoveryBaseChanged.value) return;
  draft.value = recovery.value.content;
  editorContent.value = recovery.value.content;
  localDraft = recovery.value;
  recovery.value = undefined;
  renderEpoch++;
}
async function discardRecovery() {
  const version = recovery.value?.version;
  if (!version || !draftStore) return;
  try {
    await draftStore.remove(props.note.id, version);
    recovery.value = undefined;
    if (localDraft?.version === version) localDraft = undefined;
    localError.value = '';
  } catch (e) {
    localError.value = (e as Error).message;
  }
}
const previewOpen = ref(false);
const previewAllowed = computed(() => new TextEncoder().encode(draft.value).length <= 128 * 1024);
const previewHtml = computed(() => {
  if (!previewOpen.value || !previewAllowed.value) return '';
  const md = new MarkdownIt({ html: false, linkify: true }).use(markdownStyles).use(markdownTasks).use(knowledgeMarkdown);
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
        if (mapped) { if (token.type === 'image') deferImageSource(token, mapped); else token.attrSet(attr, mapped); }
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
  submittedLocalVersion: string | undefined,
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
    editorContent.value = r.data.content;
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
  if (props.serviceUnavailable) return;
  if (!page.value || busy.value || recovery.value) return;
  if (requestId) {
    await check();
    return;
  }
  const current = epoch;
  busy.value = true;
  error.value = '';
  notice.value = '';
  try {
    await flushLocalDraft();
    if (current !== epoch) return;
    if (new TextEncoder().encode(draft.value).length > 128 * 1024)
      throw new Error('片段超过 128 KiB，请分次修改');
    const nextRequestId = crypto.randomUUID();
    const p = page.value;
    submittedDraft = draft.value;
    submittedLocalVersion = localDraft?.content === submittedDraft ? localDraft.version : undefined;
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
    original.value = submittedDraft;
    await removeLocalVersion(submittedLocalVersion);
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
    await removeLocalVersion(submittedLocalVersion);
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
  if (recovery.value) {
    notice.value = '请先恢复或丢弃本地草稿后再切换片段。';
    return;
  }
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
  } else await discard();
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
async function discard() {
  stopLocalTimer();
  await localWrite;
  await removeLocalVersion(localDraft?.version);
  draft.value = original.value;
  editorContent.value = original.value;
  renderEpoch++;
}
async function loadInitial() {
  const range = recovery.value?.range;
  await load(
    range
      ? {
          maxBytes: Math.max(1, range.endByte - range.startByte),
          range: {
            startLine: range.startLine,
            endLine: range.endLine,
            lineByteOffset: range.lineByteOffset,
          },
        }
      : props.initialLine
        ? { range: { startLine: props.initialLine } }
        : {},
  );
  await loadOutline();
}
watch(
  () => props.initialLine,
  (line, previous) => {
    if (!line || line === previous || props.note.editorMode === 'metadata') return;
    void navigate(async () => {
      // Supersede any older fragment request for this mounted note.
      epoch++;
      await load({ range: { startLine: line } });
    });
  },
);
watch(
  [() => props.note.id, () => props.draftScope?.ownerId, () => props.draftScope?.knowledgeId],
  async () => {
    stopLocalTimer();
    epoch++;
    const current = epoch;
    draft.value = '';
    original.value = '';
    page.value = undefined;
    operation.value = undefined;
    outline.value = undefined;
    requestId = '';
    submittedPatch = undefined;
    submittedNoteId = '';
    submittedLocalVersion = undefined;
    previewOpen.value = false;
    recovery.value = undefined;
    localDraft = undefined;
    localError.value = '';
    localStatus.value = '';
    draftStore = props.draftScope ? createDraftStore({ scope: props.draftScope }) : undefined;
    if (props.note.editorMode !== 'metadata') {
      if (draftStore) {
        try {
          const cached = await draftStore.load(props.note.id);
          if (current !== epoch) return;
          if (cached) recovery.value = cached;
        } catch (e) {
          if (current === epoch) localError.value = (e as Error).message;
        }
      }
      if (current !== epoch) return;
      await loadInitial();
    }
  },
  { immediate: true },
);
function pageHidden() {
  if (document.visibilityState === 'hidden') void flushLocalDraft();
}
window.addEventListener('pagehide', flushLocalDraft);
document.addEventListener('visibilitychange', pageHidden);
onBeforeUnmount(() => {
  void flushLocalDraft();
  epoch++;
  window.removeEventListener('pagehide', flushLocalDraft);
  document.removeEventListener('visibilitychange', pageHidden);
});
async function reload() {
  await load();
  await loadOutline();
}
defineExpose({ save, discard, reload, flushLocalDraft });
</script>
<template>
  <section class="large-workspace">
    <NAlert type="info">大文件模式</NAlert>
    <p>仅编辑已加载片段。正文上限 20 MiB，每次加载最多 128 KiB。</p>
    <DraftRecovery
      v-if="recovery"
      :draft="recovery"
      :base-changed="recoveryBaseChanged"
      fragment
      :busy="busy"
      @restore="recoverLocalDraft"
      @discard="discardRecovery"
    />
    <NAlert v-if="localError" type="warning" role="alert">{{ localError }}</NAlert>
    <p v-else-if="localStatus" role="status">{{ localStatus }} · 尚未写入原文</p>
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
      <p v-if="page" class="large-range">
        第 {{ page.startLine }}–{{ page.endLine }} 行 · {{ page.startByte }}–{{ page.endByte }} 字节
        · {{ dirty ? '未保存' : '已保存' }}
      </p>
      <div v-if="page" class="large-editor">
        <MarkdownEditor
          :model-value="editorContent"
          :incremental="true"
          :wrap="false"
          :show-line-numbers="true"
          :read-only="busy || !!requestId || !!recovery"
          @changes="applyChanges"
          :key="`${page.snapshotId}:${page.startByte}:${renderEpoch}`"
        />
      </div>
      <div class="large-actions">
        <NButton :disabled="!page || !previewAllowed" @click="previewOpen = !previewOpen">{{
          previewOpen ? '关闭片段预览' : '预览当前片段'
        }}</NButton>
        <NButton
          type="primary"
          :loading="busy"
          :disabled="!page || !!recovery || !!props.serviceUnavailable"
          @click="save"
          >保存片段</NButton
        ><NButton
          :disabled="!page?.hasMore || busy || !!recovery"
          @click="navigate(() => load({ cursor: page!.nextCursor }))"
          >下一片段</NButton
        ><NButton
          :disabled="busy || (!!page && !!recovery)"
          @click="page ? navigate(() => load()) : loadInitial()"
          >重新读取</NButton
        ><a
          v-if="page"
          :href="`/api/notes/${note.id}/download?snapshotId=${encodeURIComponent(page.snapshotId)}`"
          >下载完整文件</a
        >
      </div>
      <div v-if="previewOpen" class="markdown large-preview" v-html="previewHtml"></div></template
    ><NModal v-model:show="leaveOpen" preset="card" title="片段尚未保存" class="dialog-card"
      ><p>保存或放弃当前修改后再切换。</p>
      <NButton @click="leave('save')">保存</NButton><NButton @click="leave('discard')">放弃</NButton
      ><NButton @click="leave('cancel')">取消</NButton></NModal
    >
  </section>
</template>
<style scoped>
.large-workspace {
  padding: 24px 28px;
  overflow: auto;
  flex: 1;
  min-height: 0;
  color: var(--text, #414858);
}
.large-workspace > p {
  color: var(--muted, #7a8190);
  font-size: 12px;
  line-height: 1.8;
}
.large-editor {
  height: 50vh;
  min-height: 220px;
  border: 1px solid var(--border, #e3e6ec);
  border-radius: 8px;
  overflow: hidden;
  margin-top: 15px;
}
.large-actions {
  display: flex;
  gap: 9px;
  align-items: center;
  flex-wrap: wrap;
  margin-top: 16px;
}
.large-actions a {
  font-size: 12px;
  text-underline-offset: 3px;
}
.large-preview {
  margin-top: 20px;
  border: 1px solid var(--border, #e3e6ec);
  border-radius: 8px;
}
@media (max-width: 720px) {
  .large-workspace {
    padding: 18px 16px;
  }
  .large-actions {
    gap: 8px;
  }
  .large-editor {
    height: 45dvh;
  }
}
</style>
