<script setup lang="ts">
import { watch, ref, defineAsyncComponent } from 'vue';
import Icon from './Icon.vue';
import BlogWorkspace from './BlogWorkspace.vue';
import type { TreeEntry } from '../../../shared/contracts';
import type { BlogSection, BlogWorkbench } from '../blog-workbench';
import type { ToDooAppSection, WorkspaceRoute } from '../navigation';
import '../blog.css';
const ToDooWorkspace = defineAsyncComponent(() => import('./ToDooWorkspace.vue'));
type Selection = Pick<WorkspaceRoute, 'task' | 'list' | 'date' | 'calendarView'>;
const toDooRef = ref<{ hasUnsavedChanges(): boolean; requestLeave(): Promise<boolean> }>();
const props = defineProps<{
  app?: 'blog' | 'to-doo';
  section: BlogSection | ToDooAppSection;
  selection?: Selection;
  tree: TreeEntry[];
  model: BlogWorkbench;
}>();
const emit = defineEmits<{
  navigate: [app: 'blog' | 'to-doo' | undefined, section?: BlogSection | ToDooAppSection, selection?: Selection];
  'open-note': [id: string];
  'note-created': [id: string];
}>();
defineExpose({
  hasUnsavedChanges: () => props.app === 'to-doo' && !!toDooRef.value?.hasUnsavedChanges(),
  requestLeave: async () => props.app !== 'to-doo' || !toDooRef.value || await toDooRef.value.requestLeave(),
});
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
    :section="section as BlogSection"
    :tree="tree"
    :model="model"
    @section="emit('navigate', 'blog', $event)"
    @back="emit('navigate', undefined)"
    @open-note="emit('open-note', $event)"
  />
  <ToDooWorkspace
    v-else-if="app === 'to-doo'"
    ref="toDooRef"
    :section="section as ToDooAppSection"
    :selection="selection"
    :tree="tree"
    @navigate="(next, value) => emit('navigate', 'to-doo', next, value)"
    @open-note="emit('open-note', $event)"
    @back="emit('navigate', undefined)"
    @note-created="emit('note-created', $event)"
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
      <button class="app-card" type="button" @click="emit('navigate', 'to-doo', 'overview')">
        <div class="app-card-top">
          <span class="blog-app-icon"><Icon name="task" :size="28" /></span>
          <span class="app-native">原生应用</span>
        </div>
        <h2>To Doo</h2>
        <p>带着资料做事，把每一步成果留下来。</p>
        <div class="app-card-preview" aria-hidden="true">
          <span class="app-preview-dot"></span><span></span><span></span>
          <div></div><i></i><i></i><i></i>
        </div>
        <div class="app-card-bottom">
          <span>目标 · 任务 · 日程 · 专注</span><Icon name="forward" :size="18" />
        </div>
      </button>
    </div>
    <p class="apps-footnote">
      <Icon name="lock" :size="14" /> 资料与应用数据由你掌握，公开分享由你决定。
    </p>
  </section>
</template>
