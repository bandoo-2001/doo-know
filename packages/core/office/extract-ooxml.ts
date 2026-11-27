import { posix } from 'node:path';
import { SaxesParser, type SaxesTagNS } from 'saxes';
import { HttpError } from '../errors.js';
import { readOfficePackage, type OfficeFormat } from './formats.js';

export type OfficeTextSegment = { heading: string; text: string };
type PackageReader = ReturnType<typeof readOfficePackage>;
type XmlNode = (tag: SaxesTagNS, stack: SaxesTagNS[]) => void;
type XmlHandlers = {
  open?: XmlNode;
  close?: XmlNode;
  text?: (value: string, stack: SaxesTagNS[]) => void;
};

const namespaces = {
  word: [
    'http://schemas.openxmlformats.org/wordprocessingml/2006/main',
    'http://purl.oclc.org/ooxml/wordprocessingml/main',
  ],
  cell: [
    'http://schemas.openxmlformats.org/spreadsheetml/2006/main',
    'http://purl.oclc.org/ooxml/spreadsheetml/main',
  ],
  slide: [
    'http://schemas.openxmlformats.org/presentationml/2006/main',
    'http://purl.oclc.org/ooxml/presentationml/main',
  ],
  drawing: [
    'http://schemas.openxmlformats.org/drawingml/2006/main',
    'http://purl.oclc.org/ooxml/drawingml/main',
  ],
  relation: [
    'http://schemas.openxmlformats.org/officeDocument/2006/relationships',
    'http://purl.oclc.org/ooxml/officeDocument/relationships',
  ],
};

function tagIs(tag: SaxesTagNS | undefined, family: keyof typeof namespaces, name: string) {
  return tag?.local === name && namespaces[family].includes(tag.uri);
}

function relationId(tag: SaxesTagNS) {
  return Object.values(tag.attributes).find(
    ({ local, uri }) => local === 'id' && namespaces.relation.includes(uri),
  )?.value;
}

function attribute(tag: SaxesTagNS, name: string) {
  return tag.attributes[name]?.value;
}

function wordAttribute(tag: SaxesTagNS, name: string) {
  return Object.values(tag.attributes).find(
    ({ local, uri }) => local === name && namespaces.word.includes(uri),
  )?.value;
}

function scanXml(read: PackageReader, path: string, handlers: XmlHandlers, required = true) {
  const bytes = read(path);
  if (!bytes) {
    if (required) throw new HttpError(422, 'Office 文档缺少正文部件');
    return;
  }
  const parser = new SaxesParser({ xmlns: true });
  const stack: SaxesTagNS[] = [];
  let nodes = 0;
  parser.on('doctype', () => {
    throw new HttpError(422, 'Office 文档包含不支持的 XML 声明');
  });
  parser.on('opentag', (tag) => {
    if (++nodes > 600_000 || stack.length > 128)
      throw new HttpError(422, 'Office 文档结构超过提取上限');
    stack.push(tag);
    handlers.open?.(tag, stack);
  });
  parser.on('closetag', (tag) => {
    handlers.close?.(tag, stack);
    stack.pop();
  });
  const onText = (value: string) => handlers.text?.(value, stack);
  parser.on('text', onText);
  parser.on('cdata', onText);
  try {
    const codec =
      bytes[0] === 0xff && bytes[1] === 0xfe
        ? 'utf-16le'
        : bytes[0] === 0xfe && bytes[1] === 0xff
          ? 'utf-16be'
          : 'utf-8';
    parser.write(new TextDecoder(codec, { fatal: true }).decode(bytes)).close();
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw new HttpError(422, 'Office 文档正文 XML 损坏');
  }
}

