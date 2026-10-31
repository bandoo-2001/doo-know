import { z } from 'zod';
import { isDiagramRelativePath } from './diagram-document.js';

export const documentTypeSchema = z.enum(['markdown', 'whiteboard', 'mindmap', 'flowchart']);
export type DocumentType = z.infer<typeof documentTypeSchema>;
export const diagramRoleSchema = z.enum(['primary', 'embedded']);
export type DiagramRole = z.infer<typeof diagramRoleSchema>;
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const path = z.string().refine(isDiagramRelativePath);
const sourceSchema = z.object({
  format: z.enum(['svg', 'excalidraw', 'markdown-outline', 'mermaid']),
  hash,
  content: z.string().optional(),
  path: path.optional(),
  readHandle: z.string().min(1).optional(),
});
export const diagramResourceSchema = z
  .object({
    version: z.literal(1),
    noteId: z.string().min(1),
    documentType: documentTypeSchema,
    role: diagramRoleSchema,
    documentHash: hash,
    title: z.string().optional(),
    render: z
      .object({ renderer: z.string(), config: z.record(z.string(), z.unknown()) })
      .optional(),
    publication: z
      .object({ state: z.enum(['pending', 'conflicted']), operationId: z.string().optional(),code:z.string().optional() })
      .optional(),
    issues: z.array(z.object({ code: z.string() })).optional(),
    source: sourceSchema,
    preview: z
      .object({ path, hash, renderHash: hash, state: z.enum(['ready', 'stale', 'missing']) })
      .optional(),
    capabilities: z.object({ canEdit: z.boolean(), canDownloadSource: z.boolean() }),
  })
  .superRefine((value, context) => {
    const hasSource =
      value.source.content !== undefined ||
      value.source.path !== undefined ||
      value.source.readHandle !== undefined;
    if (
      hasSource !== value.capabilities.canDownloadSource ||
      (value.capabilities.canEdit && !value.capabilities.canDownloadSource)
    )
      context.addIssue({ code: 'custom', message: '图形源读取能力与载荷不一致', path: ['source'] });
    const primaryFormats: Record<string, string> = {
      whiteboard: 'excalidraw',
      mindmap: 'markdown-outline',
      flowchart: 'mermaid',
    };
    if (value.role === 'primary' && primaryFormats[value.documentType] !== value.source.format)
      context.addIssue({
        code: 'custom',
        message: '主图格式与文档类型不一致',
        path: ['source', 'format'],
      });
  });
export type DiagramResource = z.infer<typeof diagramResourceSchema>;
export const pendingDiagramPreviewSchema = z.object({
  noteId: z.string().min(1),
  role: diagramRoleSchema,
  documentHash: hash,
  sourceHash: hash,
  renderHash: hash,
});
export type PendingDiagramPreview = z.infer<typeof pendingDiagramPreviewSchema>;
export const diagramPreviewRequiredSchema = z.object({
  code: z.literal('DIAGRAM_PREVIEW_REQUIRED'),
  planId: z.string().min(1).optional(),
  documents: z.array(pendingDiagramPreviewSchema).min(1),
});
export type DiagramPreviewRequired = z.infer<typeof diagramPreviewRequiredSchema>;
