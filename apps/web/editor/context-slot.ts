import { Extension, getMarkRange, isMarkActive } from '@tiptap/core';
import { NodeSelection, Plugin, type EditorState } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';

export type EditorContextKind = 'table' | 'code' | 'image' | 'link';

export function contextAt(
  state: EditorState,
): { kind: EditorContextKind; position: number } | undefined {
  const at = state.selection.$from;
  if (state.selection instanceof NodeSelection && state.selection.node.type.name === 'image')
    return { kind: 'image', position: state.selection.from };
  let table: { kind: 'table'; position: number } | undefined;
  for (let depth = at.depth; depth > 0; depth--) {
    const name = at.node(depth).type.name;
    if (name === 'table') table = { kind: 'table', position: at.before(depth) };
    if (name === 'codeBlock') return { kind: 'code', position: at.before(depth) };
  }
  if (at.depth && isMarkActive(state, 'link'))
    return { kind: 'link', position: getMarkRange(at, state.schema.marks.link)?.from ?? at.pos };
  return table;
}

// Decorations reserve a place for controls without adding anything to the
// document model or its Markdown. Events inside a control never move the caret.
export function contextSlots(enabled: () => boolean, changed: () => void) {
  return Extension.create({
    name: 'documentContextSlots',
    addProseMirrorPlugins() {
      return [
        new Plugin({
          props: {
            decorations(state) {
              const context = enabled() ? contextAt(state) : undefined;
              if (!context) return DecorationSet.empty;
              return DecorationSet.create(state.doc, [
                Decoration.widget(
                  context.position,
                  () => {
                    const slot = document.createElement(
                      context.kind === 'image' || context.kind === 'link' ? 'span' : 'div',
                    );
                    slot.className = 'document-context-slot';
                    slot.dataset.editorContext = context.kind;
                    slot.contentEditable = 'false';
                    return slot;
                  },
                  {
                    side: -1,
                    key: `${context.kind}:${context.position}`,
                    ignoreSelection: true,
                    marks: [],
                    stopEvent: () => true,
                  },
                ),
              ]);
            },
          },
          view() {
            changed();
            return { update: changed };
          },
        }),
      ];
    },
  });
}
