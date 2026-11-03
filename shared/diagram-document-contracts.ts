import { z } from 'zod';
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const targetSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('creation'), intentId: z.string().min(1) }).strict(),
  z
    .object({
      kind: z.literal('document'),
      noteId: z.string().min(1),
      expectedDocumentHash: hash,
      expectedSourceHash: hash,
    })
    .strict(),
]);
export const diagramPreparationSchema = z
  .object({
    target: targetSchema,
    type: z.enum(['whiteboard', 'mindmap', 'flowchart']),
    source: z.string(),
    sourceHash: hash,
    title: z.string().min(1).max(2000),
    renderer: z.string().min(1).max(160),
    config: z.record(z.string(), z.unknown()),
    pngBase64: z.string(),
    requestId: z
      .string()
      .min(8)
      .max(100)
      .regex(/^[A-Za-z0-9_-]+$/),
  })
  .strict();
export type DiagramPreparationInput = z.infer<typeof diagramPreparationSchema>;

export const diagramCommitSchema = z
  .object({
    preparedId: z.string().min(1),
    markdown: z.string().max(20 * 1024 * 1024),
    requestId: z
      .string()
      .min(1)
      .max(128)
      .regex(/^[A-Za-z0-9_-]+$/),
  })
  .strict();
export type DiagramCommitInput = z.infer<typeof diagramCommitSchema>;
export const diagramCreationSchema = z
  .object({
    path: z
      .string()
      .min(1)
      .refine((path) => /\.md$/i.test(path)),
    type: z.enum(['whiteboard', 'mindmap', 'flowchart']),
    requestId: z.string().min(1).max(128),
  })
  .strict();
