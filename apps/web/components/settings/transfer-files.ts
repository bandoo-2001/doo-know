export function importPath(value: string, stripPickerRoot = false): string {
  if (!value || value.startsWith('/') || /[\\\u0000-\u001f:]/.test(value))
    throw Error('文件路径无效，请重新选择文件。');
  const parts = value.split('/');
  if (parts.some((part) => !part || part === '.' || part === '..'))
    throw Error('文件路径无效，请重新选择文件。');
  const relative = stripPickerRoot ? parts.slice(1).join('/') : value;
  if (!relative) throw Error('请选择目录中的文件。');
  return relative;
}
export async function encodeImportFile(file: Blob, path: string) {
  const safePath = importPath(path);
  if (/\.(?:md|excalidraw)$/i.test(path)) {
    let content: string;
    try {
      content = new TextDecoder('utf-8', { fatal: true }).decode(await file.arrayBuffer());
    } catch {
      throw Error(path + ' 不是有效的 UTF-8 Markdown，请转换编码后重试。');
    }
    return { path: safePath, encoding: 'utf8' as const, content };
  }
  const bytes = new Uint8Array(await file.arrayBuffer());
  let binary = '';
  for (let start = 0; start < bytes.length; start += 8192)
    binary += String.fromCharCode(...bytes.subarray(start, start + 8192));
  return { path: safePath, encoding: 'base64' as const, content: btoa(binary) };
}
