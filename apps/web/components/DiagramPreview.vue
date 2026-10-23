<script setup lang="ts">
import { ref, computed, onMounted, onBeforeUnmount, watch } from 'vue';
import DOMPurify from 'dompurify';
import { api } from '../api';
import Icon from './Icon.vue';
import { parseWhiteboard, whiteboardId, whiteboardReference } from '../../../shared/whiteboard';
import { validateSvgSource } from '../../../shared/svg-policy';
import { isDiagramKind } from '../../../shared/diagram-fences';
import { hashDiagramCode } from '../../../shared/diagram-portability';
import {
  assertGeneratedSvgSafe,
  assertMermaidSourceSafe,
  preparePreview,
  hashDiagramSource,
} from '../diagrams/preview-artifact';
import { downloadBlob } from '../whiteboards/download';
const props = defineProps<{
  kind: string;
  code: string;
  noteId?: string;
  sourceId?: string;
  sourceLine?: number;
  previewCodeHash?: string;
  previewSourceHash?: string;
  shareToken?: string;
  readOnly?: boolean;
  editable?: boolean;
  scene?: string;
}>();
const svg = ref(''),
  svgImage = ref(''),
  error = ref(''),
  portableError = ref(''),
  loading = ref(true),
  generating = ref(false),
  title = ref('白板'),
  sourceVisible = ref(false),
  expanded = ref(false);
const canEdit = computed(() => !props.readOnly && !props.shareToken);
const canGenerate = computed(() => canEdit.value && props.editable === true);
const boardSource = ref('');
const stalePreview = ref(false);
const sourceText = computed(() =>
  props.kind === 'excalidraw' ? boardSource.value || props.scene || props.code : props.code,
);
let boardId = '',
  renderedSvg = '',
  epoch = 0,
  disposed = false;
