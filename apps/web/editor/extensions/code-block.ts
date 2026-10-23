import { createApp, h, reactive } from 'vue';
import CodeBlock from '@tiptap/extension-code-block';
import { createCodeBlockView } from '../code-block-view';
import { isDiagramKind } from '../../../../shared/diagram-fences';
export const DocumentCodeBlock = CodeBlock.extend({
  addAttributes() {
    return { ...this.parent?.(), previewCodeHash: { default: null, rendered: false }, previewSourceHash: { default: null, rendered: false } };
  },
  addNodeView() {
    return (props) => {
      const { node, editor } = props;
      const language = node.attrs.language;
      if (!isDiagramKind(language)) {
        const view = createCodeBlockView(props),
          update = view.update;
        return {
          ...view,
          update(next, decorations, innerDecorations) {
            if (isDiagramKind(next.attrs.language)) return false;
            return update?.call(view, next, decorations, innerDecorations) ?? false;
          },
        };
      }
      const dom = document.createElement('div');
      dom.contentEditable = 'false';
      dom.className = 'document-diagram';
      let app: ReturnType<typeof createApp> | undefined,
        alive = true;
      const state = reactive({
        kind: language,
        code: node.textContent,
        noteId: (editor.options.editorProps.attributes as Record<string, string>)?.['data-note-id'],
        sourceId: node.attrs.sourceId as string | undefined,
        previewCodeHash: node.attrs.previewCodeHash as string | undefined,
        previewSourceHash: node.attrs.previewSourceHash as string | undefined,
        readOnly: !editor.isEditable,
        editable: editor.isEditable,
      });
      const syncEditable = () => {
        state.readOnly = !editor.isEditable;
        state.editable = editor.isEditable;
      };
      editor.on('update', syncEditable);
      void import('../../components/DiagramPreview.vue').then(({ default: DiagramPreview }) => {
        if (!alive) return;
        app = createApp({ render: () => h(DiagramPreview, state) });
        app.mount(dom);
      });
      return {
        dom,
        stopEvent: () => true,
        ignoreMutation: () => true,
        update(next) {
          if (next.type !== node.type || next.attrs.language !== language) return false;
          state.code = next.textContent;
          state.sourceId = next.attrs.sourceId;
          state.previewCodeHash = next.attrs.previewCodeHash;
          state.previewSourceHash = next.attrs.previewSourceHash;
          syncEditable();
          return true;
        },
        destroy() {
          alive = false;
          editor.off('update', syncEditable);
          app?.unmount();
        },
      };
    };
  },
  renderMarkdown(node) {
    const language = node.attrs?.language || '';
    if (!/^[a-zA-Z0-9_+#.-]*$/.test(language)) throw Error('代码语言包含无法安全保存的字符');
    const body = (node.content || []).map((x) => x.text || '').join('');
    let width = 3;
    for (const match of body.matchAll(/`+/g)) width = Math.max(width, match[0].length + 1);
    const fence = '`'.repeat(width);
    return `${fence}${language}\n${body}\n${fence}`;
  },
});
