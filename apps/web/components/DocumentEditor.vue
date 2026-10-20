<script setup lang="ts">
import { onMounted, onBeforeUnmount, ref, watch } from 'vue';
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
import { textEdit, parseSource } from '../editor/source-codec';
import { syncDOMTextSelection } from '../editor/dom-selection';
import type { EditorSession } from '../editor/session';
import type { SelectionBookmark, TableAction } from '../editor/contracts';
import {
  emptyToolbarState,
  type MarkdownAction,
  type MarkdownToolbarState,
} from '../editor/toolbar-state';
import DocumentTableTools from './DocumentTableTools.vue';
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
}>();
const mount = ref<HTMLElement>(),
  message = ref(''),
  tableActive = ref(false),
  codeActive = ref(false),
  imageActive = ref(false),
  imageAlt = ref(''),
  imageTitle = ref(''),
  activeLink = ref(''),
  language = ref('');
const newProjectionId = () => Date.now().toString(36) + '-' + Math.random().toString(36).slice(2);
let projectionId = newProjectionId();
let editor: Editor | undefined,
  projection = createRichProjection(props.session.snapshot().markdown),
  loading = false,
  blocked = false,
  pendingOpaqueDeletion = '',
  imageIdentity = '',
  codeIdentity = '',
  imagePosition = 0,
  compositionTimer: ReturnType<typeof setTimeout> | undefined;
const deletingOpaque = ref(''),
  copyingRaw = ref<string>(),
  recoveryPending = ref(false);
const linkOpen = ref(false),
  linkUrl = ref(''),
  linkTitle = ref(''),
  linkText = ref('');
