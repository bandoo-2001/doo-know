<script setup lang="ts">
import { onMounted, onBeforeUnmount, ref, watch, useId, type CSSProperties } from 'vue';
import { Editor, Extension, type JSONContent } from '@tiptap/core';
import { Plugin, TextSelection } from '@tiptap/pm/state';
import { NModal } from 'naive-ui';
import {
  createRichProjection,
  richExtensions,
  parseRichUnit,
  parseRichContent,
  safeEditorUrl,
} from '../editor/rich-adapter';
import { convertClipboard, plainTextMarkdown } from '../editor/clipboard';
import { contextAt, contextSlots } from '../editor/context-slot';
import { textEdit, parseSource } from '../editor/source-codec';
import { syncDOMTextSelection } from '../editor/dom-selection';
import { CODE_BLOCK_ACTION } from '../editor/code-block-view';
import {
  isTableMoveAction,
  moveMarkdownTable,
  tableMoveActions,
  tableMoveAvailability,
  type TableMoveAction,
} from '../editor/table-move';
import { documentMatches, type TextMatch } from '../editor/search';
import {
  countCharacters,
  visibleDocumentText,
  type DocumentStatistics,
} from '../editor/document-stats';
import { createFloatingTools, virtualAnchor } from '../editor/floating-tools';
import type { EditorSession } from '../editor/session';
import type { ImageReplacementTarget, SelectionBookmark, TableAction } from '../editor/contracts';
import {
  emptyToolbarState,
  type MarkdownAction,
  type MarkdownToolbarState,
} from '../editor/toolbar-state';
import DocumentTableTools from './DocumentTableTools.vue';
import Icon from './Icon.vue';
const props = defineProps<{
  session: EditorSession;
  readOnly?: boolean;
  initialLine?: number;
  resolveImage?: (url: string) => string | undefined;
}>();
const emit = defineEmits<{
  'state-change': [state: MarkdownToolbarState];
  'line-change': [line: number];
  error: [message: string];
  source: [offset: number];
  change: [markdown: string];
  composing: [value: boolean];
  'open-link': [url: string];
  'upload-file': [file: File];
  'upload-files': [files: File[]];
  'stats-change': [statistics: DocumentStatistics];
  'replace-image': [target: ImageReplacementTarget];
}>();
const root = ref<HTMLElement>(),
  mount = ref<HTMLElement>(),
  tableOverlay = ref<HTMLElement>(),
  contextSlot = ref<HTMLElement>(),
  tableToolsHeight = ref(46),
  message = ref(''),
  tableActive = ref(false),
  imageActive = ref(false),
  imageAlt = ref(''),
  imageTitle = ref(''),
  activeLink = ref('');
const tablePosition = ref<CSSProperties>(),
  tableDetails = ref({ rows: 0, columns: 0, alignment: 'left', disabledActions: [] as TableAction[] });
let positionFrame: number | undefined, layoutObserver: ResizeObserver | undefined;
let tablePositioner: ReturnType<typeof createFloatingTools> | undefined,
  positionedTable: Element | undefined,
  tableAnchorRect: DOMRect | undefined;
const newProjectionId = () => Date.now().toString(36) + '-' + Math.random().toString(36).slice(2);
let projectionId = newProjectionId();
let editor: Editor | undefined,
  projection = createRichProjection(props.session.snapshot().markdown),
  loading = false,
  blocked = false,
  pendingOpaqueDeletion = '',
  imageIdentity = '',
  editingContext = '',
  imagePosition = 0,
  compositionTimer: ReturnType<typeof setTimeout> | undefined;
const deletingOpaque = ref(''),
  copyingRaw = ref<string>(),
  recoveryPending = ref(false);
const linkOpen = ref(false),
  linkUrl = ref(''),
  linkTitle = ref(''),
  linkText = ref(''),
  linkError = ref(''),
  imagePreviewOpen = ref(false),
  imagePreviewUrl = ref(''),
  imagePreviewScale = ref(100);
