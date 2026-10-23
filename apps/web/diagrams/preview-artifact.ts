import { SaxesParser } from 'saxes';
import { SVG_NAMESPACE, SVG_POLICY, validateSvgSource } from '../../../shared/svg-policy';
import { parseWhiteboard } from '../../../shared/whiteboard';

export type DiagramKind = 'svg' | 'mermaid' | 'excalidraw';
export type PreparedPreview = { kind: DiagramKind; sourceHash: string; preview: Blob };
type PreviewSource =
  | { kind: 'svg'; source: string }
  | { kind: 'mermaid'; source: string; svg: string }
  | { kind: 'excalidraw'; source: string };

/** Check before allocating a canvas, including the integer dimensions actually allocated. */
export function previewDimensions(width: number, height: number) {
  width = Math.ceil(width);
  height = Math.ceil(height);
  if (
    !Number.isFinite(width) ||
    !Number.isFinite(height) ||
    width <= 0 ||
    height <= 0 ||
    width > SVG_POLICY.maxDimension ||
    height > SVG_POLICY.maxDimension ||
    width * height > SVG_POLICY.maxPixels
  )
    throw Error('图形预览尺寸超限：单边不能超过 8192 像素，总面积不能超过 16777216 像素');
  return { width, height };
}

export async function hashDiagramSource(source: string) {
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(source));
  return [...new Uint8Array(hash)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

/** Mermaid may measure image nodes while rendering, before an SVG exists to inspect.
 * Decline resource-bearing syntax before calling the renderer as well as checking its output.
 */
export function assertMermaidSourceSafe(source: string) {
  if (source.length > 50_000) throw Error('流程图内容过长，请精简后预览');
  if (
    /\b(?:https?|data|javascript|file|ftp):|\/\/|\\|@import|url\s*\(|image-set\s*\(|\b(?:img|src|href)\s*[:=]|!\[|<\s*(?:img|image|iframe|foreignObject|style|link|script)\b/i.test(
      source,
    )
  )
    throw Error('流程图包含不支持的资源引用或转义语法，源码已保留');
}

const fragment = /^#[A-Za-z_][A-Za-z0-9_.:-]*$/;
const raster = /^data:image\/(?:png|jpeg|gif|webp);base64,[A-Za-z\d+/]*={0,2}$/;
const font =
  /^data:(?:font\/(?:woff2?|ttf|otf)|application\/(?:font-woff|x-font-ttf|octet-stream));base64,[A-Za-z\d+/]*={0,2}$/;

/** Extra resource boundary for library-generated SVG, never an alternative to validateSvgSource.
 * Mermaid needs generated CSS; Excalidraw may embed already validated raster files and fonts.
 * No URL may resolve against the page or reach an outside host.
 */
export function assertGeneratedSvgSafe(markup: string, embedded = false) {
  const unsafe = () => {
    throw Error('图形包含不支持的内容或外部资源，无法安全预览');
  };
  if (new TextEncoder().encode(markup).length > 12 * 1024 * 1024) unsafe();
  const resource = (value: string, css = false) => {
    if (fragment.test(value)) return;
    if (embedded && (raster.test(value) || (css && font.test(value)))) return;
    unsafe();
  };
  const css = (value: string) => {
    const text = value.replace(/\/\*[\s\S]*?\*\//g, '');
    const rest = text.replace(
      /url\(\s*(?:"([^"]*)"|'([^']*)'|([^)]*))\s*\)/gi,
      (_match, quoted, single, plain) => {
        resource((quoted ?? single ?? plain).trim(), true);
        return '';
      },
    );
    if (
      /\\|@import\b|(?:https?:|javascript:|file:|\/\/)|(?:image-set|cross-fade|url)\s*\(/i.test(
        rest,
      )
    )
      unsafe();
  };
  const parser = new SaxesParser({ xmlns: true });
  let depth = 0,
    elements = 0,
    styleDepth = 0,
    styleText = '',
    root = false;
  let dimensions: { width: number; height: number } | undefined;
  parser.on('error', unsafe);
  parser.on('doctype', unsafe);
  parser.on('processinginstruction', unsafe);
  parser.on('opentag', (tag) => {
    if (++elements > 20_000 || ++depth > 64 || tag.uri !== SVG_NAMESPACE) unsafe();
    if (
      [
        'script',
        'foreignobject',
        'iframe',
        'object',
        'embed',
        'video',
        'audio',
        'link',
        'animate',
        'animatetransform',
        'animatemotion',
        'set',
      ].includes(tag.local.toLowerCase())
    )
      unsafe();
    if (!root) {
      if (tag.local !== 'svg') unsafe();
      root = true;
      const attributes = Object.fromEntries(
        Object.values(tag.attributes).map((attr) => [attr.local, attr.value]),
      );
      const box = attributes.viewBox
        ?.trim()
        .split(/[\s,]+/)
        .map(Number);
      if (box?.length === 4 && box.every(Number.isFinite))
        dimensions = previewDimensions(box[2], box[3]);
      else if (
        /^\d+(?:\.\d+)?(?:px)?$/.test(attributes.width || '') &&
        /^\d+(?:\.\d+)?(?:px)?$/.test(attributes.height || '')
      )
        dimensions = previewDimensions(parseFloat(attributes.width), parseFloat(attributes.height));
      else throw Error('图形缺少有效的预览尺寸');
    }
    if (tag.local === 'style') {
      if (styleDepth) unsafe();
      styleDepth = depth;
      styleText = '';
    }
    for (const attr of Object.values(tag.attributes)) {
      if (attr.uri === 'http://www.w3.org/2000/xmlns/') {
        if (![SVG_NAMESPACE, 'http://www.w3.org/1999/xlink'].includes(attr.value)) unsafe();
        continue;
      }
      if (
        attr.uri &&
        !['http://www.w3.org/1999/xlink', 'http://www.w3.org/XML/1998/namespace'].includes(attr.uri)
      )
        unsafe();
      if (/^on/i.test(attr.local) || ['src', 'srcset', 'base'].includes(attr.local)) unsafe();
      if (attr.local === 'href') resource(attr.value);
      if (attr.local === 'style' || /url\s*\(|@import|\\/i.test(attr.value)) css(attr.value);
    }
  });
  parser.on('text', (value) => {
    if (styleDepth) styleText += value;
  });
  parser.on('cdata', (value) => {
    if (styleDepth) styleText += value;
  });
  parser.on('closetag', () => {
    if (styleDepth === depth) {
      css(styleText);
      styleDepth = 0;
    }
    depth--;
  });
  parser.write(markup).close();
  if (!root || !dimensions) unsafe();
  return dimensions!;
}

async function rasterizeSvg(markup: string, width: number, height: number) {
  const dimensions = previewDimensions(width, height);
  const image = new Image();
  const url = URL.createObjectURL(new Blob([markup], { type: 'image/svg+xml' }));
  let released = false;
  let canvas: HTMLCanvasElement | undefined;
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        cleanup();
        reject(Error('图形预览载入超时，请重试'));
      }, 15_000);
      const cleanup = () => {
        clearTimeout(timer);
        image.onload = image.onerror = null;
      };
      image.onload = () => {
        cleanup();
        resolve();
      };
      image.onerror = () => {
        cleanup();
        reject(Error('图形无法生成 PNG 预览，源码已保留'));
      };
      image.src = url;
    });
    canvas = document.createElement('canvas');
    canvas.width = dimensions.width;
    canvas.height = dimensions.height;
    const context = canvas.getContext('2d');
    if (!context) throw Error('当前浏览器无法生成 PNG 预览');
    context.drawImage(image, 0, 0, dimensions.width, dimensions.height);
    image.removeAttribute('src');
    URL.revokeObjectURL(url);
    released = true;
    const preview = await new Promise<Blob>((resolve, reject) => {
      canvas!.toBlob(
        (value) =>
          value?.type === 'image/png'
            ? resolve(value)
            : reject(Error('PNG 预览生成失败，源码已保留')),
        'image/png',
      );
    });
    return preview;
  } finally {
    image.onload = image.onerror = null;
    image.removeAttribute('src');
    if (!released) URL.revokeObjectURL(url);
    if (canvas) canvas.width = canvas.height = 0;
  }
}

/** Source and PNG are prepared together; this helper does not upload or save any note. */
export async function preparePreview(input: PreviewSource): Promise<PreparedPreview> {
  let preview: Blob;
  if (input.kind === 'svg') {
    const result = validateSvgSource(new TextEncoder().encode(input.source));
    if (!result.ok) throw Error(result.message);
    preview = await rasterizeSvg(result.presentation, result.width, result.height);
  } else if (input.kind === 'mermaid') {
    assertMermaidSourceSafe(input.source);
    const dimensions = assertGeneratedSvgSafe(input.svg);
    preview = await rasterizeSvg(input.svg, dimensions.width, dimensions.height);
  } else {
    const scene = parseWhiteboard(input.source);
    const { scenePng } = await import('../whiteboards/canvas');
    preview = await scenePng(scene);
  }
  return { kind: input.kind, sourceHash: await hashDiagramSource(input.source), preview };
}
