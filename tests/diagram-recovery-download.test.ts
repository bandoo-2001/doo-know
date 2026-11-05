import { readFileSync } from 'node:fs';
import { parseDiagramDocument } from '../shared/diagram-document';
import { expect, it } from 'vitest';
import * as download from '../apps/web/diagrams/document-draft';
import type { DocumentSessionState } from '../apps/web/diagrams/document-session';
import type { DraftRecord } from '../apps/web/drafts';

const baseline = { markdown: '# Saved whiteboard\n\nSaved prose.\n', source: '{"type":"excalidraw","elements":[]}', title: 'Saved whiteboard' };
const state = (change: Partial<DocumentSessionState> = {}): DocumentSessionState => ({
  ...baseline, noteId: 'board', type: 'whiteboard', documentHash: 'a'.repeat(64), sourceHash: 'b'.repeat(64), ...change,
});

it('downloads the full Markdown draft when native source has not changed', () => {
  const result = download.currentDraftDownload(state({ markdown: '# Saved whiteboard\n\nSaved prose.\nUNSAVED_DESCRIPTION\n' }), baseline);
  expect(result.extension).toBe('.md');
  expect(result.content).toBe('# Saved whiteboard\n\nSaved prose.\nUNSAVED_DESCRIPTION\n');
});

it('keeps native-only recovery usable as an original Excalidraw file', () => {
  const native = '{"type":"excalidraw","elements":[{"id":"local-stroke","type":"rectangle"}]}';
  const result = download.currentDraftDownload(state({ source: native }), baseline);
  expect(result.extension).toBe('.excalidraw');
  expect(result.content).toBe(native);
});

it('keeps mixed native and Markdown edits together in the existing v2 recovery envelope', () => {
  const native = '{"type":"excalidraw","elements":[{"id":"local-stroke","type":"rectangle"}]}';
  const result = download.currentDraftDownload(state({ source: native, markdown: '# Changed description\nUNSAVED_DESCRIPTION\n' }), baseline);
  expect(result.extension).toBe('.draft.json');
  expect(JSON.parse(result.content)).toMatchObject({ version: 2, documentType: 'whiteboard', payloadFormat: 'excalidraw', payload: native, documentMarkdown: '# Changed description\nUNSAVED_DESCRIPTION\n', documentHash: 'a'.repeat(64), baselineSourceHash: 'b'.repeat(64) });
});

it('exports exact pending evidence alongside newer edits without resolving or replacing it', () => {
  const pending = { preparedId: 'prepared', requestId: 'immutable-request', markdown: '# Submitted\n', source: 'submitted-native', title: 'Submitted', inputMarkdown: '# Earlier\n' };
  const current = state({ markdown: '# Later\n', source: 'later-native', pending });
  const result = download.currentDraftDownload(current, baseline);
  expect(result.extension).toBe('.draft.json');
  expect(JSON.parse(result.content)).toMatchObject({ payload: 'later-native', documentMarkdown: '# Later\n', pending });
  expect(current.pending).toEqual(pending);
});

it('preserves all held v2 fields including whole Markdown and pending receipt', () => {
  const diagram = { version: 2 as const, documentType: 'whiteboard' as const, payloadFormat: 'excalidraw' as const, payload: 'held-native', documentMarkdown: '# Held Markdown\n', documentHash: 'a'.repeat(64), sourceHash: null, baselineSourceHash: 'b'.repeat(64), title: 'Held', pending: { requestId: 'held-request', preparedId: 'held-prepare', markdown: '# Exact pending\n', source: 'pending-native', title: 'Pending', inputMarkdown: '# Original input\n' } };
  const record: DraftRecord = { noteId: 'board', kind: 'note', content: 'held-native', baseRevision: 'base', scope: { ownerId: 'owner', knowledgeId: 'kb' }, version: 'local', updatedAt: 1, diagram };
  const result = download.heldDraftDownload(record);
  expect(result.extension).toBe('.draft.json');
  expect(JSON.parse(result.content)).toEqual(diagram);
  expect(record.content).toBe('held-native');
});

it('keeps legacy held payload bytes and ordinary Markdown downloads unchanged', () => {
  const record: DraftRecord = { noteId: 'board', kind: 'note', content: '  exact held bytes\n', baseRevision: 'base', scope: { ownerId: 'owner', knowledgeId: 'kb' }, version: 'local', updatedAt: 1 };
  expect(download.heldDraftDownload(record)).toEqual({ content: '  exact held bytes\n', extension: '.md' });
  expect(download.heldDraftDownload({ ...record, diagram: { version: 2, documentType: 'whiteboard', payloadFormat: 'excalidraw', payload: record.content, documentHash: null, sourceHash: null } })).toEqual({ content: '  exact held bytes\n', extension: '.excalidraw' });
});

it.each([
  ['whiteboard', '.excalidraw'],
  ['flowchart', '.mmd'],
  ['mindmap', '.outline.md'],
] as const)('preserves native-only %s bytes and its existing source extension', (type, extension) => {
  const result = download.currentDraftDownload(state({ type, source: '  exact native bytes\n' }), baseline);
  expect(result).toEqual({ content: '  exact native bytes\n', extension });
});

