import { crc32, inflateRawSync } from 'node:zlib';
import { HttpError } from '../errors.js';

const packages = {
  docx: 'word/document.xml',
  xlsx: 'xl/workbook.xml',
  pptx: 'ppt/presentation.xml',
} as const;

export const officeFormats = {
  docx: {
    documentType: 'word',
    mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  },
  xlsx: {
    documentType: 'cell',
    mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  },
  pptx: {
    documentType: 'slide',
    mime: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  },
  pdf: { documentType: 'pdf', mime: 'application/pdf' },
} as const;

export type OfficeFormat = keyof typeof officeFormats;
export const maxOfficeFileBytes = 10 * 1024 * 1024;

export function officeFileName(value: string) {
  const name = value.normalize('NFC').trim();
  const suffix = /^[^\p{Cc}\\/]+\.(docx|xlsx|pptx|pdf)$/iu.exec(name)?.[1]?.toLowerCase();
  if (Buffer.byteLength(name) > 240 || !suffix)
    throw new HttpError(400, '请选择有效的 .docx、.xlsx、.pptx 或 .pdf 文件');
  return { name, fileType: suffix as OfficeFormat };
}

function validPdf(bytes: Buffer) {
  if (!/^%PDF-(?:1\.[0-7]|2\.0)[\r\n]/.test(bytes.subarray(0, 10).toString('latin1'))) return false;
  // A complete PDF has a final cross-reference offset and EOF marker. The
  // editor handles its internal object stream and cross-reference structure.
  const tail = bytes.subarray(Math.max(0, bytes.length - 1024)).toString('latin1');
  const xref = /(?:^|[\r\n])startxref[\t \r\n]+(\d{1,10})[\t \r\n]+%%EOF[\x00\t\n\f\r ]*$/.exec(
    tail,
  )?.[1];
  return xref !== undefined && Number(xref) > 0 && Number(xref) < bytes.length;
}

type PackagePart = {
  offset: number;
  compressed: number;
  expanded: number;
  method: number;
  checksum: number;
};

function packageParts(bytes: Buffer, fileType: Exclude<OfficeFormat, 'pdf'>) {
  if (bytes.length < 22 || bytes.readUInt32LE(0) !== 0x04034b50) return;

  // Read archive directory metadata only. The app never expands or runs the document.
  let end = bytes.length - 22;
  const minimumEnd = Math.max(0, end - 0xffff);
  while (
    end >= minimumEnd &&
    (bytes.readUInt32LE(end) !== 0x06054b50 ||
      end + 22 + bytes.readUInt16LE(end + 20) !== bytes.length)
  )
    end--;
  if (end < minimumEnd || bytes.readUInt32LE(end + 4) !== 0) return;
  const entries = bytes.readUInt16LE(end + 10);
  const start = bytes.readUInt32LE(end + 16);
  if (
    entries < 2 ||
    entries > 4096 ||
    bytes.readUInt16LE(end + 8) !== entries ||
    start + bytes.readUInt32LE(end + 12) !== end
  )
    return;
  let offset = start;
  let expanded = 0;
  const parts = new Map<string, PackagePart>();
  for (let index = 0; index < entries; index++) {
    if (offset + 46 > end || bytes.readUInt32LE(offset) !== 0x02014b50) return;
    const flags = bytes.readUInt16LE(offset + 8);
    const length = bytes.readUInt16LE(offset + 28);
    const next =
      offset + 46 + length + bytes.readUInt16LE(offset + 30) + bytes.readUInt16LE(offset + 32);
    if (next > end || !length || flags & 1 || bytes.readUInt16LE(offset + 34)) return;
    const expandedSize = bytes.readUInt32LE(offset + 24);
    const compressedSize = bytes.readUInt32LE(offset + 20);
    expanded += expandedSize;
    if (expanded > 128 * 1024 * 1024) return;
    const local = bytes.readUInt32LE(offset + 42);
    if (local + 30 > start || bytes.readUInt32LE(local) !== 0x04034b50) return;
    const dataOffset = local + 30 + length + bytes.readUInt16LE(local + 28);
    const nameBytes = bytes.subarray(offset + 46, offset + 46 + length);
    const compression = bytes.readUInt16LE(offset + 10);
    if (
      bytes.readUInt16LE(local + 26) !== length ||
      bytes.readUInt16LE(local + 8) !== compression ||
      (compression !== 0 && compression !== 8) ||
      dataOffset + compressedSize > start ||
      !nameBytes.equals(bytes.subarray(local + 30, local + 30 + length))
    )
      return;
    const name = nameBytes.toString('utf8');
    if (
      name.startsWith('/') ||
      /[\\:\x00]/.test(name) ||
      name.split('/').includes('..') ||
      parts.has(name) ||
      /(?:^|\/)vbaProject\.bin$/i.test(name)
    )
      return;
    parts.set(name, {
      offset: dataOffset,
      compressed: compressedSize,
      expanded: expandedSize,
      method: compression,
      checksum: bytes.readUInt32LE(offset + 16),
    });
    offset = next;
  }
  if (
    offset === end &&
    parts.has('[Content_Types].xml') &&
    parts.has(packages[fileType]) &&
    Object.values(packages).every((part) => part === packages[fileType] || !parts.has(part))
  )
    return parts;
}

export function validateOfficeFile(bytes: Buffer, fileType: OfficeFormat) {
  if (bytes.length > maxOfficeFileBytes) throw new HttpError(413, '文件不能超过 10 MiB');
  const valid = fileType === 'pdf' ? validPdf(bytes) : !!packageParts(bytes, fileType);
  if (!valid) throw new HttpError(400, `文件不是受支持的 .${fileType} 文档`);
}

export function readOfficePackage(bytes: Buffer, fileType: Exclude<OfficeFormat, 'pdf'>) {
  if (bytes.length > maxOfficeFileBytes) throw new HttpError(413, '文件不能超过 10 MiB');
  const parts = packageParts(bytes, fileType);
  if (!parts) throw new HttpError(400, `文件不是受支持的 .${fileType} 文档`);
  let consumed = 0;
  return (name: string) => {
    const part = parts.get(name);
    if (!part) return undefined;
    consumed += part.expanded;
    if (part.expanded > 12 * 1024 * 1024 || consumed > 32 * 1024 * 1024)
      throw new HttpError(422, '文档正文超过提取大小上限');
    try {
      const compressed = bytes.subarray(part.offset, part.offset + part.compressed);
      const value =
        part.method === 8
          ? inflateRawSync(compressed, { maxOutputLength: Math.max(1, part.expanded) })
          : compressed;
      if (value.byteLength !== part.expanded || crc32(value) !== part.checksum)
        throw new Error('invalid archive member');
      return value;
    } catch {
      throw new HttpError(422, '无法读取 Office 文档内部文件');
    }
  };
}