let linkTarget: { from: number; to: number; revision: number; text: string } | undefined;
const pasteChoice = ref<{ text: string; reason: string }>();
function error(text: string) {
  message.value = text;
  emit('error', text);
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
  };
  tableActive.value = editor.isActive('table');
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
  codeActive.value = editor.isActive('codeBlock');
  const code = editor.getAttributes('codeBlock');
  const codeKey = codeActive.value ? JSON.stringify([editor.state.selection.$from.start(), code.language]) : '';
  if (codeKey !== codeIdentity) {
    codeIdentity = codeKey;
    language.value = code.language || '';
  }
  return s;
}
function report() {
  if (!editor) return;
  emit('state-change', toolbar());
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
      ),
      guard,
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
        if (!props.readOnly && !props.session.composing && !event.isComposing &&
            (event.ctrlKey || event.metaKey) && !event.altKey &&
            (['b', 'i', 'e', 'k'].includes(key) || (event.shiftKey && key === 's'))) {
          // End/arrows may have moved the DOM caret before selectionchange is
          // delivered. Apply formatting to that caret, so the later selection
          // update cannot clear a mark that was set at an obsolete position.
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
          emit('upload-file', data.files[0]);
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
    },
    onTransaction() {
      if (!loading && !props.session.composing) report();
    },
    onUpdate() {
      if (recoveryPending.value) finishComposition();
      else if (!props.session.composing) publish();
    },
    onSelectionUpdate() {
      if (!loading) report();
    },
    onCreate() {
      report();
      if (props.initialLine) goToLine(props.initialLine);
    },
  });
  editor.view.dom.addEventListener('compositionstart', startComposition);
  editor.view.dom.addEventListener('compositionend', endComposition);
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
    let index = units.findIndex((u) => target.anchor >= u.from && target.anchor <= u.to);
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
  if (!editor || props.readOnly) return false;
  props.session.sealHistory();
  const chain = editor.chain().focus();
  if (action === 'bold') return chain.toggleBold().run();
  if (action === 'italic') return chain.toggleItalic().run();
  if (action === 'strike') return chain.toggleStrike().run();
  if (action === 'inlineCode') return chain.toggleCode().run();
  if (action === 'quote') return chain.toggleBlockquote().run();
  if (action === 'bulletList') return chain.toggleBulletList().run();
  if (action === 'orderedList') return chain.toggleOrderedList().run();
  if (action === 'taskList') return chain.toggleTaskList().run();
  if (action === 'codeBlock') return chain.toggleCodeBlock().run();
  if (action === 'rule') return chain.setHorizontalRule().run();
  if (action === 'table') return chain.insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run();
  if (action === 'paragraph') return chain.setParagraph().run();
  if (/^heading[1-5]$/.test(action))
    return chain.toggleHeading({ level: Number(action.at(-1)) as 1 | 2 | 3 | 4 | 5 }).run();
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
    linkTarget = { from: editor.state.selection.from, to: editor.state.selection.to,
      revision: props.session.snapshot().revision, text: linkText.value };
    linkOpen.value = true;
    return true;
  }
  return false;
}
function confirmLink() {
  if (!editor || !linkTarget) return;
  if (props.session.snapshot().revision !== linkTarget.revision) {
    message.value = '正文已变化，请关闭后重新选择链接';
    return;
  }
  if (!safeEditorUrl(linkUrl.value)) {
    message.value = '请输入有效的链接地址';
    return;
  }
  props.session.sealHistory();
  const attrs = { href: linkUrl.value, title: linkTitle.value || null };
  const chain = editor.chain().focus().setTextSelection({ from: linkTarget.from, to: linkTarget.to });
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
function executeTable(action: TableAction) {
  if (!editor || props.readOnly) return false;
  props.session.sealHistory();
  const chain = editor.chain().focus();
  if (action.startsWith('align')) {
    const align = action === 'alignLeft' ? 'left' : action === 'alignCenter' ? 'center' : 'right';
    return chain.command(({ tr }) => {
      const at = tr.selection.$from;
      let depth = at.depth;
      while (depth > 0 && at.node(depth).type.name !== 'table') depth--;
      if (!depth || at.depth <= depth) return false;
      const table = at.node(depth), column = at.index(depth + 1), start = at.start(depth);
      // Markdown alignment belongs to a column, including its header. A single
      // cell attribute would be discarded when that table is serialized.
      table.forEach((row, rowOffset) => row.forEach((cell, cellOffset, index) => {
        if (index === column) tr.setNodeMarkup(start + rowOffset + cellOffset + 1, undefined, { ...cell.attrs, align });
      }));
      return true;
    }).run();
  }
  return chain[action as Exclude<TableAction, 'alignLeft' | 'alignCenter' | 'alignRight'>]().run();
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
function setLanguage() {
  if (editor && !props.readOnly) {
    props.session.sealHistory();
    editor.chain().updateAttributes('codeBlock', { language: language.value || null }).run();
  }
}
async function flush() {
  if (recoveryPending.value) throw Error('当前输入尚不能安全保存，请先保留恢复副本或调整格式');
  if (!blocked && !props.session.composing && publish() === false) throw Error(message.value);
  return props.session.flush();
}
defineExpose({
  flush,
  format: execute,
  execute,
  editHistory,
  focus,
  goToLine,
  state: toolbar,
  selection: bookmark,
  insertAsset: insertMarkdown,
  executeTable,
  load,
});
onBeforeUnmount(() => {
  clearTimeout(compositionTimer);
  if (editor) {
    editor.view.dom.removeEventListener('compositionstart', startComposition);
    editor.view.dom.removeEventListener('compositionend', endComposition);
    editor.destroy();
  }
  props.session.setComposing(false);
});
</script>
<template>
  <div class="document-editor">
    <p v-if="message" class="editor-warning" role="alert">{{ message }}</p>
    <div v-if="recoveryPending" class="editor-warning" role="status">
      当前输入暂时无法安全保存。请先保留恢复副本，调整格式后再保存。
      <button type="button" @click="downloadRecovery">下载恢复副本</button>
    </div>
    <DocumentTableTools v-if="tableActive" :disabled="readOnly" @action="executeTable" />
    <div v-if="codeActive" class="document-context-tools">
      <label
        >代码语言
        <input
          v-model="language"
          aria-label="代码语言"
          placeholder="纯文本"
          :disabled="readOnly"
          @change="setLanguage"
      /></label>
    </div>
    <div v-if="imageActive" class="document-context-tools" @mousedown="preserveContextSelection">
      <label
        >替代文字 <input v-model="imageAlt" aria-label="图片替代文字" :disabled="readOnly" /></label
      ><label
        >图片标题 <input v-model="imageTitle" aria-label="图片标题" :disabled="readOnly" /></label
      ><button :disabled="readOnly" @click="applyImage">应用图片说明</button>
    </div>
    <div v-if="activeLink" class="document-context-tools" @mousedown="preserveContextSelection">
      <button @click="emit('open-link', activeLink)">打开链接</button
      ><button :disabled="readOnly" @click="execute('link')">编辑链接</button
      ><button :disabled="readOnly" @click="editor?.chain().focus().unsetLink().run()">
        移除链接
      </button>
    </div>
    <div ref="mount" class="document-editor-mount"></div>
    <NModal
      :show="copyingRaw !== undefined"
      preset="card"
      title="复制保留原文"
      class="dialog-card"
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
      class="dialog-card"
      @update:show="
        (v) => {
          if (!v) deletingOpaque = '';
        }
      "
      ><p>将移除此块原文，保存后生效；可以通过撤销恢复。</p>
      <div class="dialog-actions">
        <button @click="deletingOpaque = ''">取消</button
        ><button @click="confirmOpaqueDelete">确认删除此内容</button>
      </div></NModal
    >
    <NModal v-model:show="linkOpen" preset="card" title="编辑链接" class="dialog-card"
      ><div class="document-link-fields">
        <label>显示文字<input v-model="linkText" aria-label="链接文字" /></label
        ><label>链接地址<input v-model="linkUrl" aria-label="链接地址" /></label
        ><label>标题<input v-model="linkTitle" aria-label="链接标题" /></label>
      </div>
      <div class="dialog-actions">
        <button @click="linkOpen = false">取消</button
        ><button @click="confirmLink">保存链接</button>
      </div></NModal
    >
    <NModal
      :show="!!pasteChoice"
      preset="card"
      title="粘贴内容"
      class="dialog-card"
      @update:show="
        (v) => {
          if (!v) pasteChoice = undefined;
        }
      "
      ><p>{{ pasteChoice?.reason }}</p>
      <div class="dialog-actions">
        <button @click="pasteChoice = undefined">取消</button
        ><button
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