const linkErrorId = useId();
let linkTarget: { from: number; to: number; revision: number; text: string } | undefined;
const pasteChoice = ref<{ text: string; reason: string }>();
function error(text: string) {
  message.value = text;
  emit('error', text);
}
function hideTableTools() {
  tablePositioner?.stop();
  tablePositioner = undefined;
  positionedTable = undefined;
  tablePosition.value = undefined;
}
function positionTableTools() {
  positionFrame = undefined;
  contextSlot.value = mount.value?.querySelector<HTMLElement>('[data-editor-context]') || undefined;
  if (
    !editor ||
    !tableActive.value ||
    props.readOnly ||
    !root.value ||
    !mount.value ||
    !tableOverlay.value
  ) {
    hideTableTools();
    return;
  }
  const at = editor.state.selection.$from;
  let depth = at.depth;
  while (depth > 0 && at.node(depth).type.name !== 'table') depth--;
  if (!depth) {
    hideTableTools();
    return;
  }
  const node = editor.view.nodeDOM(at.before(depth));
  const table =
    node instanceof HTMLElement
      ? node.matches('table')
        ? node
        : node.querySelector('table')
      : null;
  if (!table) {
    hideTableTools();
    return;
  }
  const bounds = table.getBoundingClientRect(),
    viewport = mount.value.getBoundingClientRect(),
    tools = tableOverlay.value.getBoundingClientRect();
  if (tools.height && tableToolsHeight.value !== tools.height)
    tableToolsHeight.value = tools.height;
  const visible = window.visualViewport,
    visibleLeft = visible?.offsetLeft ?? 0,
    visibleTop = visible?.offsetTop ?? 0;
  const left = Math.max(viewport.left, visibleLeft) + 12,
    right = Math.min(viewport.right, visibleLeft + (visible?.width ?? window.innerWidth)) - 12,
    top = Math.max(viewport.top, visibleTop) + 8,
    bottom = Math.min(viewport.bottom, visibleTop + (visible?.height ?? window.innerHeight)) - 8;
  if (
    bounds.bottom <= top ||
    bounds.top >= bottom ||
    bottom - top < tools.height ||
    right <= left
  ) {
    hideTableTools();
    return;
  }
  const reserved =
    contextSlot.value?.dataset.editorContext === 'table'
      ? contextSlot.value.getBoundingClientRect()
      : undefined;
  let y: number;
  if (reserved && reserved.top >= top && reserved.top + tools.height <= bottom) y = reserved.top;
  else {
    // Once the reserved header scrolls away, keep controls inside the table and
    // clear of the current cell. Adjacent paragraphs never become overlay space.
    const node = editor.view.domAtPos(at.pos).node;
    const element = node instanceof HTMLElement ? node : node.parentElement;
    const cell = element?.closest('td, th') || table.querySelector('.selectedCell');
    const current = cell?.getBoundingClientRect();
    const tableTop = Math.max(top, bounds.top),
      tableBottom = Math.min(bottom, bounds.bottom);
    if (current && current.top - tools.height - 8 >= tableTop) y = current.top - tools.height - 8;
    else if (current && current.bottom + 8 + tools.height <= tableBottom) y = current.bottom + 8;
    else {
      hideTableTools();
      return;
    }
  }
  tableAnchorRect = new DOMRect(bounds.left, y, 0, 0);
  if (!tablePositioner || positionedTable !== table) {
    tablePositioner?.stop();
    positionedTable = table;
    tablePositioner = createFloatingTools(
      virtualAnchor(() => tableAnchorRect!, table),
      tableOverlay.value,
      {
        gap: 0,
        flip: false,
        boundary: mount.value,
        padding: { left: 12, right: 12, top: 8, bottom: 8 },
      },
      (style) => {
        tablePosition.value = style;
      },
    );
  }
  void tablePositioner.update();
}
function scheduleTableTools() {
  if (positionFrame === undefined) positionFrame = requestAnimationFrame(positionTableTools);
}
function bookmark(): SelectionBookmark {
  if (!editor) return props.session.snapshot().selection;
  const state = editor.state,
    at = state.selection.$from,
    index = at.index(0);
  const unit = parseSource(props.session.snapshot().markdown).units[index];
  const prefix = at.depth
    ? at.node(1).textBetween(0, Math.max(0, at.pos - at.before(1) - 1), '\n')
    : '';
  const needle = unit?.raw.includes('\r\n') ? prefix.replace(/\n/g, '\r\n') : prefix;
  const found = unit?.raw.indexOf(needle) ?? -1;
  const offset = unit ? unit.from + (found >= 0 ? found + needle.length : 0) : 0;
  return {
    anchor: offset,
    head: offset + Math.max(0, state.selection.to - state.selection.from),
    affinity: 'after',
    document: { id: projectionId, anchor: state.selection.anchor, head: state.selection.head },
  };
}
function toolbar() {
  if (!editor) return emptyToolbarState();
  const base = emptyToolbarState();
  let heading = 0;
  for (let i = 1; i <= 6; i++) if (editor.isActive('heading', { level: i })) heading = i;
  const s = {
    ...base,
    heading,
    bold: editor.isActive('bold'),
    italic: editor.isActive('italic'),
    strike: editor.isActive('strike'),
    code: editor.isActive('code') || editor.isActive('codeBlock'),
    quote: editor.isActive('blockquote'),
    bullet: editor.isActive('bulletList'),
    ordered: editor.isActive('orderedList'),
    task: editor.isActive('taskList'),
    alignment: (editor.getAttributes('paragraph').textAlign ||
      editor.getAttributes('heading').textAlign ||
      'left') as MarkdownToolbarState['alignment'],
    color: editor.getAttributes('textStyle').color || null,
    canUndo: props.session.canUndo,
    canRedo: props.session.canRedo,
    styleDisabled:
      editor.isActive('codeBlock') || editor.isActive('code') || editor.isActive('image'),
    headingDisabled:
      editor.isActive('codeBlock') || editor.isActive('image') || editor.isActive('table'),
    disabledActions: [
      ...(!editor.can().sinkListItem(editor.isActive('taskList') ? 'taskItem' : 'listItem')
        ? ['indent' as const]
        : []),
      ...(!editor.can().liftListItem(editor.isActive('taskList') ? 'taskItem' : 'listItem')
        ? ['outdent' as const]
        : []),
      ...(editor.isActive('codeBlock')
        ? (['quote', 'bulletList', 'orderedList', 'taskList', 'rule', 'table'] as const)
        : []),
      ...(editor.isActive('table')
        ? ([
            'table',
            'codeBlock',
            'quote',
            'bulletList',
            'orderedList',
            'taskList',
            'rule',
            'alignLeft',
            'alignCenter',
            'alignRight',
          ] as const)
        : []),
      ...(editor.isActive('image')
        ? ([
            'bold',
            'italic',
            'strike',
            'inlineCode',
            'link',
            'codeBlock',
            'quote',
            'bulletList',
            'orderedList',
            'taskList',
            'rule',
            'table',
          ] as const)
        : []),
    ],
  };
  tableActive.value = contextAt(editor.state)?.kind === 'table';
  if (tableActive.value) {
    const at = editor.state.selection.$from;
    for (let depth = at.depth; depth > 0; depth--) {
      if (at.node(depth).type.name !== 'table') continue;
      const table = at.node(depth);
      const moves = tableMoveAvailability(editor.state);
      tableDetails.value = {
        rows: table.childCount,
        columns: table.firstChild?.childCount || 0,
        alignment:
          editor.getAttributes('tableCell').align ||
          editor.getAttributes('tableHeader').align ||
          'left',
        disabledActions: tableMoveActions.filter(action => !moves[action]),
      };
      break;
    }
  }
  scheduleTableTools();
  imageActive.value = editor.isActive('image');
  if (imageActive.value) {
    const attrs = editor.getAttributes('image'),
      key = JSON.stringify([attrs.sourceId, attrs.src, attrs.alt, attrs.title]);
    imagePosition = editor.state.selection.from;
    if (key !== imageIdentity) {
      imageIdentity = key;
      imageAlt.value = attrs.alt || '';
      imageTitle.value = attrs.title || '';
    }
  }
  activeLink.value = editor.isActive('link') ? editor.getAttributes('link').href || '' : '';
  return s;
}
function sealEditingContext() {
  if (!editor) return;
  const context = contextAt(editor.state);
  const next = context?.kind === 'code' ? `code:${context.position}` : 'body';
  if (
    editingContext &&
    next !== editingContext &&
    (next.startsWith('code:') || editingContext.startsWith('code:'))
  )
    props.session.sealHistory();
  editingContext = next;
}
function report() {
  if (!editor) return;
  sealEditingContext();
  emit('state-change', toolbar());
  emit('stats-change', statistics());
  const b = bookmark();
  props.session.setSelection(b);
  emit('line-change', props.session.snapshot().markdown.slice(0, b.anchor).split('\n').length);
}
function publish() {
  if (!editor || loading || blocked) return;
  const result = projection.serialize(
    editor.getJSON(),
    pendingOpaqueDeletion ? { deleteOpaqueId: pendingOpaqueDeletion } : undefined,
  );
  if (!result.ok) {
    error(result.message);
    return false;
  }
  const current = props.session.snapshot();
  const result2 = props.session.apply({
    noteId: current.noteId,
    generation: current.generation,
    baseRevision: current.revision,
    origin: 'document',
    edits: textEdit(current.markdown, result.markdown),
    selection: bookmark(),
    intent: pendingOpaqueDeletion ? 'deleteOpaque' : undefined,
  });
  if (!result2.ok) {
    error(result2.message);
    return false;
  }
  if (pendingOpaqueDeletion) {
    projection.confirmOpaqueDeletion(pendingOpaqueDeletion);
    pendingOpaqueDeletion = '';
  }
  message.value = '';
  emit('change', result.markdown);
  report();
  return true;
}
function startComposition() {
  props.session.setComposing(true);
  emit('composing', true);
}
function endComposition() {
  clearTimeout(compositionTimer);
  compositionTimer = setTimeout(() => {
    if (!editor) return;
    finishComposition();
  }, 0);
}
function finishComposition() {
  if (publish() === false) {
    recoveryPending.value = true;
    props.session.rejectPendingFlush('当前输入尚不能安全保存，请先保留恢复副本或调整格式');
    return;
  }
  recoveryPending.value = false;
  props.session.setComposing(false);
  emit('composing', false);
}
function downloadRecovery() {
  if (!editor) return;
  const snapshot = props.session.snapshot(),
    richDocument = editor.getJSON();
  const rawBlocks = (richDocument.content || [])
    .filter((node) => node.type === 'opaqueSource')
    .map((node) => ({
      id: node.attrs?.sourceId,
      raw: projection.sourceRange(node.attrs?.sourceId)?.raw,
    }));
  const blob = new Blob(
    [
      JSON.stringify(
        {
          format: 'dooknow-editor-recovery-v1',
          noteId: snapshot.noteId,
          markdown: snapshot.markdown,
          richDocument,
          rawBlocks,
        },
        null,
        2,
      ),
    ],
    { type: 'application/json;charset=utf-8' },
  );
  const url = URL.createObjectURL(blob),
    link = document.createElement('a');
  link.href = url;
  link.download = `dooknow-recovery-${snapshot.noteId}.json`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
onMounted(() => {
  if (!projection.eligibility.allowed) {
    emit('error', projection.eligibility.message || '此笔记请使用源码编辑');
    emit('source', 0);
    return;
  }
  const guard = Extension.create({
    name: 'sourceGuard',
    addProseMirrorPlugins() {
      return [
        new Plugin({
          filterTransaction(tr) {
            if (loading || !tr.docChanged) return true;
            if (blocked) return false;
            if (props.session.composing) return true;
            const result = projection.serialize(
              tr.doc.toJSON(),
              pendingOpaqueDeletion ? { deleteOpaqueId: pendingOpaqueDeletion } : undefined,
            );
            if (!result.ok) {
              error(result.message);
              return false;
            }
            return true;
          },
        }),
      ];
    },
  });
  editor = new Editor({
    element: mount.value,
    content: projection.json,
    extensions: [
      ...richExtensions(
        (id) => void openRawSource(id),
        (url) => props.resolveImage?.(url),
        (id) => {
          if (!props.readOnly) deletingOpaque.value = id;
        },
        (id) => {
          const raw = projection.sourceRange(id)?.raw;
          if (raw !== undefined) {
            copyingRaw.value = raw;
            void navigator.clipboard?.writeText(raw).catch(() => {});
          }
        },
        (url) => emit('open-link', url),
      ),
      guard,
      contextSlots(() => !props.readOnly, scheduleTableTools),
    ],
    enableInputRules: false,
    enablePasteRules: false,
    injectCSS: false,
    editable: !props.readOnly,
    editorProps: {
      handleDOMEvents: {
        copy(view, event) {
          let contains = false;
          view.state.doc.nodesBetween(
            view.state.selection.from,
            view.state.selection.to,
            (node) => {
              if (node.type.name === 'opaqueSource') contains = true;
            },
          );
          if (!contains) return false;
          event.preventDefault();
          if (
            view.state.selection.from <= 1 &&
            view.state.selection.to >= view.state.doc.content.size - 1
          ) {
            event.clipboardData?.setData('text/plain', props.session.snapshot().markdown);
          } else {
            message.value = '选区包含原文保留块，请使用该块的“复制原文”或切换源码复制';
          }
          return true;
        },
        click(_view, event) {
          if ((event.target as HTMLElement).closest('a')) event.preventDefault();
          return false;
        },
      },
      handleKeyDown(view, event) {
        const key = event.key.toLowerCase();
        if (
          !props.readOnly &&
          !props.session.composing &&
          !event.isComposing &&
          (event.ctrlKey || event.metaKey) &&
          !event.altKey &&
          (['b', 'i', 'e', 'k'].includes(key) || (event.shiftKey && key === 's'))
        ) {
          // Synchronize the DOM caret before a pending selectionchange can clear
          // formatting applied at an obsolete position.
          syncDOMTextSelection(view);
        }
        if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') {
          event.preventDefault();
          execute('link');
          return true;
        }
        return false;
      },
      attributes: {
        'data-note-id': props.session.snapshot().noteId,
        role: 'textbox',
        'aria-label': '文档正文',
        'aria-multiline': 'true',
        spellcheck: 'false',
      },
      handlePaste(view, event) {
        if (props.readOnly) return true;
        const data = event.clipboardData;
        if (!data) return false;
        if (data.files.length) {
          event.preventDefault();
          if (data.files.length === 1) emit('upload-file', data.files[0]);
          else emit('upload-files', Array.from(data.files));
          return true;
        }
        if (editor?.isActive('codeBlock')) {
          event.preventDefault();
          view.dispatch(view.state.tr.insertText(data.getData('text/plain')));
          return true;
        }
        const html = data.getData('text/html');
        if (!html) {
          event.preventDefault();
          if (!data.getData('text/plain')) return true;
          props.session.sealHistory();
          const content = data
            .getData('text/plain')
            .split(/\r?\n/)
            .map((text) => ({ type: 'paragraph', content: text ? [{ type: 'text', text }] : [] }));
          editor?.chain().focus().insertContent(content).run();
          return true;
        }
        const result = convertClipboard({
          text: data.getData('text/plain'),
          html,
          resolveImage: props.resolveImage,
        });
        event.preventDefault();
        if (result.kind === 'plain-text-choice') {
          pasteChoice.value = result;
          return true;
        }
        insertMarkdown(result.markdown);
        return true;
      },
      handleDrop(view, event, _slice, moved) {
        const files = event.dataTransfer?.files;
        if (moved || !files?.length) return false;
        event.preventDefault();
        if (props.readOnly || blocked || props.session.composing) return true;
        const point = view.posAtCoords({ left: event.clientX, top: event.clientY });
        if (point)
          view.dispatch(
            view.state.tr.setSelection(TextSelection.near(view.state.doc.resolve(point.pos))),
          );
        if (files.length === 1) emit('upload-file', files[0]);
        else emit('upload-files', Array.from(files));
        return true;
      },
    },
    onTransaction({ transaction }) {
      if (loading) return;
      if (transaction.getMeta(CODE_BLOCK_ACTION)) props.session.sealHistory();
      sealEditingContext();
      // Keep the pre-edit bookmark until publish records it in shared history.
      if (!transaction.docChanged && !props.session.composing) report();
    },
    onUpdate() {
      if (recoveryPending.value) finishComposition();
      else if (!props.session.composing) publish();
    },
    onSelectionUpdate({ transaction }) {
      if (!loading && !transaction.docChanged) report();
    },
    onCreate() {
      report();
      if (props.initialLine) goToLine(props.initialLine);
    },
  });
  editor.view.dom.addEventListener('compositionstart', startComposition);
  editor.view.dom.addEventListener('compositionend', endComposition);
  layoutObserver = new ResizeObserver(scheduleTableTools);
  if (root.value) layoutObserver.observe(root.value);
  layoutObserver.observe(editor.view.dom);
  window.addEventListener('resize', scheduleTableTools);
  window.visualViewport?.addEventListener('resize', scheduleTableTools);
  window.visualViewport?.addEventListener('scroll', scheduleTableTools);
  report();
});
watch(
  () => props.readOnly,
  (v) => editor?.setEditable(!v),
);
function load(markdown: string) {
  if (!editor) return;
  if (recoveryPending.value) {
    recoveryPending.value = false;
    props.session.setComposing(false);
    emit('composing', false);
  }
  const next = createRichProjection(markdown);
  if (!next.eligibility.allowed) {
    blocked = true;
    projection = next;
    editor.setEditable(false);
    emit('source', 0);
    return;
  }
  blocked = false;
  loading = true;
  try {
    projection = next;
    projectionId = newProjectionId();
    editor.commands.setContent(projection.json, { emitUpdate: false });
  } finally {
    loading = false;
  }
  report();
}
function focus(target?: SelectionBookmark) {
  if (!editor) return;
  if (target?.document?.id === projectionId) {
    const native = target.document;
    const a = editor.state.doc.resolve(Math.min(native.anchor, editor.state.doc.content.size)),
      b = editor.state.doc.resolve(Math.min(native.head, editor.state.doc.content.size));
    const selection =
      a.parent.inlineContent && b.parent.inlineContent
        ? TextSelection.create(editor.state.doc, a.pos, b.pos)
        : TextSelection.near(a);
    editor.view.dispatch(editor.state.tr.setSelection(selection));
    editor.view.focus();
    return;
  }
  if (target) {
    const units = parseSource(props.session.snapshot().markdown).units;
    // Adjacent source units share an endpoint. Prefer the unit beginning at
    // that offset, while still allowing the final unit's inclusive EOF.
    let index = units.findIndex((u) => target.anchor >= u.from && target.anchor < u.to);
    if (index < 0) index = units.findIndex((u) => target.anchor >= u.from && target.anchor <= u.to);
    if (index < 0) index = units.length - 1;
    let at = 0;
    for (let i = 0; i < index && i < editor.state.doc.childCount; i++)
      at += editor.state.doc.child(i).nodeSize;
    const node = editor.state.doc.child(
      Math.max(0, Math.min(index, editor.state.doc.childCount - 1)),
    );
    const unit = units[index];
    const text = node.textContent;
    const rawStart = unit?.raw.indexOf(text) ?? 0;
    const relative = Math.max(0, target.anchor - (unit?.from || 0) - Math.max(0, rawStart));
    const point = Math.min(
      editor.state.doc.content.size,
      at + 1 + Math.min(relative, node.content.size),
    );
    editor.view.dispatch(
      editor.state.tr.setSelection(TextSelection.near(editor.state.doc.resolve(point))),
    );
  }
  editor.view.focus();
  editor.commands.scrollIntoView();
}
function goToLine(line: number) {
  const text = props.session.snapshot().markdown;
  const offset =
    text
      .split('\n')
      .slice(0, Math.max(0, line - 1))
      .join('\n').length + (line > 1 ? 1 : 0);
  focus({ anchor: offset, head: offset, affinity: 'after' });
}
function execute(action: MarkdownAction): boolean {
  if (!editor || props.readOnly || blocked || props.session.composing || editor.view.composing)
    return false;
  props.session.sealHistory();
  const chain = editor.chain().focus();
  if (action === 'bold') return chain.toggleBold().run();
  if (action === 'italic') return chain.toggleItalic().run();
  if (action === 'strike') return chain.toggleStrike().run();
  if (action === 'inlineCode') return chain.toggleCode().run();
  if (action === 'clearFormatting')
    return chain.unsetBold().unsetItalic().unsetStrike().unsetCode().unsetColor().run();
  if (action === 'quote') return chain.toggleBlockquote().run();
  if (action === 'bulletList') return chain.toggleBulletList().run();
  if (action === 'orderedList') return chain.toggleOrderedList().run();
  if (action === 'taskList') return chain.toggleTaskList().run();
  if (action === 'codeBlock') return chain.toggleCodeBlock().run();
  if (action === 'rule') return chain.setHorizontalRule().run();
  if (action === 'table') return chain.insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run();
  if (action === 'paragraph') return chain.setParagraph().run();
  if (/^heading[1-6]$/.test(action))
    return chain.toggleHeading({ level: Number(action.at(-1)) as 1 | 2 | 3 | 4 | 5 | 6 }).run();
  if (action === 'indent')
    return chain.sinkListItem(editor.isActive('taskList') ? 'taskItem' : 'listItem').run();
  if (action === 'outdent')
    return chain.liftListItem(editor.isActive('taskList') ? 'taskItem' : 'listItem').run();
  if (action === 'alignLeft' || action === 'alignCenter' || action === 'alignRight')
    return chain
      .setTextAlign(action === 'alignLeft' ? 'left' : action === 'alignCenter' ? 'center' : 'right')
      .run();
  if (action === 'colorDefault') return chain.unsetColor().run();
  if (action.startsWith('color:')) return chain.setColor(action.slice(6)).run();
  if (action === 'link') {
    linkError.value = '';
    const link = editor.getAttributes('link');
    if (editor.state.selection.empty && editor.isActive('link'))
      editor.commands.extendMarkRange('link');
    linkUrl.value = link.href || '';
    linkTitle.value = link.title || '';
    linkText.value = editor.state.doc.textBetween(
      editor.state.selection.from,
      editor.state.selection.to,
      ' ',
    );
    linkTarget = {
      from: editor.state.selection.from,
      to: editor.state.selection.to,
      revision: props.session.snapshot().revision,
      text: linkText.value,
    };
    linkOpen.value = true;
    return true;
  }
  return false;
}
function confirmLink() {
  if (!editor || !linkTarget) return;
  if (props.readOnly || blocked) {
    linkError.value = '编辑器暂不可编辑，请稍后重试';
    return;
  }
  if (props.session.snapshot().revision !== linkTarget.revision) {
    linkError.value = '正文已变化，请关闭后重新选择链接';
    return;
  }
  if (!safeEditorUrl(linkUrl.value)) {
    linkError.value = '请输入有效的链接地址';
    return;
  }
  props.session.sealHistory();
  const attrs = { href: linkUrl.value, title: linkTitle.value || null };
  const chain = editor
    .chain()
    .focus()
    .setTextSelection({ from: linkTarget.from, to: linkTarget.to });
  if (linkTarget.from === linkTarget.to || linkText.value !== linkTarget.text)
    chain
      .insertContent({
        type: 'text',
        text: linkText.value || linkUrl.value,
        marks: [{ type: 'link', attrs }],
      })
      .run();
  else chain.setLink(attrs).run();
  linkOpen.value = false;
}
async function openRawSource(id: string) {
  try {
    await flush();
    const range = projection.sourceRange(id);
    if (range) emit('source', range.from);
  } catch (cause) {
    error(cause instanceof Error ? cause.message : '请先保留当前输入');
  }
}
function editHistory(action: 'undo' | 'redo') {
  if (props.readOnly || blocked || props.session.composing) return false;
  const result = props.session[action]();
  if (!result.ok) return false;
  load(result.markdown);
  emit('change', result.markdown);
  focus(result.selection);
  return true;
}
function insertMarkdown(markdown: string, target?: SelectionBookmark) {
  if (target?.document && target.document.id !== projectionId) return false;
  if (!editor || props.readOnly || blocked) return false;
  if (target) focus(target);
  props.session.sealHistory();
  try {
    const nodes = parseRichContent(markdown);
    const content =
      nodes.length === 1 && nodes[0].type === 'paragraph' && !nodes[0].attrs?.textAlign
        ? nodes[0].content || []
        : nodes;
    return editor.chain().focus().insertContent(content).run();
  } catch {
    error('此内容无法插入，请保留原文后使用源码编辑');
    return false;
  }
}
function insertTable(rows: number, columns: number) {
  if (
    !editor ||
    props.readOnly ||
    blocked ||
    !Number.isInteger(rows) ||
    !Number.isInteger(columns) ||
    rows < 1 ||
    rows > 20 ||
    columns < 1 ||
    columns > 10 ||
    editor.isActive('table') ||
    editor.isActive('codeBlock')
  )
    return false;
  props.session.sealHistory();
  return editor.chain().focus().insertTable({ rows, cols: columns, withHeaderRow: true }).run();
}
function requestImageReplacement() {
  if (!editor || props.readOnly || !imageActive.value) return;
  const node = editor.state.doc.nodeAt(imagePosition);
  if (node?.type.name !== 'image') return;
  emit('replace-image', {
    position: imagePosition,
    src: node.attrs.src,
    revision: props.session.snapshot().revision,
    projectionId,
  });
}
function replaceImage(target: ImageReplacementTarget, src: string) {
  if (
    !editor ||
    props.readOnly ||
    blocked ||
    target.projectionId !== projectionId ||
    target.revision !== props.session.snapshot().revision ||
    !safeEditorUrl(src)
  )
    return false;
  const node = editor.state.doc.nodeAt(target.position);
  if (node?.type.name !== 'image' || node.attrs.src !== target.src) return false;
  props.session.sealHistory();
  return editor
    .chain()
    .focus()
    .setNodeSelection(target.position)
    .updateAttributes('image', { src })
    .run();
}
function previewImage() {
  if (!editor) return;
  const node = editor.state.doc.nodeAt(imagePosition);
  if (node?.type.name !== 'image') return;
  const url = props.resolveImage?.(node.attrs.src);
  if (!url || !/^\/api\/assets\/[a-zA-Z0-9-]+(?:\?|$)/.test(url)) {
    error('图片暂时无法预览，请重新打开笔记后再试');
    return;
  }
  imagePreviewUrl.value = url;
  imagePreviewScale.value = 100;
  imagePreviewOpen.value = true;
}
function deleteImage() {
  if (!editor || props.readOnly || editor.state.doc.nodeAt(imagePosition)?.type.name !== 'image')
    return;
  props.session.sealHistory();
  editor.chain().focus().setNodeSelection(imagePosition).deleteSelection().run();
}
function executeTable(action: TableAction) {
  if (!editor || props.readOnly || blocked || props.session.composing || editor.view.composing) return false;
  syncDOMTextSelection(editor.view);
  props.session.sealHistory();
  if (isTableMoveAction(action)) {
    editor.view.focus();
    const result = moveMarkdownTable(action)(editor.state, tr => editor!.view.dispatch(tr));
    props.session.sealHistory();
    return result;
  }
  const chain = editor.chain().focus();
  if (action.startsWith('align')) {
    const align = action === 'alignLeft' ? 'left' : action === 'alignCenter' ? 'center' : 'right';
    return chain
      .command(({ tr }) => {
        const at = tr.selection.$from;
        let depth = at.depth;
        while (depth > 0 && at.node(depth).type.name !== 'table') depth--;
        if (!depth || at.depth <= depth) return false;
        const table = at.node(depth),
          column = at.index(depth + 1),
          start = at.start(depth);
        // Markdown alignment belongs to a column, including its header. A single
        // cell attribute would be discarded when that table is serialized.
        table.forEach((row, rowOffset) =>
          row.forEach((cell, cellOffset, index) => {
            if (index === column)
              tr.setNodeMarkup(start + rowOffset + cellOffset + 1, undefined, {
                ...cell.attrs,
                align,
              });
          }),
        );
        return true;
      })
      .run();
  }
  return chain[action as Exclude<TableAction, TableMoveAction | 'alignLeft' | 'alignCenter' | 'alignRight'>]().run();
}
function confirmOpaqueDelete() {
  if (!editor || props.readOnly) return;
  const id = deletingOpaque.value;
  let range: { from: number; to: number } | undefined;
  editor.state.doc.forEach((node, offset) => {
    if (node.attrs.sourceId === id && node.type.name === 'opaqueSource')
      range = { from: offset, to: offset + node.nodeSize };
  });
  if (!range) return;
  pendingOpaqueDeletion = id;
  props.session.sealHistory();
  editor.view.focus();
  editor.chain().deleteRange(range).run();
  pendingOpaqueDeletion = '';
  deletingOpaque.value = '';
}
function preserveContextSelection(event: MouseEvent) {
  if ((event.target as HTMLElement).closest('button')) event.preventDefault();
}
function applyImage() {
  if (editor && !props.readOnly) {
    props.session.sealHistory();
    const attrs = { alt: imageAlt.value, title: imageTitle.value || null };
    if (editor.state.doc.nodeAt(imagePosition)?.type.name !== 'image') {
      error('请重新选中图片再修改说明');
      return;
    }
    editor.chain().focus().setNodeSelection(imagePosition).updateAttributes('image', attrs).run();
  }
}
async function flush() {
  if (recoveryPending.value) throw Error('当前输入尚不能安全保存，请先保留恢复副本或调整格式');
  if (!blocked && !props.session.composing && publish() === false) throw Error(message.value);
  return props.session.flush();
}
function searchText(query: string, caseSensitive = false) {
  return editor ? documentMatches(editor.state.doc, query, caseSensitive) : [];
}
function selectTextMatch(match: TextMatch) {
  if (
    !editor ||
    props.session.composing ||
    editor.view.composing ||
    match.from < 0 ||
    match.to > editor.state.doc.content.size
  )
    return;
  editor.view.dispatch(
    editor.state.tr
      .setSelection(TextSelection.create(editor.state.doc, match.from, match.to))
      .scrollIntoView(),
  );
  editor.view.focus();
}
function replaceTextMatches(
  query: string,
  replacement: string,
  all: boolean,
  index = 0,
  caseSensitive = false,
) {
  if (!editor || props.readOnly || blocked || props.session.composing || editor.view.composing)
    return false;
  const matches = searchText(query, caseSensitive);
  if (!matches.length) return false;
  const selected = all ? matches : [matches[Math.max(0, Math.min(index, matches.length - 1))]];
  props.session.sealHistory();
  const transaction = editor.state.tr;
  for (const match of [...selected].reverse())
    transaction.insertText(replacement, match.from, match.to);
  editor.view.dispatch(transaction.scrollIntoView());
  props.session.sealHistory();
  return transaction.docChanged && editor.state.doc.eq(transaction.doc);
}
function statistics(): DocumentStatistics {
  if (!editor) return { characters: 0, selectedCharacters: 0 };
  const { from, to } = editor.state.selection;
  return {
    characters: countCharacters(visibleDocumentText(editor.state.doc)),
    selectedCharacters: countCharacters(visibleDocumentText(editor.state.doc, from, to)),
  };
}
defineExpose({
  sourceRange: (id: string) => projection.sourceRange(id),
  searchText,
  selectTextMatch,
  replaceTextMatches,
  statistics,
  flush,
  format: execute,
  execute,
  editHistory,
  focus,
  goToLine,
  state: toolbar,
  selection: bookmark,
  insertAsset: insertMarkdown,
  insertTable,
  replaceImage,
  executeTable,
  load,
});
onBeforeUnmount(() => {
  tablePositioner?.stop();
  clearTimeout(compositionTimer);
  if (positionFrame !== undefined) cancelAnimationFrame(positionFrame);
  layoutObserver?.disconnect();
  window.removeEventListener('resize', scheduleTableTools);
  window.visualViewport?.removeEventListener('resize', scheduleTableTools);
  window.visualViewport?.removeEventListener('scroll', scheduleTableTools);
  if (editor) {
    editor.view.dom.removeEventListener('compositionstart', startComposition);
    editor.view.dom.removeEventListener('compositionend', endComposition);
    editor.destroy();
  }
  props.session.setComposing(false);
});
</script>
<template>
  <div
    ref="root"
    class="document-editor"
    :style="{ '--table-tools-height': tableToolsHeight + 'px' }"
  >
    <p v-if="message" class="editor-warning" role="alert">{{ message }}</p>
    <div v-if="recoveryPending" class="editor-warning" role="status">
      当前输入暂时无法安全保存。请先保留恢复副本，调整格式后再保存。
      <button type="button" @click="downloadRecovery">下载恢复副本</button>
    </div>
    <div
      v-if="tableActive && !readOnly"
      ref="tableOverlay"
      class="document-table-overlay"
      :style="{ ...tablePosition, visibility: tablePosition ? 'visible' : 'hidden' }"
    >
      <DocumentTableTools
        :disabled="readOnly"
        v-bind="tableDetails"
        @action="executeTable"
        @exit="editor?.view.focus()"
      />
    </div>
    <Teleport v-if="contextSlot && contextSlot.dataset.editorContext !== 'table'" :to="contextSlot">
      <div
        v-if="imageActive"
        class="document-context-tools document-image-tools"
        role="group"
        aria-label="图片设置"
        @mousedown="preserveContextSelection"
      >
        <div class="context-tools-heading">
          <span class="context-tools-icon"><Icon name="image" :size="17" /></span>
          <span>图片<small>编辑图片说明</small></span>
        </div>
        <label class="context-tools-field"
          >替代文字
          <input
            v-model="imageAlt"
            aria-label="图片替代文字"
            placeholder="描述图片内容"
            :disabled="readOnly"
          />
        </label>
        <label class="context-tools-field"
          >图片标题
          <input
            v-model="imageTitle"
            aria-label="图片标题"
            placeholder="添加标题（可选）"
            :disabled="readOnly"
          />
        </label>
        <button type="button" class="editor-menu-primary" :disabled="readOnly" @click="applyImage">
          <Icon name="check" :size="15" />应用图片说明
        </button>
        <div class="context-tools-actions">
          <button type="button" aria-label="预览图片" @click="previewImage">
            <Icon name="eye" :size="15" />预览图片
          </button>
          <button
            type="button"
            aria-label="替换图片"
            :disabled="readOnly"
            @click="requestImageReplacement"
          >
            <Icon name="refresh" :size="15" />替换图片
          </button>
          <button
            type="button"
            aria-label="删除图片"
            class="editor-menu-danger"
            :disabled="readOnly"
            @click="deleteImage"
          >
            <Icon name="trash" :size="15" />删除图片
          </button>
        </div>
      </div>
      <div
        v-if="activeLink"
        class="document-context-tools document-link-tools"
        role="group"
        aria-label="链接操作"
        @mousedown="preserveContextSelection"
      >
        <div class="context-tools-heading">
          <span class="context-tools-icon"><Icon name="link" :size="17" /></span>
          <span
            >链接<small class="context-link-url" :title="activeLink">{{ activeLink }}</small></span
          >
        </div>
        <div class="context-tools-actions">
          <button type="button" @click="emit('open-link', activeLink)">
            <Icon name="forward" :size="15" />打开链接
          </button>
          <button type="button" :disabled="readOnly" @click="execute('link')">
            <Icon name="link" :size="15" />编辑链接
          </button>
          <button
            type="button"
            class="editor-menu-danger"
            :disabled="readOnly"
            @click="editor?.chain().focus().unsetLink().run()"
          >
            <Icon name="close" :size="15" />移除链接
          </button>
        </div>
      </div>
    </Teleport>
    <div ref="mount" class="document-editor-mount" @scroll.passive="scheduleTableTools"></div>
    <NModal
      v-model:show="imagePreviewOpen"
      preset="card"
      title="图片预览"
      class="dialog-card editor-dialog editor-image-preview"
    >
      <div class="image-preview-controls">
        <label
          >预览缩放
          <input
            v-model.number="imagePreviewScale"
            type="range"
            min="25"
            max="200"
            step="25"
            aria-label="图片缩放"
        /></label>
        <span>{{ imagePreviewScale }}%</span>
        <button type="button" @click="imagePreviewScale = 100">重置缩放</button>
      </div>
      <div class="image-preview-canvas">
        <img
          :src="imagePreviewUrl"
          :alt="imageAlt || '图片预览'"
          :style="{ transform: `scale(${imagePreviewScale / 100})` }"
        />
      </div>
    </NModal>
    <NModal
      :show="copyingRaw !== undefined"
      preset="card"
      title="复制保留原文"
      class="dialog-card editor-dialog"
      @update:show="
        (v) => {
          if (!v) copyingRaw = undefined;
        }
      "
      ><p>可选择并复制下方完整原文。</p>
      <textarea
        class="raw-source-copy"
        aria-label="保留块原文"
        :value="copyingRaw"
        readonly
        @focus="($event.target as HTMLTextAreaElement).select()"
      ></textarea>
    </NModal>
    <NModal
      :show="!!deletingOpaque"
      preset="card"
      title="删除保留内容？"
      class="dialog-card editor-dialog"
      @update:show="
        (v) => {
          if (!v) deletingOpaque = '';
        }
      "
      ><p>将移除此块原文，保存后生效；可以通过撤销恢复。</p>
      <div class="dialog-actions">
        <button @click="deletingOpaque = ''">取消</button
        ><button class="editor-menu-danger" @click="confirmOpaqueDelete">确认删除此内容</button>
      </div></NModal
    >
    <NModal v-model:show="linkOpen" preset="card" title="编辑链接" class="dialog-card editor-dialog"
      ><div class="document-link-fields">
        <label>显示文字<input v-model="linkText" aria-label="链接文字" /></label
        ><label
          >链接地址<input
            v-model="linkUrl"
            aria-label="链接地址"
            placeholder="https://"
            :aria-invalid="!!linkError"
            :aria-describedby="linkError ? linkErrorId : undefined"
            @input="linkError = ''"
          />
          <span v-if="linkError" :id="linkErrorId" class="editor-field-error" role="alert">{{
            linkError
          }}</span> </label
        ><label>标题<input v-model="linkTitle" aria-label="链接标题" /></label>
      </div>
      <div class="dialog-actions">
        <button @click="linkOpen = false">取消</button
        ><button class="editor-menu-primary" @click="confirmLink">保存链接</button>
      </div></NModal
    >
    <NModal
      :show="!!pasteChoice"
      preset="card"
      title="粘贴内容"
      class="dialog-card editor-dialog"
      @update:show="
        (v) => {
          if (!v) pasteChoice = undefined;
        }
      "
      ><p>{{ pasteChoice?.reason }}</p>
      <div class="dialog-actions">
        <button @click="pasteChoice = undefined">取消</button
        ><button
          class="editor-menu-primary"
          @click="
            () => {
              if (pasteChoice) insertMarkdown(plainTextMarkdown(pasteChoice.text));
              pasteChoice = undefined;
            }
          "
        >
          按普通文本粘贴
        </button>
      </div></NModal
    >
  </div>
</template>
