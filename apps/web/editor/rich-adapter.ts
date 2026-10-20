import { sourceVisibleText, richVisibleText } from './source-semantic';
import { Extension, getSchema, type JSONContent, type AnyExtension } from '@tiptap/core';
import { MarkdownManager } from '@tiptap/markdown';
import StarterKit from '@tiptap/starter-kit';
import { TableKit } from '@tiptap/extension-table';
import { TaskList, TaskItem } from '@tiptap/extension-list';
import { authorizedImage } from './extensions/authorized-image';
import { DocumentParagraph } from './extensions/paragraph';
import { DocumentHardBreak } from './extensions/hard-break';
import { DocumentCodeBlock } from './extensions/code-block';
import { ProjectTextStyle, ProjectColor, ProjectAlignment } from './extensions/project-styles';
import { opaqueSourceExtension } from './extensions/opaque-source';
import { parseSource } from './source-codec';
import type { SourceUnit } from './contracts';
const origin = Extension.create({
  name: 'sourceOrigin',
  addGlobalAttributes() {
    return [
      {
        types: [
          'paragraph',
          'heading',
          'blockquote',
          'bulletList',
          'orderedList',
          'taskList',
          'codeBlock',
          'horizontalRule',
          'table',
          'image',
        ],
        attributes: { sourceId: { default: null, rendered: false } },
      },
    ];
  },
});
export function richExtensions(
  openSource?: (id: string) => void,
  resolveImage?: (url: string) => string | undefined,
  deleteOpaque?: (id: string) => void,
  copyOpaque?: (id: string) => void,
): AnyExtension[] {
  return [
    StarterKit.configure({
      undoRedo: false,
      trailingNode: false,
      paragraph: false,
      codeBlock: false,
      hardBreak: false,
      underline: false,
      link: { openOnClick: false, autolink: false },
    }),
    DocumentParagraph,
    DocumentHardBreak,
    DocumentCodeBlock,
    TableKit.configure({ table: { resizable: false } }),
    TaskList,
    TaskItem.configure({ nested: true }),
    authorizedImage(resolveImage),
    ProjectTextStyle,
    ProjectColor,
    ProjectAlignment,
    origin,
    opaqueSourceExtension(openSource, deleteOpaque, copyOpaque),
  ];
}
const extensions = richExtensions();
const schema = getSchema(extensions);
const manager = new MarkdownManager({ extensions, markedOptions: { gfm: true } });
export function safeEditorUrl(value: string) {
  const s = value.trim();
  return (
    !!s &&
    !/[\\\u0000-\u0020]/.test(s) &&
    !s.startsWith('//') &&
    (!/^[a-z][a-z0-9+.-]*:/i.test(s) || /^(https?:|mailto:|tel:)/i.test(s))
  );
}
function sorted(value: any): any {
  if (Array.isArray(value)) return value.map(sorted);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value)
        .filter((k) => k !== 'sourceId')
        .sort()
        .map((k) => [k, sorted(value[k])]),
    );
  }
  return value;
}
function fingerprint(node: JSONContent) {
  const value = schema.nodeFromJSON(node);
  value.check();
  return JSON.stringify(sorted(value.toJSON()));
}
function hasUnsafe(node: JSONContent): boolean {
  for (const key of ['href', 'src'])
    if (typeof node.attrs?.[key] === 'string' && !safeEditorUrl(node.attrs[key])) return true;
  return (node.content || []).some(hasUnsafe) || (node.marks || []).some(hasUnsafe);
}
function lastBlock(doc: JSONContent): JSONContent | undefined {
  if (['paragraph', 'heading', 'codeBlock'].includes(doc.type || '')) return doc;
  const last = doc.content?.at(-1);
  return last ? lastBlock(last) : undefined;
}
function normalizeInlineRoots(doc: JSONContent): JSONContent {
  return {
    ...doc,
    content: (doc.content || []).map((node) =>
      node.type === 'image' ? { type: 'paragraph', content: [node] } : node,
    ),
  };
}
export function parseRichUnit(raw: string): JSONContent[] {
  let input = raw.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n');
  const align =
    /^\s*<div[ \t]+style="text-align:[ \t]*(left|center|right)[ \t]*">\s*\n([\s\S]*?)\n<\/div>[ \t\r\n]*$/.exec(
      input,
    );
  if (align) input = align[2];
  const leading = /^((?: {2,}\n)+)/.exec(input);
  if (leading && !input.slice(leading[0].length).trim()) {
    return [
      {
        type: 'paragraph',
        content: (leading[1].match(/\n/g) || []).map(() => ({ type: 'hardBreak' })),
      },
    ];
  }
  let json = normalizeInlineRoots(manager.parse(input.replace(/\n+$/, '')));
  const tail = /((?:\\\n)+)\n*$/.exec(input),
    spaces = /((?: {2,}\n)+)\n*$/.exec(input);
  const last = lastBlock(json);
  if (last?.type === 'paragraph' && (tail || spaces)) {
    const matched = tail || spaces!;
    json = normalizeInlineRoots(manager.parse(input.slice(0, matched.index).replace(/\n+$/, '')));
    if (!json.content?.length) json = { type: 'doc', content: [{ type: 'paragraph' }] };
    const target = lastBlock(json);
    if (target?.type === 'paragraph') {
      target.content ||= [];
      for (
        let i = 0;
        i < (tail ? tail[1].split('\\\n').length - 1 : (spaces![1].match(/\n/g) || []).length);
        i++
      )
        target.content.push({ type: 'hardBreak' });
    }
  }
  if (leading && json.content?.[0]?.type === 'paragraph') {
    json.content[0].content = [
      ...(leading[1].match(/\n/g) || []).map(() => ({ type: 'hardBreak' })),
      ...(json.content[0].content || []),
    ];
  }
  if (align) {
    if (
      json.content?.length !== 1 ||
      !['paragraph', 'heading'].includes(json.content[0].type || '')
    )
      throw Error('跨段对齐容器需保留原文');
    json.content[0].attrs = { ...json.content[0].attrs, textAlign: align[1] };
  }
  return json.content || [];
}
function writeNode(node: JSONContent) {
  const clean = structuredClone(node);
  if (clean.attrs) delete clean.attrs.sourceId;
  const align = clean.attrs?.textAlign;
  if (clean.attrs) delete clean.attrs.textAlign;
  // The document serializer drops whitespace-only output, including an intentional soft line.
  let text = manager.renderNodeToMarkdown(clean, { type: 'doc', content: [clean] });
  if (align && /^(left|center|right)$/.test(align))
    text = `<div style="text-align:${align}">\n\n${text}\n\n</div>`;
  return text;
}
export type ProjectionResult = { ok: true; markdown: string } | { ok: false; message: string };
export type RichProjection = ReturnType<typeof createRichProjection>;
export function createRichProjection(original: string) {
  const removedOpaque = new Set<string>();
  const source = parseSource(original);
  const ledger = new Map<string, { unit: SourceUnit; fingerprint: string }>();
  const nodes: JSONContent[] = [];
  for (const u of source.units) {
    if (u.kind === 'blank' && !u.raw.trim()) {
      const blank = parseRichUnit(u.raw)[0] || { type: 'paragraph' };
      nodes.push({ ...blank, attrs: { ...blank.attrs, sourceId: u.id } });
      ledger.set(u.id, { unit: u, fingerprint: fingerprint(nodes.at(-1)!) });
      continue;
    }
    let node: JSONContent;
    try {
      const parsed = u.opaque ? [] : parseRichUnit(u.raw);
      if (
        parsed.length !== 1 ||
        hasUnsafe(parsed[0]) ||
        sourceVisibleText(u.raw) !== richVisibleText(parsed[0])
      )
        throw Error('保留此内容的原文');
      node = parsed[0];
      fingerprint(node);
    } catch {
      u.opaque = true;
      node = { type: 'opaqueSource' };
    }
    node.attrs = { ...node.attrs, sourceId: u.id };
    nodes.push(node);
    ledger.set(u.id, { unit: u, fingerprint: fingerprint(node) });
  }
  if (!nodes.length) {
    const node: JSONContent = { type: 'paragraph', attrs: { sourceId: 'empty' } };
    nodes.push(node);
    ledger.set('empty', {
      unit: {
        id: 'empty',
        from: 0,
        to: 0,
        raw: '',
        kind: 'blank',
        opaque: false,
        dependencies: [],
      },
      fingerprint: fingerprint(node),
    });
  }
  const json: JSONContent = { type: 'doc', content: nodes };
  const initial = JSON.stringify(sorted(schema.nodeFromJSON(json).toJSON()));
  const currentRanges = new Map([...ledger].map(([id, entry]) => [id, entry.unit]));
  return {
    original,
    source,
    eligibility: source.eligibility,
    json,
    sourceRange(id: string) {
      return currentRanges.get(id);
    },
    confirmOpaqueDeletion(id: string) {
      if (ledger.get(id)?.unit.opaque) removedOpaque.add(id);
    },
    serialize(doc: JSONContent, options?: { deleteOpaqueId?: string }): ProjectionResult {
      try {
        if (JSON.stringify(sorted(schema.nodeFromJSON(doc).toJSON())) === initial) {
          currentRanges.clear();
          for (const [id, entry] of ledger) currentRanges.set(id, entry.unit);
          return { ok: true, markdown: original };
        }
        const used = new Set<string>();
        const protectedIds = [...ledger]
          .filter(
            ([id, v]) => v.unit.opaque && !removedOpaque.has(id) && id !== options?.deleteOpaqueId,
          )
          .map(([id]) => id);
        const seenOpaque: string[] = [];
        const output: { id?: string; raw: string; changed: boolean }[] = [];
        for (const node of doc.content || []) {
          const id = String(node.attrs?.sourceId || '');
          const old = used.has(id) ? undefined : ledger.get(id);
          used.add(id);
          if (hasUnsafe(node))
            return { ok: false, message: '链接或图片地址不可用，请使用安全地址' };
          if (old?.unit.opaque) {
            if (node.type !== 'opaqueSource' || fingerprint(node) !== old.fingerprint)
              return { ok: false, message: '此内容需在 Markdown 源码中编辑' };
            seenOpaque.push(id);
            output.push({ id, raw: old.unit.raw, changed: false });
            continue;
          }
          if (node.type === 'opaqueSource')
            return { ok: false, message: '原文保留块身份已失效，请切换源码' };
          if (old && fingerprint(node) === old.fingerprint) {
            output.push({ id, raw: old.unit.raw, changed: false });
            continue;
          }
          const text = writeNode(node);
          const parsed =
            node.type === 'paragraph' && !node.content?.length
              ? [{ type: 'paragraph' }]
              : parseRichUnit(text);
          if (parsed.length !== 1 || fingerprint(parsed[0]) !== fingerprint(node))
            return { ok: false, message: '此格式无法安全保存为 Markdown，请使用源码编辑' };
          const eol = old?.unit.raw.includes('\r\n')
            ? '\r\n'
            : original.includes('\r\n')
              ? '\r\n'
              : '\n';
          const last = node === (doc.content || []).at(-1);
          const suffix = last ? old?.unit.raw.match(/(?:\r?\n)*$/)?.[0] || '' : eol + eol;
          output.push({ id: old ? id : undefined, raw: text.replace(/\r?\n/g, eol) + suffix, changed: true });
        }
        if (JSON.stringify(seenOpaque) !== JSON.stringify(protectedIds))
          return { ok: false, message: '操作会删除或移动原文保留块，请切换源码处理' };
        for (let i = 1; i < output.length; i++)
          if (output[i].changed && !/(?:\r?\n){2}$/.test(output[i - 1].raw)) {
            const eol = original.includes('\r\n') ? '\r\n' : '\n';
            output[i].raw = (/\n$/.test(output[i - 1].raw) ? eol : eol + eol) + output[i].raw;
          }
        currentRanges.clear();
        let offset = 0;
        for (const part of output) {
          if (part.id) {
            const unit = ledger.get(part.id)!.unit;
            currentRanges.set(part.id, { ...unit, from: offset, to: offset + part.raw.length, raw: part.raw });
          }
          offset += part.raw.length;
        }
        return { ok: true, markdown: output.map((x) => x.raw).join('') };
      } catch {
        return { ok: false, message: '转换未完成，当前内容已保留，请使用源码编辑' };
      }
    },
  };
}

export function renderRichContent(doc: JSONContent): ProjectionResult {
  try {
    if (hasUnsafe(doc)) return { ok: false, message: '链接地址不可用' };
    const parts: string[] = [];
    for (const node of doc.content || []) {
      const raw = writeNode(node),
        parsed =
          node.type === 'paragraph' && !node.content?.length
            ? [{ type: 'paragraph' }]
            : parseRichUnit(raw);
      if (parsed.length !== 1 || fingerprint(parsed[0]) !== fingerprint(node))
        return { ok: false, message: '此格式无法完整转换，可按普通文本粘贴' };
      parts.push(raw);
    }
    return { ok: true, markdown: parts.join('\n\n') };
  } catch {
    return { ok: false, message: '此内容无法安全转换为 Markdown' };
  }
}

export function parseRichContent(markdown: string): JSONContent[] {
  const source = parseSource(markdown);
  if (!source.eligibility.allowed || source.units.some((u) => u.opaque))
    throw Error('此内容需要在源码中编辑');
  return source.units.flatMap((u) => parseRichUnit(u.raw));
}
