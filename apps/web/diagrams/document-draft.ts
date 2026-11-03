import { parseDiagramDocument } from '../../../shared/diagram-document';
import { canRestoreNoteDraft, type DiagramDraftEnvelope, type DraftRecord } from '../drafts';
import type { DocumentSessionState, PendingDocumentCommit } from './document-session';
import { diagramFormat } from './primary-api';
export function heldDraftDownload(record: DraftRecord) {
  const formats = { markdown: '.md', excalidraw: '.excalidraw', mermaid: '.mmd', 'markdown-outline': '.outline.md' };
  return { content: record.content, extension: record.diagram ? formats[record.diagram.payloadFormat] : '.md' };
}
export function documentDraft(state: DocumentSessionState): DiagramDraftEnvelope {
  return {
    version: 2,
    documentType: state.type,
    payloadFormat: diagramFormat[state.type],
    payload: state.source,
    documentMarkdown: state.markdown,
    title: state.title,
    documentHash: state.documentHash,
    sourceHash: null,
    baselineSourceHash: state.sourceHash,
    ...(state.intentId ? { intentId: state.intentId } : {}),
    ...(state.pending ? { pending: { ...state.pending } } : {}),
  };
}
export function restoreDocumentDraft(record: DraftRecord, state: DocumentSessionState) {
  if (!canRestoreNoteDraft(record, state.type, [diagramFormat[state.type], 'markdown']))
    throw Error('草稿类型不匹配，请下载保留后在对应视图恢复');
  const d = record.diagram;
  if (!d) throw Error('旧草稿需要手动核对，请下载原文');
  if (
    d.documentHash !== state.documentHash ||
    (d.baselineSourceHash !== undefined && d.baselineSourceHash !== state.sourceHash)
  )
    throw Error('原文已在其他位置更新；草稿已保留，请下载后核对');
  const markdown =
    d.payloadFormat === 'markdown' ? record.content : (d.documentMarkdown ?? state.markdown);
  const source = d.payloadFormat === 'markdown' ? state.source : record.content;
  let pending: PendingDocumentCommit | undefined;
  if (d.pending) {
    if (!d.pending.preparedId || d.pending.markdown === undefined)
      throw Error('提交证据不完整，请下载草稿后核对保存结果');
    const parsed = parseDiagramDocument(d.pending.markdown);
    if (parsed.status !== 'diagram' || parsed.type !== state.type)
      throw Error('待重试的提交正文类型不匹配，请下载核对');
    pending = {
      preparedId: d.pending.preparedId,
      requestId: d.pending.requestId,
      markdown: d.pending.markdown,
      source:
        parsed.primary.source.format === 'excalidraw'
          ? (d.pending.source ?? '')
          : parsed.primary.source.content,
      title: parsed.title,
      inputMarkdown: d.pending.inputMarkdown,
    };
  }
  return { markdown, source, title: d.title ?? state.title, pending };
}
