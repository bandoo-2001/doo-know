<script setup lang="ts">
import { ref, onMounted } from 'vue';
import DOMPurify from 'dompurify';
import { api } from '../api';
import Icon from './Icon.vue';
import MarkdownIt from 'markdown-it';
import { NButton } from 'naive-ui';
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
    const tokens = md.parse(page.content, {});
    const visit = (items: typeof tokens) => {
      for (const token of items) {
        if (token.type === 'image' || token.type === 'link_open') {
          const attr = token.type === 'image' ? 'src' : 'href',
            url = String(token.attrGet(attr) || '');
          if (
            !url.startsWith('/') &&
            !url.includes('\\') &&
            !/^[a-z][a-z0-9+.-]*:/i.test(url) &&
            !url.startsWith('#')
          )
            token.attrSet(
              attr,
              `/api/public/shares/${encodeURIComponent(props.token)}/asset?source=${encodeURIComponent(url)}`,
            );
          else if (token.type === 'link_open' && /^https?:\/\//i.test(url)) {
            token.attrSet('rel', 'noopener noreferrer');
            token.attrSet('target', '_blank');
          } else if (!(token.type === 'link_open' && url.startsWith('#'))) token.attrSet(attr, '');
        }
        if (token.children) visit(token.children);
      }
    };
    visit(tokens);
    doc.value = {
      title: doc.value?.title || page.content.match(/^#\s+(.+)$/m)?.[1] || '分享笔记',
      updatedAt: new Date(Number(BigInt(page.modifiedAt) / 1000000n)).toISOString(),
      html: DOMPurify.sanitize(md.renderer.render(tokens, md.options, {})),
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
      if (meta.readState === 'ready') doc.value = { title: meta.title };
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
    <div v-if="error" class="share-error" role="alert">
      <div class="reader-state-icon"><Icon name="lock" :size="25" /></div>
      <h1>{{ error }}</h1>
      <p>请向笔记主人获取有效链接。</p>
    </div>
    <div v-else-if="doc" class="reader-layout" :class="{ 'has-toc': doc.headings?.length }">
      <article>
        <h1 class="reader-title">{{ doc.title }}</h1>
        <p v-if="doc.updatedAt" class="reader-meta">
          更新于
          {{ new Date(doc.updatedAt).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' }) }}
        </p>
        <div class="markdown" v-html="doc.html"></div>
        <div v-if="loading && !doc.html" class="reader-loading" role="status">正在读取笔记…</div>
        <p v-if="large" class="reader-fragment">正在阅读当前片段</p>
        <NButton
          v-if="nextCursor"
          :loading="loading"
          :disabled="loading"
          @click="readPage(nextCursor)"
        >
          下一片段
        </NButton>
      </article>
      <nav v-if="doc.headings?.length" class="reader-toc" aria-label="本文目录">
        <b>本文目录</b><a v-for="h in doc.headings" :key="h.id" :href="`#${h.id}`">{{ h.text }}</a>
      </nav>
    </div>
    <div v-else class="reader-loading" role="status">
      <div class="reader-state-icon"><Icon name="book" :size="25" /></div>
      <p>正在读取分享笔记…</p>
    </div>
    <footer>由 DooKnow 分享　｜　内容随原笔记保存同步更新</footer>
  </div>
</template>
<style scoped>
.share-page {
  min-height: 100dvh;
  display: flex;
  flex-direction: column;
  background: white;
  color: var(--text, #262b36);
}
.reader-header {
  display: flex;
  align-items: center;
  gap: 20px;
  min-height: 68px;
  padding: 16px max(32px, calc((100vw - 1160px) / 2));
  border-bottom: 1px solid var(--border, #e3e6ec);
  background: var(--surface-soft, #fafbfc);
}
.reader-header .brand {
  gap: 9px;
  color: var(--blue, #4566c6);
  font-size: 22px;
  letter-spacing: -0.6px;
}
.reader-header .brand svg {
  width: 26px;
  height: 26px;
}
.reader-header > span {
  padding-left: 20px;
  border-left: 1px solid var(--border, #e3e6ec);
  color: var(--muted, #7a8190);
  font-size: 12px;
}
.reader-header > .read-only {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-left: auto;
  padding: 4px 9px;
  border: 1px solid var(--border, #e3e6ec);
  border-radius: 5px;
  background: white;
  color: #6c7482;
  font-size: 11px;
  white-space: nowrap;
}
.reader-layout {
  display: block;
  width: 100%;
  max-width: 850px;
  margin: 0 auto;
  padding: 52px 40px 60px;
  flex: 1 0 auto;
}
.reader-layout.has-toc {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 180px;
  gap: 52px;
  max-width: 1100px;
}
.reader-layout article {
  min-width: 0;
}
.reader-title {
  margin: 0 0 14px;
  color: var(--text, #262b36);
  font-size: 32px;
  font-weight: 650;
  line-height: 1.5;
  letter-spacing: -0.7px;
  overflow-wrap: anywhere;
}
.reader-meta {
  margin: 0;
  padding-bottom: 24px;
  border-bottom: 1px solid var(--border, #e3e6ec);
  color: var(--muted, #7a8190);
  font-size: 12px;
  line-height: 1.8;
}
.reader-layout article > .markdown {
  padding: 24px 0 0;
  color: var(--text, #262b36);
  font-size: 15px;
  line-height: 1.95;
  overflow-wrap: anywhere;
}
.markdown :deep(h1),
.markdown :deep(h2),
.markdown :deep(h3),
.markdown :deep(h4) {
  color: var(--text, #262b36);
  font-weight: 650;
  line-height: 1.55;
}
.markdown :deep(h1:first-child) {
  display: none;
}
.markdown :deep(h2) {
  margin: 34px 0 14px;
  font-size: 23px;
}
.markdown :deep(h3) {
  margin: 28px 0 12px;
  font-size: 19px;
}
.markdown :deep(p) {
  margin: 14px 0;
}
.markdown :deep(a) {
  color: var(--blue, #4566c6);
  text-decoration-color: #bbc7e7;
  text-underline-offset: 3px;
}
.markdown :deep(blockquote) {
  margin: 24px 0;
  padding: 2px 0 2px 18px;
  border-left: 3px solid #dbe1ec;
  background: transparent;
  color: #727a88;
}
.markdown :deep(blockquote p) {
  margin: 5px 0;
}
.markdown :deep(img) {
  max-width: 100%;
  height: auto;
  border-radius: 6px;
}
.markdown :deep(pre) {
  max-width: 100%;
  margin: 20px 0;
  padding: 16px 18px;
  overflow-x: auto;
  border: 1px solid var(--border, #e3e6ec);
  border-radius: 7px;
  background: var(--surface-soft, #fafbfc);
  color: #4c5668;
  font-size: 13px;
  line-height: 1.8;
}
.markdown :deep(table) {
  display: block;
  max-width: 100%;
  overflow-x: auto;
  border-collapse: collapse;
  font-size: 14px;
}
.markdown :deep(th),
.markdown :deep(td) {
  padding: 10px 14px;
  border: 1px solid var(--border, #e3e6ec);
}
.markdown :deep(th) {
  background: var(--surface-soft, #fafbfc);
  font-weight: 500;
}
.markdown :deep(hr) {
  margin: 30px 0;
  border: 0;
  border-top: 1px solid var(--border, #e3e6ec);
}
.reader-toc {
  position: sticky;
  top: 28px;
  display: flex;
  align-self: start;
  flex-direction: column;
  gap: 12px;
  margin-top: 8px;
  padding-left: 20px;
  border-left: 1px solid var(--border, #e3e6ec);
  font-size: 12px;
  line-height: 1.7;
  overflow-wrap: anywhere;
}
.reader-toc b {
  margin-bottom: 4px;
  color: var(--muted, #7a8190);
  font-size: 11px;
  font-weight: 500;
}
.reader-toc a {
  color: #6c7482;
  text-decoration: none;
}
.reader-toc a:hover {
  color: var(--blue, #4566c6);
}
.reader-fragment {
  margin-top: 28px;
  color: var(--muted, #7a8190);
  font-size: 12px;
}
.share-page footer {
  margin: auto 32px 0;
  padding: 20px;
  border-top: 1px solid var(--border, #e3e6ec);
  color: var(--muted, #7a8190);
  font-size: 11px;
  line-height: 1.9;
  text-align: center;
}
.share-error,
.reader-loading {
  width: 100%;
  max-width: 560px;
  margin: auto;
  padding: 80px 24px;
  color: var(--muted, #7a8190);
  text-align: center;
}
.share-error h1 {
  margin: 24px 0 10px;
  color: var(--text, #262b36);
  font-size: 23px;
  font-weight: 600;
  line-height: 1.5;
}
.share-error p,
.reader-loading p {
  font-size: 13px;
  line-height: 1.9;
}
.reader-state-icon {
  display: grid;
  place-items: center;
  width: 52px;
  height: 52px;
  margin: 0 auto;
  border: 1px solid var(--border, #e3e6ec);
  border-radius: 10px;
  background: var(--surface-soft, #fafbfc);
  color: #7b8493;
}
@media (max-width: 720px) {
  .reader-header {
    min-height: 60px;
    padding: 14px 20px;
    gap: 14px;
  }
  .reader-header .brand {
    font-size: 20px;
  }
  .reader-header .brand svg {
    width: 24px;
    height: 24px;
  }
  .reader-header > span {
    padding-left: 14px;
    font-size: 11px;
  }
  .reader-header > .read-only {
    display: none;
  }
  .reader-layout,
  .reader-layout.has-toc {
    display: block;
    padding: 32px 22px 40px;
  }
  .reader-title {
    font-size: 26px;
  }
  .reader-toc {
    display: none;
  }
  .reader-layout article > .markdown {
    font-size: 14px;
    line-height: 1.95;
  }
  .markdown :deep(h2) {
    font-size: 21px;
  }
  .markdown :deep(h3) {
    font-size: 18px;
  }
  .share-page footer {
    margin: auto 22px 0;
    padding: 16px 0;
    font-size: 10px;
  }
}
</style>
