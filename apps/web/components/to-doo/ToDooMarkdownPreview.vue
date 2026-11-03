<script setup lang="ts">
import { computed } from 'vue';
import MarkdownIt from 'markdown-it';
import DOMPurify from 'dompurify';
import { knowledgeMarkdown } from '../../../../shared/knowledge-markdown';

const props = defineProps<{ content: string }>();
const markdown = new MarkdownIt({ html: false, linkify: true }).use(knowledgeMarkdown);
const html = computed(() => DOMPurify.sanitize(markdown.render(props.content)));
</script>

<template>
  <section
    class="todo-markdown-preview"
    role="region"
    aria-label="成果正文预览"
    v-html="html"
  ></section>
</template>

<style scoped>
.todo-markdown-preview {
  max-height: min(44dvh, 460px);
  min-height: 160px;
  overflow: auto;
  overflow-wrap: anywhere;
  padding: 12px 16px;
  border: 1px solid var(--todo-line);
  border-radius: var(--todo-radius);
  background: var(--todo-paper);
  color: var(--todo-ink);
  font-size: 14px;
  line-height: 1.7;
}
.todo-markdown-preview :deep(:first-child) {
  margin-top: 0;
}
.todo-markdown-preview :deep(:last-child) {
  margin-bottom: 0;
}
.todo-markdown-preview :deep(h1) {
  font-size: 24px;
}
.todo-markdown-preview :deep(h2) {
  font-size: 20px;
}
.todo-markdown-preview :deep(h3) {
  font-size: 17px;
}
.todo-markdown-preview :deep(pre),
.todo-markdown-preview :deep(table) {
  max-width: 100%;
  overflow: auto;
}
.todo-markdown-preview :deep(img) {
  max-width: 100%;
  height: auto;
}
.todo-markdown-preview :deep(a) {
  color: var(--todo-accent);
}
</style>
