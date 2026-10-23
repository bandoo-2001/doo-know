<script setup lang="ts">
import { defineAsyncComponent, ref, watch, onBeforeUnmount, nextTick } from 'vue';
import { createEditorSession } from '../editor/session';
import { textEdit, parseSource } from '../editor/source-codec';
import type {
  EditorKind,
  EditorHandle,
  ImageReplacementTarget,
  SelectionBookmark,
  TableAction,
} from '../editor/contracts';
import {
  emptyToolbarState,
  type MarkdownAction,
  type MarkdownToolbarState,
} from '../editor/toolbar-state';
const SourceEditor = defineAsyncComponent(() => import('./MarkdownEditor.vue'));
const DocumentEditor = defineAsyncComponent(() => import('./DocumentEditor.vue'));
const props = withDefaults(
  defineProps<{
    noteId: string;
    generation: number;
    modelValue: string;
    kind: EditorKind;
    readOnly?: boolean;
    visible?: boolean;
    initialLine?: number;
    showLineNumbers?: boolean;
    wrap?: boolean;
    resolveImage?: (url: string) => string | undefined;
  }>(),
  { visible: true, wrap: true },
);
const emit = defineEmits<{
  'update:modelValue': [value: string];
  'state-change': [state: MarkdownToolbarState];
  'line-change': [line: number];
  fallback: [reason: string];
  source: [offset: number];
  'open-link': [url: string];
  'upload-file': [file: File];
  'replace-image': [target: ImageReplacementTarget];
  composing: [value: boolean];
}>();
const session = createEditorSession({
  noteId: props.noteId,
  generation: props.generation,
  markdown: props.modelValue,
});
const source = ref<any>(),
  documentView = ref<any>(),
  warning = ref(''),
  hasMounted = ref(props.visible);
