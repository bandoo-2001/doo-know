/** Ordinary Markdown only: usable without a DooKnow renderer or session. */
export type PortableFigure = {
  alt: string;
  previewPath: string;
  source: { type: 'file'; path: string } | { type: 'fence'; language: 'svg' | 'mermaid'; code: string };
};

function relativeDestination(path: string) {
  if (!path || /^[\/\\]|^[a-z][a-z\d+.-]*:/i.test(path) || /[\\\u0000-\u001f\u007f]/.test(path))
    throw Error('图形需要可携带的相对附件路径');
  // Decode each segment once so callers may pass existing Markdown destinations.
  // Encoded separators must not become a second, different filesystem path.
  return path.split('/').map(segment => {
    let decoded: string;
    try { decoded = decodeURIComponent(segment); } catch { decoded = segment; }
    if (/[\/\\\u0000-\u001f\u007f]/.test(decoded)) throw Error('附件路径不正确');
    return encodeURIComponent(decoded).replace(/[!'()*]/g, c => '%' + c.charCodeAt(0).toString(16).toUpperCase());
  }).join('/');
}

export function renderPortableImage(altText: string, path: string): string {
  const alt = altText.replace(/[\r\n]/g, ' ').replace(/[\\\[\]]/g, '\\$&');
  return `![${alt}](${relativeDestination(path)})`;
}
export function renderPortableFigure(input: PortableFigure): string {
  const image = renderPortableImage(input.alt, input.previewPath);
  if (input.source.type === 'file')
    return `${image}\n\n[图形源文件](${relativeDestination(input.source.path)})\n`;
  if (!input.source.code || !['svg', 'mermaid'].includes(input.source.language)) throw Error('图形源码为空或类型不支持');
  const runs = [...input.source.code.matchAll(/`+/g)].map(match => match[0].length);
  const fence = '`'.repeat(Math.max(3, ...runs.map(length => length + 1)));
  return `${image}\n\n${fence}${input.source.language}\n${input.source.code}${input.source.code.endsWith('\n') ? '' : '\n'}${fence}\n`;
}
