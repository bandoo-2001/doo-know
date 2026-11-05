<script setup lang="ts">
import { ref, computed, nextTick, onMounted, onBeforeUnmount, watch } from 'vue';
import { Button as AButton } from 'ant-design-vue';
import { NButton, NPopover } from 'naive-ui';
import MarkdownIt from 'markdown-it';
import DOMPurify from 'dompurify';
import { knowledgeMarkdown } from '../../../shared/knowledge-markdown';
import { frontmatterRange } from '../../../shared/frontmatter-range';
import type { NoteDocument } from '../../../shared/contracts';
import type { DiagramResource } from '../../../shared/diagram-resource';
import { parseDiagramDocument } from '../../../shared/diagram-document';
import { diagramPlainTitle } from '../../../shared/diagram-primary';
import { parseMindmapOutline, serializeMindmapOutline } from '../../../shared/mindmap-outline';
import { parseWhiteboard } from '../../../shared/whiteboard';
import { api } from '../api';
import { createDraftStore, type DraftScope, type DraftRecord } from '../drafts';
import { createDocumentSession, type DocumentSessionState } from '../diagrams/document-session';
import { readCoherentDiagramDocument } from '../diagrams/document-read';
import { documentDraft, restoreDocumentDraft } from '../diagrams/document-draft';
import { heldDraftDownload } from '../diagrams/document-draft';
import { readDiagram, renderPrimaryPng, preparePrimary, commitPrimary } from '../diagrams/primary-api';
import { hashDiagramSource } from '../diagrams/preview-artifact';
import { markdownDestination } from '../markdown-links';
import { downloadBlob } from '../whiteboards/download';
import MarkdownEditor from './MarkdownEditor.vue';
import DraftRecovery from './DraftRecovery.vue';
import DocumentBreadcrumb from './DocumentBreadcrumb.vue';
import Icon from './Icon.vue';
const props = defineProps<{ noteId: string; relativePath?: string; draftScope?: DraftScope; embedded?: boolean; autosavePaused?: boolean; shared?: boolean; shareBusy?: boolean }>();
const emit = defineEmits<{
  dirty: [value: boolean]; saved: [document: NoteDocument]; close: []; history: []; root: []; share: [];
  folder: [entry: { type: 'folder'; name: string; path: string }];
}>();
const actionsOpen = ref(false),
  actionsMenu = ref<HTMLElement>(),
  actionsTrigger = ref<InstanceType<typeof NButton>>();
watch(actionsOpen, async (open) => {
  if (open) {
    await nextTick();
    actionsMenu.value?.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus();
  }
});
function closeActions() {
  actionsOpen.value = false;
  (actionsTrigger.value?.$el as HTMLElement | undefined)?.focus();
}
const mount = ref<HTMLElement>(),
  root = ref<HTMLElement>(),
  revision = ref(0),
  loading = ref(true),
  saving = ref(false),
  exporting = ref(false),
  readingExportBusy = ref(false),
  error = ref(''),
  mode = ref<'design' | 'source' | 'preview' | 'reading'>('design'),
  recovered = ref<DraftRecord>(),
  preview = ref(''),
  attachmentSources = ref<Record<string, string>>({}),
  closing = ref(false),
  discarding = ref(false);
let doc: NoteDocument | undefined,
  resource: DiagramResource | undefined,
  session: ReturnType<typeof createDocumentSession> | undefined,
  store: ReturnType<typeof createDraftStore> | undefined,
  record: DraftRecord | undefined,
  writeQueue = Promise.resolve(),
  saveJob: Promise<void> | undefined,
  timer: ReturnType<typeof setTimeout> | undefined,
  draftTimer: ReturnType<typeof setTimeout> | undefined,
  disposed = false,
  epoch = 0;
let canvasBaseline = '',
  canvasOriginal = '';
let canvas: ReturnType<(typeof import('../whiteboards/canvas'))['mountCanvas']> | undefined,
  mind: ReturnType<(typeof import('../diagrams/mindmap'))['mountMindmap']> | undefined;
