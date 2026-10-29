import type {
  GraphEntityKind,
  GraphEvidence,
  GraphExtraction,
} from '../../../shared/graph-semantic-contracts.js';
import { graphEntityKinds } from '../../../shared/graph-semantic-contracts.js';
import { extractNoteLinks } from '../../../shared/note-links.js';
import { readDocumentProperties } from '../../../shared/frontmatter.js';
import { frontmatterRange } from '../../../shared/frontmatter-range.js';
import { documentTitle } from '../../../shared/whiteboard.js';
import { hash } from './analysis-source.js';
export type Entity = {
  id: string;
  name: string;
  kind: GraphEntityKind;
  description?: string;
  aliases: string[];
  evidence: GraphEvidence[];
};
export type Relation = {
  id: string;
  source: string;
  target: string;
  predicate: string;
  confidence: number;
  method: 'local' | 'model';
  evidence: GraphEvidence[];
};
export type Analysis = {
  title: string;
  entities: Entity[];
  relations: Relation[];
  links: string[];
  linkEvidence: Record<string, GraphEvidence[]>;
  terms: string[];
  partial: boolean;
};
export const normalize = (s: string) =>
  s.normalize('NFKC').trim().toLowerCase().replace(/\s+/g, ' ');
export const entityId = (name: string, kind: GraphEntityKind = 'concept') =>
  'entity:' + hash(kind + '\0' + normalize(name)).slice(0, 24);
export const relationId = (a: string, b: string, p: string) =>
  'relation:' + hash([a, b, normalize(p)].join('\0')).slice(0, 24);
