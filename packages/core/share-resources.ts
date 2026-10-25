import { localReference, references, renderMarkdownReferences } from './render.js';
import { HttpError } from './errors.js';

function targets(path: string, content: string) {
  return new Set([
    ...references(content).flatMap((reference) => {
      const target = localReference(path, reference);
      return target ? [`asset:${target}`] : [];
    }),
    ...renderMarkdownReferences(content).map(
      (reference) => `board:${localReference(path, reference) || reference}`,
    ),
  ]);
}
/** Editing one shared document must not grant access to a private local resource. */
export function assertShareResources(path: string, original: string, content: string) {
  const allowed = targets(path, original);
  for (const target of targets(path, content))
    if (!allowed.has(target))
      throw new HttpError(403, '分享编辑不能新增本地附件或白板引用，请联系所有者添加');
}
