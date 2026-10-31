import { z } from 'zod';
const uuid = z.string().regex(/^[a-f0-9-]{36}$/),
  hash = z.string().regex(/^[a-f0-9]{64}$/);
export const portablePreviewReference = z
  .object({
    previewId: uuid,
    sourceHash: hash,
    renderHash: hash,
    role: z.enum(['primary', 'embedded']),
    type: z.literal('whiteboard'),
    direction: z.enum(['export', 'import']),
  })
  .strict();
// Error references predate fixed operation snapshots. They can identify a note
// without yet having a prepared snapshot or all three version hashes.
const nativePreviewReference = z
  .object({
    noteId: uuid,
    role: z.enum(['primary', 'embedded']).optional(),
    documentHash: hash.optional(),
    sourceHash: hash.optional(),
    renderHash: hash.optional(),
    snapshotId: uuid.optional(),
  })
  .strict();
const cursor = z
  .string()
  .max(8192)
  .regex(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}$/);
function safeDocumentReference(raw: unknown): z.infer<typeof nativePreviewReference> | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return;
  const value = raw as Record<string, unknown>,
    id = uuid.safeParse(value.noteId);
  if (!id.success) return;
  const reference: z.infer<typeof nativePreviewReference> = { noteId: id.data };
  for (const [key, schema] of Object.entries({
    role: z.enum(['primary', 'embedded']),
    documentHash: hash,
    sourceHash: hash,
    renderHash: hash,
    snapshotId: uuid,
  })) {
    if (value[key] === undefined) continue;
    const parsed = schema.safeParse(value[key]);
    if (parsed.success) Object.assign(reference, { [key]: parsed.data });
  }
  return reference;
}
export const previewRequiredDetails = z
  .object({
    portablePreviews: z.array(portablePreviewReference).max(20).optional(),
    documents: z.array(nativePreviewReference).max(20).optional(),
    totalCount: z.number().int().min(1).max(10000),
    planId: uuid.optional(),
    operationId: uuid.optional(),
    direction: z.enum(['export', 'import']).optional(),
    nextCursor: cursor.optional(),
  })
  .strict();
/** Only typed IDs/hashes and bounded references cross an SDK error; no source/config/paths. */
export function safePreviewRequiredDetails(
  input: unknown,
): z.infer<typeof previewRequiredDetails> | undefined {
  if (!input || typeof input !== 'object') return;
  const value = input as Record<string, unknown>;
  if (Array.isArray(value.portablePreviews)) {
    const refs = value.portablePreviews.slice(0, 20).map((raw: any) =>
      portablePreviewReference.safeParse({
        previewId: raw?.previewId,
        sourceHash: raw?.sourceHash,
        renderHash: raw?.renderHash,
        role: raw?.role,
        type: raw?.type,
        direction: raw?.direction,
      }),
    );
    if (!refs.length || refs.some((r) => !r.success)) return;
    const totalCount =
      typeof value.totalCount === 'number' &&
      Number.isInteger(value.totalCount) &&
      value.totalCount >= value.portablePreviews.length &&
      value.totalCount <= 10000
        ? value.totalCount
        : value.portablePreviews.length;
    return {
      portablePreviews: refs.map((r) => r.data!),
      totalCount,
      direction: refs[0].data!.direction,
    };
  }
  const rawDocuments = Array.isArray(value.documents)
    ? value.documents
    : uuid.safeParse(value.noteId).success
      ? [value]
      : undefined;
  if (rawDocuments && rawDocuments.length <= 10000) {
    const documents = rawDocuments
      .map(safeDocumentReference)
      .filter((reference): reference is NonNullable<typeof reference> => !!reference);
    if (!documents.length) return;
    const totalCount =
      typeof value.totalCount === 'number' &&
      Number.isInteger(value.totalCount) &&
      value.totalCount >= documents.length &&
      value.totalCount <= 10000
        ? value.totalCount
        : documents.length;
    const result = {
      documents: documents.slice(0, 20),
      totalCount,
      ...(uuid.safeParse(value.planId).success ? { planId: value.planId } : {}),
      ...(uuid.safeParse(value.operationId).success ? { operationId: value.operationId } : {}),
      ...(cursor.safeParse(value.nextCursor).success ? { nextCursor: value.nextCursor } : {}),
    };
    const parsed = previewRequiredDetails.safeParse(result);
    if (parsed.success) return parsed.data;
  }
}
