import { api } from '../api';
export type DiagramUploadInput = {
  noteId: string;
  notePath?: string;
  kind: 'svg' | 'mermaid' | 'excalidraw';
  source: string;
  png: Blob;
};
export type DiagramArtifact = {
  id: string;
  markdownPath: string;
  relativePath: string;
  mime: string;
};
export type DiagramReceipt = {
  sourceHash: string;
  preview: DiagramArtifact;
  source?: DiagramArtifact;
};
async function digest(bytes: Uint8Array) {
  const value = await crypto.subtle.digest('SHA-256', bytes as Uint8Array<ArrayBuffer>);
  return [...new Uint8Array(value)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}
export async function prepareDiagramUpload(input: DiagramUploadInput) {
  if (input.png.type !== 'image/png' || input.png.size > 10 * 1024 * 1024)
    throw Error('通用预览必须是 10 MiB 以内的 PNG 图片');
  const sourceHash = await digest(new TextEncoder().encode(input.source));
  const bytes = new Uint8Array(await input.png.arrayBuffer()),
    pngHash = await digest(bytes);
  const identity = await digest(
    new TextEncoder().encode(
      [input.noteId, input.notePath || '', input.kind, sourceHash, pngHash].join('\0'),
    ),
  );
  const hex =
    identity.slice(0, 12) +
    '4' +
    identity.slice(13, 16) +
    (8 + (parseInt(identity[16], 16) & 3)).toString(16) +
    identity.slice(17, 32);
  const requestId = [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20, 32),
  ].join('-');
  let binary = '';
  for (let start = 0; start < bytes.length; start += 8192)
    binary += String.fromCharCode(...bytes.subarray(start, start + 8192));
  return { kind: input.kind, source: input.source, sourceHash, pngBase64: btoa(binary), requestId };
}
export async function persistDiagramPreview(input: DiagramUploadInput): Promise<DiagramReceipt> {
  const prepared = await prepareDiagramUpload(input);
  const result = await api<DiagramReceipt>(
    `/api/notes/${input.noteId}/diagram-artifacts`,
    'POST',
    prepared,
  );
  if (result.sourceHash !== prepared.sourceHash) throw Error('图形源版本与预览不一致，请重新生成');
  return result;
}
