import Image from '@tiptap/extension-image';
export function authorizedImage(resolve?: (url: string) => string | undefined) {
  return Image.extend({
    addNodeView() {
      return ({ node }) => {
        const img = document.createElement('img');
        img.draggable = false;
        function update(next: typeof node) {
          if (next.type.name !== 'image') return false;
          const url = resolve?.(String(next.attrs.src || ''));
          if (url && /^\/api\/assets\/[a-zA-Z0-9-]+(?:\?|$)/.test(url))
            img.setAttribute('src', url);
          else img.removeAttribute('src');
          img.alt = next.attrs.alt || '图片';
          if (next.attrs.title) img.title = next.attrs.title;
          else img.removeAttribute('title');
          return true;
        }
        update(node);
        return {
          dom: img,
          update,
          selectNode() {
            img.classList.add('ProseMirror-selectednode');
          },
          deselectNode() {
            img.classList.remove('ProseMirror-selectednode');
          },
        };
      };
    },
  }).configure({ allowBase64: false, inline: true });
}
