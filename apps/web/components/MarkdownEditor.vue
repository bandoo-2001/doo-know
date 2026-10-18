<script setup lang="ts">
import { ref, onMounted, onBeforeUnmount, watch } from 'vue';
import { EditorView, keymap } from '@codemirror/view';
import { undo, redo } from '@codemirror/commands';
import {
  markdownTransaction,
  toolbarState,
  type MarkdownAction,
  type MarkdownToolbarState,
} from '../markdown-format';
import { Compartment, EditorState } from '@codemirror/state';
import { basicSetup } from 'codemirror';
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { HighlightStyle, defaultHighlightStyle, syntaxHighlighting } from '@codemirror/language';
import { tags } from '@lezer/highlight';
const props = withDefaults(
  defineProps<{
    modelValue: string;
    incremental?: boolean;
    wrap?: boolean;
    readOnly?: boolean;
    initialLine?: number;
    showLineNumbers?: boolean;
  }>(),
  { wrap: true, showLineNumbers: false },
);
const emit = defineEmits<{
  'update:modelValue': [value: string];
  changes: [edits: { from: number; to: number; insert: string }[]];
  'line-change': [line: number];
  'state-change': [state: MarkdownToolbarState];
}>();
const mount = ref<HTMLElement>();
let view: EditorView | undefined;
const editability = new Compartment();
const gutters = new Compartment();
const gutterTheme = () =>
  EditorView.theme({
    '.cm-gutters': { display: props.showLineNumbers ? 'flex' : 'none' },
  });
