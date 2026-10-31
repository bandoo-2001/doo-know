import { it, expect, vi } from 'vitest';
import {
  isLegacySceneDraft,
  convertLegacySceneDraft,
  heldDraftDownload,
} from '../apps/web/diagrams/legacy-draft';
import { emptyWhiteboard } from '../shared/whiteboard';
import { createHash } from 'node:crypto';
const raw = JSON.stringify(emptyWhiteboard()),
  hash = (s: string) => createHash('sha256').update(s).digest('hex');
const state = {
  noteId: 'note',
  type: 'whiteboard' as const,
  markdown: '<!-- current Markdown -->\n当前说明',
  source: raw,
  title: 'Current',
  documentHash: hash('markdown'),
  sourceHash: hash(raw),
};
const record = {
  kind: 'note',
  noteId: 'note',
  content: raw,
  baseRevision: '["123",null]',
  version: 'old',
} as any;
it('downloads the actual held payload, retaining unknown envelopes as text', () => {
  expect(heldDraftDownload(record)).toEqual({ content: raw, extension: '.excalidraw' });
  expect(
    heldDraftDownload({ ...record, diagram: { version: 9, payloadFormat: 'excalidraw' } }),
  ).toEqual({ content: raw, extension: '.draft.txt' });
});
it('recognizes only old scene payloads, not future formats or pending primary commits', () => {
  expect(isLegacySceneDraft(record, state)).toBe(true);
  expect(
    isLegacySceneDraft(
      {
        ...record,
        diagram: {
          version: 2,
          documentType: 'whiteboard',
          payloadFormat: 'excalidraw',
          payload: raw,
          documentHash: null,
          sourceHash: null,
        },
      },
      state,
    ),
  ).toBe(true);
  for (const diagram of [
    { version: 3 },
    {
      version: 2,
      documentType: 'whiteboard',
      payloadFormat: 'excalidraw',
      documentMarkdown: 'new Markdown',
    },
    {
      version: 2,
      documentType: 'whiteboard',
      payloadFormat: 'excalidraw',
      pending: { requestId: 'unresolved' },
    },
  ])
    expect(isLegacySceneDraft({ ...record, diagram }, state)).toBe(false);
  expect(isLegacySceneDraft(record, { ...state, type: 'flowchart' })).toBe(false);
});
it('uses a server-verified rebased scene only as source, preserving current Markdown and requiring the current dual baseline', async () => {
  const source = JSON.stringify({ ...emptyWhiteboard(), future: 'keep' }),
    call = vi.fn(async (_url: string, _method?: string, _body?: unknown) => ({
      source,
      sourceHash: hash(source),
      expectedDocumentHash: state.documentHash,
      expectedSourceHash: state.sourceHash,
    }));
  const adopted = await convertLegacySceneDraft(record, state, call as any);
  expect(adopted).toEqual({ markdown: state.markdown, source, title: 'Current' });
  expect(call.mock.calls[0]?.[2]).toMatchObject({
    draft: raw,
    baseRevision: record.baseRevision,
    expectedDocumentHash: state.documentHash,
    expectedSourceHash: state.sourceHash,
  });
  const changed = vi.fn(async () => ({
    source,
    sourceHash: hash(source),
    expectedDocumentHash: 'a'.repeat(64),
    expectedSourceHash: state.sourceHash,
  }));
  await expect(convertLegacySceneDraft(record, state, changed as any)).rejects.toThrow('版本');
  expect(record.content).toBe(raw);
});
