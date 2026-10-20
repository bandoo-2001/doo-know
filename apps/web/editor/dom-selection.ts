import { TextSelection } from '@tiptap/pm/state';
import type { EditorView } from '@tiptap/pm/view';

// Read the browser caret before a formatting command can use an older editor
// selection. Keep node selections and an active composition under their owner.
export function syncDOMTextSelection(view: EditorView) {
  if (view.composing || !view.hasFocus() || !(view.state.selection instanceof TextSelection)) return;
  const native = view.dom.ownerDocument.getSelection();
  if (!native?.anchorNode || !native.focusNode ||
      !view.dom.contains(native.anchorNode) || !view.dom.contains(native.focusNode)) return;
  const anchor = view.posAtDOM(native.anchorNode, native.anchorOffset);
  const head = view.posAtDOM(native.focusNode, native.focusOffset);
  if (!view.state.doc.resolve(anchor).parent.inlineContent ||
      !view.state.doc.resolve(head).parent.inlineContent) return;
  const selection = TextSelection.create(view.state.doc, anchor, head);
  if (!selection.eq(view.state.selection)) view.dispatch(view.state.tr.setSelection(selection));
}
