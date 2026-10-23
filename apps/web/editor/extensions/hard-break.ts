import HardBreak from '@tiptap/extension-hard-break';
// A visible trailing soft line is retained in source even at a paragraph boundary.
export const DocumentHardBreak = HardBreak.extend({
  renderMarkdown() {
    return '  \n';
  },
});
