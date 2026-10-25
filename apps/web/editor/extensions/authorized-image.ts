import Image from '@tiptap/extension-image';
import { trackImageRequest } from '../../image-requests';
/** The editor may display only assets authorized by its current owner or share context. */
export function editorImageSource(url: string | undefined, shareToken?: string): string | undefined {
  if (!url) return;
  if (shareToken) {
    if (!/^[a-zA-Z0-9_-]{43}$/.test(shareToken)) return;
    const prefix = `/api/public/shares/${encodeURIComponent(shareToken)}/`;
    if (!url.startsWith(prefix)) return;
    return /^(?:asset\?source=[^#]+|assets\/[a-zA-Z0-9-]+(?:\?[^#]*)?)$/.test(url.slice(prefix.length)) ? url : undefined;
  }
  return /^\/api\/assets\/[a-zA-Z0-9-]+(?:\?[^#]*)?$/.test(url) ? url : undefined;
}
export function authorizedImage(resolve?: (url: string) => string | undefined, shareToken?: string) {
  return Image.extend({
    addNodeView() {
      return ({ node, view }) => {
        const img = view.dom.ownerDocument.createElement('img');
        img.draggable = false;
        let current = node;
        function currentSource() {
          const url = resolve?.(String(current.attrs.src || ''));
          return editorImageSource(url, shareToken) || null;
        }
        const stopRequest = trackImageRequest(img, () => ({ src: currentSource() }));
        function update(next: typeof node) {
          if (next.type.name !== 'image') return false;
          current = next;
          stopRequest.refresh();
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
          ignoreMutation: (mutation) => mutation.type !== 'selection',
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