const stop = new Set(
  'the a an and or is are was were be been being to of in on at for with from by this that these those it its as we you they our their has have had not into about can will also using use 是 的 了 和 与 在 为 及 一个 通过 进行 可以 这个 我们 以及'.split(
    ' ',
  ),
);
const segmenter = new Intl.Segmenter(undefined, { granularity: 'word' });
export function terms(text: string) {
  const result: string[] = [];
  for (const item of segmenter.segment(text))
    if (
      item.isWordLike &&
      item.segment.length >= 2 &&
      item.segment.length <= 64 &&
      !stop.has(normalize(item.segment)) &&
      !/^\d+$/.test(item.segment)
    )
      result.push(item.segment);
  return result;
}
export function chunks(text: string, size: number) {
  const result: { text: string; line: number }[] = [];
  let offset = 0,
    line = 1;
  while (offset < text.length && result.length < 256) {
    let end = Math.min(offset + size, text.length);
    if (end < text.length) {
      const nl = text.lastIndexOf('\n', end);
      if (nl > offset + size / 2) end = nl + 1;
      if (/[\uD800-\uDBFF]/.test(text[end - 1])) end--;
    }
    const part = text.slice(offset, end);
    result.push({ text: part, line });
    line += (part.match(/\n/g) || []).length;
    offset = end;
  }
  return { parts: result, partial: offset < text.length };
}
export function analyzer(
  text: string,
  path: string,
  noteId: string,
  sourceHash: string,
  revision: number,
) {
  const title = documentTitle(path, text).slice(0, 256);
  let clipped = false;
  const referenceText = text.slice(0, 1024 * 1024),
    links = extractNoteLinks(referenceText, path).slice(0, 512),
    linkEvidence: Record<string, GraphEvidence[]> = {};
  const entities = new Map<string, Entity>(),
    relations = new Map<string, Relation>(),
    counts = new Map<string, { name: string; count: number }>();
  function evidence(
    quote: string,
    part: { text: string; line: number },
    method: 'local' | 'model',
    model?: string,
  ): GraphEvidence | undefined {
    if (!quote || quote.length > 4000) return;
    const offset = part.text.indexOf(quote);
    if (offset < 0) return;
    const startLine = part.line + (part.text.slice(0, offset).match(/\n/g) || []).length;
    return {
      id:
        'evidence:' + hash([noteId, sourceHash, startLine, quote, method].join('\0')).slice(0, 24),
      noteId,
      title,
      relativePath: path,
      sourceHash,
      sourceRevision: revision,
      startLine,
      endLine: startLine + (quote.match(/\n/g) || []).length,
      quote,
      method,
      ...(model ? { model } : {}),
    };
  }
  function addEntity(
    name: string,
    kind: GraphEntityKind,
    ev: GraphEvidence,
    description?: string,
    aliases: string[] = [],
  ) {
    if (!name.trim() || name.length > 160 || !graphEntityKinds.includes(kind)) return;
    const id = entityId(name, kind);
    let item = entities.get(id);
    if (!item) {
      if (entities.size >= (ev.method === 'local' ? 64 : 128)) {
        clipped = true;
        return;
      }
      item = {
        id,
        name: name.trim(),
        kind,
        description: typeof description === 'string' ? description.slice(0, 2000) : undefined,
        aliases: (Array.isArray(aliases) ? aliases : [])
          .filter((a) => typeof a === 'string' && a.length <= 160)
          .slice(0, 16),
        evidence: [],
      };
      entities.set(id, item);
    }
    if (item.evidence.length < 4 && !item.evidence.some((e) => e.id === ev.id))
      item.evidence.push(ev);
    return id;
  }
  function addRelation(
    source: string,
    target: string,
    predicate: string,
    confidence: number,
    method: 'local' | 'model',
    ev: GraphEvidence,
  ) {
    if (source === target || !predicate.trim() || predicate.length > 160) return;
    const id = relationId(source, target, predicate),
      item = relations.get(id);
    if (item) {
      if (item.evidence.length < 4 && !item.evidence.some((e) => e.id === ev.id))
        item.evidence.push(ev);
      return;
    }
    if (relations.size >= (method === 'local' ? 128 : 256)) {
      clipped = true;
      return;
    }
    relations.set(id, { id, source, target, predicate, confidence, method, evidence: [ev] });
  }
  let codeFence: string | undefined;
  function local(part: { text: string; line: number }) {
    // Code fences and inline code are opaque; quoted evidence always comes from the original part.
    let source = part.text;
    if (part.line === 1) {
      const front = frontmatterRange(source);
      if (front && front.end <= 32000) {
        const properties = readDocumentProperties(source);
        for (const prop of properties.properties.filter((p) => ['tags', 'aliases'].includes(p.key)))
          for (const value of Array.isArray(prop.value) ? prop.value : [prop.value])
            if (typeof value === 'string' && value.length <= 128) {
              const ev = evidence(value, part, 'local');
              if (ev) addEntity(value, 'concept', ev);
            }
        source = source.slice(0, front.end).replace(/[^\n]/g, ' ') + source.slice(front.end);
      }
    }
    const prose = source
      .split('\n')
      .map((line) => {
        const marker = /^ {0,3}(`{3,}|~{3,})/.exec(line)?.[1];
        if (marker) {
          if (!codeFence) codeFence = marker;
          else if (marker[0] === codeFence[0] && marker.length >= codeFence.length)
            codeFence = undefined;
          return ' '.repeat(line.length);
        }
        return codeFence
          ? ' '.repeat(line.length)
          : line.replace(/`[^`\n]*`/g, (m) => ' '.repeat(m.length));
      })
      .join('\n');
    for (const line of prose.split('\n')) {
      const heading = /^#{1,6}\s+(.{2,128})$/.exec(line)?.[1];
      if (heading) {
        const ev = evidence(heading, part, 'local');
        if (ev) addEntity(heading, 'concept', ev);
      }
    }
    const candidates = terms(prose),
      frequencies = new Map<string, { name: string; count: number }>();
    for (const name of candidates) {
      const key = normalize(name),
        n = frequencies.get(key);
      frequencies.set(key, { name: n?.name ?? name, count: (n?.count ?? 0) + 1 });
      const all = counts.get(key);
      counts.set(key, { name: all?.name ?? name, count: (all?.count ?? 0) + 1 });
    }
    const selected = [...frequencies.values()]
      .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name))
      .slice(0, 24);
    const selectedIds = new Map<string, string>();
    for (const { name } of selected) {
      const ev = evidence(name, part, 'local');
      if (ev) {
        const id = addEntity(name, 'concept', ev);
        if (id) selectedIds.set(normalize(name), id);
      }
    }
    for (const sentence of prose.split(/(?<=[.!?。！？])\s*|\n/).slice(0, 256)) {
      const quote = sentence.trim();
      if (!quote || quote.length > 4000) continue;
      const ev = evidence(quote, part, 'local');
      if (!ev) continue;
      const ids = [
        ...new Set(
          terms(quote)
            .map((t) => selectedIds.get(normalize(t)))
            .filter((v): v is string => !!v),
        ),
      ].slice(0, 8);
      for (let i = 0; i < ids.length; i++)
        for (let j = i + 1; j < ids.length; j++) {
          const pair = [ids[i], ids[j]].sort();
          addRelation(pair[0], pair[1], '共同出现', 0.45, 'local', ev);
        }
    }
  }
  function enhance(part: { text: string; line: number }, output: GraphExtraction, model: string) {
    if (output.entities.length > 80 || output.relations.length > 160) clipped = true;
    const byName = new Map<string, string>();
    for (const item of (output.entities ?? []).slice(0, 80)) {
      if (typeof item.name !== 'string' || typeof item.quote !== 'string') continue;
      const ev = evidence(item.quote, part, 'model', model);
      if (!ev) continue;
      const id = addEntity(item.name, item.kind, ev, item.description, item.aliases);
      if (id) byName.set(normalize(item.name), id);
    }
    for (const item of (output.relations ?? []).slice(0, 160)) {
      if (
        typeof item.source !== 'string' ||
        typeof item.target !== 'string' ||
        typeof item.predicate !== 'string' ||
        typeof item.quote !== 'string' ||
        !Number.isFinite(item.confidence) ||
        item.confidence < 0 ||
        item.confidence > 1
      )
        continue;
      const a = byName.get(normalize(item.source)),
        b = byName.get(normalize(item.target)),
        ev = evidence(item.quote, part, 'model', model);
      if (a && b && ev) addRelation(a, b, item.predicate, item.confidence, 'model', ev);
    }
  }
  let line = 1;
  for (const quote of referenceText.split('\n')) {
    if (quote.includes('[') && quote.length <= 2000) {
      for (const target of extractNoteLinks(quote, path)) {
        if (links.includes(target) && !linkEvidence[target]) {
          const ev = evidence(quote, { text: quote, line }, 'local');
          if (ev) linkEvidence[target] = [ev];
        }
      }
    }
    line++;
  }
  return {
    local,
    enhance,
    result(partial = false): Analysis {
      return {
        title,
        entities: [...entities.values()],
        relations: [...relations.values()],
        links,
        linkEvidence,
        terms: [...counts]
          .sort((a, b) => b[1].count - a[1].count)
          .slice(0, 64)
          .map(([key]) => key),
        partial: partial || clipped || text.length > 1024 * 1024,
      };
    },
  };
}
