import MarkdownIt from 'markdown-it';
import { parseDiagramDocument, type DiagramDocumentType } from '../../../shared/diagram-document';
import {
  applyPreparedDiagramDocument,
  diagramPlainTitle,
  renderPreparedDiagramDocument,
  type PreparedDiagramPrimary,
} from '../../../shared/diagram-primary';
import type { DiagramCommitInput } from '../../../shared/diagram-document-contracts';
export type DocumentSnapshot = { markdown: string; source: string; title: string };
export type PendingDocumentCommit = DiagramCommitInput &
  DocumentSnapshot & { inputMarkdown?: string };
export type DocumentSessionState = DocumentSnapshot & {
  noteId: string;
  type: DiagramDocumentType;
  intentId?: string;
  documentHash: string | null;
  sourceHash: string | null;
  pending?: PendingDocumentCommit;
};
type Dependencies = {
  hash: (source: string) => string | Promise<string>;
  render: (snapshot: DocumentSnapshot) => Promise<Blob>;
  prepare: (
    snapshot: DocumentSnapshot,
    png: Blob,
    target:
      | { kind: 'creation'; intentId: string }
      | {
          kind: 'document';
          noteId: string;
          expectedDocumentHash: string;
          expectedSourceHash: string;
        },
  ) => Promise<PreparedDiagramPrimary>;
  commit: (request: PendingDocumentCommit) => Promise<unknown>;
  resource: () => Promise<{
    documentHash: string;
    source: { hash: string; content?: string };
    publication?: { state: string };
  }>;
  persist: (state: DocumentSessionState) => Promise<void>;
  changed?: () => void;
};
/** Replace only the actual top-level H1; frontmatter and headings in descriptions remain byte exact. */
export function diagramMarkdownTitle(markdown: string, title: string) {
  const parsed = parseDiagramDocument(markdown);
  if (parsed.status !== 'diagram') throw Error('图形 Markdown 不完整，请在源码中修复');
  if (parsed.title === title) return markdown;
  const before = markdown.slice(parsed.markerRange.to, parsed.primary.range.from);
  const tokens = new MarkdownIt().parse(before, {});
  const heading = tokens.find((t) => t.type === 'heading_open' && t.tag === 'h1' && t.level === 0);
  if (!heading?.map) throw Error('图形根标题缺失');
  const lines = before.split(/(?<=\n)/);
  const from = lines.slice(0, heading.map[0]).join('').length;
  const to = lines.slice(0, heading.map[1]).join('').length;
  return (
    markdown.slice(0, parsed.markerRange.to) +
    before.slice(0, from) +
    diagramPlainTitle(title) +
    '\n' +
    before.slice(to) +
    markdown.slice(parsed.primary.range.from)
  );
}
export function createDocumentSession(initial: DocumentSessionState, deps: Dependencies) {
  const state: DocumentSessionState = { ...initial };
  let baseline: DocumentSnapshot = {
    markdown: initial.markdown,
    source: initial.source,
    title: initial.title,
  };
  let running: Promise<void> | undefined;
  const whiteboardPaths = new Set<string>();
  const rememberPath = (markdown: string) => {
    const parsed = parseDiagramDocument(markdown);
    if (parsed.status === 'diagram' && parsed.primary.source.format === 'excalidraw')
      whiteboardPaths.add(parsed.primary.source.path);
  };
  rememberPath(initial.markdown);
  const notify = () => deps.changed?.();
  const dirty = () =>
    !!state.intentId ||
    !!state.pending ||
    state.markdown !== baseline.markdown ||
    state.source !== baseline.source ||
    state.title !== baseline.title;
  function editSource(source: string, title = state.title) {
    state.source = source;
    state.title = title;
    notify();
  }
  function editMarkdown(markdown: string) {
    state.markdown = markdown;
    const parsed = parseDiagramDocument(markdown);
    if (parsed.status === 'diagram' && parsed.type === state.type) {
      state.title = parsed.title;
      if (parsed.primary.source.format !== 'excalidraw')
        state.source = parsed.primary.source.content;
    }
    notify();
  }
  async function save() {
    if (running) return running;
    if (!dirty()) return;
    running = (async () => {
      // Persist native edits BEFORE any render/prepare work, and exact pending evidence BEFORE commit.
      const snapshot: DocumentSnapshot = {
        markdown: state.markdown,
        source: state.source,
        title: state.title,
      };
      await deps.persist({ ...state });
      if (!state.pending) {
        if (snapshot.markdown) {
          const parsed = parseDiagramDocument(snapshot.markdown);
          if (parsed.status !== 'diagram' || parsed.type !== state.type)
            throw Error('图形 Markdown 不完整，请在源码中修复');
          if (
            parsed.primary.source.format === 'excalidraw' &&
            !whiteboardPaths.has(parsed.primary.source.path)
          )
            throw Error('白板原件链接已变化，请保留源码并重新读取对应原件');
        }
        const png = await deps.render(snapshot);
        const target = state.intentId
          ? { kind: 'creation' as const, intentId: state.intentId }
          : {
              kind: 'document' as const,
              noteId: state.noteId,
              expectedDocumentHash: state.documentHash!,
              expectedSourceHash: state.sourceHash!,
            };
        const prepared = await deps.prepare(snapshot, png, target);
        const markdown = snapshot.markdown
          ? applyPreparedDiagramDocument({
              markdown: diagramMarkdownTitle(snapshot.markdown, snapshot.title),
              prepared,
              source: snapshot.source,
            })
          : renderPreparedDiagramDocument({
              prepared,
              title: snapshot.title,
              source: snapshot.source,
            });
        state.pending = {
          ...snapshot,
          inputMarkdown: snapshot.markdown,
          markdown,
          preparedId: prepared.id,
          requestId: crypto.randomUUID(),
        };
        notify();
        await deps.persist({ ...state, pending: { ...state.pending } });
      }
      const request = state.pending!;
      await deps.commit(request);
      const resource = await deps.resource();
      if (resource.documentHash !== (await deps.hash(request.markdown)))
        throw Error('图形已在其他位置更新，请保留草稿并重新读取');
      const committed = parseDiagramDocument(request.markdown);
      const baselineSource = resource.source.content ?? request.source;
      if (
        committed.status !== 'diagram' ||
        resource.source.hash !== committed.primary.binding.sourceHash ||
        (await deps.hash(baselineSource)) !== resource.source.hash ||
        resource.publication
      )
        throw Error('图形原件已在其他位置变化或尚未完成发布，请保留草稿并重新读取');
      // Derived bindings never replace input typed while render/commit was awaiting.
      if (state.markdown === (request.inputMarkdown ?? baseline.markdown))
        state.markdown = request.markdown;
      rememberPath(request.markdown);
      baseline = { markdown: request.markdown, source: baselineSource, title: request.title };
      state.documentHash = resource.documentHash;
      state.sourceHash = resource.source.hash;
      state.intentId = undefined;
      state.pending = undefined;
      notify();
      await deps.persist({ ...state });
    })();
    try {
      await running;
    } finally {
      running = undefined;
      notify();
    }
  }
  function restore(snapshot: DocumentSnapshot, pending?: PendingDocumentCommit) {
    Object.assign(state, snapshot);
    if (pending?.inputMarkdown) rememberPath(pending.inputMarkdown);
    state.pending = pending;
    notify();
  }
  return {
    state,
    dirty,
    editSource,
    editMarkdown,
    save,
    restore,
    persist: () => deps.persist({ ...state }),
    discard() {
      if (running || state.pending) throw Error('图形提交结果尚未核对，请先重试保存');
      Object.assign(state, baseline);
      state.pending = undefined;
      notify();
    },
  };
}
