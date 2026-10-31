import { rewriteDestinations } from './paths.js';
import { renderPortableFigure } from '../../../shared/portable-figure.js';
import { posix } from 'node:path';
import {
  boundDiagramSources,
  normalizeDiagramCode,
  serializeDiagramBinding,
} from '../../../shared/diagram-portability.js';
import { localReference } from '../render.js';
import { sha256 } from '../knowledge/operations.js';
import { fail } from '../knowledge/errors.js';
/** Only recognized prepared Excalidraw groups are snapshots; bare fences remain live references. */
export function boundWhiteboardLines(content: string) {
  return new Set(
    boundDiagramSources(content)
      .filter((group) => group.kind === 'excalidraw')
      .map((group) => group.line - 1),
  );
}
export function portableBoundWhiteboards(
  content: string,
  document: string,
  target: string,
  mapping: Map<string, string>,
) {
  for (const group of boundDiagramSources(content)
    .filter((group) => group.kind === 'excalidraw')
    .reverse()) {
    const source = localReference(document, group.sourcePath),
      mapped = source && mapping.get(source);
    if (!mapped) fail(409, 'PORTABLE_DEPENDENCY_UNAVAILABLE');
    const code = posix.relative(posix.dirname(target), mapped),
      binding = { ...group.binding, codeHash: sha256(normalizeDiagramCode(code)) };
    const prefix = content
      .slice(group.prefixFrom, group.from)
      .replace(serializeDiagramBinding(group.binding), serializeDiagramBinding(binding));
    const fence = content.slice(group.from, group.to),
      lines = fence.split('\n'),
      trailing = lines.at(-1) === '';
    if (trailing) lines.pop();
    const indentation = /^([ \t]*(?:>[ \t]*)*)/.exec(lines[0])?.[1] ?? '';
    const replacement =
      prefix + lines[0] + '\n' + indentation + code + '\n' + lines.at(-1) + (trailing ? '\n' : '');
    content = content.slice(0, group.prefixFrom) + replacement + content.slice(group.to);
  }
  return content;
}

/** Update a complete recognized native snapshot group as one source/PNG binding. */
export function replacePortableNativeGroup(
  content: string,
  document: string,
  oldSource: string,
  pair: { sourcePath: string; previewPath: string; sourceHash: string },
) {
  const groups = boundDiagramSources(content)
    .filter(
      (group) =>
        group.kind === 'excalidraw' && localReference(document, group.sourcePath) === oldSource,
    )
    .reverse();
  const sourcePath = posix.relative(posix.dirname(document), pair.sourcePath),
    previewPath = posix.relative(posix.dirname(document), pair.previewPath),
    code = sourcePath;
  const replacement = (binding: ReturnType<typeof boundDiagramSources>[number]['binding']) =>
    renderPortableFigure({
      alt: 'EXCALIDRAW 预览',
      previewPath,
      source: { type: 'file', path: sourcePath },
    }) +
    '\n' +
    serializeDiagramBinding({
      ...binding,
      sourceHash: pair.sourceHash,
      codeHash: sha256(normalizeDiagramCode(code)),
    }) +
    '\n\n```excalidraw\n' +
    code +
    '\n```\n';
  if (!groups.length)
    return (
      rewriteDestinations(content, document, document, new Map([[oldSource, pair.sourcePath]])) +
      '\n\n' +
      replacement({
        kind: 'excalidraw',
        sourceHash: pair.sourceHash,
        codeHash: sha256(normalizeDiagramCode(code)),
      })
    );
  for (const group of groups)
    content =
      content.slice(0, group.prefixFrom) + replacement(group.binding) + content.slice(group.to);
  return content;
}
