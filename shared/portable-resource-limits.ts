import { MAX_WHITEBOARD_BYTES } from './whiteboard.js';

/** Shared Web/server defaults. Legacy JSON transfer budgets intentionally remain separate. */
export const portableResourceLimits = Object.freeze({
  packageBytes: 256 * 1024 * 1024,
  files: 10_000,
  documents: 1_000,
  mediaBytes: 128 * 1024 * 1024,
  pngBytes: 10 * 1024 * 1024,
  whiteboardBytes: MAX_WHITEBOARD_BYTES,
  attachmentBytes: 10 * 1024 * 1024,
  stagedBytes: 512 * 1024 * 1024,
  resourceTimeoutMs: 30_000,
  redirects: 3,
});
export type PortableResourceLimits = { [K in keyof typeof portableResourceLimits]: number };
export type PortableResourceMeasurement = {
  kind: 'media' | 'png' | 'whiteboard' | 'attachment';
  fileBytes?: number;
  totalBytes?: number;
  files?: number;
  documents?: number;
  stagedBytes?: number;
};
export function assertPortableResourceBudget(
  value: PortableResourceMeasurement,
  limits: PortableResourceLimits = portableResourceLimits,
) {
  const fileLimit = {
    media: limits.mediaBytes,
    png: limits.pngBytes,
    whiteboard: limits.whiteboardBytes,
    attachment: limits.attachmentBytes,
  }[value.kind];
  const pairs: [number | undefined, number][] = [
    [value.fileBytes, fileLimit],
    [value.totalBytes, limits.packageBytes],
    [value.files, limits.files],
    [value.documents, limits.documents],
    [value.stagedBytes, limits.stagedBytes],
  ];
  for (const [actual, maximum] of pairs) {
    if (!Number.isSafeInteger(maximum) || maximum < 0) throw Error('便携资源配额配置无效');
    if (actual !== undefined && (!Number.isSafeInteger(actual) || actual < 0 || actual > maximum))
      throw Error('便携资源超过配置配额');
  }
}
