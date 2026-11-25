import { createHash, randomUUID } from 'node:crypto';
import type { AppDatabase } from '../db.js';
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

const directory = 'apps/onlyoffice/documents';
const idPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const location = (id: string, file: string) => `${directory}/${id}/${file}`;
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
  return listKnowledgeDataDirectories(root, directory)
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

function saveOfficeDocument(
  root: string,
  id: string,
  fileType: OfficeFormat,
  bytes: Buffer,
  expectedDigest: string,
) {
  writeKnowledgeDataFile(root, originalLocation(id, fileType), bytes, expectedDigest);
}

export type OfficeSessionRow = {
  key: string;
  digest: string;
  expires: number;
  closed: number;
  last_issued_at: number;
  pending_digest: string | null;
  pending_receipt: string | null;
  pending_status: number | null;
  pending_issued_at: number | null;
};

export function officeSessionStore(db: AppDatabase) {
  db.exec(`CREATE TABLE IF NOT EXISTS onlyoffice_sessions(
    root TEXT NOT NULL, document_id TEXT NOT NULL, key TEXT NOT NULL, digest TEXT NOT NULL,
    expires INTEGER NOT NULL, closed INTEGER NOT NULL DEFAULT 0, last_issued_at INTEGER NOT NULL DEFAULT 0,
    pending_digest TEXT, pending_receipt TEXT, pending_status INTEGER, pending_issued_at INTEGER,
    PRIMARY KEY(root, document_id));
    CREATE TABLE IF NOT EXISTS onlyoffice_receipts(key TEXT NOT NULL, receipt TEXT NOT NULL,
    expires INTEGER NOT NULL, PRIMARY KEY(key, receipt));`);
  const get = (root: string, id: string) =>
    db.prepare('SELECT * FROM onlyoffice_sessions WHERE root=? AND document_id=?').get(root, id) as
      | OfficeSessionRow
      | undefined;
  const clearPending = (key: string) =>
    db
      .prepare(
        `UPDATE onlyoffice_sessions SET pending_digest=NULL,
    pending_receipt=NULL,pending_status=NULL,pending_issued_at=NULL WHERE key=?`,
      )
      .run(key);
  const commit = db.transaction((row: OfficeSessionRow) => {
    db.prepare('INSERT OR IGNORE INTO onlyoffice_receipts VALUES(?,?,?)').run(
      row.key,
      row.pending_receipt,
      row.expires,
    );
    db.prepare(
      `UPDATE onlyoffice_sessions SET digest=?,closed=?,last_issued_at=max(last_issued_at,?)
      WHERE key=?`,
    ).run(row.pending_digest, row.pending_status === 2 ? 1 : 0, row.pending_issued_at, row.key);
    clearPending(row.key);
  });

  function current(root: string, id: string, digest: string) {
    const row = get(root, id);
    if (!row?.pending_digest) return row;
    if (row.pending_digest === digest) commit(row);
    else if (row.digest === digest) clearPending(row.key);
    return get(root, id);
  }

  return {
    current,
    begin(root: string, id: string, digest: string) {
      const now = Math.floor(Date.now() / 1000);
      const row = current(root, id, digest);
      if (row && !row.closed && row.digest === digest && row.expires > now) return row;
      const key = randomUUID();
      db.prepare('DELETE FROM onlyoffice_receipts WHERE expires<=?').run(now);
      db.prepare(
        `INSERT OR REPLACE INTO onlyoffice_sessions(root,document_id,key,digest,expires)
        VALUES(?,?,?,?,?)`,
      ).run(root, id, key, digest, now + 24 * 60 * 60);
      return get(root, id)!;
    },
    alreadySaved(key: string, receipt: string) {
      return !!db
        .prepare('SELECT 1 FROM onlyoffice_receipts WHERE key=? AND receipt=?')
        .get(key, receipt);
    },
    close(key: string) {
      db.prepare('UPDATE onlyoffice_sessions SET closed=1 WHERE key=?').run(key);
    },
    update(
      library: { path: string; identity: string },
      id: string,
      fileType: OfficeFormat,
      row: OfficeSessionRow,
      bytes: Buffer,
      receipt: string,
      status: number,
      issuedAt: number,
    ) {
      const next = officeDigest(bytes);
      db.prepare(
        `UPDATE onlyoffice_sessions SET pending_digest=?,pending_receipt=?,pending_status=?,
        pending_issued_at=? WHERE key=?`,
      ).run(next, receipt, status, issuedAt, row.key);
      if (next !== row.digest) saveOfficeDocument(library.path, id, fileType, bytes, row.digest);
      commit(get(library.identity, id)!);
    },
  };
}
