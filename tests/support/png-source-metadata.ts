import { crc32, deflateSync } from 'node:zlib';
export const cleanPng = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a7i8AAAAASUVORK5CYII=',
  'base64',
);
export function pngWithText(
  type: 'tEXt' | 'zTXt' | 'iTXt',
  keyword = 'application/vnd.excalidraw+json',
) {
  const source = Buffer.from('{"elements":[{"text":"PRIVATE_NATIVE_SCENE"}]}');
  const text =
    type === 'tEXt'
      ? source
      : type === 'zTXt'
        ? Buffer.concat([Buffer.from([0]), deflateSync(source)])
        : Buffer.concat([Buffer.from([0, 0, 0, 0]), source]);
  const data = Buffer.concat([Buffer.from(keyword + '\0'), text]);
  const chunk = Buffer.alloc(data.length + 12);
  chunk.writeUInt32BE(data.length);
  chunk.write(type, 4);
  data.copy(chunk, 8);
  chunk.writeUInt32BE(crc32(chunk.subarray(4, -4)), chunk.length - 4);
  return Buffer.concat([cleanPng.subarray(0, -12), chunk, cleanPng.subarray(-12)]);
}