let lastState = emptyToolbarState();
let pendingFocus: SelectionBookmark | undefined;
let compositionTimer: ReturnType<typeof setTimeout> | undefined;
watch([source, documentView], async () => {
  await nextTick();
  const active = props.kind === 'document' ? documentView.value : source.value;
  if (active && pendingFocus) {
    const target = pendingFocus;
    pendingFocus = undefined;
    active.focus(target);
  }
});
watch(
  () => props.visible,
  (v) => {
    if (v) hasMounted.value = true;
    if (v) checkKind();
  },
);
function checkKind() {
  if (props.kind === 'document' && props.visible) {
    const d = parseSource(session.snapshot().markdown);
    if (!d.eligibility.allowed) {
      warning.value = d.eligibility.message || '请使用源码编辑';
      emit('fallback', warning.value);
    }
  }
}
checkKind();
watch(
  () => props.kind,
  () => {
    checkKind();
    session.sealHistory();
  },
);
watch(
  () => props.modelValue,
  (value) => {
    if (value !== session.snapshot().markdown) {
      session.replaceExternal(value);
      documentView.value?.load(value);
      report();
    }
  },
);
function report(state: MarkdownToolbarState = emptyToolbarState()) {
  emit('state-change', { ...state, canUndo: session.canUndo, canRedo: session.canRedo });
}
function publish(value: string) {
  emit('update:modelValue', value);
  report(documentView.value?.state?.() || undefined);
  if (new TextEncoder().encode(value).length > 262144) {
    warning.value = '内容已保留，笔记较大，请继续使用 Markdown 源码编辑';
    emit('fallback', warning.value);
  }
}
function sourceUpdated(value: string) {
  const current = session.snapshot();
  const b = source.value?.selection?.() || current.selection;
  const result = session.apply({
    noteId: props.noteId,
    generation: props.generation,
    baseRevision: current.revision,
    origin: 'source',
    edits: textEdit(current.markdown, value),
    selection: b,
  });
  if (result.ok) {
    warning.value = '';
    emit('update:modelValue', result.markdown);
    report(lastState);
  } else warning.value = result.message;
}
function sourceState(state: MarkdownToolbarState) {
  lastState = state;
  const b = source.value?.selection?.();
  if (b) session.setSelection(b);
  report(state);
}
function sourceCompositionStart() {
  if (props.kind === 'source') {
    session.setComposing(true);
    emit('composing', true);
  }
}
function sourceCompositionEnd() {
  if (props.kind === 'source') {
    clearTimeout(compositionTimer);
    compositionTimer = setTimeout(() => {
      session.setComposing(false);
      emit('composing', false);
    }, 0);
  }
}
async function flush() {
  if (props.kind === 'document' && documentView.value) return documentView.value.flush();
  const value = await session.flush();
  return value;
}
function format(action: MarkdownAction) {
  session.sealHistory();
  return props.kind === 'document'
    ? documentView.value?.format(action) || false
    : source.value?.format(action) || false;
}
function editHistory(action: 'undo' | 'redo') {
  if (props.readOnly) return false;
  if (props.kind === 'document') return documentView.value?.editHistory(action) || false;
  const result = session[action]();
  if (!result.ok) return false;
  emit('update:modelValue', result.markdown);
  report(lastState);
  void nextTick(() => source.value?.focus(result.selection));
  return true;
}
function keyboard(event: KeyboardEvent) {
  pendingFocus = undefined;
  if (
    !(event.ctrlKey || event.metaKey) ||
    event.altKey ||
    !['z', 'y'].includes(event.key.toLowerCase())
  )
    return;
  event.preventDefault();
  event.stopPropagation();
  editHistory(event.key.toLowerCase() === 'y' || event.shiftKey ? 'redo' : 'undo');
}
function cancelPendingFocus() {
  pendingFocus = undefined;
}
function focus(b?: SelectionBookmark) {
  const active = props.kind === 'document' ? documentView.value : source.value;
  if (active) active.focus(b);
  else pendingFocus = b || session.snapshot().selection;
}
function goToLine(line: number, align: 'start' | 'center' = 'center') {
  (props.kind === 'document' ? documentView.value : source.value)?.goToLine(line, align);
}
function selection(): SelectionBookmark {
  return (
    (props.kind === 'document' ? documentView.value : source.value)?.selection?.() ||
    session.snapshot().selection
  );
}
function insertAsset(markdown: string, target?: SelectionBookmark) {
  if (props.readOnly) return false;
  if (props.kind === 'document') return documentView.value?.insertAsset(markdown, target) || false;
  const current = session.snapshot();
  const b = target || selection();
  const from = Math.min(b.anchor, b.head),
    to = Math.max(b.anchor, b.head);
  session.sealHistory();
  const result = session.apply({
    noteId: props.noteId,
    generation: props.generation,
    baseRevision: current.revision,
    origin: 'source',
    edits: [{ from, to, insert: markdown }],
    selection: { anchor: from + markdown.length, head: from + markdown.length, affinity: 'after' },
  });
  session.sealHistory();
  if (!result.ok) {
    warning.value = result.message;
    return false;
  }
  warning.value = '';
  emit('update:modelValue', result.markdown);
  report(lastState);
  void nextTick(() => source.value?.focus(result.selection));
  return true;
}
function requestSource(offset: number) {
  emit('source', offset);
}
function insertTable(rows: number, columns: number) {
  if (
    props.readOnly ||
    !Number.isInteger(rows) ||
    !Number.isInteger(columns) ||
    rows < 1 ||
    rows > 20 ||
    columns < 1 ||
    columns > 10
  )
    return false;
  if (props.kind === 'document') return documentView.value?.insertTable(rows, columns) || false;
  const header = `| ${Array.from({ length: columns }, (_, i) => `标题 ${i + 1}`).join(' | ')} |`;
  const separator = `| ${Array(columns).fill('---').join(' | ')} |`;
  const body = `| ${Array(columns).fill('内容').join(' | ')} |`;
  return insertAsset(`\n${[header, separator, ...Array(rows - 1).fill(body)].join('\n')}\n`);
}
function replaceImage(target: ImageReplacementTarget, src: string) {
  if (props.readOnly || props.kind !== 'document') return false;
  return documentView.value?.replaceImage(target, src) || false;
}
defineExpose({
  flush,
  format,
  execute: format,
  editHistory,
  focus,
  cancelPendingFocus,
  goToLine,
  selection,
  insertAsset,
  insertTable,
  replaceImage,
  session,
  state: () => ({ ...emptyToolbarState(), canUndo: session.canUndo, canRedo: session.canRedo }),
  executeTable: (a: TableAction) => documentView.value?.executeTable(a),
});
onBeforeUnmount(() => {
  clearTimeout(compositionTimer);
  session.dispose();
});
</script>
<template>
  <div
    class="note-editor-host"
    @pointerdown.capture="cancelPendingFocus"
    @beforeinput.capture="cancelPendingFocus"
    @keydown.capture="keyboard"
    @compositionstart="sourceCompositionStart"
    @compositionend="sourceCompositionEnd"
  >
    <p v-if="warning" class="editor-warning" role="alert">{{ warning }}</p>
    <template v-if="hasMounted"
      ><DocumentEditor
        v-if="kind === 'document'"
        ref="documentView"
        :session="session"
        :resolve-image="resolveImage"
        @open-link="emit('open-link', $event)"
        :read-only="readOnly"
        :initial-line="initialLine"
        @change="publish"
        @upload-file="emit('upload-file', $event)"
        @replace-image="emit('replace-image', $event)"
        @composing="emit('composing', $event)"
        @state-change="report"
        @line-change="emit('line-change', $event)"
        @error="warning = $event"
        @source="requestSource" /><SourceEditor
        v-else
        ref="source"
        :model-value="modelValue"
        shared-history
        :read-only="readOnly"
        :wrap="wrap"
        :show-line-numbers="showLineNumbers"
        :initial-line="initialLine"
        @update:model-value="sourceUpdated"
        @line-change="emit('line-change', $event)"
        @state-change="sourceState"
        @history-boundary="session.sealHistory"
    /></template>
  </div>
</template>