let programmatic = false;
onMounted(() => {
  view = new EditorView({
    doc: props.modelValue,
    parent: mount.value,
    extensions: [
      gutters.of(gutterTheme()),
      markdown({ base: markdownLanguage }),
      keymap.of([
        { key: 'Mod-b', run: () => format('bold'), preventDefault: true },
        { key: 'Mod-i', run: () => format('italic'), preventDefault: true },
        { key: 'Mod-k', run: () => format('link'), preventDefault: true },
      ]),
      basicSetup,
      syntaxHighlighting(
        HighlightStyle.define([
          ...defaultHighlightStyle.specs,
          { tag: tags.heading1, fontSize: '1.4em', fontWeight: '650', color: '#262d3b' },
          { tag: tags.heading2, fontSize: '1.18em', fontWeight: '600', color: '#303747' },
          { tag: tags.heading3, fontSize: '1.1em', fontWeight: '600', color: '#40495b' },
          {
            tag: tags.heading4,
            fontSize: '1em',
            fontWeight: '600',
            color: '#4c566a',
            textDecoration: 'none',
          },
          {
            tag: tags.heading5,
            fontSize: '.95em',
            fontWeight: '600',
            color: '#566177',
            textDecoration: 'none',
          },
          { tag: tags.processingInstruction, color: '#a0a8b8' },
          { tag: tags.link, color: '#4566c6' },
          { tag: tags.quote, color: '#8791a6' },
          {
            tag: tags.monospace,
            fontFamily: '"SFMono-Regular",Consolas,monospace',
            fontSize: '.9em',
          },
        ]),
      ),
      editability.of([
        EditorView.editable.of(!props.readOnly),
        EditorState.readOnly.of(!!props.readOnly),
      ]),
      ...(props.wrap === false ? [] : [EditorView.lineWrapping]),
      EditorView.contentAttributes.of({ 'aria-label': 'Markdown 正文' }),
      EditorView.theme({
        '&': { height: '100%', fontSize: '15px', color: '#343c4a' },
        '&.cm-focused': { outline: 'none' },
        '.cm-scroller': {
          overflow: 'auto',
          fontFamily:
            props.wrap === false
              ? '"SFMono-Regular",Consolas,monospace'
              : 'Inter,-apple-system,"Noto Sans CJK SC","Microsoft YaHei",sans-serif',
          lineHeight: '1.7',
        },
        '.cm-content': { padding: '28px 24px 64px', caretColor: '#4566c6' },
        '.cm-line': { padding: '0 4px' },
        '.cm-gutters': {
          backgroundColor: '#ffffff',
          color: '#69778c',
          borderRight: '0',
          fontSize: '10px',
        },
        '.cm-activeLineGutter': { backgroundColor: '#f5f7fc', color: '#8594b5' },
        '.cm-activeLine': { backgroundColor: '#f8f9fd' },
        '.cm-selectionBackground, &.cm-focused .cm-selectionBackground': {
          backgroundColor: '#dce5fa',
        },
        '.cm-cursor': { borderLeftColor: '#4566c6', borderLeftWidth: '2px' },
        '@media (max-width: 720px)': {
          '&': { fontSize: '14px' },
          '.cm-content': { padding: '22px 14px 70px' },
        },
      }),
      EditorView.updateListener.of((update) => {
        if (update.docChanged || update.selectionSet || update.transactions.length)
          emit('state-change', toolbarState(update.state));
        if (update.selectionSet && update.view.hasFocus)
          emit('line-change', update.state.doc.lineAt(update.state.selection.main.head).number);
        if (update.docChanged && !programmatic) {
          if (props.incremental) {
            const edits: { from: number; to: number; insert: string }[] = [];
            update.changes.iterChanges((from, to, _fromB, _toB, insert) =>
              edits.push({ from, to, insert: insert.toString() }),
            );
            emit('changes', edits);
          } else emit('update:modelValue', update.state.doc.toString());
        }
      }),
    ],
  });
  view.scrollDOM.addEventListener('scroll', reportVisibleLine, { passive: true });
  emit('state-change', toolbarState(view.state));
  if (props.initialLine) {
    const line = view.state.doc.line(Math.min(props.initialLine, view.state.doc.lines));
    view.dispatch({ selection: { anchor: line.from }, scrollIntoView: true });
  }
});
function reportVisibleLine() {
  if (!view || !view.scrollDOM.clientHeight) return;
  const top = Math.max(0, view.scrollDOM.getBoundingClientRect().top - view.documentTop + 32);
  const block = view.lineBlockAtHeight(top);
  emit('line-change', view.state.doc.lineAt(block.from).number);
}
watch(
  () => props.showLineNumbers,
  () => {
    view?.dispatch({ effects: gutters.reconfigure(gutterTheme()) });
  },
);
watch(
  () => props.modelValue,
  (v) => {
    if (view && view.state.doc.toString() !== v) {
      programmatic = true;
      try {
        view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: v } });
      } finally {
        programmatic = false;
      }
    }
  },
);
watch(
  () => props.readOnly,
  (v) =>
    view?.dispatch({
      effects: editability.reconfigure([EditorView.editable.of(!v), EditorState.readOnly.of(!!v)]),
    }),
);
function goToLine(number: number, align: 'start' | 'center' = 'center') {
  if (!view || !Number.isInteger(number) || number < 1) return;
  const line = view.state.doc.line(Math.min(number, view.state.doc.lines));
  view.dispatch({
    selection: { anchor: line.from },
    effects: EditorView.scrollIntoView(line.from, { y: align, yMargin: 32 }),
  });
  view.focus();
}
watch(
  () => props.initialLine,
  (line) => {
    if (line) goToLine(line);
  },
);
function format(action: MarkdownAction) {
  if (!view || props.readOnly) return false;
  const transaction = markdownTransaction(view.state, action);
  if (!transaction) return false;
  view.dispatch(transaction);
  view.focus();
  return true;
}
function editHistory(action: 'undo' | 'redo') {
  if (!view || props.readOnly) return false;
  const changed = (action === 'undo' ? undo : redo)(view);
  view.focus();
  return changed;
}
defineExpose({ goToLine, format, editHistory });
onBeforeUnmount(() => {
  view?.scrollDOM.removeEventListener('scroll', reportVisibleLine);
  view?.destroy();
});
</script>
<template><div ref="mount" class="markdown-editor"></div></template>
