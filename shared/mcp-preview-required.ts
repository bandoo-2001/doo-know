import { z } from 'zod';
import { operationPreviewNeed } from './mcp-operation-preview-tools.js';
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
const nativePreviewReference = operationPreviewNeed
  .extend({ noteId: uuid, snapshotId: uuid })
  .strict();
export const previewRequiredDetails = z
  .object({
    portablePreviews: z.array(portablePreviewReference).max(20).optional(),
    documents: z.array(nativePreviewReference).max(20).optional(),
    totalCount: z.number().int().min(1).max(10000),
    planId: uuid.optional(),
    operationId: uuid.optional(),
    direction: z.enum(['export', 'import']).optional(),
    nextCursor: z.string().max(8192).optional(),
  })
  .strict();
/** Only typed IDs/hashes and bounded references cross an SDK error; no source/config/paths. */
export function safePreviewRequiredDetails(
  input: unknown,
): z.infer<typeof previewRequiredDetails> | undefined {
  if (!input || typeof input !== 'object') return;
  const value = input as Record<string, unknown>;
  if (Array.isArray(value.portablePreviews)) {
    const refs = value.portablePreviews
      .slice(0, 20)
      .map((raw: any) =>
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
  if (Array.isArray(value.documents)) {
    const docs = value.documents.slice(0, 20).map((raw) => nativePreviewReference.safeParse(raw));
    if (!docs.length || docs.some((r) => !r.success)) return;
    const result = {
      documents: docs.map((r) => r.data!),
      totalCount: typeof value.totalCount === 'number' ? value.totalCount : value.documents.length,
      ...(uuid.safeParse(value.planId).success ? { planId: value.planId } : {}),
      ...(uuid.safeParse(value.operationId).success ? { operationId: value.operationId } : {}),
      ...(typeof value.nextCursor === 'string' ? { nextCursor: value.nextCursor } : {}),
    };
    const parsed = previewRequiredDetails.safeParse(result);
    if (parsed.success) return parsed.data;
  }
}
