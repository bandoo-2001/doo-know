<script setup lang="ts">
import type { MarkdownAction, MarkdownToolbarState } from '../markdown-format';
import HeadingPicker from './HeadingPicker.vue';
import Icon from './Icon.vue';
import TablePicker from './TablePicker.vue';
import TextColorPicker from './TextColorPicker.vue';
const props = defineProps<{
  state: MarkdownToolbarState;
  disabled: boolean;
  label?: string;
  uploading?: boolean;
}>();
const emit = defineEmits<{
  format: [action: MarkdownAction];
  'insert-table': [rows: number, columns: number];
  upload: [];
  whiteboard: [];
  search: [];
  'insert-menu': [];
  properties: [];
  'paste-markdown': [];
  backlinks: [];
  'export-html': [];
  print: [];
}>();
function actionDisabled(action: MarkdownAction) {
  return props.disabled || !!props.state.disabledActions?.includes(action);
}
function format(action: MarkdownAction) {
  if (!actionDisabled(action)) emit('format', action);
}
const alignments = [
  { action: 'alignLeft', label: '左对齐', icon: 'align-left', value: 'left' },
  { action: 'alignCenter', label: '居中对齐', icon: 'align-center', value: 'center' },
  { action: 'alignRight', label: '右对齐', icon: 'align-right', value: 'right' },
] as const;
function color(value: string | null) {
  if (props.state.styleDisabled || actionDisabled('colorDefault')) return;
  format(value ? `color:${value as `#${string}`}` : 'colorDefault');
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
function heading(level: number) {
  if (!props.state.headingDisabled)
    format(level ? (`heading${level}` as MarkdownAction) : 'paragraph');
}
function insertTable(rows: number, columns: number) {
  if (!actionDisabled('table')) emit('insert-table', rows, columns);
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
    :aria-label="label || 'Markdown 格式'"
    @keydown="keydown"
    @mousedown="preserveSelection"
  >
    <div class="format-group">
      <HeadingPicker
        :value="state.heading"
        :disabled="disabled || !!state.headingDisabled"
        @select="heading"
      />
    </div>
    <span class="format-divider" aria-hidden="true"></span>
    <div class="format-group">
      <button
        type="button"
        aria-label="加粗"
        title="加粗 · Ctrl/Cmd+B"
        :aria-pressed="state.bold"
        :disabled="actionDisabled('bold') || state.code"
        @click="format('bold')"
      >
        <b>B</b>
      </button>
      <button
        type="button"
        aria-label="斜体"
        title="斜体 · Ctrl/Cmd+I"
        :aria-pressed="state.italic"
        :disabled="actionDisabled('italic') || state.code"
        @click="format('italic')"
      >
        <i>I</i>
      </button>
      <button
        type="button"
        aria-label="删除线"
        title="删除线"
        :aria-pressed="state.strike"
        :disabled="actionDisabled('strike') || state.code"
        @click="format('strike')"
      >
        <s>S</s>
      </button>
      <button
        type="button"
        aria-label="行内代码"
        title="行内代码"
        :aria-pressed="state.code"
        :disabled="actionDisabled('inlineCode')"
        @click="format('inlineCode')"
      >
        <Icon name="inline-code" :size="18" />
      </button>
      <button
        type="button"
        aria-label="清除格式"
        title="清除选中文字样式"
        :disabled="actionDisabled('clearFormatting') || state.styleDisabled"
        @click="format('clearFormatting')"
      >
        T×
      </button>
    </div>
    <span class="format-divider" aria-hidden="true"></span>
    <div class="format-group text-color-controls">
      <TextColorPicker
        :value="state.color"
        :disabled="actionDisabled('colorDefault') || state.styleDisabled"
        @select="color"
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
        :disabled="actionDisabled(item.action) || state.styleDisabled"
        @click="format(item.action)"
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
        :disabled="actionDisabled(item.action)"
        @click="format(item.action)"
      >
        <Icon :name="item.icon" :size="18" />
      </button>
    </div>
    <span class="format-divider" aria-hidden="true"></span>
    <div class="format-group">
      <template v-for="item in inserts" :key="item.action">
        <TablePicker
          v-if="item.action === 'table'"
          :disabled="actionDisabled('table')"
          @select="insertTable"
        />
        <button
          v-else
          type="button"
          :aria-label="item.label"
          :title="item.label"
          :disabled="actionDisabled(item.action) || (item.action === 'link' && state.code)"
          @click="format(item.action)"
        >
          <Icon :name="item.icon" :size="18" />
        </button>
      </template>
      <button
        type="button"
        aria-label="上传附件"
        :title="uploading ? '正在上传附件，请稍候' : '插入图片或 PDF'"
        :aria-busy="uploading || undefined"
        :disabled="disabled || uploading"
        @click="emit('upload')"
      >
        <Icon :name="uploading ? 'clock' : 'image'" :size="18" />
      </button>
      <span v-if="uploading" class="toolbar-upload-status" role="status">正在上传附件</span>
    </div>
    <div class="format-group">
      <button
        type="button"
        aria-label="插入白板"
        title="插入白板"
        :disabled="disabled"
        @click="emit('whiteboard')"
      >
        <Icon name="whiteboard" :size="17" />
      </button>
    </div>
    <span class="format-divider" aria-hidden="true"></span>
    <div class="format-group">
      <button
        type="button"
        aria-label="查找替换"
        title="查找替换 · Ctrl/Cmd+F"
        @click="emit('search')"
      >
        <Icon name="search" :size="18" />
      </button>
      <button
        type="button"
        aria-label="快捷插入"
        title="快捷插入"
        :disabled="disabled"
        @click="emit('insert-menu')"
      >
        ＋
      </button>
      <button
        type="button"
        aria-label="笔记属性"
        title="笔记属性"
        :disabled="disabled"
        @click="emit('properties')"
      >
        <Icon name="settings" :size="18" />
      </button>
      <button type="button" aria-label="按 Markdown 粘贴" title="按 Markdown 粘贴" :disabled="disabled" @click="emit('paste-markdown')">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 5H5v16h14V5h-4M9 3h6v4H9zM8 12h8M8 16h5" /></svg>
      </button>
      <button type="button" aria-label="反向引用" title="查看提及此笔记的链接" @click="emit('backlinks')">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m8 5-5 5 5 5M3 10h10a7 7 0 0 1 7 7v2M12 5h8" /></svg>
      </button>
      <button type="button" aria-label="导出 HTML" title="导出 HTML" @click="emit('export-html')">
        <svg
          width="18"
          height="18"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="1.7"
          stroke-linecap="round"
          stroke-linejoin="round"
          aria-hidden="true"
        >
          <path d="M12 3v13m-5-5 5 5 5-5M4 15v6h16v-6" />
        </svg>
      </button>
      <button type="button" aria-label="打印笔记" title="打印笔记" @click="emit('print')">
        <svg
          width="18"
          height="18"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="1.7"
          stroke-linecap="round"
          stroke-linejoin="round"
          aria-hidden="true"
        >
          <path d="M6 8V3h12v5M6 17H3V8h18v9h-3M6 14h12v7H6ZM17 11h1" />
        </svg>
      </button>
    </div>
  </div>
</template>
<style scoped>
.toolbar-upload-status {
  position: absolute;
  width: 1px;
  height: 1px;
  padding: 0;
  overflow: hidden;
  clip-path: inset(50%);
  white-space: nowrap;
}
</style>
