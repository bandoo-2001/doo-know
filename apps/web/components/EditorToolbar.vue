<script setup lang="ts">
import type { MarkdownAction, MarkdownToolbarState } from '../markdown-format';
import Icon from './Icon.vue';
import { textColors } from '../markdown-style';
const props = defineProps<{ state: MarkdownToolbarState; disabled: boolean }>();
const emit = defineEmits<{ format: [action: MarkdownAction]; upload: [] }>();
const alignments = [
  { action: 'alignLeft', label: '左对齐', icon: 'align-left', value: 'left' },
  { action: 'alignCenter', label: '居中对齐', icon: 'align-center', value: 'center' },
  { action: 'alignRight', label: '右对齐', icon: 'align-right', value: 'right' },
] as const;
function color(event: Event) {
  const value = (event.target as HTMLInputElement | HTMLSelectElement).value;
  emit('format', value ? `color:${value as `#${string}`}` : 'colorDefault');
}
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
    ['SELECT', 'INPUT'].includes((event.target as HTMLElement).tagName) ||
    !['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)
  )
    return;
  const controls = Array.from(
    (event.currentTarget as HTMLElement).querySelectorAll<HTMLElement>(
      'button:not(:disabled), select:not(:disabled), input:not(:disabled)',
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
    <div class="format-group text-color-controls">
      <span
        class="text-color-symbol"
        :style="{ borderColor: state.color || '#343c4a' }"
        aria-hidden="true"
        >A</span
      >
      <select
        class="text-color-select"
        aria-label="文字颜色"
        :value="state.color || ''"
        :disabled="disabled || state.styleDisabled"
        @change="color"
      >
        <option value="">默认颜色</option>
        <option v-for="item in textColors" :key="item.value" :value="item.value">
          {{ item.name }}
        </option>
        <option
          v-if="state.color && !textColors.some((item) => item.value === state.color)"
          :value="state.color"
        >
          自定义颜色
        </option>
      </select>
      <input
        class="custom-text-color"
        type="color"
        aria-label="自定义文字颜色"
        title="自定义文字颜色"
        :value="state.color || '#343c4a'"
        :disabled="disabled || state.styleDisabled"
        @change="color"
      />
    </div>
    <span class="format-divider" aria-hidden="true"></span>
    <div class="format-group">
      <button
        v-for="item in alignments"
        :key="item.action"
        type="button"
        :aria-label="item.label"
        :title="item.label"
        :aria-pressed="state.alignment === item.value"
        :disabled="disabled || state.styleDisabled"
        @click="emit('format', item.action)"
      >
        <Icon :name="item.icon" :size="18" />
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
