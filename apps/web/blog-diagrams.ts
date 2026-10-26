import type { BlogDiagramPreview, BlogPostDetail } from '../../shared/blog-contracts';
/** Reuse the editor's PNG preparation; publishing must never persist changes to the original note. */
export async function prepareBlogDiagrams(detail: BlogPostDetail): Promise<BlogDiagramPreview[]> {
  if (detail.diagramNeeds.length > 32) throw Error('一次最多发布 32 个图形，请精简后重试。');
  const { prepareDiagramSource } = await import('./diagrams/prepare-source');
  const { hashDiagramSource } = await import('./diagrams/preview-artifact');
  const diagrams: BlogDiagramPreview[] = [];
  for (const need of detail.diagramNeeds) {
    const { source, png } = await prepareDiagramSource({
      kind: need.kind,
      code: need.code,
      noteId: detail.post.sourceNoteId,
    });
    if ((await hashDiagramSource(source)) !== need.sourceHash)
      throw Error('图形源码已变化，请重新预览后发布。');
    const bytes = new Uint8Array(await png.arrayBuffer());
    let binary = '';
    for (let offset = 0; offset < bytes.length; offset += 8192)
      binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
    diagrams.push({
      fenceFrom: need.fenceFrom,
      kind: need.kind,
      codeHash: need.codeHash,
      sourceHash: need.sourceHash,
      pngBase64: btoa(binary),
    });
  }
  return diagrams;
}
