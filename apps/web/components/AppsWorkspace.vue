<script setup lang="ts">
import { watch } from 'vue';
import Icon from './Icon.vue';
import BlogWorkspace from './BlogWorkspace.vue';
import type { TreeEntry } from '../../../shared/contracts';
import type { BlogSection, BlogWorkbench } from '../blog-workbench';
import '../blog.css';
const props = defineProps<{
  app?: 'blog';
  section: BlogSection;
  tree: TreeEntry[];
  model: BlogWorkbench;
}>();
const emit = defineEmits<{
  navigate: [app: 'blog' | undefined, section?: BlogSection];
  'open-note': [id: string];
}>();
watch(
  () => props.app,
  (app) => {
    if (app === 'blog') void props.model.load();
  },
  { immediate: true },
);
</script>
<template>
  <BlogWorkspace
    v-if="app === 'blog'"
    :section="section"
    :tree="tree"
    :model="model"
    @section="emit('navigate', 'blog', $event)"
    @back="emit('navigate', undefined)"
    @open-note="emit('open-note', $event)"
  />
  <section v-else class="apps-home" aria-labelledby="apps-title">
    <div class="apps-eyebrow">YOUR WORKSPACE, EXTENDED</div>
    <h1 id="apps-title">应用</h1>
    <p class="apps-description">让知识走得更远。为你的笔记，打开新的可能。</p>
    <div class="apps-grid">
      <button class="app-card" type="button" @click="emit('navigate', 'blog', 'overview')">
        <div class="app-card-top">
          <span class="blog-app-icon"><Icon name="book" :size="28" /></span
          ><span class="app-native">原生应用</span>
        </div>
        <h2>博客</h2>
        <p>把值得分享的笔记，变成你的个人博客。</p>
        <div class="app-card-preview" aria-hidden="true">
          <span class="app-preview-dot"></span><span></span><span></span>
          <div></div>
          <i></i><i></i><i></i>
        </div>
        <div class="app-card-bottom">
          <span>选稿 · 预览 · 手动发布</span><Icon name="forward" :size="18" />
        </div>
      </button>
    </div>
    <p class="apps-footnote">
      <Icon name="lock" :size="14" /> 由你决定哪些内容公开，原稿始终留在知识库。
    </p>
  </section>
</template>
