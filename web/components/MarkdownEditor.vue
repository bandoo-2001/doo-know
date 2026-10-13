<script setup lang="ts">
import { ref, onMounted, onBeforeUnmount, watch } from 'vue';
import { EditorView } from '@codemirror/view';
import { basicSetup } from 'codemirror';
import { markdown } from '@codemirror/lang-markdown';
const props = defineProps<{ modelValue: string }>();
const emit = defineEmits<{ 'update:modelValue': [value: string] }>();
const mount = ref<HTMLElement>();
let view: EditorView | undefined;
onMounted(() => {
  view = new EditorView({
    doc: props.modelValue,
    parent: mount.value,
    extensions: [
      basicSetup,
      markdown(),
      EditorView.lineWrapping,
      EditorView.contentAttributes.of({ 'aria-label': 'Markdown 正文' }),
      EditorView.theme({
        '&': { height: '100%', fontSize: '16px' },
        '.cm-scroller': {
          overflow: 'auto',
          fontFamily: '"SFMono-Regular",Consolas,"Noto Sans Mono",monospace',
        },
        '.cm-content': { padding: '24px 18px' },
        '.cm-gutters': {
          backgroundColor: '#f7fbff',
          color: '#7c94ad',
          borderRight: '1px solid #e1edf8',
        },
      }),
      EditorView.updateListener.of((update) => {
        if (update.docChanged) emit('update:modelValue', update.state.doc.toString());
      }),
    ],
  });
});
watch(
  () => props.modelValue,
  (v) => {
    if (view && view.state.doc.toString() !== v)
      view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: v } });
  },
);
onBeforeUnmount(() => view?.destroy());
</script>
<template><div ref="mount" class="markdown-editor"></div></template>
