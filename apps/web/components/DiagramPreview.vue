<script setup lang="ts">
import { ref, onMounted, onBeforeUnmount, watch } from 'vue';
import DOMPurify from 'dompurify';
import { api } from '../api';
import Icon from './Icon.vue';
import { parseWhiteboard, whiteboardId, whiteboardReference } from '../../../shared/whiteboard';
const props = defineProps<{
  kind: string;
  code: string;
  noteId?: string;
  shareToken?: string;
  readOnly?: boolean;
  scene?: string;
}>();
const svg = ref(''),
  error = ref(''),
  loading = ref(true),
  title = ref('白板'),
  expanded = ref(false);
let boardId = '',
  epoch = 0,
  disposed = false;
let themeObserver: MutationObserver | undefined;
async function load() {
  const generation = ++epoch;
  loading.value = true;
  error.value = '';
  try {
    let markup: string;
    if (props.kind === 'mermaid') {
      if (props.code.length > 50000) throw Error('流程图内容过长，请精简后预览');
      const { default: mermaid } = await import('mermaid');
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
      const result = await mermaid.render('dooknow-mermaid-' + crypto.randomUUID(), props.code);
      markup = result.svg;
      title.value = 'Mermaid 流程图';
    } else {
      let text = props.scene;
      if (!text) {
        const reference = whiteboardReference(props.code);
        if (!reference) throw Error('白板引用格式不正确');
        let url: string;
        if (props.shareToken)
          url = `/api/public/shares/${encodeURIComponent(props.shareToken)}/whiteboards/${encodeURIComponent(reference)}`;
        else if (whiteboardId(reference)) url = '/api/notes/' + encodeURIComponent(reference);
        else if (props.noteId)
          url = `/api/notes/${encodeURIComponent(props.noteId)}/whiteboards/resolve?source=${encodeURIComponent(reference)}`;
        else throw Error('请从原笔记打开此白板引用');
        const board = await api(url);
        text = board.content;
        boardId = board.id;
        title.value = board.title;
      }
      const scene = parseWhiteboard(text!);
      markup = scene.elements.some((e) => !e.isDeleted)
        ? await (await import('../whiteboards/canvas')).sceneSvg(scene)
        : '';
    }
    if (disposed || generation !== epoch) return;
    svg.value = DOMPurify.sanitize(markup, {
      ADD_TAGS: ['foreignObject'],
      ADD_ATTR: ['xmlns'],
      FORBID_TAGS: ['script', 'iframe'],
      FORBID_ATTR: ['onload', 'onclick'],
    });
  } catch (e) {
    if (!disposed && generation === epoch) error.value = (e as Error).message;
  } finally {
    if (!disposed && generation === epoch) loading.value = false;
  }
}
function edit() {
  window.dispatchEvent(
    new CustomEvent('dooknow-open-whiteboard', {
      detail:
        props.kind === 'mermaid'
          ? { mermaid: props.code }
          : { id: boardId || whiteboardId(props.code) },
    }),
  );
}
function updated(event: Event) {
  if (
    props.kind !== 'mermaid' &&
    (event as CustomEvent).detail?.id === (boardId || whiteboardId(props.code))
  )
    void load();
}
watch(
  () => [props.code, props.scene],
  () => void load(),
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
  themeObserver?.disconnect();
  window.removeEventListener('dooknow-whiteboard-saved', updated);
});
</script>
<template>
  <figure class="diagram-card" :class="{ 'is-expanded': expanded }" contenteditable="false">
    <figcaption>
      <span><Icon :name="kind === 'mermaid' ? 'code' : 'whiteboard'" :size="16" />{{ title }}</span>
      <div>
        <button type="button" :disabled="loading || !!error" @click="expanded = !expanded">
          {{ expanded ? '收起' : '放大' }}
        </button>
        <button v-if="!readOnly" type="button" :disabled="loading || !!error" @click="edit">
          {{ kind === 'mermaid' ? '转换为白板' : '编辑设计' }}
        </button>
      </div>
    </figcaption>
    <div v-if="loading" class="diagram-state" role="status">正在载入图形…</div>
    <div v-else-if="error" class="diagram-state" role="alert">
      <p>{{ error }}</p>
      <button type="button" @click="load">重新加载</button>
    </div>
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
.diagram-card .diagram-image > svg {
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
.diagram-card.is-expanded .diagram-image > svg {
  max-height: 100%;
  width: 100%;
  height: 100%;
}
@media (max-width: 600px) {
  .diagram-card figcaption {
    padding: 9px 10px;
  }
  .diagram-card .diagram-image {
    padding: 12px;
  }
  .diagram-card.is-expanded {
    inset: 8px;
  }
}
</style>