let themeObserver: MutationObserver | undefined;
function releaseImage() {
  if (svgImage.value) URL.revokeObjectURL(svgImage.value);
  svgImage.value = '';
}
async function load() {
  const generation = ++epoch;
  const { kind, code, noteId, shareToken, scene: providedScene } = props;
  const current = () => !disposed && generation === epoch;
  loading.value = true;
  generating.value = false;
  error.value = '';
  portableError.value = '';
  boardId = '';
  boardSource.value = '';
  stalePreview.value = false;
  renderedSvg = '';
  svg.value = '';
  releaseImage();
  title.value = kind === 'svg' ? 'SVG 图形' : kind === 'mermaid' ? 'Mermaid 流程图' : '白板';
  try {
    if (props.previewCodeHash) {
      const changed = await hashDiagramCode(code) !== props.previewCodeHash;
      if (!current()) return;
      stalePreview.value = changed;
    }
    let markup = '',
      source = '',
      resolvedId = '',
      boardTitle = '';
    if (kind === 'svg') {
      const result = validateSvgSource(new TextEncoder().encode(code));
      if (!result.ok) throw Error(result.message);
      if (!current()) return;
      svgImage.value = URL.createObjectURL(
        new Blob([result.presentation], { type: 'image/svg+xml' }),
      );
      return;
    } else if (kind === 'mermaid') {
      assertMermaidSourceSafe(code);
      const { default: mermaid } = await import('mermaid');
      if (!current()) return;
      mermaid.initialize({
        startOnLoad: false,
        securityLevel: 'strict',
        suppressErrorRendering: true,
        theme: document.documentElement.dataset.theme === 'dark' ? 'dark' : 'default',
        maxTextSize: 50000,
        maxEdges: 500,
        flowchart: { htmlLabels: false },
        htmlLabels: false,
      });
      const result = await mermaid.render('dooknow-mermaid-' + crypto.randomUUID(), code);
      markup = result.svg;
      assertGeneratedSvgSafe(markup);
    } else if (kind === 'excalidraw') {
      let text = providedScene;
      if (text === undefined) {
        const reference = whiteboardReference(code);
        if (!reference) throw Error('白板引用格式不正确');
        let url: string;
        if (shareToken)
          url = `/api/public/shares/${encodeURIComponent(shareToken)}/whiteboards/${encodeURIComponent(reference)}`;
        else if (whiteboardId(reference)) url = '/api/notes/' + encodeURIComponent(reference);
        else if (noteId)
          url = `/api/notes/${encodeURIComponent(noteId)}/whiteboards/resolve?source=${encodeURIComponent(reference)}`;
        else throw Error('请从原笔记打开此白板引用');
        const board = await api(url);
        text = board.content;
        resolvedId = board.id;
        boardTitle = board.title;
      }
      const scene = parseWhiteboard(text!);
      source = text!;
      if (props.previewSourceHash) {
        const changed = await hashDiagramSource(source) !== props.previewSourceHash;
        if (!current()) return;
        stalePreview.value ||= changed;
      }
      markup = scene.elements.some((e) => !e.isDeleted)
        ? await (await import('../whiteboards/canvas')).sceneSvg(scene)
        : '';
      if (markup) assertGeneratedSvgSafe(markup, true);
    } else throw Error('不支持此图形格式');
    if (!current()) return;
    boardId = resolvedId;
    boardSource.value = source;
    if (boardTitle) title.value = boardTitle;
    renderedSvg = markup;
    svg.value = DOMPurify.sanitize(markup, {
      ADD_ATTR: ['xmlns'],
      FORBID_TAGS: ['script', 'iframe', 'foreignObject'],
      FORBID_ATTR: ['onload', 'onclick'],
    });
  } catch (e) {
    if (!disposed && generation === epoch) error.value = (e as Error).message;
  } finally {
    if (!disposed && generation === epoch) loading.value = false;
  }
}
function edit() {
  if (!canEdit.value || props.kind === 'svg') return;
  window.dispatchEvent(
    new CustomEvent('dooknow-open-whiteboard', {
      detail:
        props.kind === 'mermaid'
          ? { mermaid: props.code }
          : { id: boardId || whiteboardId(props.code) },
    }),
  );
}
function editSource() {
  if (!canEdit.value || !isDiagramKind(props.kind)) return;
  window.dispatchEvent(
    new CustomEvent('dooknow-edit-diagram-source', {
      detail: {
        kind: props.kind,
        code: props.code,
        ...(props.noteId ? { noteId: props.noteId } : {}),
        ...(props.sourceId ? { sourceId: props.sourceId } : {}),
        ...(props.sourceLine ? { sourceLine: props.sourceLine } : {}),
      },
    }),
  );
}
function downloadSource() {
  const extension =
    props.kind === 'excalidraw' ? 'excalidraw' : props.kind === 'svg' ? 'svg' : 'mmd';
  downloadBlob(
    new Blob([sourceText.value], {
      type: props.kind === 'svg' ? 'image/svg+xml' : 'text/plain;charset=utf-8',
    }),
    'diagram.' + extension,
  );
}
async function portable() {
  if (
    !canGenerate.value ||
    generating.value ||
    loading.value ||
    error.value ||
    !isDiagramKind(props.kind)
  )
    return;
  const generation = epoch,
    kind = props.kind,
    code = props.code,
    noteId = props.noteId;
  const sourceId = props.sourceId,
    sourceLine = props.sourceLine;
  const source = kind === 'excalidraw' ? boardSource.value : code;
  const currentBoardId = boardId;
  generating.value = true;
  portableError.value = '';
  try {
    const prepared = await preparePreview(
      kind === 'mermaid' ? { kind, source, svg: renderedSvg } : { kind, source },
    );
    if (disposed || generation !== epoch || !canGenerate.value || code !== props.code) return;
    window.dispatchEvent(
      new CustomEvent('dooknow-portable-diagram', {
        detail: {
          kind,
          code,
          ...(noteId ? { noteId } : {}),
          ...(sourceId ? { sourceId } : {}),
          ...(sourceLine ? { sourceLine } : {}),
          ...(kind === 'excalidraw'
            ? { boardId: currentBoardId || whiteboardId(code), sourceContent: source }
            : {}),
          png: prepared.preview,
        },
      }),
    );
  } catch (e) {
    if (!disposed && generation === epoch)
      portableError.value = '无法生成通用预览，源码已保留：' + (e as Error).message;
  } finally {
    if (!disposed && generation === epoch) generating.value = false;
  }
}
function updated(event: Event) {
  if (
    props.kind === 'excalidraw' &&
    (event as CustomEvent).detail?.id === (boardId || whiteboardId(props.code))
  )
    void load();
}
watch(
  () => [
    props.kind,
    props.code,
    props.scene,
    props.noteId,
    props.sourceId,
    props.sourceLine,
    props.previewCodeHash,
    props.previewSourceHash,
    props.shareToken,
    props.readOnly,
    props.editable,
  ],
  () => void load(),
  { flush: 'sync' },
);
onMounted(() => {
  void load();
  window.addEventListener('dooknow-whiteboard-saved', updated);
  themeObserver = new MutationObserver(() => {
    if (props.kind === 'mermaid') void load();
  });
  themeObserver.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ['data-theme'],
  });
});
onBeforeUnmount(() => {
  disposed = true;
  epoch++;
  releaseImage();
  themeObserver?.disconnect();
  window.removeEventListener('dooknow-whiteboard-saved', updated);
});
</script>
<template>
  <figure class="diagram-card" :class="{ 'is-expanded': expanded }" contenteditable="false">
    <figcaption>
      <span
        ><Icon :name="kind === 'excalidraw' ? 'whiteboard' : 'code'" :size="16" />{{ title }}</span
      >
      <div class="diagram-actions">
        <div class="diagram-view-tabs" role="group" aria-label="图形显示方式">
          <button type="button" :aria-pressed="!sourceVisible" @click="sourceVisible = false">
            预览
          </button>
          <button type="button" :aria-pressed="sourceVisible" @click="sourceVisible = true">
            源码
          </button>
        </div>
        <button type="button" :disabled="loading || !!error" @click="expanded = !expanded">
          {{ expanded ? '收起' : '放大' }}
        </button>
        <button v-if="canGenerate" type="button" @click="editSource">编辑源码</button>
        <button
          v-if="canEdit && kind !== 'svg'"
          type="button"
          :disabled="loading || !!error"
          @click="edit"
        >
          {{ kind === 'mermaid' ? '转换为白板' : '编辑设计' }}
        </button>
        <button
          v-if="canGenerate"
          type="button"
          :disabled="loading || !!error || generating"
          @click="portable"
        >
          {{ generating ? '正在生成…' : '生成通用预览' }}
        </button>
      </div>
    </figcaption>
    <div v-if="portableError" class="diagram-feedback" role="alert">{{ portableError }}</div>
    <div v-if="stalePreview" class="diagram-stale-preview" role="status">源码已更新，通用预览仍是旧版本。保存时可重新生成预览。</div>
    <div v-if="sourceVisible" class="diagram-source-panel">
      <button type="button" @click="downloadSource">下载源码</button>
      <pre class="diagram-source"><code>{{ sourceText }}</code></pre>
    </div>
    <div v-else-if="loading" class="diagram-state" role="status">正在载入图形…</div>
    <div v-else-if="error" class="diagram-state" role="alert">
      <p>{{ error }}</p>
      <button type="button" @click="load">重新加载</button>
    </div>
    <div v-else-if="svgImage" class="diagram-image"><img :src="svgImage" :alt="title" /></div>
    <div v-else-if="svg" class="diagram-image" v-html="svg"></div>
    <div v-else class="diagram-state">
      <Icon name="whiteboard" :size="36" />
      <p>空白画布，随时开始设计</p>
    </div>
  </figure>
