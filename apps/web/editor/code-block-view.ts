import type { NodeViewRendererProps } from '@tiptap/core';
import type { Node as ProseMirrorNode } from '@tiptap/pm/model';
import { Selection, TextSelection } from '@tiptap/pm/state';
import type { NodeView } from '@tiptap/pm/view';
import { Compartment, EditorState } from '@codemirror/state';
import {
  EditorView,
  drawSelection,
  highlightSpecialChars,
  keymap,
  lineNumbers,
} from '@codemirror/view';
import { defaultKeymap, indentWithTab } from '@codemirror/commands';
import {
  bracketMatching,
  defaultHighlightStyle,
  ensureSyntaxTree,
  foldAll,
  foldGutter,
  indentOnInput,
  syntaxHighlighting,
  unfoldAll,
} from '@codemirror/language';
import { classHighlighter, highlightTree } from '@lezer/highlight';
import { codeLanguages, loadCodeLanguage } from './code-languages';

export const CODE_BLOCK_ACTION = 'codeBlockAction';
export const isDiagramCodeLanguage = (name: unknown) => ['mermaid', 'excalidraw'].includes(String(name));
let nextLanguageList = 0;
const MAX_PREVIEW_BYTES = 64 * 1024;

export function createCodeBlockView({ node: initial, view, getPos, editor }: NodeViewRendererProps): NodeView {
  let node = initial,
    code: EditorView | undefined,
    syncing = false,
    destroyed = false,
    languageRequest = 0,
    previewVisible = false,
    previewGeneration = 0,
    previewVersion = 0,
    highlightedVersion = -1,
    previewQueued = false,
    previewFrame: number | undefined,
    numbered = true,
    wrapped = true,
    folded = false,
    copiedTimer: ReturnType<typeof setTimeout> | undefined;
  const syntax = new Compartment(),
    editing = new Compartment(),
    numbers = new Compartment(),
    wrapping = new Compartment();
  const dom = document.createElement('div');
  dom.className = 'document-code-block';
  dom.contentEditable = 'false';
  const header = dom.appendChild(document.createElement('div'));
  header.className = 'document-code-header';
  header.setAttribute('role', 'group');
  header.setAttribute('aria-label', '代码块设置');
  const language = header.appendChild(document.createElement('input'));
  language.className = 'document-code-language';
  language.setAttribute('aria-label', '代码语言');
  language.setAttribute('placeholder', '纯文本');
  language.spellcheck = false;
  language.value = node.attrs.language || '';
  const list = header.appendChild(document.createElement('datalist'));
  list.id = `document-code-languages-${++nextLanguageList}`;
  language.setAttribute('list', list.id);
  language.addEventListener('focus', () => {
    if (list.childElementCount) return;
    for (const item of codeLanguages) {
      const option = list.appendChild(document.createElement('option'));
      option.value = item.value;
      option.label = item.name;
    }
  });
  const preview = dom.appendChild(document.createElement('pre'));
  preview.className = 'document-code-preview';
  preview.tabIndex = 0;
  preview.setAttribute('aria-label', '代码内容');
  const text = preview.appendChild(document.createElement('code'));
  text.textContent = node.textContent;
  const mount = dom.appendChild(document.createElement('div'));
  mount.className = 'document-code-mount';
  const previewObserver = typeof IntersectionObserver === 'function'
    ? new IntersectionObserver(entries => {
      previewVisible = entries.at(-1)?.isIntersecting ?? false;
      if (previewVisible) schedulePreview(); else cancelPreview();
    })
    : undefined;
  previewObserver?.observe(preview);

  function cancelPreview() {
    previewGeneration++;
    previewQueued = false;
    if (previewFrame !== undefined) cancelAnimationFrame(previewFrame);
    previewFrame = undefined;
  }
  function schedulePreview() {
    if (destroyed || code || !previewVisible || previewQueued || highlightedVersion === previewVersion) return;
    previewQueued = true;
    const generation = ++previewGeneration, version = previewVersion;
    previewFrame = requestAnimationFrame(() => {
      previewFrame = undefined;
      void highlightPreview(generation, version).finally(() => {
        if (generation === previewGeneration) previewQueued = false;
      });
    });
  }
  async function highlightPreview(generation: number, version: number) {
    const source = node.textContent, name = node.attrs.language || '';
    const current = () => !destroyed && !code && previewVisible &&
      generation === previewGeneration && version === previewVersion;
    if (!current()) return;
    // Keep large previews complete, while bounding both parser input and work.
    if (source.length > MAX_PREVIEW_BYTES || new TextEncoder().encode(source).byteLength > MAX_PREVIEW_BYTES) {
      highlightedVersion = version;
      return;
    }
    try {
      const extension = await loadCodeLanguage(name);
      if (!current()) return;
      const state = EditorState.create({
        doc: source,
        extensions: [extension, EditorState.lineSeparator.of('\n')],
      });
      const tree = ensureSyntaxTree(state, source.length, 20);
      if (!tree) {
        highlightedVersion = version;
        return;
      }
      const fragment = document.createDocumentFragment();
      let offset = 0;
      highlightTree(tree, classHighlighter, (from, to, classes) => {
        if (from > offset) fragment.append(document.createTextNode(source.slice(offset, from)));
        const span = document.createElement('span');
        span.className = classes;
        span.textContent = source.slice(from, to);
        fragment.append(span);
        offset = to;
      });
      fragment.append(document.createTextNode(source.slice(offset)));
      if (!current()) return;
      text.replaceChildren(fragment);
      highlightedVersion = version;
    } catch {
      if (current()) {
        text.textContent = source;
        highlightedVersion = version;
      }
    }
  }

  function position() {
    const pos = getPos();
    return typeof pos === 'number' && view.state.doc.nodeAt(pos)?.type === node.type ? pos : undefined;
  }
  function guarded() {
    return destroyed || !!code?.composing || view.composing;
  }
  function editable() {
    return [EditorState.readOnly.of(!view.editable), EditorView.editable.of(view.editable)];
  }
  function syncEditable() {
    language.disabled = !view.editable;
    dom.dataset.readonly = String(!view.editable);
    if (code && code.state.readOnly === view.editable) {
      syncing = true;
      try { code.dispatch({ effects: editing.reconfigure(editable()) }); }
      finally { syncing = false; }
    }
  }
  function setLanguage() {
    if (!view.editable || guarded()) return;
    const value = language.value.trim();
    if (!/^[a-z0-9_+#.-]*$/i.test(value)) {
      language.setCustomValidity('语言名只能包含字母、数字和 _ + # . -');
      language.reportValidity();
      return;
    }
    language.setCustomValidity('');
    const pos = position();
    if (pos === undefined || value === (node.attrs.language || '')) return;
    view.dispatch(view.state.tr.setNodeMarkup(pos, undefined, { ...node.attrs, language: value || null })
      .setMeta(CODE_BLOCK_ACTION, true));
  }
  language.addEventListener('input', () => language.setCustomValidity(''));
  language.addEventListener('change', setLanguage);
  language.addEventListener('keydown', event => {
    if (event.isComposing) return;
    if (event.key === 'Enter') {
      event.preventDefault();
      setLanguage();
      ensureCode().focus();
    } else if (event.key === 'Escape') {
      event.preventDefault();
      language.value = node.attrs.language || '';
      ensureCode().focus();
    }
  });
  function button(label: string, caption: string, run: () => void) {
    const button = header.appendChild(document.createElement('button'));
    button.type = 'button';
    button.setAttribute('aria-label', label);
    button.textContent = caption;
    button.addEventListener('mousedown', event => event.preventDefault());
    button.addEventListener('click', run);
    return button;
  }
  const lineButton = button('代码行号', '行号', () => {
    numbered = !numbered;
    lineButton.setAttribute('aria-pressed', String(numbered));
    code?.dispatch({ effects: numbers.reconfigure(numbered ? lineNumbers() : []) });
  });
  lineButton.setAttribute('aria-pressed', 'true');
  const wrapButton = button('代码自动折行', '折行', () => {
    wrapped = !wrapped;
    wrapButton.setAttribute('aria-pressed', String(wrapped));
    preview.style.whiteSpace = wrapped ? 'pre-wrap' : 'pre';
    code?.dispatch({ effects: wrapping.reconfigure(wrapped ? EditorView.lineWrapping : []) });
  });
  wrapButton.setAttribute('aria-pressed', 'true');
  const foldButton = button('折叠代码', '折叠', () => {
    const cm = ensureCode();
    if (folded) unfoldAll(cm); else foldAll(cm);
    folded = !folded;
    foldButton.setAttribute('aria-pressed', String(folded));
  });
  foldButton.setAttribute('aria-pressed', 'false');
  const copyButton = button('复制代码', '复制代码', () => { void copy(); });
  let copyFallback: HTMLTextAreaElement | undefined;
  async function copy() {
    const current = node.textContent;
    try {
      await navigator.clipboard.writeText(current);
      if (destroyed) return;
      copyButton.textContent = '已复制';
      clearTimeout(copiedTimer);
      copiedTimer = setTimeout(() => { copyButton.textContent = '复制代码'; }, 2000);
    } catch {
      if (destroyed) return;
      copyFallback ||= dom.appendChild(document.createElement('textarea'));
      copyFallback.className = 'document-code-copy';
      copyFallback.setAttribute('aria-label', '代码复制内容');
      copyFallback.readOnly = true;
      copyFallback.value = current;
      copyFallback.focus();
      copyFallback.select();
    }
  }
  async function updateLanguage() {
    const request = ++languageRequest;
    const name = node.attrs.language || '';
    // Clearing first prevents the previous parser from colouring a newly selected language.
    code?.dispatch({ effects: syntax.reconfigure([]) });
    const extension = await loadCodeLanguage(name);
    if (destroyed || request !== languageRequest || node.attrs.language !== (name || null)) return;
    code?.dispatch({ effects: syntax.reconfigure(extension) });
  }
  function leave(direction: -1 | 1, vertical = false) {
    if (!code || guarded() || !code.state.selection.main.empty) return false;
    const at = code.state.selection.main.head;
    if (vertical) {
      const line = code.state.doc.lineAt(at);
      if (direction < 0 ? line.number > 1 : line.number < code.state.doc.lines) return false;
    } else if (at !== (direction < 0 ? 0 : code.state.doc.length)) return false;
    const pos = position();
    if (pos === undefined) return false;
    const outside = pos + (direction < 0 ? 0 : node.nodeSize);
    const selection = Selection.near(view.state.doc.resolve(outside), direction);
    if (selection.$from.parent === node) return false;
    view.dispatch(view.state.tr.setSelection(selection).scrollIntoView());
    view.focus();
    return true;
  }
  function forward(update: import('@codemirror/view').ViewUpdate) {
    if (syncing || destroyed || !update.view.hasFocus || (!update.docChanged && !update.selectionSet && !update.focusChanged)) return;
    const pos = position();
    if (pos === undefined) return;
    let tr = view.state.tr;
    if (update.docChanged) {
      update.changes.iterChanges((_from, to, fromB, _toB, insert) => {
        const from = pos + 1 + fromB;
        tr = insert.length ? tr.replaceWith(from, pos + 1 + to + fromB - _from, view.state.schema.text(insert.toString()))
          : tr.delete(from, pos + 1 + to + fromB - _from);
      });
    }
    const selected = update.state.selection.main;
    const selection = TextSelection.create(tr.doc, pos + 1 + selected.anchor, pos + 1 + selected.head);
    if (!selection.eq(tr.selection)) tr.setSelection(selection);
    if (tr.docChanged || tr.selectionSet) view.dispatch(tr);
    // A rejected document transaction must not leave a second, divergent code document.
    const accepted = view.state.doc.nodeAt(pos);
    if (accepted && accepted.textContent !== update.state.doc.toString()) syncText(accepted.textContent);
  }
  function ensureCode() {
    if (code) return code;
    cancelPreview();
    previewObserver?.disconnect();
    preview.hidden = true;
    code = new EditorView({
      parent: mount,
      state: EditorState.create({
        doc: node.textContent,
        extensions: [
          editing.of(editable()), numbers.of(numbered ? lineNumbers() : []),
          wrapping.of(wrapped ? EditorView.lineWrapping : []), syntax.of([]),
          // Deliberately omit CodeMirror's history: EditorSession owns every undo.
          EditorState.transactionFilter.of(transaction =>
            transaction.docChanged && !syncing && !view.editable ? [] : transaction),
          keymap.of([
            { key: 'ArrowLeft', run: () => leave(-1) },
            { key: 'ArrowRight', run: () => leave(1) },
            { key: 'ArrowUp', run: () => leave(-1, true) },
            { key: 'ArrowDown', run: () => leave(1, true) },
            { key: 'Mod-Enter', run: () => {
              if (!view.editable || guarded()) return false;
              const pos = position();
              if (pos === undefined) return false;
              editor.commands.setTextSelection(pos + 1 + node.content.size);
              return editor.commands.exitCode();
            } },
            indentWithTab,
            ...defaultKeymap,
          ]),
          highlightSpecialChars(), drawSelection(), indentOnInput(), bracketMatching(), foldGutter(),
          syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
          EditorView.contentAttributes.of({ 'aria-label': '代码内容', spellcheck: 'false' }),
          EditorView.domEventHandlers({
            focus: (_event, cm) => {
              // Native arrow navigation can focus an already mounted nested editor
              // before ProseMirror has received a selection transaction.
              queueMicrotask(() => {
                const pos = position();
                if (destroyed || syncing || !cm.hasFocus || pos === undefined) return;
                const selected = cm.state.selection.main;
                const selection = TextSelection.create(view.state.doc, pos + 1 + selected.anchor, pos + 1 + selected.head);
                if (!selection.eq(view.state.selection)) view.dispatch(view.state.tr.setSelection(selection));
              });
              return false;
            },
          }),
          EditorView.updateListener.of(forward),
        ],
      }),
    });
    void updateLanguage();
    return code;
  }
  function syncText(value: string) {
    if (!code || code.state.doc.toString() === value) return;
    const before = code.state.doc.toString();
    let start = 0, oldEnd = before.length, newEnd = value.length;
    while (start < oldEnd && start < newEnd && before[start] === value[start]) start++;
    while (oldEnd > start && newEnd > start && before[oldEnd - 1] === value[newEnd - 1]) { oldEnd--; newEnd--; }
    syncing = true;
    try { code.dispatch({ changes: { from: start, to: oldEnd, insert: value.slice(start, newEnd) } }); }
    finally { syncing = false; }
  }
  preview.addEventListener('mousedown', event => {
    event.preventDefault();
    const cm = ensureCode();
    const point = cm.posAtCoords({ x: event.clientX, y: event.clientY }) ?? cm.state.doc.length;
    cm.dispatch({ selection: { anchor: point } });
    cm.focus();
  });
  preview.addEventListener('focus', () => ensureCode().focus());
  editor.on('update', syncEditable);
  syncEditable();
  return {
    dom,
    stopEvent: () => true,
    ignoreMutation: () => true,
    setSelection(anchor, head) {
      if (guarded()) return;
      const cm = ensureCode();
      syncing = true;
      try { cm.dispatch({ selection: { anchor, head } }); }
      finally { syncing = false; }
      cm.focus();
    },
    update(next: ProseMirrorNode) {
      if (next.type !== node.type || isDiagramCodeLanguage(next.attrs.language)) return false;
      const changedLanguage = next.attrs.language !== node.attrs.language;
      const changedPreview = changedLanguage || next.textContent !== node.textContent ||
        next.attrs.sourceId !== node.attrs.sourceId;
      node = next;
      if (changedPreview) {
        previewVersion++;
        cancelPreview();
        text.textContent = node.textContent;
        schedulePreview();
      }
      if (document.activeElement !== language) language.value = node.attrs.language || '';
      syncText(node.textContent);
      syncEditable();
      if (changedLanguage && code) void updateLanguage();
      return true;
    },
    destroy() {
      destroyed = true;
      languageRequest++;
      cancelPreview();
      previewObserver?.disconnect();
      clearTimeout(copiedTimer);
      editor.off('update', syncEditable);
      code?.destroy();
    },
  };
}
