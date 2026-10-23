<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue';
import { Modal as AModal } from 'ant-design-vue';
import { filterEditorSnippets, type EditorSnippet } from '../../../shared/editor-snippets';

const props = defineProps<{ open: boolean; readOnly?: boolean }>();
const emit = defineEmits<{ insert: [snippet: EditorSnippet]; close: [] }>();
const query = ref('');
const active = ref(0);
const search = ref<HTMLInputElement>();
const choices = computed(() => filterEditorSnippets(query.value));
watch(query, () => {
  active.value = 0;
});
watch(
  () => props.open,
  async (open) => {
    if (!open) return;
    query.value = '';
    active.value = 0;
    await nextTick();
    search.value?.focus();
  },
);
function choose(item: EditorSnippet) {
  if (props.readOnly) return;
  emit('insert', item);
}
function keydown(event: KeyboardEvent) {
  if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
    event.preventDefault();
    const length = choices.value.length;
    if (length)
      active.value = (active.value + (event.key === 'ArrowDown' ? 1 : length - 1)) % length;
    nextTick(() =>
      document
        .getElementById(`editor-insert-${choices.value[active.value]?.id}`)
        ?.scrollIntoView({ block: 'nearest' }),
    );
  } else if (event.key === 'Enter' && choices.value[active.value]) {
    event.preventDefault();
    choose(choices.value[active.value]);
  }
}
</script>

<template>
  <AModal :open="open" title="快捷插入" :width="460" :footer="null" @cancel="emit('close')">
    <div class="editor-insert-menu" @keydown="keydown">
      <input
        ref="search"
        v-model="query"
        type="search"
        aria-label="搜索插入内容"
        aria-controls="editor-insert-options"
        :aria-activedescendant="choices.length ? `editor-insert-${choices[active]?.id}` : undefined"
        placeholder="搜索公式、脚注、表格…"
        autocomplete="off"
      />
      <div
        id="editor-insert-options"
        class="editor-insert-options"
        role="listbox"
        aria-label="可插入内容"
      >
        <button
          v-for="(item, index) in choices"
          :id="`editor-insert-${item.id}`"
          :key="item.id"
          type="button"
          role="option"
          :aria-selected="index === active"
          :disabled="readOnly"
          @mouseenter="active = index"
          @focus="active = index"
          @click="choose(item)"
        >
          <strong>{{ item.label }}</strong
          ><span>{{ item.description }}</span>
        </button>
        <p v-if="!choices.length">没有匹配的内容</p>
      </div>
    </div>
  </AModal>
</template>

<style scoped>
.editor-insert-menu > input {
  box-sizing: border-box;
  width: 100%;
  padding: 10px 12px;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: var(--panel, #fff);
  color: var(--text);
  font: inherit;
}
.editor-insert-options {
  max-height: min(50vh, 430px);
  margin-top: 10px;
  overflow-y: auto;
}
.editor-insert-options button {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 4px;
  width: 100%;
  padding: 10px 12px;
  border: 0;
  border-radius: 6px;
  background: transparent;
  color: var(--text);
  text-align: left;
  cursor: pointer;
}
.editor-insert-options button[aria-selected='true'],
.editor-insert-options button:hover {
  background: var(--blue-soft);
}
.editor-insert-options button:focus-visible {
  outline: 2px solid var(--focus, #4566c6);
  outline-offset: -2px;
}
.editor-insert-options button:disabled {
  opacity: 0.5;
  cursor: default;
}
.editor-insert-options span,
.editor-insert-options p {
  color: var(--muted);
  font-size: 12px;
}
</style>
