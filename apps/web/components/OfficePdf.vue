<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, shallowRef, watch } from 'vue';
import {
  getDocument,
  GlobalWorkerOptions,
  type PDFDocumentLoadingTask,
  type PDFDocumentProxy,
  type RenderTask,
} from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';

const props = defineProps<{ bytes: ArrayBuffer }>();
const emit = defineEmits<{ ready: []; error: [message: string] }>();
GlobalWorkerOptions.workerSrc = workerUrl;
const viewer = ref<HTMLElement>();
const paper = ref<HTMLElement>();
const pdf = shallowRef<PDFDocumentProxy>();
const page = ref(1);
const zoom = ref(1);
const width = ref(0);
let observer: ResizeObserver | undefined;
let task: PDFDocumentLoadingTask | undefined;
let rendering: RenderTask | undefined;
let generation = 0;
let closed = false;

function fail(error: unknown) {
  if (!closed) emit('error', error instanceof Error ? error.message : 'PDF 加载失败');
}
async function render() {
  const current = ++generation;
  rendering?.cancel();
  const document = pdf.value;
  if (!document || !paper.value || !width.value) return;
  try {
    const pdfPage = await document.getPage(page.value);
    if (current !== generation) return;
    const original = pdfPage.getViewport({ scale: 1 });
    const scale = (Math.max(100, width.value - 24) / original.width) * zoom.value;
    const viewport = pdfPage.getViewport({ scale });
    const density = Math.min(
      window.devicePixelRatio || 1,
      2,
      4096 / Math.max(viewport.width, viewport.height),
    );
    const canvas = window.document.createElement('canvas');
    canvas.width = Math.max(1, Math.ceil(viewport.width * density));
    canvas.height = Math.max(1, Math.ceil(viewport.height * density));
    canvas.style.width = viewport.width + 'px';
    canvas.style.height = viewport.height + 'px';
    canvas.setAttribute('aria-label', `PDF 第 ${page.value} 页`);
    rendering = pdfPage.render({ canvas, viewport, transform: [density, 0, 0, density, 0, 0] });
    await rendering.promise;
    if (current !== generation || closed) return;
    paper.value.replaceChildren(canvas);
    emit('ready');
  } catch (error) {
    if (current === generation) fail(error);
  }
}
watch([pdf, page, zoom, width], render);
onMounted(async () => {
  observer = new ResizeObserver(([entry]) => {
    width.value = Math.round(entry.contentRect.width);
  });
  observer.observe(viewer.value!);
  try {
    const assets = new URL('/assets/pdfjs/', window.location.href).href;
    task = getDocument({
      data: props.bytes,
      cMapUrl: assets + 'cmaps/',
      cMapPacked: true,
      standardFontDataUrl: assets + 'standard_fonts/',
      wasmUrl: assets + 'wasm/',
      iccUrl: assets + 'iccs/',
    });
    const loaded = await task.promise;
    if (!closed) pdf.value = loaded;
  } catch (error) {
    fail(error);
  }
});
onBeforeUnmount(() => {
  closed = true;
  generation++;
  observer?.disconnect();
  rendering?.cancel();
  void task?.destroy().catch(() => {});
});
</script>

<template>
  <div class="pdf-panel">
    <nav aria-label="PDF 阅读工具">
      <button type="button" :disabled="page <= 1" @click="page--">上一页</button>
      <span role="status">{{ page }} / {{ pdf?.numPages ?? '…' }}</span>
      <button type="button" :disabled="!pdf || page >= pdf.numPages" @click="page++">下一页</button>
      <label
        >缩放
        <select v-model="zoom">
          <option :value="0.75">75%</option>
          <option :value="1">适应宽度</option>
          <option :value="1.25">125%</option>
          <option :value="1.5">150%</option>
          <option :value="2">200%</option>
        </select></label
      >
    </nav>
    <div ref="viewer" class="pdf-scroll"><div ref="paper" class="pdf-paper"></div></div>
  </div>
</template>

<style scoped>
.pdf-panel {
  display: flex;
  flex-direction: column;
  height: 100%;
}
nav {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 12px;
  padding: 8px 12px;
  border-bottom: 1px solid var(--border);
}
nav button,
nav select {
  padding: 4px 8px;
  background: var(--panel);
  color: var(--text);
  border: 1px solid var(--border);
  border-radius: 5px;
}
nav button:disabled {
  opacity: 0.5;
}
.pdf-scroll {
  flex: 1;
  overflow: auto;
  scrollbar-gutter: stable;
}
.pdf-paper {
  width: max-content;
  margin: 12px auto;
}
.pdf-paper :deep(canvas) {
  display: block;
}
</style>
