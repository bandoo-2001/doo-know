import { Node } from '@tiptap/core';
export function opaqueSourceExtension(
  openSource?: (id: string) => void,
  remove?: (id: string) => void,
  copy?: (id: string) => void,
) {
  return Node.create({
    name: 'opaqueSource',
    group: 'block',
    atom: true,
    selectable: true,
    draggable: false,
    addAttributes() {
      return { sourceId: { default: null, rendered: false } };
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
      return ({ node }) => {
        const dom = document.createElement('div');
        dom.className = 'opaque-source-card';
        dom.contentEditable = 'false';
        const label = document.createElement('span');
        label.textContent = '此内容保留原文';
        const action = document.createElement('button');
        action.type = 'button';
        action.textContent = '在源码中编辑';
        action.addEventListener('click', () => openSource?.(String(node.attrs.sourceId)));
        dom.append(label, action);
        if (copy) {
          const copying = document.createElement('button');
          copying.type = 'button';
          copying.textContent = '复制原文';
          copying.addEventListener('click', () => copy(String(node.attrs.sourceId)));
          dom.append(copying);
        }
        if (remove) {
          const deletion = document.createElement('button');
          deletion.type = 'button';
          deletion.textContent = '删除此内容';
          deletion.addEventListener('click', () => remove(String(node.attrs.sourceId)));
          dom.append(deletion);
        }
        return { dom, stopEvent: () => true, ignoreMutation: () => true };
      };
    },
  });
}