const state = computed(() => {
  revision.value;
  return session?.state;
});
const dirty = computed(() => {
  revision.value;
  return session?.dirty() ?? false;
});
const editable = computed(() => {
  revision.value;
  return !!resource?.capabilities.canEdit && !recovered.value;
});
const readingHtml = computed(() => {
  revision.value;
  if (!state.value) return '';
  const markdown = state.value.markdown,
    parsed = parseDiagramDocument(markdown);
  if (parsed.status !== 'diagram') return '';
  const main =
    markdown.slice(0, parsed.primary.range.from) +
    (preview.value ? '\n![主图预览](' + preview.value + ')\n' : '\n') +
    markdown.slice(parsed.primary.range.to);
  const md = new MarkdownIt({ html: false, linkify: true }).use(knowledgeMarkdown);
  md.renderer.rules.image = (tokens, index) => {
    const token = tokens[index],
      source = String(token.attrGet('src') || '');
    const local = markdownDestination(source, doc?.relativePath || '');
    const url = /^\/api\/assets\/[a-zA-Z0-9-]+(?:\?[^#]*)?$/.test(source)
      ? source
      : local?.kind === 'local'
        ? attachmentSources.value[local.path]
        : undefined;
    return url
      ? '<img src="' +
          md.utils.escapeHtml(url) +
          '" alt="' +
          md.utils.escapeHtml(token.content) +
          '">'
      : md.utils.escapeHtml(token.content);
  };
  return DOMPurify.sanitize(md.render(main.slice(frontmatterRange(main)?.end ?? 0)));
});
const labels = { whiteboard: '白板', mindmap: '脑图', flowchart: '流程图' };
const diagramIcon = computed(() => state.value?.type === 'mindmap' ? 'graph' : state.value?.type === 'flowchart' ? 'code' : 'whiteboard');
const saveStatus = computed(() => loading.value ? '正在载入' : saving.value ? '正在保存…' : error.value ? '保存未完成' : dirty.value ? '未保存' : '已保存');
const automaticSavePaused = computed(
  () => !!props.autosavePaused || closing.value || discarding.value,
);
function scheduleAutomaticSave(delay = 1200) {
  clearTimeout(timer);
  timer = undefined;
  if (
    !disposed && !loading.value && !recovered.value && !automaticSavePaused.value &&
    !saving.value && !error.value && session?.dirty()
  ) timer = setTimeout(() => void save(), delay);
}
watch(automaticSavePaused, (paused) => {
  clearTimeout(timer);
  timer = undefined;
  if (!paused) scheduleAutomaticSave();
}, { flush: 'sync' });
function changed() {
  if (disposed) return;
  revision.value++;
  emit('dirty', session?.dirty() ?? false);
  clearTimeout(timer);
  clearTimeout(draftTimer);
  if (!disposed && !loading.value && !recovered.value) {
    draftTimer = setTimeout(() => void session?.persist().catch(report), 150);
    scheduleAutomaticSave();
  }
}
function report(cause: unknown) {
  error.value = (cause as Error).message;
}
async function persist(snapshot: DocumentSessionState) {
  // An offered recovery is not adopted by this clean server-baseline session.
  if (recovered.value || loading.value) return;
  const copy = structuredClone(snapshot);
  const work = writeQueue.then(async () => {
    if (recovered.value || loading.value) return;
    if (!store) throw Error('本地草稿身份尚未准备，请稍后重试');
    if (!session?.dirty()) {
      if (record) {
        if (!(await store.remove(props.noteId, record.version)))
          throw Error('本地草稿已在其他页面变化');
        record = undefined;
      }
      return;
    }
    const envelope = documentDraft(copy);
    record = await store.put({
      noteId: props.noteId,
      kind: 'note',
      baseRevision: copy.documentHash || 'creation:' + copy.intentId,
      content: envelope.payload,
      diagram: envelope,
    });
  });
  writeQueue = work.catch(() => {});
  await work;
}
function disposeEditor() {
  epoch++;
  canvas?.dispose();
  canvas = undefined;
  mind?.destroy();
  mind = undefined;
}
async function mountEditor() {
  disposeEditor();
  if (!session || mode.value !== 'design' || !editable.value) return;
  const generation = epoch;
  await nextTick();
  if (disposed || generation !== epoch || !mount.value) return;
  const snapshot = { ...session.state };
  try {
    if (snapshot.type === 'whiteboard') {
      const scene = parseWhiteboard(snapshot.source);
      const { mountCanvas } = await import('../whiteboards/canvas');
      if (disposed || generation !== epoch) return;
      canvasOriginal = snapshot.source;
      canvasBaseline = '';
      canvas = mountCanvas(mount.value!, scene, (value, initial) => {
        if (disposed || generation !== epoch) return;
        if (initial) {
          canvasBaseline = value;
          return;
        }
        const source = value === canvasBaseline ? canvasOriginal : value;
        if (source !== session?.state.source) session?.editSource(source);
      });
    } else if (snapshot.type === 'mindmap') {
      const adapter = await import('../diagrams/mindmap');
      if (disposed || generation !== epoch) return;
      mind = adapter.mountMindmap(
        mount.value!,
        parseMindmapOutline(diagramPlainTitle(snapshot.title) + '\n\n' + snapshot.source),
      );
      const syncMindmap = () => {
        try {
          if (!mind) return;
          const tree = adapter.readMindmapTree(mind);
          const outline = serializeMindmapOutline(tree);
          session?.editSource(
            outline.slice(outline.indexOf('\n') + 1).replace(/^\n/, ''),
            tree.topic,
          );
        } catch (e) {
          report(e);
        }
      };
      mind.bus.addListener('operation', syncMindmap);
      // Undo and redo rebuild the tree through refresh/linkDiv without an operation event.
      mind.bus.addListener('linkDiv', syncMindmap);
    }
  } catch (e) {
    report(e);
    mode.value = 'source';
  }
}
async function loadPreview(current = () => !disposed) {
  const snapshotResource = resource, snapshotDocument = doc;
  if (!snapshotResource?.preview || !snapshotDocument) return;
  const assets = await api<any[]>('/api/notes/' + props.noteId + '/assets');
  if (!current() || resource !== snapshotResource || doc !== snapshotDocument) return;
  attachmentSources.value = Object.fromEntries(
    assets.map((a) => [a.relativePath, '/api/assets/' + a.id]),
  );
  const target = markdownDestination(snapshotResource.preview.path, snapshotDocument.relativePath);
  const asset = assets.find(
    (a) => a.relativePath === (target?.kind === 'local' ? target.path : snapshotResource.preview!.path),
  );
  preview.value = asset ? '/api/assets/' + asset.id + '?v=' + snapshotResource.preview.hash : '';
}
async function load() {
  clearTimeout(timer);
  clearTimeout(draftTimer);
  try {
    await session?.persist();
    await writeQueue;
  } catch (e) {
    report(e);
    return;
  }
  disposeEditor();
  loading.value = true;
  error.value = '';
  try {
    if (!props.draftScope) throw Error('本地草稿身份尚未准备');
    const nextStore = createDraftStore({ scope: props.draftScope });
    const { document, resource: value } = await readCoherentDiagramDocument(
      () => api<NoteDocument>('/api/notes/' + props.noteId),
      () => readDiagram(props.noteId),
    );
    if (disposed) return;
    const nextRecord = await nextStore.load(props.noteId);
    if (disposed) return;
    store = nextStore;
    record = nextRecord;
    recovered.value = nextRecord;
    doc = document;
    resource = value;
    const parsed = parseDiagramDocument(document.content);
    if (parsed.status !== 'diagram') throw Error('图形 Markdown 不完整，请下载原文核对');
    session = createDocumentSession(
      {
        noteId: props.noteId,
        type: parsed.type,
        markdown: document.content,
        source: value.source.content ?? '',
        title: parsed.title,
        documentHash: value.documentHash,
        sourceHash: value.source.hash,
      },
      {
        hash: hashDiagramSource,
        render: (s) => renderPrimaryPng(parsed.type, s),
        prepare: (s, png, target) => preparePrimary(parsed.type, s, png, target, value.render),
        commit: commitPrimary,
        resource: () => readDiagram(props.noteId),
        persist,
        changed,
      },
    );
    await loadPreview();
    if (!value.capabilities.canEdit) {
      error.value =
        '图形源不可编辑，已保留现有预览与 Markdown 原文。' +
        (value.issues?.map((i) => i.code).join('，') || '');
      mode.value = 'preview';
    }
    revision.value++;
    await mountEditor();
  } catch (e) {
    report(e);
  } finally {
    loading.value = false;
  }
}
function save(): Promise<void> {
  if (saveJob) return saveJob;
  if (!session || !editable.value) return Promise.resolve();
  const activeSession = session;
  const current = () => !disposed && session === activeSession;
  clearTimeout(timer);
  clearTimeout(draftTimer);
  saving.value = true;
  error.value = '';
  saveJob = (async () => {
    try {
      await activeSession.save();
      if (!current()) return;
      const fresh = await api<NoteDocument>('/api/notes/' + props.noteId);
      if (!current()) return;
      const freshResource = await readDiagram(props.noteId);
      if (!current()) return;
      doc = fresh;
      resource = freshResource;
      emit('saved', fresh);
      window.dispatchEvent(
        new CustomEvent('dooknow-whiteboard-saved', { detail: { id: props.noteId } }),
      );
      await loadPreview(current);
    } catch (e) {
      if (current()) report(e);
    } finally {
      saving.value = false;
      if (current()) {
        revision.value++;
        emit('dirty', activeSession.dirty());
      }
    }
  })().finally(() => {
    saveJob = undefined;
    if (current()) scheduleAutomaticSave(300);
  });
  return saveJob;
}
async function switchMode(next: 'design' | 'source' | 'preview' | 'reading') {
  if (!session || next === mode.value) return;
  if (mode.value === 'design' && canvas) {
    try {
      const source = canvas.snapshot();
      session.editSource(source === canvasBaseline ? canvasOriginal : source);
    } catch (e) {
      report(e);
      return;
    }
  }
  // Hand off a complete native snapshot before source/preview gets ownership; invalid source stays visible.
  if (session.dirty()) {
    await save();
    if (session.dirty() || error.value) return;
  }
  if (next === 'design') {
    const parsed = parseDiagramDocument(session.state.markdown);
    if (parsed.status !== 'diagram') {
      error.value = '源码不完整，请先修复';
      return;
    }
  }
  mode.value = next;
  await mountEditor();
}
function nativeEdit(value: string) {
  session?.editSource(value);
}
function markdownEdit(value: string) {
  session?.editMarkdown(value);
}
async function restore() {
  if (!session || !recovered.value) return;
  try {
    const originalSession=session,originalRecord=recovered.value;
    const draft = recovered.value.diagram;
    let baseline = session.state;
    if (
      draft?.pending?.markdown &&
      (await hashDiagramSource(draft.pending.markdown)) === resource?.documentHash
    )
      baseline = {
        ...session.state,
        documentHash: draft.documentHash,
        sourceHash: draft.baselineSourceHash ?? null,
      };
    const restored = restoreDocumentDraft(originalRecord, baseline);
    if(disposed||session!==originalSession||recovered.value?.version!==originalRecord.version)
      throw Error('草稿或页面已变化，请重新核对，原草稿仍保留');

    session.restore(restored,restored.pending);
    recovered.value = undefined;
    error.value = '';
    if (parseDiagramDocument(restored.markdown).status !== 'diagram') mode.value = 'source';
    await mountEditor();
    await session.persist();
  } catch (e) {
    report(e);
  }
}
async function discard() {
  discarding.value = true;
  clearTimeout(timer);
  try {
    // A save owns commit evidence and fresh server baselines until its full refresh settles.
    await saveJob;
    if (session?.state.pending) {
      await save();
      if (session.state.pending) throw Error('提交结果尚未核对，请先重试或下载草稿');
    }
    clearTimeout(draftTimer);
    await writeQueue;
    if (record && store) {
      if (!(await store.remove(props.noteId, record.version)))
        throw Error('本地草稿已在其他页面变化');
      record = undefined;
    }
    recovered.value = undefined;
    session?.discard();
    error.value = '';
    await mountEditor();
  } finally {
    discarding.value = false;
  }
}
async function png() {
  if (!session || exporting.value) return;
  exporting.value = true;
  try {
    if (canvas) {
      const source = canvas.snapshot();
      session.editSource(source === canvasBaseline ? canvasOriginal : source);
    }
    const snapshot = { ...session.state };
    await session.persist();
    downloadBlob(await renderPrimaryPng(snapshot.type, snapshot), snapshot.title + '.png');
  } catch (e) {
    report(e);
  } finally {
    exporting.value = false;
  }
}
async function abandon() {
  try {
    await discard();
    emit('close');
  } catch (e) {
    report(e);
  }
}
async function exportReading(print = false) {
  if (!session || readingExportBusy.value) return;
  const popup = print ? window.open('', '_blank') : null;
  readingExportBusy.value = true;
  try {
    await save();
    if (session.dirty()) {
      popup?.close();
      return;
    }
    const snapshot = { ...session.state };
    const proof = await readDiagram(props.noteId);
    const attachments = await api<any[]>('/api/notes/' + props.noteId + '/assets');
    const path = doc?.relativePath || '';
    const { buildReadingHtml, downloadReadingHtml, printReadingHtml } =
      await import('../reading-export');
    const html = await buildReadingHtml({
      title: snapshot.title,
      markdown: snapshot.markdown,
      diagramResource: proof,
      resolveImage: async (source) => {
        const target = markdownDestination(source, path);
        const asset = attachments.find(
          (a) => a.relativePath === (target?.kind === 'local' ? target.path : ''),
        );
        if (!asset || !/^image\//.test(asset.mime || '')) return undefined;
        const response = await fetch('/api/assets/' + asset.id, {
          cache: 'no-store',
          credentials: 'same-origin',
          redirect: 'error',
          signal: AbortSignal.timeout(15000),
        });
        if (!response.ok) throw Error('预览或附件暂不可导出，请重新读取');
        return response.blob();
      },
    });
    if (print) await printReadingHtml(html, popup);
    else downloadReadingHtml(html, snapshot.title);
  } catch (e) {
    popup?.close();
    report(e);
  } finally {
    readingExportBusy.value = false;
  }
}
async function portable() {
  try {
    await save();
    if (session?.dirty()) return;
    await (await import('../diagrams/portable-download')).downloadPortableDocument(props.noteId);
  } catch (e) {
    report(e);
  }
}
async function close() {
  await save();
  if (session?.dirty() || recovered.value) closing.value = true;
  else emit('close');
}
function download(markdown = false) {
  const current = session?.state;
  downloadBlob(
    new Blob([markdown ? current?.markdown || doc?.content || '' : current?.source || ''], {
      type: markdown ? 'text/markdown;charset=utf-8' : 'text/plain;charset=utf-8',
    }),
    (doc?.title || 'diagram') +
      (markdown
        ? '.md'
        : current?.type === 'whiteboard'
          ? '.excalidraw'
          : current?.type === 'flowchart'
            ? '.mmd'
            : '.outline.md'),
  );
}
function downloadDraft(){
  if(!recovered.value){download();return;}
  const held=heldDraftDownload(recovered.value);
  downloadBlob(new Blob([held.content],{type:'text/plain;charset=utf-8'}),(doc?.title||'diagram')+held.extension);
}
function key(event: KeyboardEvent) {
  if (
    root.value?.getClientRects().length &&
    (event.ctrlKey || event.metaKey) &&
    event.key.toLowerCase() === 's'
  ) {
    event.preventDefault();
    event.stopImmediatePropagation();
    void save();
  }
}
function unload(event: BeforeUnloadEvent) {
  if (session?.dirty()) {
    void session.persist();
    event.preventDefault();
    event.returnValue = '';
  }
}
onMounted(() => {
  void load();
  window.addEventListener('keydown', key, true);
  window.addEventListener('beforeunload', unload);
});
onBeforeUnmount(() => {
  disposed = true;
  clearTimeout(timer);
  clearTimeout(draftTimer);
  void session?.persist().catch(() => {});
  disposeEditor();
  window.removeEventListener('keydown', key, true);
  window.removeEventListener('beforeunload', unload);
  emit('dirty', false);
});
defineExpose({ save, discard, settleSave: () => saveJob, reload:load, requestClose: close, flush: () => session?.persist() });
</script>
<template>
  <section
    ref="root"
    class="diagram-document-workspace"
    :class="{ embedded }"
    data-testid="diagram-document-workspace"
  >
    <header class="note-header">
      <div class="note-topline">
        <slot name="navigation">
          <button
            class="icon-button"
            type="button"
            :aria-label="embedded ? '返回笔记' : '返回目录'"
            :title="embedded ? '返回笔记' : '返回目录'"
            @click="close"
          >
            <Icon name="back" :size="18" />
          </button>
        </slot>
        <DocumentBreadcrumb
          v-if="!embedded && relativePath"
          :relative-path="relativePath"
          :title="state?.title || '图形文档'"
          @root="emit('root')"
          @folder="emit('folder', $event)"
        />
        <h1 v-else class="document-title">{{ state?.title || '图形文档' }}</h1>
        <div class="toolbar">
          <span
            class="save-state"
            :class="{ dirty, 'has-error': !!error }"
            role="status"
            aria-live="polite"
            :title="saveStatus"
            >● {{ saveStatus }}</span
          >
          <button
            v-if="!embedded"
            class="icon-button"
            type="button"
            aria-label="历史版本"
            title="历史版本"
            :disabled="loading || saving || !!recovered"
            @click="emit('history')"
          >
            <Icon name="clock" :size="18" />
          </button>
          <AButton
            v-if="!embedded"
            class="share-button"
            title="分享"
            aria-label="分享"
            :loading="shareBusy"
            :disabled="loading || shareBusy"
            @click="emit('share')"
          >
            <template #icon><Icon name="share" /></template>分享
          </AButton>
          <AButton
            class="save-button"
            type="primary"
            aria-label="保存图形"
            title="保存 · Ctrl/Cmd+S"
            :loading="saving"
            :disabled="loading || saving || !editable"
            @click="save"
          >
            <template #icon><Icon name="save" :size="18" /></template>保存
          </AButton>
          <NPopover
            v-model:show="actionsOpen"
            trigger="click"
            placement="bottom-end"
            :show-arrow="false"
            :z-index="embedded ? 1700 : undefined"
          >
            <template #trigger>
              <NButton
                ref="actionsTrigger"
                aria-label="更多操作"
                title="更多操作"
                aria-haspopup="dialog"
                :aria-expanded="actionsOpen"
                @keydown.esc.stop.prevent="closeActions"
              >
                <Icon name="more" />
              </NButton>
            </template>
            <div
              ref="actionsMenu"
              class="note-action-menu diagram-document-menu"
              role="dialog"
              aria-label="图形文档操作"
              @keydown.esc.stop.prevent="closeActions"
            >
              <button
                type="button"
                :disabled="loading || saving"
                @click="
                  closeActions();
                  portable();
                "
              >
                <Icon name="download" />下载完整文档
              </button>
              <button
                type="button"
                aria-label="下载 Markdown"
                title="仅下载 Markdown 原文，不包含图片和附件"
                @click="
                  closeActions();
                  download(true);
                "
              >
                <Icon name="file" />下载 Markdown 原文
              </button>
              <button
                type="button"
                :disabled="loading || !resource?.capabilities.canDownloadSource"
                @click="
                  closeActions();
                  download();
                "
              >
                <Icon :name="diagramIcon" />下载原件
              </button>
            </div>
          </NPopover>
        </div>
      </div>
      <div v-if="shared && !embedded" class="shared-status">
        <Icon name="share" :size="14" />已分享，保存后的修改将同步公开
      </div>
      <div class="document-format-row diagram-document-controls">
        <div class="format-toolbar" role="toolbar" aria-label="图形工具">
          <span class="diagram-document-kind"
            ><Icon :name="diagramIcon" :size="16" />{{
              state ? labels[state.type] : '图形文档'
            }}</span
          >
          <span class="format-divider" aria-hidden="true"></span>
          <div class="format-group">
            <button
              type="button"
              aria-label="导出 HTML"
              title="导出 HTML"
              :disabled="loading || saving || readingExportBusy"
              @click="exportReading(false)"
            >
              <Icon name="code" :size="18" />
            </button>
            <button
              type="button"
              aria-label="打印"
              title="打印"
              :disabled="loading || saving || readingExportBusy"
              @click="exportReading(true)"
            >
              <Icon name="printer" :size="18" />
            </button>
            <button
              type="button"
              aria-label="导出 PNG"
              title="导出 PNG"
              :disabled="exporting || !editable"
              @click="png"
            >
              <Icon name="image" :size="18" />
            </button>
          </div>
        </div>
        <nav class="mode-row" aria-label="图形视图">
          <div class="mode-tabs">
            <button
              type="button"
              :aria-pressed="mode === 'design'"
              :class="{ active: mode === 'design' }"
              :disabled="!editable"
              @click="switchMode('design')"
            >
              {{ state ? labels[state.type] : '设计' }}</button
            ><button
              type="button"
              :disabled="loading || !state"
              :aria-pressed="mode === 'source'"
              :class="{ active: mode === 'source' }"
              @click="switchMode('source')"
            >
              Markdown 源码</button
            ><button
              type="button"
              :disabled="loading || !state"
              :aria-pressed="mode === 'reading'"
              :class="{ active: mode === 'reading' }"
              @click="switchMode('reading')"
            >
              阅读</button
            ><button
              type="button"
              :disabled="loading || !state"
              :aria-pressed="mode === 'preview'"
              :class="{ active: mode === 'preview' }"
              @click="switchMode('preview')"
            >
              PNG 预览
            </button>
          </div>
        </nav>
      </div>
    </header>
    <div v-if="error" role="alert" class="diagram-document-error">
      {{ error }} <button :disabled="saving" @click="save">重试</button
      ><button :disabled="saving" @click="load">重新读取</button
      ><button @click="downloadDraft">下载草稿</button>
    </div>
    <DraftRecovery
      v-if="recovered"
      :draft="recovered"
      :base-changed="recovered.diagram?.documentHash !== state?.documentHash"
      @restore="restore"
      @discard="discard"
    />
    <div v-if="state" class="diagram-document-body" :inert="!!recovered">
      <MarkdownEditor
        v-if="mode === 'source'"
        :key="'markdown-' + mode"
        :model-value="state.markdown"
        :read-only="!editable"
        show-line-numbers
        @update:model-value="markdownEdit"
      />
      <template v-else-if="mode === 'design' && state.type === 'flowchart'"
        ><div class="diagram-flow-source">
          <div class="diagram-flow-heading">
            <span>Mermaid 流程图</span>
            <AButton size="small" type="text" :disabled="!editable"
              @click="
                nativeEdit(
                  'flowchart TD\n  A[开始] --> B{判断}\n  B -->|是| C[完成]\n  B -->|否| A\n',
                )
              "
            >
              插入判断模板
            </AButton>
          </div>
          <MarkdownEditor
            :model-value="state.source"
            :read-only="!editable"
            show-line-numbers
            @update:model-value="nativeEdit"
          />
        </div>
        <div class="diagram-pg">
          <p>{{ dirty ? '源码未保存，显示最后完整预览' : 'PNG 预览' }}</p>
          <img v-if="preview" :src="preview" alt="最后完整流程图预览" /></div
      ></template>
      <div v-else-if="mode === 'design'" ref="mount" class="diagram-native-mount"></div>
      <article
        v-else-if="mode === 'reading'"
        class="diagram-reading"
        v-html="readingHtml"
      ></article>
      <div v-else class="diagram-pg">
        <p v-if="dirty || error">显示最后完整保存的预览</p>
        <img v-if="preview" :src="preview" :alt="state.title + ' 预览'" />
        <p v-else>预览暂不可用，原文已保留。</p>
      </div>
    </div>
    <div v-if="closing" class="diagram-document-close" role="dialog" aria-label="保留图形草稿">
      <p>当前图形尚未保存。</p>
      <button @click="closing = false">继续编辑</button><button @click="downloadDraft">下载草稿</button
      ><button :disabled="saving" @click="abandon">放弃修改并返回</button>
    </div>
  </section>
</template>
<style scoped>
.diagram-document-workspace {
  display: flex;
  flex: 1;
  min-width: 0;
  min-height: 0;
  flex-direction: column;
  background: var(--panel, #fff);
  position: relative;
}
.diagram-document-workspace.embedded {
  position: fixed;
  inset: 0;
  z-index: 1600;
  container: document-area / inline-size;
}
.diagram-document-kind {
  display: inline-flex;
  flex: 0 0 auto;
  align-items: center;
  gap: 7px;
  color: var(--muted);
  font-size: 12px;
}
.save-state.has-error {
  color: var(--ui-danger-text);
}
.diagram-document-menu {
  max-height: calc(100dvh - 100px);
  overflow-y: auto;
}
.diagram-document-error button,
.diagram-document-close button {
  border: 1px solid var(--border, #ddd);
  border-radius: var(--ui-radius, 8px);
  padding: 6px 10px;
  background: var(--surface, #fafafa);
  color: var(--text, #333);
  cursor: pointer;
}
.diagram-document-error button:disabled,
.diagram-document-close button:disabled {
  opacity: 0.5;
  cursor: default;
}
.diagram-document-body {
  flex: 1;
  min-width: 0;
  min-height: 0;
  display: flex;
  overflow: hidden;
}
.diagram-native-mount {
  width: 100%;
  height: 100%;
  min-height: 0;
}
/* Native canvas controls need vertical room even in short landscape windows.
   Keep the surrounding document body scrollable when that room exceeds it. */
@media (max-width: 960px) and (max-height: 500px) {
  .diagram-document-body:has(.diagram-native-mount) { overflow: auto; }
  .diagram-native-mount { flex: 0 0 auto; min-height: 360px; }
}
.diagram-document-body > :deep(.markdown-editor) {
  flex: 1;
  min-width: 0;
  height: 100%;
}
.diagram-reading {
  flex: 1;
  overflow: auto;
  padding: 24px;
  line-height: 1.75;
}
.diagram-reading :deep(img) {
  max-width: 100%;
  height: auto;
}
.diagram-pg {
  flex: 1;
  overflow: auto;
  padding: 24px;
  text-align: center;
}
.diagram-pg img {
  max-width: 100%;
  height: auto;
}
.diagram-flow-source {
  display: flex;
  flex-direction: column;
  width: 48%;
  min-width: 0;
  border-right: 1px solid var(--border);
}
.diagram-flow-heading {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  min-height: 44px;
  padding: 8px 16px;
  border-bottom: 1px solid var(--border);
  color: var(--muted);
  font-size: 12px;
}
.diagram-flow-source :deep(.markdown-editor) {
  flex: 1;
  min-height: 0;
}
.diagram-document-error {
  padding: 10px 18px;
  background: color-mix(in srgb, var(--todo-danger) 8%, var(--panel));
  color: var(--ui-danger-text);
}
.diagram-document-close {
  position: absolute;
  top: 50%;
  left: 50%;
  transform: translate(-50%, -50%);
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  box-sizing: border-box;
  width: min(520px, calc(100% - 24px));
  max-height: calc(100% - 24px);
  overflow: auto;
  overscroll-behavior: contain;
  background: var(--panel, #fff);
  padding: 24px;
  border: 1px solid var(--border);
  border-radius: var(--ui-radius, 8px);
  box-shadow: 0 0 0 100vmax #0004;
  z-index: 5;
}
.diagram-document-close p {
  flex: 1 1 100%;
  margin: 0 0 8px;
  overflow-wrap: anywhere;
}
.diagram-document-close button {
  min-height: 36px;
  max-width: 100%;
}
@container document-area (max-width: 360px) {
  .diagram-document-close {
    padding: 16px;
  }
  .diagram-document-close button {
    flex: 1 1 100%;
  }
}
@container document-area (max-width: 700px) {
  .diagram-document-body:has(.diagram-flow-source) {
    flex-direction: column;
  }
  .diagram-flow-source {
    flex: 1;
    width: 100%;
    min-height: 0;
    border-right: 0;
    border-bottom: 1px solid var(--border);
  }
}
</style>
