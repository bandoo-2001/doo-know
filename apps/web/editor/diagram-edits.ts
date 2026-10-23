import MarkdownIt from 'markdown-it';
import { renderPortableFigure, renderPortableImage } from '../../../shared/portable-figure';
import {
  findDiagramPreviewGroup,
  serializeDiagramBinding,
  type DiagramBinding,
} from '../../../shared/diagram-portability';
const parser = new MarkdownIt({ html: false });
type Range = { from: number; to: number };
function offsets(text: string) {
  const result = [0];
  for (let i = 0; i < text.length; i++) if (text[i] === '\n') result.push(i + 1);
  return result;
}
const codeText = (text: string) => text.replace(/\r\n/g, '\n').replace(/\n+$/, '');
export function findDiagramRange(
  markdown: string,
  selector: { kind: string; code: string; line?: number; range?: Range },
): Range {
  const lines = offsets(markdown);
  const candidates = parser
    .parse(markdown, {})
    .filter(
      (token) =>
        token.type === 'fence' &&
        token.map &&
        token.info.trim() === selector.kind &&
        codeText(token.content) === codeText(selector.code),
    )
    .map((token) => ({
      from: lines[token.map![0]],
      to: lines[token.map![1]] ?? markdown.length,
      line: token.map![0] + 1,
    }))
    .filter(
      (range) =>
        (selector.line === undefined || range.line === selector.line) &&
        (!selector.range || (range.from >= selector.range.from && range.to <= selector.range.to)),
    );
  if (candidates.length !== 1)
    throw Error(
      candidates.length ? '存在多个相同图块，请重新选择目标图块' : '图块源码已变化，请重新生成预览',
    );
  return { from: candidates[0].from, to: candidates[0].to };
}

/** Changes only generated neighbors and leaves the exact original fence bytes. */
export function withDiagramPreview(
  markdown: string,
  range: Range,
  previewPath: string,
  sourcePath?: string,
  binding?: DiagramBinding,
) {
  const sourceLines = offsets(markdown);
  const fence = parser
    .parse(markdown, {})
    .find(
      (token) => token.type === 'fence' && token.map && sourceLines[token.map[0]] === range.from,
    );
  if (!fence || fence.level > 0)
    throw Error('引用或列表内的图块请先移到独立段落生成预览，也可以仅保存源码');
  const before = markdown.slice(0, range.from),
    tokens = parser.parse(before, {}),
    lines = offsets(before);
  const paragraphs = tokens.filter((token) => token.type === 'inline' && token.map);
  let at = findDiagramPreviewGroup(markdown, range.from)?.prefixFrom ?? range.from,
    last = paragraphs.at(-1),
    sourceLast = false;
  if (
    last?.children?.[0]?.type === 'link_open' &&
    last.children[1]?.content === '图形源文件' &&
    /(?:^|\/)diagram-[a-f\d]{64}\.(?:svg|mmd|excalidraw)$/.test(
      String(last.children[0].attrGet('href') || ''),
    )
  ) {
    sourceLast = true;
    last = paragraphs.at(-2);
  }
  const image = last?.children?.length === 1 ? last.children[0] : undefined;
  if (
    image?.type === 'image' &&
    /^(?:SVG|MERMAID|EXCALIDRAW) 预览$/.test(image.content) &&
    /(?:^|\/)diagram-[a-f\d]{64}\.png$/.test(String(image.attrGet('src') || ''))
  ) {
    const tail = lines[(sourceLast ? paragraphs.at(-1) : last)!.map![1]] ?? before.length;
    if (!before.slice(tail).trim()) at = lines[last!.map![0]];
  }
  const newline = markdown.includes('\r\n') ? '\r\n' : '\n';
  const kind =
    parser
      .parse(markdown.slice(range.from, range.to), {})
      .find((token) => token.type === 'fence')
      ?.info.trim() || 'SVG';
  const prefix = sourcePath
    ? renderPortableFigure({
        alt: kind.toUpperCase() + ' 预览',
        previewPath,
        source: { type: 'file', path: sourcePath },
      })
    : renderPortableImage(kind.toUpperCase() + ' 预览', previewPath) + '\n';
  const marker = binding ? serializeDiagramBinding(binding) + newline + newline : '';
  return (
    markdown.slice(0, at) +
    prefix.replace(/\n/g, newline) +
    newline +
    marker +
    markdown.slice(range.from)
  );
}
