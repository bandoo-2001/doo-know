<script setup lang="ts">
import { createApp, h, onBeforeUnmount, onMounted, ref, shallowRef, type App } from 'vue';
import { createI18n } from 'vue-i18n';
import {
  PowerPointViewer,
  type PowerPointViewerExpose,
  type ViewerLoadDetail,
} from 'pptx-vue-viewer/viewer';
import { keyToLabel, toVueI18nSyntax, translationsEn } from 'pptx-vue-viewer/i18n';
import { translationsZhCN } from 'pptx-vue-viewer/i18n/zh-CN';
import viewerStyles from 'pptx-vue-viewer/styles.css?inline';

const props = defineProps<{ bytes: ArrayBuffer; name: string }>();
const emit = defineEmits<{ ready: []; error: [message: string] }>();
const host = ref<HTMLElement>();
const deck = shallowRef<PowerPointViewerExpose>();
const slide = ref(0);
const count = ref(0);
let viewer: App | undefined;
onMounted(() => {
  // Isolate the slide renderer's CSS reset and language plugin from the main app.
  const root = host.value!.attachShadow({ mode: 'open' });
  const style = document.createElement('style');
  style.textContent = viewerStyles;
  const container = document.createElement('div');
  container.style.height = '100%';
  root.append(style, container);
  const i18n = createI18n({
    legacy: false,
    locale: 'zh-CN',
    fallbackLocale: 'en',
    messages: { 'zh-CN': toVueI18nSyntax(translationsZhCN), en: translationsEn },
    missing: (_locale, key) => keyToLabel(key),
  });
  viewer = createApp({
    render: () =>
      h(PowerPointViewer, {
        ref: deck,
        content: props.bytes,
        filePath: props.name,
        canEdit: false,
        readOnly: true,
        autosave: false,
        showToolbar: false,
        showThumbnails: true,
        googleFonts: false,
        'onActive-slide-change': (index: number) => {
          slide.value = index;
        },
        onLoad: (result: ViewerLoadDetail) => {
          count.value = result.slideCount;
          emit('ready');
        },
        onError: (message: string) => emit('error', message),
      }),
  });
  viewer.config.errorHandler = (error) =>
    emit('error', error instanceof Error ? error.message : '无法预览幻灯片');
  viewer.use(i18n).mount(container);
});
onBeforeUnmount(() => viewer?.unmount());
</script>
<template>
  <div class="slides">
    <nav aria-label="幻灯片翻页">
      <button type="button" :disabled="slide <= 0" @click="deck?.goPrev()">上一页</button>
      <span role="status">{{ count ? slide + 1 : 0 }} / {{ count }}</span>
      <button type="button" :disabled="slide + 1 >= count" @click="deck?.goNext()">下一页</button>
    </nav>
    <div ref="host" class="slide-host"></div>
  </div>
</template>
<style scoped>
.slides {
  display: flex;
  flex-direction: column;
  height: 100%;
}
nav {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 8px 12px;
  border-bottom: 1px solid var(--border);
}
button {
  padding: 4px 8px;
  color: var(--text);
  background: var(--panel);
  border: 1px solid var(--border);
  border-radius: 5px;
}
button:disabled {
  opacity: 0.5;
}
.slide-host {
  display: block;
  flex: 1;
  min-height: 0;
}
</style>
