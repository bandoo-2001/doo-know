import { sha256Hex } from './sha256.js';
import { z } from 'zod';

const hash = z.string().regex(/^[a-f0-9]{64}$/);
export const primaryBindingSchema = z
  .object({
    version: z.literal(1),
    sourceHash: hash,
    renderHash: hash,
    previewHash: hash,
  })
  .passthrough();
export type PrimaryBinding = z.infer<typeof primaryBindingSchema>;

/** Escape HTML delimiters without losing unknown metadata on a later read. */
export function inertJson(value: unknown) {
  return JSON.stringify(value).replace(/</g, '\\u003c').replace(/>/g, '\\u003e');
}
export function serializePrimaryBinding(binding: PrimaryBinding) {
  return '<!-- dooknow:primary-binding ' + inertJson(primaryBindingSchema.parse(binding)) + ' -->';
}
export function parsePrimaryBinding(comment: string): PrimaryBinding | undefined {
  const match = /^<!-- dooknow:primary-binding (\{[^\r\n]*\}) -->$/.exec(comment.trim());
  if (!match) return;
  try {
    const result = primaryBindingSchema.safeParse(JSON.parse(match[1]));
    return result.success ? result.data : undefined;
  } catch {
    return;
  }
}

export async function hashDiagramBytes(value: string | Uint8Array) {
  return sha256Hex(value);
}

export type DiagramRenderInput = {
  type: 'whiteboard' | 'mindmap' | 'flowchart';
  sourceHash: string;
  title: string;
  renderer: string;
  config: Record<string, unknown>;
};
function canonical(value: unknown, depth = 0): unknown {
  if (depth > 32) throw Error('图形渲染配置嵌套过深');
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (Array.isArray(value)) return value.map((item) => canonical(item, depth + 1));
  if (typeof value === 'object' && value && Object.getPrototypeOf(value) === Object.prototype)
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonical((value as Record<string, unknown>)[key], depth + 1)]),
    );
  throw Error('图形渲染配置必须是 JSON');
}
/** Versioned domain separation; derived paths and binding bytes never enter the fingerprint. */
export function serializeDiagramRenderInput(input: DiagramRenderInput) {
  hash.parse(input.sourceHash);
  if (
    !['whiteboard', 'mindmap', 'flowchart'].includes(input.type) ||
    !input.renderer ||
    typeof input.title !== 'string'
  )
    throw Error('图形渲染参数不正确');
  return JSON.stringify(
    canonical({
      version: 1,
      type: input.type,
      sourceHash: input.sourceHash,
      title: input.title,
      renderer: input.renderer,
      config: input.config,
    }),
  );
}
export function diagramRenderFingerprint(input: DiagramRenderInput) {
  return hashDiagramBytes(serializeDiagramRenderInput(input));
}
