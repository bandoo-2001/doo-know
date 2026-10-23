import {
  boundDiagramSources,
  collectDiagramSaveNeeds,
  hashDiagramCode,
  type DiagramSaveNeed,
} from '../../../shared/diagram-portability';
import { hashDiagramSource } from './preview-artifact';

/** A canonical board can change without changing its parent fence reference. */
export async function collectCurrentDiagramSaveNeeds(
  markdown: string,
  baseline: string,
  noteId: string,
) {
  const needs = await collectDiagramSaveNeeds(markdown, baseline);
  let checked = 0;
  let readWhiteboardSource: (typeof import('./prepare-source'))['readWhiteboardSource'] | undefined;
  for (const fence of boundDiagramSources(markdown)) {
    if (fence.kind !== 'excalidraw' || needs.some((need) => need.from === fence.from)) continue;
    let current = false;
    try {
      // A save never turns into an unbounded scan of separate canvas files.
      if (checked++ < 32) {
        readWhiteboardSource ??= (await import('./prepare-source')).readWhiteboardSource;
        current =
          (await hashDiagramSource(await readWhiteboardSource({ code: fence.code, noteId }))) ===
          fence.binding.sourceHash;
      }
    } catch {
      /* An unverifiable preview needs the same explicit source-only choice. */
    }
    if (!current)
      needs.push({
        ...fence,
        codeHash: await hashDiagramCode(fence.code),
        reason: 'stale',
      } satisfies DiagramSaveNeed);
  }
  return needs.sort((a, b) => a.from - b.from);
}
