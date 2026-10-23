import MarkdownIt from 'markdown-it';
import { diagramKinds, isDiagramKind } from './diagram-fences.js';
import { knowledgeMarkdown } from './knowledge-markdown.js';
import { parseDiagramBinding, type DiagramBinding } from './diagram-binding.js';
export { parseDiagramBinding, serializeDiagramBinding } from './diagram-binding.js';
export type { DiagramBinding } from './diagram-binding.js';

export type PortableDiagramKind = (typeof diagramKinds)[number];
export type DiagramPreviewGroup = {
  prefixFrom: number;
  prefixTo: number;
  previewPath: string;
  sourcePath: string;
  binding: DiagramBinding;
};
type DiagramFence = {
  kind: PortableDiagramKind;
  code: string;
  from: number;
  to: number;
  line: number;
};
export type DiagramSaveNeed = DiagramFence &
  Partial<DiagramPreviewGroup> & {
    codeHash: string;
    reason: 'new' | 'changed' | 'stale';
  };
const parser = new MarkdownIt({ html: true, linkify: true }).use(knowledgeMarkdown);
const extensions: Record<PortableDiagramKind, string> = {
  svg: 'svg',
  mermaid: 'mmd',
  excalidraw: 'excalidraw',
};

export function normalizeDiagramCode(code: string) {
  return code.replace(/\r\n?/g, '\n').replace(/\n+$/, '');
}
export async function hashDiagramCode(code: string) {
  const bytes = new TextEncoder().encode(normalizeDiagramCode(code));
  const hash = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(hash)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

function lineOffsets(markdown: string) {
  const starts = [0];
  for (let index = 0; index < markdown.length; index++) {
    if (markdown[index] === '\r') {
      if (markdown[index + 1] === '\n') index++;
      starts.push(index + 1);
    } else if (markdown[index] === '\n') starts.push(index + 1);
  }
  return starts;
}
function generatedPath(value: unknown, extension: string): value is string {
  if (
    typeof value !== 'string' ||
    /^[a-z][a-z\d+.-]*:|^[\/\\]/i.test(value) ||
    /[\\\u0000-\u001f]/.test(value)
  )
    return false;
  try {
    const file = decodeURIComponent(value.split(/[?#]/)[0]).split('/').at(-1) || '';
    return new RegExp('^diagram-[a-f0-9]{64}\\.' + extension + '$').test(file);
  } catch {
    return false;
  }
}
function inspect(markdown: string) {
  const starts = lineOffsets(markdown);
  const blocks = parser
    .parse(markdown, {})
    .filter((token) => token.map && ['inline', 'fence', 'html_block'].includes(token.type));
  const range = (token: (typeof blocks)[number]) => ({
    from: starts[token.map![0]],
    to: starts[token.map![1]] ?? markdown.length,
  });
  const fences: (DiagramFence & { group?: DiagramPreviewGroup })[] = [];
  const emptyGap = (from: number, to: number) =>
    !markdown
      .slice(from, to)
      .replace(/^[ \t]*(?:>[ \t]*)+$/gm, '')
      .trim();
  for (let index = 0; index < blocks.length; index++) {
    const token = blocks[index],
      kind = token.info.trim();
    if (token.type !== 'fence' || !isDiagramKind(kind)) continue;
    const current = { kind, code: token.content, ...range(token), line: token.map![0] + 1 };
    const marker = blocks[index - 1],
      source = blocks[index - 2],
      image = blocks[index - 3];
    let group: DiagramPreviewGroup | undefined;
    if (marker?.type === 'html_block' && source?.type === 'inline' && image?.type === 'inline') {
      const binding = parseDiagramBinding(marker.content);
      const imageToken = image.children?.length === 1 ? image.children[0] : undefined;
      const links = source.children;
      const previewPath = imageToken?.attrGet('src'),
        sourcePath = links?.[0]?.attrGet('href');
      if (
        binding &&
        imageToken?.type === 'image' &&
        imageToken.content === binding.kind.toUpperCase() + ' 预览' &&
        links?.length === 3 &&
        links[0].type === 'link_open' &&
        links[1].type === 'text' &&
        links[1].content === '图形源文件' &&
        links[2].type === 'link_close' &&
        generatedPath(previewPath, 'png') &&
        generatedPath(sourcePath, extensions[binding.kind]) &&
        emptyGap(range(image).to, range(source).from) &&
        emptyGap(range(source).to, range(marker).from) &&
        emptyGap(range(marker).to, current.from)
      )
        group = {
          prefixFrom: range(image).from,
          prefixTo: current.from,
          previewPath,
          sourcePath,
          binding,
        };
    }
    fences.push({ ...current, ...(group ? { group } : {}) });
  }
  return fences;
}

export function findDiagramPreviewGroup(
  markdown: string,
  fenceFrom: number,
): DiagramPreviewGroup | undefined {
  return inspect(markdown).find((fence) => fence.from === fenceFrom)?.group;
}
export function diagramPreviewGroups(markdown: string) {
  return new Map(
    inspect(markdown).flatMap((fence) => (fence.group ? [[fence.from, fence.group] as const] : [])),
  );
}
export function boundDiagramSources(markdown: string) {
  return inspect(markdown).flatMap(({ group, ...fence }) =>
    group ? [{ ...fence, ...group }] : [],
  );
}

/** Unchanged unconverted legacy fences stay readable without triggering a migration. */
export async function collectDiagramSaveNeeds(
  current: string,
  baseline: string,
): Promise<DiagramSaveNeed[]> {
  const now = inspect(current),
    before = inspect(baseline);
  const available = new Map<string, number>();
  const key = (fence: DiagramFence) => fence.kind + '\0' + normalizeDiagramCode(fence.code);
  for (const fence of before) available.set(key(fence), (available.get(key(fence)) || 0) + 1);
  // Match all unchanged copies first, so an edit cannot steal an identical legacy neighbor.
  const unchanged = now.map((fence) => {
    const count = available.get(key(fence)) || 0;
    if (count) available.set(key(fence), count - 1);
    return count > 0;
  });
  const remaining = new Map<PortableDiagramKind, number>();
  for (const [key, count] of available) {
    const kind = key.split('\0')[0] as PortableDiagramKind;
    remaining.set(kind, (remaining.get(kind) || 0) + count);
  }
  const result: DiagramSaveNeed[] = [];
  for (let index = 0; index < now.length; index++) {
    const { group, ...fence } = now[index];
    const codeHash = await hashDiagramCode(fence.code);
    let reason: DiagramSaveNeed['reason'] = 'new';
    if (!unchanged[index] && (remaining.get(fence.kind) || 0) > 0) {
      reason = 'changed';
      remaining.set(fence.kind, remaining.get(fence.kind)! - 1);
    }
    if (group) {
      if (group.binding.kind === fence.kind && group.binding.codeHash === codeHash) continue;
      reason = 'stale';
    } else if (unchanged[index]) continue;
    result.push({ ...fence, codeHash, reason, ...(group || {}) });
  }
  return result;
}

/** Explicit source-only action: remove only recognized bound generated neighbors, never files. */
export function stripDiagramPreviews(markdown: string, needs: readonly DiagramSaveNeed[]) {
  const fences = inspect(markdown);
  const removals: { from: number; to: number; insert: string }[] = [];
  for (const need of needs) {
    const fence = fences.find(
      (fence) =>
        fence.from === need.from &&
        fence.to === need.to &&
        fence.kind === need.kind &&
        normalizeDiagramCode(fence.code) === normalizeDiagramCode(need.code),
    );
    if (!fence) throw Error('图块源码已变化，请重新确认保存方式');
    if (need.prefixFrom === undefined) continue;
    const group = fence.group;
    if (
      !group ||
      group.prefixFrom !== need.prefixFrom ||
      group.prefixTo !== need.prefixTo ||
      group.previewPath !== need.previewPath ||
      group.sourcePath !== need.sourcePath ||
      JSON.stringify(group.binding) !== JSON.stringify(need.binding)
    )
      throw Error('图形预览已变化，请重新确认保存方式');
    const beginning = markdown.slice(group.prefixFrom, group.prefixTo);
    const listMarker = /^((?:(?:[ \t]*>[ \t]*)*[ \t]*(?:[-+*]|\d{1,9}[.)])[ \t]+)+)(?=!\[)/.exec(
      beginning,
    )?.[1];
    const eol = beginning.includes('\r\n') ? '\r\n' : '\n';
    removals.push({
      from: group.prefixFrom,
      to: group.prefixTo,
      insert: listMarker ? listMarker + eol : '',
    });
  }
  for (const range of [...new Map(removals.map((range) => [range.from, range])).values()].sort(
    (a, b) => b.from - a.from,
  ))
    markdown = markdown.slice(0, range.from) + range.insert + markdown.slice(range.to);
  return markdown;
}
