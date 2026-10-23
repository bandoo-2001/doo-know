import { Node } from '@tiptap/core';
import DOMPurify from 'dompurify';
import { syncMath, clearMath } from '../../diagrams/math';
import { trackImageRequest } from '../../image-requests';
export function opaqueSourceExtension(
  openSource?: (id: string) => void,
  remove?: (id: string) => void,
  copy?: (id: string) => void,
  resolveImage?: (url: string) => string | undefined,
  openLink?: (url: string) => void,
) {
  return Node.create({
    name: 'opaqueSource',
    group: 'block',
    atom: true,
    selectable: true,
    draggable: false,
    addAttributes() {
      return { sourceId: { default: null, rendered: false }, previewHtml: { default: null, rendered: false }, internal: { default: false, rendered: false } };
    },
    parseHTML() {
      return [];
    },
    renderHTML() {
      return [
        'div',
        { 'data-opaque-source': 'true', class: 'opaque-source-card' },
        '此内容保留原文，可在源码中编辑',
      ];
    },
    addNodeView() {
      return ({ node, view }) => {
        const owner = view.dom.ownerDocument;
        const dom = owner.createElement('div');
        dom.className = 'opaque-source-card';
        dom.contentEditable = 'false';
        if (node.attrs.internal) {
          dom.hidden = true;
          dom.style.display = 'none';
          dom.setAttribute('aria-hidden', 'true');
          return { dom, stopEvent: () => true, ignoreMutation: () => true };
        }
        const stops: (() => void)[] = [];
        if (node.attrs.previewHtml) {
          dom.classList.add('opaque-source-preview');
          dom.style.display = 'block';
          const preview = owner.createElement('div');
          preview.className = 'markdown-body knowledge-source-preview';
          preview.style.color = 'var(--text)';
          const template = owner.createElement('template');
          template.innerHTML = DOMPurify.sanitize(String(node.attrs.previewHtml));
          // Never attach unresolved image URLs to the live document. Images
          // share the existing authorized, bounded and revocable request path.
          for (const image of template.content.querySelectorAll('img')) {
            const original = image.getAttribute('src') || '';
            const resolved = resolveImage?.(original);
            image.removeAttribute('src');
            image.removeAttribute('srcset');
            stops.push(trackImageRequest(image, () => ({ src: resolved || null })));
          }
          for (const link of template.content.querySelectorAll<HTMLAnchorElement>('a[href]')) {
            const href = link.getAttribute('href') || '';
            if (/^https?:\/\//i.test(href)) {
              link.target = '_blank';
              link.rel = 'noopener noreferrer';
            }
            if (href && !href.startsWith('#')) link.addEventListener('click', event => {
              if (openLink) {
                event.preventDefault();
                openLink(href);
              } else if (!/^https?:\/\//i.test(href)) {
                event.preventDefault();
              }
            });
          }
          preview.append(template.content);
          dom.append(preview);
          void syncMath(preview);
          stops.push(() => clearMath(preview));
        }
        const controls = owner.createElement('div');
        controls.style.cssText = 'display:flex;flex-wrap:wrap;align-items:center;gap:8px';
        const label = owner.createElement('span');
        label.textContent = '此内容保留原文';
        const action = owner.createElement('button');
        action.type = 'button';
        action.textContent = '在源码中编辑';
        action.addEventListener('click', () => openSource?.(String(node.attrs.sourceId)));
        controls.append(label, action);
        if (copy) {
          const copying = owner.createElement('button');
          copying.type = 'button';
          copying.textContent = '复制原文';
          copying.addEventListener('click', () => copy(String(node.attrs.sourceId)));
          controls.append(copying);
        }
        if (remove) {
          const deletion = owner.createElement('button');
          deletion.type = 'button';
          deletion.textContent = '删除此内容';
          deletion.addEventListener('click', () => remove(String(node.attrs.sourceId)));
          controls.append(deletion);
        }
        dom.append(controls);
        return { dom, destroy: () => stops.forEach(stop => stop()), stopEvent: () => true, ignoreMutation: () => true };
      };
    },
  });
}
