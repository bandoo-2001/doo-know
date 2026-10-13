<script setup lang="ts">
import { ref, onMounted } from 'vue';
import DOMPurify from 'dompurify';
import { api } from '../api';
import Icon from './Icon.vue';
const props = defineProps<{ token: string }>();
const doc = ref<any>(),
  error = ref('');
onMounted(async () => {
  const meta = document.createElement('meta');
  meta.name = 'robots';
  meta.content = 'noindex, nofollow';
  document.head.append(meta);
  try {
    doc.value = await api(`/api/public/shares/${encodeURIComponent(props.token)}`);
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
      </article>
      <nav class="reader-toc" aria-label="本文目录">
        <b>本文目录</b><a v-for="h in doc.headings" :key="h.id" :href="`#${h.id}`">{{ h.text }}</a>
      </nav>
    </div>
    <footer>由 DooKnow 分享　｜　内容随原笔记保存同步更新</footer>
  </div>
</template>
