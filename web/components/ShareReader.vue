<script setup lang="ts">
import { ref, onMounted } from 'vue';
import DOMPurify from 'dompurify';
import { api } from '../api';
import Icon from './Icon.vue';
import MarkdownIt from 'markdown-it';
const props = defineProps<{ token: string }>();
const doc = ref<any>(),
  error = ref('');
const large = ref(false),
  nextCursor = ref<string>(),
  loading = ref(false);
async function readPage(cursor?: string) {
  loading.value = true;
  try {
    let result: any;
    for (let i = 0; i < 60; i++) {
      result = await api(
        `/api/public/shares/${encodeURIComponent(props.token)}/read`,
        'POST',
        cursor ? { cursor } : {},
      );
      if (result.kind === 'ready') break;
      if (!['queued', 'running'].includes(result.operation.status)) throw new Error();
      await new Promise((r) => setTimeout(r, 1000));
    }
    if (result.kind !== 'ready') throw new Error();
    const page = result.data,
      md = new MarkdownIt({ html: false, linkify: true });
    md.renderer.rules.image = (tokens, index) => md.utils.escapeHtml(tokens[index].content);
    doc.value = {
      title: doc.value?.title || page.content.match(/^#\s+(.+)$/m)?.[1] || '分享笔记',
      updatedAt: new Date(Number(BigInt(page.modifiedAt) / 1000000n)).toISOString(),
      html: DOMPurify.sanitize(md.render(page.content)),
      headings: [],
    };
    nextCursor.value = page.nextCursor;
  } catch {
    error.value = '分享不存在或已取消';
  } finally {
    loading.value = false;
  }
}
onMounted(async () => {
  const meta = document.createElement('meta');
  meta.name = 'robots';
  meta.content = 'noindex, nofollow';
  document.head.append(meta);
  try {
    const meta = await api(`/api/public/shares/${encodeURIComponent(props.token)}/meta`);
    if (meta.editorMode !== 'full') {
      large.value = true;
      await readPage();
    } else doc.value = await api(`/api/public/shares/${encodeURIComponent(props.token)}`);
    doc.value.html = DOMPurify.sanitize(doc.value.html);
    document.title = `${doc.value.title} · DooKnow 分享`;
  } catch {
    error.value = '分享不存在或已取消';
  }
});
</script>
<template>
  <div class="share-page">
    <header class="reader-header">
      <div class="brand"><Icon name="book" :size="30" /><strong>DooKnow</strong></div>
      <span>分享笔记</span><span class="read-only"><Icon name="eye" :size="17" />只读</span>
    </header>
    <div v-if="error" class="share-error">
      <Icon name="lock" :size="40" />
      <h1>{{ error }}</h1>
      <p>请向笔记主人获取有效链接。</p>
    </div>
    <div v-else-if="doc" class="reader-layout">
      <article>
        <h1 class="reader-title">{{ doc.title }}</h1>
        <p class="muted">
          更新于
          {{ new Date(doc.updatedAt).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' }) }}
        </p>
        <div class="markdown" v-html="doc.html"></div>
        <p v-if="large">正在阅读当前片段</p>
        <button v-if="nextCursor" :disabled="loading" @click="readPage(nextCursor)">
          下一片段
        </button>
      </article>
      <nav class="reader-toc" aria-label="本文目录">
        <b>本文目录</b><a v-for="h in doc.headings" :key="h.id" :href="`#${h.id}`">{{ h.text }}</a>
      </nav>
    </div>
    <footer>由 DooKnow 分享　｜　内容随原笔记保存同步更新</footer>
  </div>
</template>
