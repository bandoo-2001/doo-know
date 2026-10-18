<script setup lang="ts">
import type { MarkdownAction, MarkdownToolbarState } from '../markdown-format';
import Icon from './Icon.vue';
const props = defineProps<{ state: MarkdownToolbarState; disabled: boolean }>();
const emit = defineEmits<{ format: [action: MarkdownAction]; upload: [] }>();
const blocks = [
  { action: 'quote', label: '引用', icon: 'quote', state: 'quote' },
  { action: 'bulletList', label: '无序列表', icon: 'list', state: 'bullet' },
  { action: 'orderedList', label: '有序列表', icon: 'ordered', state: 'ordered' },
  { action: 'taskList', label: '任务列表', icon: 'task', state: 'task' },
  { action: 'indent', label: '增加缩进', icon: 'indent' },
  { action: 'outdent', label: '减少缩进', icon: 'outdent' },
] as const;
const inserts = [
  { action: 'link', label: '插入链接', icon: 'link' },
  { action: 'codeBlock', label: '代码块', icon: 'code' },
  { action: 'table', label: '插入表格', icon: 'table' },
  { action: 'rule', label: '分隔线', icon: 'rule' },
] as const;
function heading(event: Event) {
  const level = Number((event.target as HTMLSelectElement).value);
  emit('format', level ? (`heading${level}` as MarkdownAction) : 'paragraph');
}
function keydown(event: KeyboardEvent) {
  if (
    (event.target as HTMLElement).tagName === 'SELECT' ||
    !['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)
  )
    return;
  const controls = Array.from(
    (event.currentTarget as HTMLElement).querySelectorAll<HTMLElement>(
      'button:not(:disabled), select:not(:disabled)',
    ),
  );
  const index = controls.indexOf(event.target as HTMLElement);
  if (index < 0) return;
  event.preventDefault();
  const next =
    event.key === 'Home'
      ? 0
      : event.key === 'End'
        ? controls.length - 1
        : (index + (event.key === 'ArrowRight' ? 1 : -1) + controls.length) % controls.length;
  controls[next]?.focus();
}
function preserveSelection(event: MouseEvent) {
  if ((event.target as HTMLElement).closest('button')) event.preventDefault();
}
</script>
<template>
  <div
    class="format-toolbar"
    role="toolbar"
    aria-label="Markdown 格式"
    @keydown="keydown"
    @mousedown="preserveSelection"
  >
    <div class="format-group">
      <select
        class="heading-select"
        aria-label="段落格式"
        :value="state.heading"
        :disabled="disabled"
        @change="heading"
      >
        <option value="0">正文</option>
        <option v-for="level in 5" :key="level" :value="level">标题 {{ level }}</option>
      </select>
    </div>
    <span class="format-divider" aria-hidden="true"></span>
    <div class="format-group">
      <button
        type="button"
        aria-label="加粗"
        title="加粗 · Ctrl/Cmd+B"
        :aria-pressed="state.bold"
        :disabled="disabled || state.code"
        @click="emit('format', 'bold')"
      >
        <b>B</b>
      </button>
      <button
        type="button"
        aria-label="斜体"
        title="斜体 · Ctrl/Cmd+I"
        :aria-pressed="state.italic"
        :disabled="disabled || state.code"
        @click="emit('format', 'italic')"
      >
        <i>I</i>
      </button>
      <button
        type="button"
        aria-label="删除线"
        title="删除线"
        :aria-pressed="state.strike"
        :disabled="disabled || state.code"
        @click="emit('format', 'strike')"
      >
        <s>S</s>
      </button>
      <button
        type="button"
        aria-label="行内代码"
        title="行内代码"
        :aria-pressed="state.code"
        :disabled="disabled"
        @click="emit('format', 'inlineCode')"
      >
        <Icon name="inline-code" :size="18" />
      </button>
    </div>
    <span class="format-divider" aria-hidden="true"></span>
    <div class="format-group">
      <button
        v-for="item in blocks"
        :key="item.action"
        type="button"
        :aria-label="item.label"
        :title="item.label"
        :aria-pressed="'state' in item ? props.state[item.state] : undefined"
        :disabled="disabled"
        @click="emit('format', item.action)"
      >
        <Icon :name="item.icon" :size="18" />
      </button>
    </div>
    <span class="format-divider" aria-hidden="true"></span>
    <div class="format-group">
      <button
        v-for="item in inserts"
        :key="item.action"
        type="button"
        :aria-label="item.label"
        :title="item.label"
        :disabled="disabled || (item.action === 'link' && state.code)"
        @click="emit('format', item.action)"
      >
        <Icon :name="item.icon" :size="18" />
      </button>
      <button
        type="button"
        aria-label="上传附件"
        title="插入图片或 PDF"
        :disabled="disabled"
        @click="emit('upload')"
      >
        <Icon name="image" :size="18" />
      </button>
    </div>
  </div>
</template>
