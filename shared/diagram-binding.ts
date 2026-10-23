export type DiagramBinding = {
  kind: 'svg' | 'mermaid' | 'excalidraw';
  codeHash: string;
  sourceHash: string;
};
const hashPattern = /^[a-f0-9]{64}$/;

/** A standard inert comment remains invisible in ordinary Markdown readers. */
export function serializeDiagramBinding(binding: DiagramBinding) {
  if (
    !['svg', 'mermaid', 'excalidraw'].includes(binding.kind) ||
    !hashPattern.test(binding.codeHash) ||
    !hashPattern.test(binding.sourceHash)
  )
    throw Error('图形预览绑定格式不正确');
  return `<!-- dooknow:diagram-preview v1 kind=${binding.kind} code=${binding.codeHash} source=${binding.sourceHash} -->`;
}
export function parseDiagramBinding(comment: unknown): DiagramBinding | undefined {
  if (typeof comment !== 'string') return;
  const match =
    /^<!-- dooknow:diagram-preview v1 kind=(svg|mermaid|excalidraw) code=([a-f0-9]{64}) source=([a-f0-9]{64}) -->$/.exec(
      comment.trim(),
    );
  if (!match) return;
  return { kind: match[1] as DiagramBinding['kind'], codeHash: match[2], sourceHash: match[3] };
}
