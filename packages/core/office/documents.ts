import { createHash, randomUUID } from 'node:crypto';
import { HttpError } from '../errors.js';
import {
  listKnowledgeDataDirectories,
  readKnowledgeDataFile,
  statKnowledgeDataFile,
  writeKnowledgeDataFile,
} from '../knowledge-data.js';
import {
  maxOfficeFileBytes,
  officeFileName,
  validateOfficeFile,
  type OfficeFormat,
} from './formats.js';

// Existing libraries and Git history use this location for original files.
export const officeDirectory = 'apps/onlyoffice/documents';
const idPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const location = (id: string, file: string) => `${officeDirectory}/${id}/${file}`;
const originalLocation = (id: string, fileType: OfficeFormat) =>
  location(id, `document.${fileType}`);
export const officeDigest = (data: Buffer | string) =>
  createHash('sha256').update(data).digest('hex');

function item(root: string, id: string) {
  if (!idPattern.test(id)) return undefined;
  const metadata = readKnowledgeDataFile(root, location(id, 'metadata.json'), 4096);
  if (!metadata) return undefined;
  // Format 1 stored only a display name. Infer the file type for both legacy
  // Word documents and newer formats without migrating their original files.
  let file: ReturnType<typeof officeFileName>;
  try {
    const value = JSON.parse(metadata.toString('utf8'));
    if (value.format !== 1 || typeof value.name !== 'string') throw new Error('format');
    file = officeFileName(value.name);
  } catch {
    throw new HttpError(409, 'Office 文件的名称记录损坏');
  }
  const stat = statKnowledgeDataFile(root, originalLocation(id, file.fileType));
  if (stat) return { id, ...file, ...stat };
}

export function listOfficeDocuments(root: string) {
  return listKnowledgeDataDirectories(root, officeDirectory)
    .flatMap((id) => item(root, id) ?? [])
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.name.localeCompare(b.name));
}

export function addOfficeDocument(root: string, name: string, bytes: Buffer) {
  const file = officeFileName(name);
  validateOfficeFile(bytes, file.fileType);
  const id = randomUUID();
  writeKnowledgeDataFile(
    root,
    location(id, 'metadata.json'),
    JSON.stringify({ format: 1, name: file.name }) + '\n',
    null,
  );
  writeKnowledgeDataFile(root, originalLocation(id, file.fileType), bytes, null);
  return item(root, id)!;
}

export function readOfficeDocument(root: string, id: string) {
  const metadata = item(root, id);
  const bytes =
    metadata &&
    readKnowledgeDataFile(root, originalLocation(id, metadata.fileType), maxOfficeFileBytes);
  if (!metadata || !bytes) throw new HttpError(404, 'Office 文件不存在');
  return { metadata, bytes, digest: officeDigest(bytes) };
}

export function saveOfficeDocument(
  root: string,
  id: string,
  fileType: 'docx' | 'xlsx',
  bytes: Buffer,
  expectedDigest: string,
) {
  validateOfficeFile(bytes, fileType);
  writeKnowledgeDataFile(root, originalLocation(id, fileType), bytes, expectedDigest);
  return item(root, id)!;
}