</template>
<style>
.diagram-card {
  position: relative;
  display: block;
  overflow: hidden;
  max-width: 100%;
  margin: 18px 0;
  border: 1px solid var(--border, #e0e5ed);
  border-radius: 12px;
  background: var(--panel, #fff);
  color: var(--text, #263249);
  line-height: 1.6;
  font-size: 12px;
  user-select: none;
}
.diagram-card figcaption {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  padding: 10px 14px;
  border-bottom: 1px solid var(--border, #e0e5ed);
  background: var(--surface, #f7f8fb);
}
.diagram-card figcaption > span {
  display: flex;
  align-items: center;
  gap: 8px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.diagram-card figcaption > div {
  display: flex;
  gap: 5px;
  flex-shrink: 0;
  flex-wrap: wrap;
  justify-content: flex-end;
}
.diagram-view-tabs {
  display: inline-flex;
  gap: 3px;
}
.diagram-view-tabs button[aria-pressed='true'] {
  background: var(--surface, #f0f4ff);
  color: var(--text, #263249);
}
.diagram-feedback {
  padding: 10px 14px;
  color: var(--danger, #bc3030);
}
.diagram-stale-preview { padding: 10px 14px; color: var(--warning, #a16100); background: color-mix(in srgb, #f5b338 9%, transparent); }
.diagram-source-panel {
  padding: 12px;
  overflow: auto;
  min-height: 140px;
}
.diagram-source {
  margin: 10px 0 0;
  padding: 12px;
  overflow: auto;
  white-space: pre;
  user-select: text;
  font:
    12px/1.6 ui-monospace,
    monospace;
}
.diagram-card button {
  padding: 4px 9px;
  min-height: 28px;
  border: 1px solid var(--border, #dfe5ee);
  border-radius: 6px;
  background: var(--panel, #fff);
  color: var(--blue, #4566c6);
  font: inherit;
  cursor: pointer;
}
.diagram-card button:disabled {
  opacity: 0.5;
  cursor: default;
}
.diagram-card .diagram-image {
  display: flex;
  align-items: center;
  justify-content: center;
  min-height: 140px;
  padding: 24px;
  overflow: auto;
}
.diagram-card .diagram-image > svg,
.diagram-card .diagram-image > img {
  width: auto;
  height: auto;
  max-width: 100%;
  max-height: 420px;
  display: block;
}
.diagram-state {
  padding: 30px;
  text-align: center;
  color: var(--muted, #718096);
  min-height: 130px;
}
.diagram-state > svg {
  margin: auto;
}
.diagram-state p {
  font-size: 12px !important;
  margin: 10px 0 !important;
}
.diagram-card.is-expanded {
  position: fixed;
  inset: 20px;
  max-width: none;
  z-index: 1700;
  margin: 0;
  display: flex;
  flex-direction: column;
  box-shadow: 0 0 0 30px #0c192877;
}
.diagram-card.is-expanded .diagram-image {
  flex: 1;
  min-height: 0;
}
.diagram-card.is-expanded .diagram-image > svg,
.diagram-card.is-expanded .diagram-image > img {
  max-height: 100%;
  width: 100%;
  height: 100%;
  object-fit: contain;
}
.diagram-card.is-expanded .diagram-source-panel {
  flex: 1;
}
@media (max-width: 600px) {
  .diagram-card figcaption {
    padding: 9px 10px;
    flex-wrap: wrap;
  }
  .diagram-card figcaption > div {
    flex-shrink: 1;
    justify-content: flex-start;
  }
  .diagram-card .diagram-image {
    padding: 12px;
  }
  .diagram-card.is-expanded {
    inset: 8px;
  }
}
</style>