it('keeps a newer native mindmap root title when earlier Markdown prose also changed', () => {
  // Real valid document fixture, then the exact reachable post-recovery shape:
  // Markdown prose changed earlier; MindElixir changes only its separate root.
  const markdown = readFileSync(new URL('./fixtures/diagram-documents/mindmap.md', import.meta.url), 'utf8');
  const parsed = parseDiagramDocument(markdown);
  expect(parsed.status).toBe('diagram');
  if (parsed.status !== 'diagram' || parsed.primary.source.format === 'excalidraw') throw Error('Mindmap fixture unavailable');
  const source = parsed.primary.source.content;
  const baseline = { markdown, source, title: '系统架构' };
  const current = state({ type: 'mindmap', markdown: markdown + '\n先前在 Markdown 中写下的正文草稿。\n', source, title: '最新原生脑图根题' });
  const result = download.currentDraftDownload(current, baseline);
  expect(result.extension).toBe('.draft.json');
  expect(JSON.parse(result.content)).toMatchObject({ version: 2, documentType: 'mindmap', payloadFormat: 'markdown-outline', title: '最新原生脑图根题', payload: source, documentMarkdown: markdown + '\n先前在 Markdown 中写下的正文草稿。\n' });
  expect(current.title).toBe('最新原生脑图根题');
});

it('preserves a legal held Markdown payload with independent documentMarkdown and no pending receipt', () => {
  const diagram = { version: 2 as const, documentType: 'mindmap' as const, payloadFormat: 'markdown' as const, payload: '# 主载荷\n', documentMarkdown: '# 独立的整篇 Markdown\n必须保全\n', documentHash: null, sourceHash: null };
  const record: DraftRecord = { noteId: 'board', kind: 'note', content: '# 主载荷\n', baseRevision: 'base', scope: { ownerId: 'owner', knowledgeId: 'kb' }, version: 'local', updatedAt: 1, diagram };
  const result = download.heldDraftDownload(record);
  expect(result.extension).toBe('.draft.json');
  expect(JSON.parse(result.content)).toEqual(diagram);
});

it('keeps direct Markdown when its heading already expresses the changed native title', () => {
  const markdown = readFileSync(new URL('./fixtures/diagram-documents/mindmap.md', import.meta.url), 'utf8');
  const parsed = parseDiagramDocument(markdown);
  if (parsed.status !== 'diagram' || parsed.primary.source.format === 'excalidraw') throw Error('Mindmap fixture unavailable');
  const updated = markdown.replace('# 系统架构', '# 当前新根题') + '\n正文说明也已改变。\n';
  const result = download.currentDraftDownload(state({ type: 'mindmap', markdown: updated, source: parsed.primary.source.content, title: '当前新根题' }), { markdown, source: parsed.primary.source.content, title: '系统架构' });
  expect(result).toEqual({ content: updated, extension: '.md' });
});

it('keeps legacy Markdown bytes when its repeated documentMarkdown adds no independent information', () => {
  const content = '# 相同 Markdown\n';
  const record: DraftRecord = { noteId: 'board', kind: 'note', content, baseRevision: 'base', scope: { ownerId: 'owner', knowledgeId: 'kb' }, version: 'local', updatedAt: 1, diagram: { version: 2, documentType: 'mindmap', payloadFormat: 'markdown', payload: content, documentMarkdown: content, documentHash: null, sourceHash: null } };
  expect(download.heldDraftDownload(record)).toEqual({ content, extension: '.md' });
});

it('keeps the current native root after it returns to baseline while Markdown still has an interim title', () => {
  const markdown = readFileSync(new URL('./fixtures/diagram-documents/mindmap.md', import.meta.url), 'utf8');
  const parsed = parseDiagramDocument(markdown);
  expect(parsed.status).toBe('diagram');
  if (parsed.status !== 'diagram' || parsed.primary.source.format === 'excalidraw') throw Error('Mindmap fixture unavailable');
  const interim = markdown.replace('# 系统架构', '# 中间标题B') + '\n正文草稿仍要保留。\n';
  const current = state({ type: 'mindmap', markdown: interim, source: parsed.primary.source.content, title: '系统架构' });
  const result = download.currentDraftDownload(current, { markdown, source: parsed.primary.source.content, title: '系统架构' });
  expect(result.extension).toBe('.draft.json');
  expect(JSON.parse(result.content)).toMatchObject({ version: 2, documentType: 'mindmap', title: '系统架构', payload: parsed.primary.source.content, documentMarkdown: interim });
  expect(current.title).toBe('系统架构');
});

it('keeps malformed Markdown-only input byte exact when native source and title have not changed', () => {
  const markdown = '# Broken primary input\n<!-- dooknow:primary:start -->\n:::unclosed\n保留不完整原文\n';
  const result = download.currentDraftDownload(state({ markdown }), baseline);
  expect(result).toEqual({ content: markdown, extension: '.md' });
});
