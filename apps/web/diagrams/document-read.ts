import type { NoteDocument } from '../../../shared/contracts';
import type { DiagramResource } from '../../../shared/diagram-resource';
import { hashDiagramSource } from './preview-artifact';
/** Both response bodies must prove the same snapshot before their hashes become a save baseline. */
export async function readCoherentDiagramDocument(
  readDocument: () => Promise<NoteDocument>,
  readResource: () => Promise<DiagramResource>,
  hash: (text: string) => Promise<string> = hashDiagramSource,
) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const [document, resource] = await Promise.all([readDocument(), readResource()]);
    if ((await hash(document.content)) !== resource.documentHash) continue;
    if (
      resource.source.content !== undefined &&
      (await hash(resource.source.content)) !== resource.source.hash
    )
      continue;
    return { document, resource };
  }
  throw Error('图形读取期间已变化，未采用不一致的编辑基线，请重新读取');
}
