<script setup lang="ts">
import { defineAsyncComponent, ref, watch, onBeforeUnmount, nextTick } from 'vue';
import EditorSearch from './EditorSearch.vue';
import type { TextMatch } from '../editor/search';
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
const editorStats = ref({characters:0,selectedCharacters:0});
const searchOpen = ref(false), searchQuery = ref(''), searchReplacement = ref(''), searchCase = ref(false);
const searchResults = ref<TextMatch[]>([]), searchIndex = ref(0);
function activeSearchEditor() { return props.kind === 'document' ? documentView.value : source.value; }
function refreshSearch() {
  searchResults.value = activeSearchEditor()?.searchText?.(searchQuery.value, searchCase.value) || [];
  searchIndex.value = Math.min(searchIndex.value, Math.max(0, searchResults.value.length - 1));
}
function openSearch() { searchOpen.value = true; void nextTick(refreshSearch); }
function closeSearch() { searchOpen.value = false; focus(); }
function nextSearch(direction: number) {
  refreshSearch();
  if (!searchResults.value.length) return;
  searchIndex.value = (searchIndex.value + direction + searchResults.value.length) % searchResults.value.length;
  activeSearchEditor()?.selectTextMatch?.(searchResults.value[searchIndex.value]);
}
function replaceSearch(all: boolean) {
  if (props.readOnly || session.composing) return;
  session.sealHistory();
  activeSearchEditor()?.replaceTextMatches?.(searchQuery.value, searchReplacement.value, all, searchIndex.value, searchCase.value);
  session.sealHistory();
  void nextTick(refreshSearch);
}
watch([searchQuery, searchCase], () => { searchIndex.value = 0; refreshSearch(); });
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
  'upload-files': [files: File[]];
  'insert-menu': [];
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
let pendingLine: { line: number; align: 'start' | 'center' } | undefined;
let disposed = false;
let compositionTimer: ReturnType<typeof setTimeout> | undefined;
watch([source, documentView, () => props.visible, () => props.kind], async () => {
  await nextTick();
  if (disposed) return;
  const active = props.kind === 'document' ? documentView.value : source.value;
  if (active && props.visible && pendingLine) {
    const target = pendingLine;
    pendingLine = undefined;
    active.goToLine(target.line, target.align);
  } else if (active && props.visible && pendingFocus) {
    const target = pendingFocus;
    pendingFocus = undefined;
    active.focus(target);
  }
  if (searchOpen.value) refreshSearch();
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
    if (searchOpen.value) void nextTick(refreshSearch);
  },
);
watch(
  () => props.modelValue,
  (value) => {
    if (value !== session.snapshot().markdown) {
      session.replaceExternal(value);
      documentView.value?.load(value);
      report();
      void nextTick(refreshSearch);
    }
  },
);
function report(state: MarkdownToolbarState = emptyToolbarState()) {
  emit('state-change', { ...state, canUndo: session.canUndo, canRedo: session.canRedo });
}
function publish(value: string) {
  emit('update:modelValue', value);
  if (searchOpen.value) void nextTick(refreshSearch);
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
    if (searchOpen.value) void nextTick(refreshSearch);
  } else warning.value = result.message;
}
function sourceState(state: MarkdownToolbarState) {
  lastState = state;
  const b = source.value?.selection?.();
  if (b && !pendingFocus && !pendingLine) session.setSelection(b);
  report(state);
}
function sourceCompositionStart(event?:CompositionEvent) {
  if((event?.target as HTMLElement)?.closest?.('.editor-search'))return;
  if (props.kind === 'source') {
    session.setComposing(true);
    emit('composing', true);
  }
}
function sourceCompositionEnd(event?:CompositionEvent) {
  if((event?.target as HTMLElement)?.closest?.('.editor-search'))return;
  if (props.kind === 'source') {
    clearTimeout(compositionTimer);
    compositionTimer = setTimeout(() => {
      session.setComposing(false);
      emit('composing', false);
    }, 0);
  }
}
async function flush() {
  if (props.visible && !pendingLine && props.kind === 'document' && documentView.value)
    return documentView.value.flush();
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
  if (searchOpen.value) void nextTick(refreshSearch);
  void nextTick(() => source.value?.focus(result.selection));
  return true;
}
function keyboard(event: KeyboardEvent) {
  cancelPendingFocus();
  if ((event.ctrlKey || event.metaKey) && !event.altKey && ['f','h'].includes(event.key.toLowerCase()) && !event.isComposing) {
    event.preventDefault(); event.stopPropagation(); openSearch(); return;
  }
  if ((event.target as HTMLElement)?.closest?.('.editor-search')) return;
  if (event.key === '/' && !event.ctrlKey && !event.metaKey && !event.altKey && !event.isComposing && !props.readOnly) {
    const target=event.target as HTMLElement;
    const current=session.snapshot(),at=selection().anchor;
    const before=current.markdown.slice(0,at).split('\n').at(-1)||'';
    if(!before.trim()&&!target.closest('.document-code-block')&&!parseSource(current.markdown).units.some(u=>['fence','code_block'].includes(u.kind)&&at>=u.from&&at<u.to)){event.preventDefault();emit('insert-menu');return;}
  }
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
  pendingLine = undefined;
}
function focus(b?: SelectionBookmark) {
  pendingLine = undefined;
  if (b) session.setSelection(b);
  const active = props.kind === 'document' ? documentView.value : source.value;
  if (active) active.focus(b);
  else pendingFocus = b || session.snapshot().selection;
}
function goToLine(line: number, align: 'start' | 'center' = 'center') {
  if (!Number.isInteger(line) || line < 1) return;
  const text = session.snapshot().markdown;
  let offset = 0;
  for (let current = 1; current < line; current++) {
    const next = text.indexOf('\n', offset);
    if (next < 0) break;
    offset = next + 1;
  }
  session.setSelection({ anchor: offset, head: offset, affinity: 'after' });
  pendingFocus = undefined;
  const active = props.kind === 'document' ? documentView.value : source.value;
  if (active && props.visible) {
    pendingLine = undefined;
    active.goToLine(line, align);
  } else pendingLine = { line, align };
}
function selection(): SelectionBookmark {
  return (
    (props.kind === 'document' ? documentView.value : source.value)?.selection?.() ||
    session.snapshot().selection
  );
}
function replaceMarkdown(markdown: string, expected = session.snapshot().markdown, bookmark?: SelectionBookmark) {
  const current=session.snapshot();
  if(props.readOnly||session.composing||current.markdown!==expected)return false;
  if(markdown===current.markdown)return true;
  session.sealHistory();
  const selection=bookmark||{...current.selection,anchor:Math.min(current.selection.anchor,markdown.length),head:Math.min(current.selection.head,markdown.length)};
  const result=session.apply({noteId:props.noteId,generation:props.generation,baseRevision:current.revision,
    origin:'source',edits:textEdit(current.markdown,markdown),selection});
  if(!result.ok){warning.value=result.message;return false;}
  if(props.kind==='document')documentView.value?.load(result.markdown);
  publish(result.markdown);session.sealHistory();
  void nextTick(()=>focus(result.selection));
  return true;
}
function insertSourceSnippet(markdown: string, expected = session.snapshot().markdown, at?: SelectionBookmark) {
  const current=session.snapshot();
  if(current.markdown!==expected)return false;
  const bookmark=at||selection();
  // Insert blocks after the source unit instead of cutting through hidden/marked text.
  const unit=props.kind==='document'?parseSource(current.markdown).units.find(u=>bookmark.anchor>=u.from&&bookmark.anchor<u.to):undefined;
  const from=unit?unit.to:Math.min(bookmark.anchor,bookmark.head),to=unit?unit.to:Math.max(bookmark.anchor,bookmark.head);
  const before=current.markdown.slice(0,from),after=current.markdown.slice(to);
  const prefix=before&&!before.endsWith('\n\n')?'\n\n':'';
  const suffix=after&&!markdown.endsWith('\n\n')?'\n\n':'';
  const next=before+prefix+markdown+suffix+after;
  return replaceMarkdown(next,expected,{anchor:from+prefix.length,head:from+prefix.length,affinity:'after'});
}
function pasteMarkdown(markdown: string, expected: string, at?: SelectionBookmark) {
  if (props.readOnly || session.composing || session.snapshot().markdown !== expected) return false;
  const parsed = parseSource(markdown);
  // Preserve unknown constructs as source blocks instead of flattening them.
  if (props.kind === 'document' && parsed.eligibility.allowed && !parsed.units.some(unit => unit.opaque))
    return insertAsset(markdown, at);
  return insertSourceSnippet(markdown, expected, at);
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
defineExpose({ openSearch, replaceMarkdown, insertSourceSnippet, pasteMarkdown, diagramRange:(id:string)=>documentView.value?.sourceRange?.(id),
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
  disposed = true;
  cancelPendingFocus();
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
    <EditorSearch v-if="searchOpen" v-model:query="searchQuery" v-model:replacement="searchReplacement"
      v-model:case-sensitive="searchCase" :count="searchResults.length" :current="searchIndex" :read-only="readOnly"
      @next="nextSearch" @replace="replaceSearch" @close="closeSearch" />
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
        @upload-files="emit('upload-files', $event)"
        @stats-change="editorStats=$event"
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
        @upload-files="emit('upload-files', $event)"
        @stats-change="editorStats=$event"
    /></template>
    <div class="editor-document-stats" role="status" aria-live="off">{{ kind==='source'?'源码':'正文' }}字符 {{ editorStats.characters }}<span v-if="editorStats.selectedCharacters"> · 已选 {{ editorStats.selectedCharacters }}</span></div>
  </div>
</template>

<style>
.editor-document-stats{padding:4px 16px;border-top:1px solid var(--border);background:var(--panel);color:var(--muted);font-size:11px;flex-shrink:0}
</style>
