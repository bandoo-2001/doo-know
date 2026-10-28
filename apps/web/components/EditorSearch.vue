<script setup lang="ts">
import { ref, onMounted } from 'vue';
defineProps<{
  query: string;
  replacement: string;
  caseSensitive: boolean;
  count: number;
  current: number;
  readOnly?: boolean;
}>();
const emit = defineEmits<{
  'update:query': [value: string];
  'update:replacement': [value: string];
  'update:caseSensitive': [value: boolean];
  next: [direction: number];
  replace: [all: boolean];
  close: [];
}>();
const input = ref<HTMLInputElement>();
defineExpose({ focus: () => input.value?.focus() });
onMounted(() => input.value?.focus());
</script>
<template>
  <section
    class="editor-search"
    role="search"
    aria-label="当前笔记查找"
    @keydown.esc.stop.prevent="emit('close')"
  >
    <label
      >查找<input
        ref="input"
        aria-label="查找内容"
        :value="query"
        @input="emit('update:query', ($event.target as HTMLInputElement).value)"
        @keydown.enter.prevent="emit('next', $event.shiftKey ? -1 : 1)"
    /></label>
    <span class="editor-search-count" aria-live="polite"
      >{{ count ? current + 1 : 0 }} / {{ count }}</span
    >
    <button type="button" aria-label="上一个匹配" :disabled="!count" @click="emit('next', -1)">
      ↑
    </button>
    <button type="button" aria-label="下一个匹配" :disabled="!count" @click="emit('next', 1)">
      ↓
    </button>
    <label class="editor-search-case"
      ><input
        type="checkbox"
        :checked="caseSensitive"
        @change="emit('update:caseSensitive', ($event.target as HTMLInputElement).checked)"
      />区分大小写</label
    >
    <label
      >替换<input
        aria-label="替换内容"
        :value="replacement"
        :disabled="readOnly"
        @input="emit('update:replacement', ($event.target as HTMLInputElement).value)"
    /></label>
    <button type="button" :disabled="readOnly || !count" @click="emit('replace', false)">
      替换当前
    </button>
    <button type="button" :disabled="readOnly || !count" @click="emit('replace', true)">
      全部替换
    </button>
    <button type="button" aria-label="关闭查找" @click="emit('close')">×</button>
  </section>
</template>
<style>
.editor-search {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 6px;
  padding: 8px 12px;
  border-bottom: 1px solid var(--border);
  background: var(--panel);
  color: var(--text);
  font-size: 12px;
  flex-shrink: 0;
}
.editor-search label {
  display: flex;
  align-items: center;
  gap: 6px;
}
.editor-search input:not([type='checkbox']) {
  width: 140px;
  max-width: 35vw;
  padding: 5px 8px;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: var(--surface-soft);
  color: var(--text);
}
.editor-search button {
  padding: 5px 8px;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: var(--panel);
  color: var(--text);
  cursor: pointer;
}
.editor-search button:disabled {
  opacity: 0.45;
  cursor: default;
}
.editor-search-case {
  white-space: nowrap;
}
.editor-search-count {
  min-width: 40px;
}
</style>
