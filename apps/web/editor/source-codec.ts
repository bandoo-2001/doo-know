import MarkdownIt from 'markdown-it';
import { markdownStyles } from '../../../shared/markdown-styles';
import { evaluateDocumentEligibility } from './compatibility';
import {
  emptySelection,
  type SourceDocument,
  type SourceUnit,
  type SourceEdit,
  type CommitResult,
} from './contracts';
const parser = new MarkdownIt({ html: false, linkify: true, maxNesting: 100 }).use(markdownStyles);
const fail = (message: string): CommitResult => ({ ok: false, code: 'invalid', message });
const tag = /<\/?[a-zA-Z][^>]*>|<!--/;
function isOpaque(raw: string, kind: string) {
  if (kind === 'code_block') return false;
  if (kind === 'fence') {
    const info = /^[ \t]*(?:`{3,}|~{3,})([^\r\n]*)/.exec(raw.trimStart())?.[1].trim() || '';
    return !/^[a-zA-Z0-9_+#.-]*$/.test(info);
  }
  const material = raw.replace(/(`+)([\s\S]*?)\1/g, '');
  if (material.includes('<!--')) return true;
  const stack: string[] = [];
  for (const match of material.matchAll(/<\/?[a-zA-Z][^>]*>/g)) {
    const value = match[0];
    if (
      /^<(?:https?:\/\/|mailto:)[^>]+>$/.test(value) ||
      /^<[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+>$/.test(value)
    )
      continue;
    if (/^<div[ \t]+style="text-align:[ \t]*(?:left|center|right)[ \t]*"[ \t]*>$/.test(value)) {
      if (stack.includes('div')) return true;
      stack.push('div');
      continue;
    }
    if (/^<span[ \t]+style="color:[ \t]*#[0-9a-fA-F]{6}[ \t]*"[ \t]*>$/.test(value)) {
      if (stack.includes('span')) return true;
      stack.push('span');
      continue;
    }
    const close = /^<\/(div|span)[ \t]*>$/.exec(value);
    if (close && stack.pop() === close[1]) continue;
    return true;
  }
  if (/!?\[\[[^\]\n]+\]\]|(^|\n)\s*>\s*\[![A-Za-z]+\]|\{[#.][^}\n]+\}|==[^=\n]+==/.test(material))
    return true;
  return (
    stack.length > 0 ||
    /(^|\n)[ \t]*(?:\$\$|:::)/.test(material) ||
    /(?<!\\)\$[^\s$][^\n$]*\$/.test(material)
  );
}
export function parseSource(markdown: string, revision = 0): SourceDocument {
  const lines = markdown.split('\n');
  const offsets = [0];
  for (let i = 0; i < lines.length - 1; i++) offsets.push(offsets[i] + lines[i].length + 1);
  const environment: Parameters<typeof parser.parse>[1] = {};
  const tokens = parser.parse(markdown, environment);
  let depth = 0,
    maxDepth = 0;
  const roots: { line: number; kind: string }[] = [];
  for (const t of tokens) {
    if (depth === 0 && t.map && t.nesting !== -1)
      roots.push({ line: t.map[0], kind: t.type.replace(/_open$/, '') });
    depth += t.nesting;
    maxDepth = Math.max(maxDepth, depth);
  }
  const front = /^\uFEFF?---\r?\n[\s\S]*?\r?\n(?:---|\.\.\.)[ \t]*\r?(?:\n|$)/.exec(markdown);
  let starts = roots.map((r) => ({ from: offsets[r.line] ?? 0, kind: r.kind }));
  if (front) {
    starts = starts.filter((r) => r.from >= front[0].length);
    starts.unshift({ from: 0, kind: 'frontmatter' });
  }
  // Unknown fenced constructs are one atomic unit, including their interior paragraphs.
  const blocks = /(^|\n)([ \t]*)(\$\$|:::[^\n\r]*)\r?\n/g;
  let match: RegExpExecArray | null;
  const codeRanges = roots
    .filter((r) => r.kind === 'fence' || r.kind === 'code_block')
    .map((r) => {
      const i = starts.findIndex((s) => s.from === (offsets[r.line] ?? 0));
      return { from: offsets[r.line] ?? 0, to: starts[i + 1]?.from ?? markdown.length };
    });
  while ((match = blocks.exec(markdown))) {
    const from = match.index + match[1].length;
    if (codeRanges.some((r) => from >= r.from && from < r.to)) continue;
    const closer = match[3] === '$$' ? '$$' : ':::';
    const rest = markdown.slice(blocks.lastIndex);
    const re = new RegExp(
      '(?:^|\\n)[ \\t]*' + closer.replace(/\$/g, '\\$') + '[ \\t]*\\r?(?:\\n|$)',
    );
    const end = re.exec(rest);
    const to = end ? blocks.lastIndex + end.index + end[0].length : markdown.length;
    const enclosing = starts.filter((s) => s.from <= from).at(-1);
    const begin = enclosing?.from ?? from;
    starts = starts.filter((s) => s.from < begin || s.from >= to);
    starts.push({ from: begin, kind: 'opaque' });
    starts.sort((a, b) => a.from - b.from);
    blocks.lastIndex = to;
  }
  if (!starts.length && markdown.length) starts = [{ from: 0, kind: 'blank' }];
  const units: SourceUnit[] = starts.map((s, i) => {
    const from = i === 0 ? 0 : s.from,
      to = starts[i + 1]?.from ?? markdown.length,
      raw = markdown.slice(from, to);
    return {
      id: `s${revision}-${i}`,
      from,
      to,
      raw,
      kind: s.kind,
      opaque: s.kind === 'frontmatter' || s.kind === 'opaque' || isOpaque(raw, s.kind),
      dependencies: [],
    };
  });
  const nonCode = units
    .filter((u) => u.kind !== 'fence' && u.kind !== 'code_block')
    .map((u) => u.raw)
    .join('\n');
  // References inside lists/quotes are still global dependencies. Source regexes
  // alone miss their container prefixes and cannot make per-unit parsing safe.
  const linked = Object.keys(environment.references || {}).length > 0 ||
    /(^|\n) {0,3}\[[^\]\n]+\]:|!?\[[^\]\n]*\]\[[^\]\n]*\]|\[\^[^\]\n]+\]/.test(nonCode);
  const eligibility = evaluateDocumentEligibility({
    editorMode: 'full',
    markdown,
    units: units.length,
    depth: maxDepth,
    enabled: true,
  });
  if (linked) {
    eligibility.allowed = false;
    eligibility.reason = 'syntax';
    eligibility.message = '此笔记包含跨段引用，请使用 Markdown 源码保留引用关系';
  }
  return { markdown, revision, units, eligibility };
}
function boundary(text: string, n: number) {
  return (
    n >= 0 &&
    n <= text.length &&
    !(
      n > 0 &&
      n < text.length &&
      ((text.charCodeAt(n - 1) >= 0xd800 &&
        text.charCodeAt(n - 1) <= 0xdbff &&
        text.charCodeAt(n) >= 0xdc00 &&
        text.charCodeAt(n) <= 0xdfff) ||
        (text[n - 1] === '\r' && text[n] === '\n'))
    )
  );
}
export function serializeEdits(base: SourceDocument, edits: readonly SourceEdit[]): CommitResult {
  const sorted = [...edits].sort((a, b) => a.from - b.from || a.to - b.to);
  let end = -1;
  for (const e of sorted) {
    if (
      !Number.isSafeInteger(e.from) ||
      !Number.isSafeInteger(e.to) ||
      e.from > e.to ||
      !boundary(base.markdown, e.from) ||
      !boundary(base.markdown, e.to) ||
      e.from < end ||
      typeof e.insert !== 'string'
    )
      return fail('编辑范围已失效，请保留草稿后重试');
    end = e.to;
  }
  let markdown = base.markdown;
  for (const e of sorted.reverse())
    markdown = markdown.slice(0, e.from) + e.insert + markdown.slice(e.to);
  const last = edits.at(-1);
  const at = last ? last.from + last.insert.length : 0;
  return {
    ok: true,
    markdown,
    revision: base.revision + (markdown === base.markdown ? 0 : 1),
    selection: last ? { anchor: at, head: at, affinity: 'after' } : emptySelection(),
  };
}
export function validateUnitOperation(
  doc: SourceDocument,
  edits: readonly SourceEdit[],
  intent: 'edit' | 'deleteOpaque',
): CommitResult {
  const result = serializeEdits(doc, edits);
  if (!result.ok || intent === 'deleteOpaque') return result;
  for (const unit of doc.units.filter((u) => u.opaque))
    for (const e of edits) {
      if (e.from < unit.to && e.to > unit.from) {
        const left = Math.max(unit.from, e.from),
          right = Math.min(unit.to, e.to);
        if (!e.insert.includes(doc.markdown.slice(left, right)))
          return {
            ok: false,
            code: 'unsupported',
            message: '此操作会修改原文保留块，请切换源码编辑',
          };
      }
    }
  return result;
}
export function classifySourceUnits(doc: SourceDocument) {
  return doc;
}
export function textEdit(before: string, after: string): SourceEdit[] {
  if (before === after) return [];
  let from = 0;
  while (from < before.length && from < after.length && before[from] === after[from]) from++;
  while (from > 0 && (!boundary(before, from) || !boundary(after, from))) from--;
  let to = before.length,
    end = after.length;
  while (to > from && end > from && before[to - 1] === after[end - 1]) {
    to--;
    end--;
  }
  while (
    (!boundary(before, to) || !boundary(after, end)) &&
    to < before.length &&
    end < after.length
  ) {
    to++;
    end++;
  }
  return [{ from, to, insert: after.slice(from, end) }];
}
