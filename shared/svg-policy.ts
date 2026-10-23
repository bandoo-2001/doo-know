import { SaxesParser } from 'saxes';

export const SVG_MIME = 'image/svg+xml';
export const SVG_NAMESPACE = 'http://www.w3.org/2000/svg';
export const SVG_POLICY = Object.freeze({
  maxBytes: 1024 * 1024,
  maxElements: 10_000,
  maxExpandedElements: 10_000,
  maxDepth: 32,
  maxAttributes: 64,
  maxAttributeLength: 65_536,
  maxNumbers: 100_000,
  maxReferences: 10_000,
  maxDimension: 8192,
  maxPixels: 16_777_216,
  maxCoordinate: 1_000_000,
});

export type SvgRejectionCode =
  | 'size-limit'
  | 'invalid-encoding'
  | 'invalid-xml'
  | 'unsafe-content'
  | 'unsupported-feature'
  | 'invalid-dimensions'
  | 'complexity-limit';
export type SvgValidationResult =
  | { ok: true; source: string; presentation: string; width: number; height: number }
  | { ok: false; code: SvgRejectionCode; message: string };

const messages: Record<SvgRejectionCode, string> = {
  'size-limit': 'SVG 不能超过 1 MiB',
  'invalid-encoding': 'SVG 必须使用有效的 UTF-8 编码',
  'invalid-xml': 'SVG XML 格式无效',
  'unsafe-content': 'SVG 包含脚本、外部资源、实体或不允许的命名空间',
  'unsupported-feature':
    'SVG 仅支持基本图形、文字、渐变和裁剪；不支持样式表、内联样式、图片、链接、动画、滤镜、蒙版或复用节点',
  'invalid-dimensions': 'SVG 尺寸必须为正数，单边不超过 8192 像素，总面积不超过 16777216 像素',
  'complexity-limit': 'SVG 图形过于复杂，超过安全预览限制',
};
class SvgRejection extends Error {
  constructor(readonly code: SvgRejectionCode) {
    super(messages[code]);
  }
}
function reject(code: SvgRejectionCode): never {
  throw new SvgRejection(code);
}

const globalAttributes = new Set([
  'id',
  'fill',
  'fill-rule',
  'fill-opacity',
  'stroke',
  'stroke-width',
  'stroke-opacity',
  'stroke-linecap',
  'stroke-linejoin',
  'stroke-miterlimit',
  'stroke-dasharray',
  'stroke-dashoffset',
  'opacity',
  'color',
  'transform',
  'clip-path',
  'clip-rule',
  'vector-effect',
  'visibility',
  'display',
  'xml:space',
  'role',
  'aria-label',
]);
const textAttributes =
  'x y dx dy rotate font-family font-size font-weight font-style text-anchor dominant-baseline textLength lengthAdjust letter-spacing word-spacing';
