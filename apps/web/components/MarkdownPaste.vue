<script setup lang="ts">
import { ref } from 'vue';
import { Modal as AModal } from 'ant-design-vue';
import { convertClipboard } from '../editor/clipboard';
defineProps<{ readOnly?: boolean }>();
const emit = defineEmits<{ insert: [markdown: string]; close: [] }>();
const text = ref('');
function insert() {
  const converted = convertClipboard({ text: text.value, mode: 'markdown' });
  if (converted.kind === 'supported') emit('insert', converted.markdown);
}
</script>

<template>
  <AModal :open="true" title="按 Markdown 粘贴" :width="620" :footer="null" @cancel="emit('close')">
    <form class="markdown-paste" @submit.prevent="insert">
      <p>粘贴 Markdown 后插入，标题、列表和代码块会转换为正文格式。暂不支持的语法会保留原文。</p>
      <label for="markdown-paste-content">Markdown 内容</label>
      <textarea
        id="markdown-paste-content"
        v-model="text"
        :readonly="readOnly"
        rows="10"
        autofocus
        placeholder="# 标题&#10;&#10;在这里粘贴 Markdown…"
      />
      <div class="markdown-paste-actions">
        <button type="button" class="btn" @click="emit('close')">取消</button>
        <button type="submit" class="btn primary" :disabled="readOnly || !text.trim()">
          插入 Markdown
        </button>
      </div>
    </form>
  </AModal>
</template>

<style scoped>
.markdown-paste p {
  color: var(--muted);
  font-size: 13px;
  line-height: 1.7;
  margin: 0 0 14px;
}
.markdown-paste label {
  display: block;
  margin-bottom: 8px;
  color: var(--text);
}
.markdown-paste textarea {
  box-sizing: border-box;
  width: 100%;
  resize: vertical;
  min-height: 180px;
  max-height: 55vh;
  padding: 12px;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--panel);
  color: var(--text);
  font:
    13px/1.7 ui-monospace,
    monospace;
}
.markdown-paste-actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  margin-top: 18px;
}
</style>
