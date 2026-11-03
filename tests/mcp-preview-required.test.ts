import { expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { sha256 } from '../packages/core/knowledge/operations.js';
import { safePreviewRequiredDetails } from '../shared/mcp-preview-required.js';
import { operationPreviewNeed } from '../shared/mcp-operation-preview-tools.js';
import { BridgeError, annotateError, errorBody } from '../plugins/mcp/server/errors.js';
import { mcpResultFrameSize } from '../shared/mcp-frame.js';

it('preserves the legacy primary publication hash tuple without inventing a fixed snapshot ID', () => {
  const need = {
    noteId: randomUUID(),
    role: 'primary',
    documentHash: sha256('doc'),
    sourceHash: sha256('source'),
    renderHash: sha256('render'),
  };
  expect(safePreviewRequiredDetails({ documents: [need] })).toEqual({
    documents: [need],
    totalCount: 1,
  });
  expect(operationPreviewNeed.safeParse(need).success).toBe(false);
});
it('preserves role-only and note-only legacy needs through repeated SDK annotations', () => {
  const documents = [{ noteId: randomUUID(), role: 'embedded' }, { noteId: randomUUID() }];
  const original = new BridgeError('DIAGRAM_PREVIEW_REQUIRED', 409);
  original.details = { documents, totalCount: 2 } as any;
  const body = errorBody(
    annotateError(original, 'complete_note_document_upload', { requestId: 'same-request' }),
  );
  expect(body.error.details).toEqual({ documents, totalCount: 2 });
  expect(
    safePreviewRequiredDetails({ noteId: documents[1].noteId, revisionId: randomUUID() }),
  ).toEqual({ documents: [documents[1]], totalCount: 1 });
});
it('keeps valid document references while filtering unknown fields and invalid optional values', () => {
  const noteId = randomUUID(),
    sourceHash = sha256('source');
  const result = safePreviewRequiredDetails({
    documents: [
      {
        noteId,
        role: 'primary',
        sourceHash,
        documentHash: '/srv/secrets',
        renderHash: 12,
        snapshotId: 'not-a-uuid',
        source: 'SECRET_SOURCE',
        config: { token: 'SECRET_TOKEN' },
        path: '/srv/private',
      },
      { noteId: '/srv/secret-note-id', role: 'primary' },
      null,
      { noteId: randomUUID(), role: 'not-a-role', sourceHash: 'SECRET_HASH' },
    ],
    nextCursor: '/srv/private-cursor',
    planId: 'SECRET_PLAN',
  });
  expect(result?.documents).toEqual([
    { noteId, role: 'primary', sourceHash },
    expect.objectContaining({ noteId: expect.any(String) }),
  ]);
  expect(result?.documents?.[1]).not.toHaveProperty('role');
  expect(result?.totalCount).toBe(2);
  expect(JSON.stringify(result)).not.toMatch(/SECRET|\/srv/);
  expect(safePreviewRequiredDetails({ documents: [{ noteId: '/srv/private' }] })).toBeUndefined();
});
it('bounds legacy error pages and retains the full count across SDK reannotation', () => {
  const documents = Array.from({ length: 1000 }, (_, i) => ({
    noteId: randomUUID(),
    ...(i % 2 ? { role: 'embedded', sourceHash: sha256(String(i)) } : {}),
  }));
  const first = safePreviewRequiredDetails({ documents });
  expect(first?.documents).toHaveLength(20);
  expect(first?.totalCount).toBe(1000);
  const original = new BridgeError('DIAGRAM_PREVIEW_REQUIRED', 409);
  original.details = first;
  const body = errorBody(
    annotateError(original, 'complete_note_document_upload', { requestId: 'same' }),
  );
  expect(body.error.details?.totalCount).toBe(1000);
  expect(body.error.details?.documents).toHaveLength(20);
  expect(mcpResultFrameSize(body)).toBeLessThanOrEqual(65536);
});