const elementAttributes: Record<string, ReadonlySet<string>> = Object.fromEntries(
  Object.entries({
    svg: 'width height viewBox preserveAspectRatio version',
    g: '',
    defs: '',
    title: '',
    desc: '',
    path: 'd pathLength',
    rect: 'x y width height rx ry pathLength',
    circle: 'cx cy r pathLength',
    ellipse: 'cx cy rx ry pathLength',
    line: 'x1 y1 x2 y2 pathLength',
    polyline: 'points pathLength',
    polygon: 'points pathLength',
    text: textAttributes,
    tspan: textAttributes,
    linearGradient: 'x1 y1 x2 y2 gradientUnits gradientTransform spreadMethod href',
    radialGradient: 'cx cy r fx fy fr gradientUnits gradientTransform spreadMethod href',
    stop: 'offset stop-color stop-opacity',
    clipPath: 'clipPathUnits',
  }).map(([tag, attrs]) => [tag, new Set(attrs.split(' ').filter(Boolean))]),
);
const numericAttributes = new Set(
  'x y x1 y1 x2 y2 dx dy cx cy r rx ry fx fy fr width height font-size textLength letter-spacing word-spacing stroke-width stroke-miterlimit stroke-dashoffset pathLength offset opacity fill-opacity stroke-opacity stop-opacity'.split(
    ' ',
  ),
);
const enums: Record<string, readonly string[]> = {
  'fill-rule': ['nonzero', 'evenodd'],
  'clip-rule': ['nonzero', 'evenodd'],
  'stroke-linecap': ['butt', 'round', 'square'],
  'stroke-linejoin': ['miter', 'round', 'bevel'],
  'vector-effect': ['none', 'non-scaling-stroke'],
  visibility: ['visible', 'hidden', 'collapse'],
  display: ['inline', 'none'],
  'xml:space': ['default', 'preserve'],
  role: ['img', 'presentation'],
  gradientUnits: ['userSpaceOnUse', 'objectBoundingBox'],
  clipPathUnits: ['userSpaceOnUse', 'objectBoundingBox'],
  spreadMethod: ['pad', 'reflect', 'repeat'],
  lengthAdjust: ['spacing', 'spacingAndGlyphs'],
  'font-style': ['normal', 'italic', 'oblique'],
  'text-anchor': ['start', 'middle', 'end'],
  'dominant-baseline': [
    'auto',
    'middle',
    'central',
    'hanging',
    'alphabetic',
    'text-after-edge',
    'text-before-edge',
    'ideographic',
    'mathematical',
  ],
};
const numberPattern = /[-+]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][-+]?\d+)?/g;
const oneLength = /^[-+]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][-+]?\d+)?(?:px|%)?$/;
const idPattern = /^[A-Za-z_][A-Za-z0-9_.:-]*$/;
const fragmentPattern = /^#([A-Za-z_][A-Za-z0-9_.:-]*)$/;
const fragmentPaint =
  /^url\(\s*(?:#([A-Za-z_][A-Za-z0-9_.:-]*)|"#([A-Za-z_][A-Za-z0-9_.:-]*)"|'#([A-Za-z_][A-Za-z0-9_.:-]*)')\s*\)$/;
const gradientTags = new Set(['linearGradient', 'radialGradient']);
function escapeText(value: string) {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
function escapeAttribute(value: string) {
  return escapeText(value)
    .replace(/"/g, '&quot;')
    .replace(/\r/g, '&#13;')
    .replace(/\n/g, '&#10;')
    .replace(/\t/g, '&#9;');
}

/** Strict XML parsing and a deliberately small SVG vocabulary shared by upload and browser previews.
 * Accepted source stays separate from a newly serialized, fixed-viewport presentation.
 * CSS, image/font loading, links, animation, filters, masks and <use> are intentionally unsupported.
 */
export function validateSvgSource(bytes: Uint8Array): SvgValidationResult {
  if (bytes.byteLength > SVG_POLICY.maxBytes)
    return { ok: false, code: 'size-limit', message: messages['size-limit'] };
  let source: string;
  try {
    source = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    return { ok: false, code: 'invalid-encoding', message: messages['invalid-encoding'] };
  }
  try {
    const parser = new SaxesParser({ xmlns: true });
    const output: string[] = [],
      stack: string[] = [],
      ids = new Map<string, string>();
    const resourceStack: (string | undefined)[] = [];
    const resourceSizes = new Map<string, number>();
    const references: { target: string; type: 'gradient' | 'clip'; from?: string }[] = [];
    let elements = 0,
      numbers = 0,
      width = 300,
      height = 150,
      currentResource: string | undefined;
    function numeric(value: string) {
      const values = value.match(numberPattern) || [];
      numbers += values.length;
      if (numbers > SVG_POLICY.maxNumbers) reject('complexity-limit');
      if (
        values.some(
          (v) => !Number.isFinite(Number(v)) || Math.abs(Number(v)) > SVG_POLICY.maxCoordinate,
        )
      )
        reject('invalid-dimensions');
      return values.map(Number);
    }
    function reference(value: string, type: 'gradient' | 'clip', from = currentResource) {
      references.push({ target: value, type, from });
      if (references.length > SVG_POLICY.maxReferences) reject('complexity-limit');
    }
    function paint(value: string, type: 'gradient' | 'clip') {
      const matched = fragmentPaint.exec(value);
      if (matched) {
        reference(matched[1] || matched[2] || matched[3], type);
        return;
      }
      if (type === 'clip') {
        if (value !== 'none') reject('unsafe-content');
        return;
      }
      if (/^(?:#[0-9a-f]{3,8}|[a-z]{1,32}|(?:rgb|rgba|hsl|hsla)\([\d\s.,%+\/-]+\))$/i.test(value))
        return;
      reject('unsafe-content');
    }
    parser.on('error', () => reject('invalid-xml'));
    parser.on('doctype', () => reject('unsafe-content'));
    parser.on('processinginstruction', () => reject('unsafe-content'));
    parser.on('xmldecl', (declaration) => {
      if (
        declaration.version !== '1.0' ||
        (declaration.encoding && !/^utf-?8$/i.test(declaration.encoding))
      )
        reject('invalid-encoding');
    });
    parser.on('opentag', (tag) => {
      if (++elements > SVG_POLICY.maxElements || stack.length >= SVG_POLICY.maxDepth)
        reject('complexity-limit');
      if (tag.uri !== SVG_NAMESPACE) reject('unsafe-content');
      const local = tag.local;
      if (!Object.hasOwn(elementAttributes, local)) reject('unsupported-feature');
      if ((!stack.length && local !== 'svg') || (stack.length && local === 'svg'))
        reject('unsupported-feature');
      const entries = Object.values(tag.attributes);
      if (entries.length > SVG_POLICY.maxAttributes) reject('complexity-limit');
      const attributes = new Map<string, string>();
      for (const attr of entries) {
        if (attr.value.length > SVG_POLICY.maxAttributeLength) reject('complexity-limit');
        if (attr.uri === 'http://www.w3.org/2000/xmlns/') {
          if (attr.value !== SVG_NAMESPACE && attr.value !== 'http://www.w3.org/1999/xlink')
            reject('unsafe-content');
          continue;
        }
        let name = attr.local;
        if (attr.uri === 'http://www.w3.org/XML/1998/namespace' && name === 'space')
          name = 'xml:space';
        else if (attr.uri && !(attr.uri === 'http://www.w3.org/1999/xlink' && name === 'href'))
          reject('unsafe-content');
        if (/^on/i.test(name)) reject('unsafe-content');
        if (!globalAttributes.has(name) && !elementAttributes[local].has(name))
          reject('unsupported-feature');
        if (attributes.has(name)) reject('invalid-xml');
        attributes.set(name, attr.value.trim());
      }
      const id = attributes.get('id');
      if (id !== undefined) {
        if (!idPattern.test(id) || ids.has(id)) reject('invalid-xml');
        ids.set(id, local);
      }
      currentResource = gradientTags.has(local) || local === 'clipPath' ? id : resourceStack.at(-1);
      if (currentResource)
        resourceSizes.set(currentResource, (resourceSizes.get(currentResource) || 0) + 1);
      for (const [name, value] of attributes) {
        if (name === 'id' || name === 'aria-label') continue;
        if (name === 'fill' || name === 'stroke' || name === 'color' || name === 'stop-color') {
          paint(value, 'gradient');
        } else if (name === 'clip-path') paint(value, 'clip');
        else if (name === 'href') {
          const fragment = fragmentPattern.exec(value);
          if (!fragment || !gradientTags.has(local)) reject('unsafe-content');
          reference(fragment[1], 'gradient', id);
        } else if (numericAttributes.has(name)) {
          if (!oneLength.test(value)) reject('invalid-dimensions');
          numeric(value);
        } else if (
          name === 'points' ||
          name === 'viewBox' ||
          name === 'stroke-dasharray' ||
          name === 'rotate'
        ) {
          if (name === 'stroke-dasharray' && value === 'none') continue;
          if (value.replace(numberPattern, '').replace(/[\s,]/g, '')) reject('unsupported-feature');
          numeric(value);
        } else if (name === 'd') {
          if (value.replace(numberPattern, '').replace(/[MmZzLlHhVvCcSsQqTtAa\s,]/g, ''))
            reject('unsupported-feature');
          numeric(value);
        } else if (name === 'transform' || name === 'gradientTransform') {
          if (
            value.replace(/(?:matrix|translate|scale|rotate|skewX|skewY)\s*\([^()]*\)/g, '').trim()
          )
            reject('unsupported-feature');
          if (
            value
              .replace(/(?:matrix|translate|scale|rotate|skewX|skewY)/g, '')
              .replace(numberPattern, '')
              .replace(/[\s,()]/g, '')
          )
            reject('unsupported-feature');
          numeric(value);
        } else if (enums[name]) {
          if (!enums[name].includes(value)) reject('unsupported-feature');
        } else if (name === 'font-family') {
          if (!/^[A-Za-z0-9 _,'"-]{1,128}$/.test(value)) reject('unsupported-feature');
        } else if (name === 'font-weight') {
          if (!/^(?:normal|bold|bolder|lighter|[1-9]00)$/.test(value))
            reject('unsupported-feature');
        } else if (name === 'version') {
          if (value !== '1.0' && value !== '1.1' && value !== '2.0') reject('unsupported-feature');
        } else if (
          name === 'preserveAspectRatio' &&
          !/^(?:none|x(?:Min|Mid|Max)Y(?:Min|Mid|Max)(?:\s+(?:meet|slice))?)$/.test(value)
        )
          reject('unsupported-feature');
      }
      if (!stack.length) {
        const box = attributes.get('viewBox')?.match(numberPattern)?.map(Number);
        if (
          attributes.has('viewBox') &&
          (!box ||
            box.length !== 4 ||
            box[2] <= 0 ||
            box[3] <= 0 ||
            box[2] > SVG_POLICY.maxDimension ||
            box[3] > SVG_POLICY.maxDimension ||
            box[2] * box[3] > SVG_POLICY.maxPixels)
        )
          reject('invalid-dimensions');
        const dimension = (value: string | undefined, fallback: number) => {
          if (value === undefined) return fallback;
          if (!oneLength.test(value) || value.endsWith('%')) reject('invalid-dimensions');
          return Number(value.replace(/px$/, ''));
        };
        width = Math.ceil(dimension(attributes.get('width'), box?.[2] ?? 300));
        height = Math.ceil(dimension(attributes.get('height'), box?.[3] ?? 150));
        if (
          !Number.isFinite(width) ||
          !Number.isFinite(height) ||
          width <= 0 ||
          height <= 0 ||
          width > SVG_POLICY.maxDimension ||
          height > SVG_POLICY.maxDimension ||
          width * height > SVG_POLICY.maxPixels
        )
          reject('invalid-dimensions');
        attributes.set('width', String(width));
        attributes.set('height', String(height));
      }
      output.push(`<${local}${stack.length ? '' : ` xmlns="${SVG_NAMESPACE}"`}`);
      for (const [name, value] of attributes) output.push(` ${name}="${escapeAttribute(value)}"`);
      output.push('>');
      stack.push(local);
      resourceStack.push(currentResource);
    });
    parser.on('closetag', () => {
      output.push(`</${stack.pop()!}>`);
      resourceStack.pop();
    });
    const text = (value: string) => {
      if (!stack.length) return;
      if (value.trim() && !['text', 'tspan', 'title', 'desc'].includes(stack[stack.length - 1]))
        reject('unsupported-feature');
      output.push(escapeText(value));
    };
    parser.on('text', text);
    parser.on('cdata', text);
    parser.write(source).close();
    if (!elements) reject('invalid-xml');
    const links = new Map<string, string[]>();
    for (const ref of references) {
      const target = ids.get(ref.target);
      if (ref.type === 'gradient' ? !target || !gradientTags.has(target) : target !== 'clipPath')
        reject('unsafe-content');
      if (ref.from) {
        const targets = links.get(ref.from) || [];
        targets.push(ref.target);
        links.set(ref.from, targets);
      }
    }
    const depths = new Map<string, number>();
    const costs = new Map<string, number>();
    function depth(id: string, route: Set<string>): number {
      if (route.has(id)) reject('unsafe-content');
      const known = depths.get(id);
      if (known !== undefined) return known;
      route.add(id);
      if (route.size > SVG_POLICY.maxDepth) reject('complexity-limit');
      let value = 1;
      let cost = resourceSizes.get(id) || 1;
      for (const target of links.get(id) || []) {
        value = Math.max(value, 1 + depth(target, route));
        cost += costs.get(target)!;
        if (cost > SVG_POLICY.maxExpandedElements) reject('complexity-limit');
      }
      route.delete(id);
      if (value > SVG_POLICY.maxDepth) reject('complexity-limit');
      depths.set(id, value);
      costs.set(id, cost);
      return value;
    }
    for (const from of links.keys()) depth(from, new Set());
    let expandedElements = elements;
    for (const ref of references) {
      if (ref.from) continue;
      depth(ref.target, new Set());
      expandedElements += costs.get(ref.target)!;
      if (expandedElements > SVG_POLICY.maxExpandedElements) reject('complexity-limit');
    }
    const presentation = output.join('');
    if (new TextEncoder().encode(presentation).byteLength > SVG_POLICY.maxBytes)
      reject('size-limit');
    return { ok: true, source, presentation, width, height };
  } catch (error) {
    const code = error instanceof SvgRejection ? error.code : 'invalid-xml';
    return { ok: false, code, message: messages[code] };
  }
}
