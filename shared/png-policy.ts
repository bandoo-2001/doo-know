const signature = [137, 80, 78, 71, 13, 10, 26, 10];
/** Recognize the known native Excalidraw payload without decompressing text.
 * Inspect at most the PNG keyword's 79 bytes; unrelated metadata stays intact. */
export function pngContainsDiagramSource(bytes: Uint8Array): boolean {
  if (bytes.length < signature.length || !signature.every((byte, i) => bytes[i] === byte))
    return false;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = 8;
  while (offset + 12 <= bytes.length) {
    const length = view.getUint32(offset),
      type = String.fromCharCode(...bytes.subarray(offset + 4, offset + 8));
    if (length > bytes.length - offset - 12) return false;
    if (['tEXt', 'zTXt', 'iTXt'].includes(type)) {
      // All three text chunk formats start with the same NUL-terminated keyword.
      const keyword = bytes.subarray(offset + 8, offset + 8 + Math.min(length, 80)),
        end = keyword.indexOf(0);
      if (
        end > 0 &&
        String.fromCharCode(...keyword.subarray(0, end)).toLowerCase() ===
          'application/vnd.excalidraw+json'
      )
        return true;
    }
    offset += length + 12;
  }
  return false;
}
