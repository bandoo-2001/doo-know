import type { OfficeDocument } from '../../../shared/office.js';
import { scanFiles } from '../files.js';
import {
  notebookOfficeItems,
  notebookOfficePaths,
  officeDigest,
  readNotebookOffice,
  saveNotebookOffice,
} from './notebook-files.js';
export { addNotebookOffice as addOfficeDocument, officeDigest } from './notebook-files.js';
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
export const officeIdPattern =
  /^(?:file-[0-9a-f]{64}|[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/;

function legacyItem(root: string, id: string): OfficeDocument | undefined {
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

function legacyIds(root: string) {
  return listKnowledgeDataDirectories(root, officeDirectory).filter((id) => idPattern.test(id));
}

export function listOfficeIds(root: string) {
  return [...notebookOfficePaths(root, scanFiles(root, true).office).keys(), ...legacyIds(root)];
}

export function listOfficeDocuments(root: string, paths = scanFiles(root, true).office) {
  const items = notebookOfficeItems(root, paths);
  for (const id of legacyIds(root)) {
    try {
      const item = legacyItem(root, id);
      if (item) items.push(item);
    } catch (error) {
      // A damaged legacy upload should not hide the rest of the notebook tree.
      if (!(error instanceof HttpError) || error.statusCode !== 409) throw error;
    }
  }
  return items.sort(
    (a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.name.localeCompare(b.name),
  );
}

export function readOfficeDocument(root: string, id: string, refreshMissing = true) {
  if (id.startsWith('file-')) return readNotebookOffice(root, id, refreshMissing);
  const metadata = legacyItem(root, id);
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
  if (id.startsWith('file-')) return saveNotebookOffice(root, id, bytes, expectedDigest);
  writeKnowledgeDataFile(root, originalLocation(id, fileType), bytes, expectedDigest);
  return legacyItem(root, id)!;
}