function relationships(read: PackageReader, owner: string) {
  const result = new Map<string, { path: string; type: string }>();
  const base = posix.dirname(owner);
  const rels = posix.join(base, '_rels', `${posix.basename(owner)}.rels`);
  scanXml(
    read,
    rels,
    {
      open(tag) {
        if (
          tag.local !== 'Relationship' ||
          attribute(tag, 'TargetMode')?.toLowerCase() === 'external'
        )
          return;
        const id = attribute(tag, 'Id');
        const target = attribute(tag, 'Target');
        const type = attribute(tag, 'Type')?.split('/').at(-1);
        if (!id || !target || !type || target.startsWith('//') || /%2f|%5c/i.test(target)) return;
        let decoded: string;
        try {
          decoded = decodeURIComponent(target);
        } catch {
          return;
        }
        if (/[\\:\u0000?#]/u.test(decoded) || decoded.startsWith('//')) return;
        const path = posix.normalize(
          decoded.startsWith('/') ? decoded.slice(1) : posix.join(base, decoded),
        );
        if (!path || path === '..' || path.startsWith('../') || result.has(id)) return;
        result.set(id, { path, type });
      },
    },
    false,
  );
  return result;
}

function segmentCollector() {
  const segments: OfficeTextSegment[] = [];
  let length = 0;
  return {
    segments,
    add(heading: string, text: string) {
      text = text.trim();
      if (!text) return;
      heading = heading.replace(/\s+/g, ' ').trim().slice(0, 240);
      length += text.length + heading.length;
      if (length > 1_000_000 || segments.length >= 512)
        throw new HttpError(422, 'Office 文档正文超过索引上限');
      segments.push({ heading, text });
    },
  };
}

function wordText(read: PackageReader) {
  const collector = segmentCollector();
  const paragraphs: { parts: string[]; heading: boolean }[] = [];
  let currentHeading = '正文';
  let explicitHeading = false;
  let lines: string[] = [];
  function flush() {
    collector.add(
      currentHeading,
      lines.length ? lines.join('\n') : explicitHeading ? currentHeading : '',
    );
    lines = [];
  }
  scanXml(read, 'word/document.xml', {
    open(tag, stack) {
      if (tagIs(tag, 'word', 'p')) {
        paragraphs.push({ parts: [], heading: false });
        return;
      }
      const current = paragraphs.at(-1);
      if (!current) return;
      if (tagIs(tag, 'word', 'pStyle') && tagIs(stack.at(-2), 'word', 'pPr')) {
        current.heading ||= /^(?:heading\s*[1-9]|title|标题\s*[1-9一二三四五六七八九])$/i.test(
          wordAttribute(tag, 'val') ?? '',
        );
      } else if (tagIs(tag, 'word', 'outlineLvl') && tagIs(stack.at(-2), 'word', 'pPr')) {
        current.heading ||= /^[0-8]$/.test(wordAttribute(tag, 'val') ?? '');
      } else if (tagIs(tag, 'word', 'br') || tagIs(tag, 'word', 'cr')) current.parts.push('\n');
      else if (tagIs(tag, 'word', 'tab')) current.parts.push('\t');
    },
    text(value, stack) {
      if (tagIs(stack.at(-1), 'word', 't')) paragraphs.at(-1)?.parts.push(value);
    },
    close(tag) {
      if (!tagIs(tag, 'word', 'p')) return;
      const current = paragraphs.pop();
      const text = current?.parts.join('').trim();
      if (!text) return;
      if (current?.heading) {
        flush();
        currentHeading = text;
        explicitHeading = true;
      } else lines.push(text);
    },
  });
  flush();
  return collector.segments;
}

function sharedStrings(read: PackageReader, path: string) {
  const strings: string[] = [];
  let current: string[] | undefined;
  scanXml(read, path, {
    open(tag) {
      if (tagIs(tag, 'cell', 'si')) current = [];
    },
    text(value, stack) {
      if (tagIs(stack.at(-1), 'cell', 't') && !stack.some((tag) => tagIs(tag, 'cell', 'rPh')))
        current?.push(value);
    },
    close(tag) {
      if (!tagIs(tag, 'cell', 'si') || !current) return;
      strings.push(current.join(''));
      current = undefined;
    },
  });
  return strings;
}

function worksheetText(read: PackageReader, path: string, strings: string[]) {
  let cell:
    | { address: string; type: string; value: string; formula: string; inline: string }
    | undefined;
  let row: string[] = [];
  const lines: string[] = [];
  let length = 0;
  scanXml(read, path, {
    open(tag) {
      if (tagIs(tag, 'cell', 'c'))
        cell = {
          address: attribute(tag, 'r') ?? '',
          type: attribute(tag, 't') ?? '',
          value: '',
          formula: '',
          inline: '',
        };
    },
    text(value, stack) {
      if (!cell) return;
      const current = stack.at(-1);
      if (tagIs(current, 'cell', 'f')) cell.formula += value;
      else if (tagIs(current, 'cell', 'v')) cell.value += value;
      else if (tagIs(current, 'cell', 't') && !stack.some((tag) => tagIs(tag, 'cell', 'rPh')))
        cell.inline += value;
    },
    close(tag) {
      if (tagIs(tag, 'cell', 'row')) {
        if (row.length) lines.push(row.join(' | '));
        row = [];
      } else if (tagIs(tag, 'cell', 'c') && cell) {
        const { type, formula, address, inline } = cell;
        let { value } = cell;
        if (type === 's') value = /^\d+$/.test(value) ? (strings[Number(value)] ?? '') : '';
        else if (type === 'inlineStr') value = inline;
        else if (type === 'b') value = value === '1' ? 'TRUE' : value === '0' ? 'FALSE' : value;
        const display = formula ? `=${formula}${value ? ` → ${value}` : ''}` : value;
        if (display.trim()) {
          const formatted = `${address ? `${address}: ` : ''}${display.replace(/\s*\r?\n\s*/g, ' ')}`;
          length += formatted.length + 3;
          if (length > 1_000_000) throw new HttpError(422, '工作表正文超过索引上限');
          row.push(formatted);
        }
        cell = undefined;
      }
    },
  });
  return lines.join('\n');
}

function workbookText(read: PackageReader) {
  const main = 'xl/workbook.xml';
  const rels = relationships(read, main);
  const stringsPath = [...rels.values()].find((part) => part.type === 'sharedStrings')?.path;
  const strings = stringsPath ? sharedStrings(read, stringsPath) : [];
  const collector = segmentCollector();
  const sheets: { name: string; path: string }[] = [];
  scanXml(read, main, {
    open(tag, stack) {
      if (!tagIs(tag, 'cell', 'sheet') || !tagIs(stack.at(-2), 'cell', 'sheets')) return;
      const id = relationId(tag);
      const part = id && rels.get(id);
      if (part && part.type === 'worksheet')
        sheets.push({ name: attribute(tag, 'name') ?? '工作表', path: part.path });
    },
  });
  for (const { name, path } of sheets) collector.add(name, worksheetText(read, path, strings));
  return collector.segments;
}

function slideText(read: PackageReader, path: string, notes = false) {
  const paragraphs: string[] = [];
  let shape: { depth: number; body: boolean } | undefined;
  let text: string[] = [];
  scanXml(read, path, {
    open(tag, stack) {
      if (notes && tagIs(tag, 'slide', 'sp')) shape = { depth: stack.length, body: false };
      if (notes && shape && tagIs(tag, 'slide', 'ph') && attribute(tag, 'type') === 'body')
        shape.body = true;
      if (tagIs(tag, 'drawing', 'p')) text = [];
      if (tagIs(tag, 'drawing', 'br')) text.push('\n');
    },
    text(value, stack) {
      if (tagIs(stack.at(-1), 'drawing', 't')) text.push(value);
    },
    close(tag, stack) {
      if (notes && shape?.depth === stack.length) shape = undefined;
      if (tagIs(tag, 'drawing', 'p') && (!notes || shape?.body)) {
        const line = text.join('').trim();
        if (line) paragraphs.push(line);
      }
    },
  });
  return paragraphs.join('\n');
}

function presentationText(read: PackageReader) {
  const main = 'ppt/presentation.xml';
  const rels = relationships(read, main);
  const collector = segmentCollector();
  const slides: (string | undefined)[] = [];
  scanXml(read, main, {
    open(tag, stack) {
      if (!tagIs(tag, 'slide', 'sldId') || !tagIs(stack.at(-2), 'slide', 'sldIdLst')) return;
      const id = relationId(tag);
      const part = id && rels.get(id);
      slides.push(part && part.type === 'slide' ? part.path : undefined);
    },
  });
  for (const [index, path] of slides.entries()) {
    if (!path) continue;
    const body = slideText(read, path);
    const notesPath = [...relationships(read, path).values()].find(
      (part) => part.type === 'notesSlide',
    )?.path;
    const notes = notesPath && slideText(read, notesPath, true);
    collector.add(`幻灯片 ${index + 1}`, notes ? `${body}\n\n讲者备注\n${notes}` : body);
  }
  return collector.segments;
}

export function extractOoxmlText(bytes: Buffer, fileType: Exclude<OfficeFormat, 'pdf'>) {
  const read = readOfficePackage(bytes, fileType);
  if (fileType === 'docx') return wordText(read);
  if (fileType === 'xlsx') return workbookText(read);
  return presentationText(read);
}
