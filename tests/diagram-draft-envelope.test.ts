import { expect, it } from 'vitest';
import * as drafts from '../apps/web/drafts';
import { emptyWhiteboard } from '../shared/whiteboard';
const record = (content: string, diagram?: drafts.DiagramDraftEnvelope) => ({
  noteId: 'note',
  kind: 'note' as const,
  content,
  baseRevision: 'base',
  ...(diagram ? { diagram } : {}),
  scope: { ownerId: 'owner', knowledgeId: 'kb' },
  version: 'local1',
  updatedAt: Date.now(),
});
const envelope = (payload: string): drafts.DiagramDraftEnvelope => ({
  version: 2,
  documentType: 'whiteboard',
  payloadFormat: 'excalidraw',
  documentHash: 'a'.repeat(64),
  sourceHash: 'b'.repeat(64),
  payload,
});
it('recognizes legacy JSON drafts and prevents restoring them as ordinary Markdown', () => {
  const content = JSON.stringify(emptyWhiteboard()),
    check = drafts.canRestoreNoteDraft;
  expect(check).toBeTypeOf('function');
  expect(check(record(content))).toBe(false);
  expect(check(record(content), 'whiteboard')).toBe(true);
  expect(check(record('# regular\n'))).toBe(true);
});
it('only hands a typed v2 diagram payload to its matching document coordinator', () => {
  const content = JSON.stringify(emptyWhiteboard()),
    check = drafts.canRestoreNoteDraft;
  expect(check).toBeTypeOf('function');
  expect(check(record(content, envelope(content)))).toBe(false);
  expect(check(record(content, envelope(content)), 'whiteboard')).toBe(true);
  expect(check(record(content, envelope(content)), 'mindmap')).toBe(false);
  for (const invalid of [
    { ...envelope(content), version: 9 },
    { ...envelope(content), payload: 'different' },
    { ...envelope(content), payloadFormat: 'mermaid' },
  ])
    expect(check(record(content, invalid as drafts.DiagramDraftEnvelope), 'whiteboard')).toBe(false);
});

it.each(['constructor','__proto__','toString'])('keeps unknown inherited format keys inert: %s',type=>{
 const payload='# recover unknown',value={...envelope(payload),documentType:type,payloadFormat:'markdown'} as drafts.DiagramDraftEnvelope;
 expect(drafts.canRestoreNoteDraft(record(payload,value),'whiteboard')).toBe(false);
});
