import Image from '@tiptap/extension-image';
import { trackImageRequest } from '../../image-requests';
export function authorizedImage(resolve?: (url: string) => string | undefined) {
  return Image.extend({
    addNodeView() {
      return ({ node, view }) => {
        const img = view.dom.ownerDocument.createElement('img');
        img.draggable = false;
        let current = node;
        function currentSource() {
          const url = resolve?.(String(current.attrs.src || ''));
          return url && /^\/api\/assets\/[a-zA-Z0-9-]+(?:\?|$)/.test(url) ? url : null;
        }
        const stopRequest = trackImageRequest(img, () => ({ src: currentSource() }));
        function update(next: typeof node) {
          if (next.type.name !== 'image') return false;
          current = next;
          const url = currentSource();
          if (url) img.setAttribute('src', url);
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
          destroy: stopRequest,
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
