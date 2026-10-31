import { openSync, closeSync, readSync, fstatSync, constants } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync, readFileSync, rmSync, lstatSync } from 'node:fs';
import { join } from 'node:path';
import type { AppConfig } from '../../../shared/contracts.js';
import type { Principal } from '../../../shared/knowledge-contracts.js';
import { portableResourceLimits } from '../../../shared/portable-resource-limits.js';
import { serializeDiagramRenderInput } from '../../../shared/diagram-document-binding.js';
import type { AppDatabase } from '../db.js';
import { authorizePath, requireScope } from '../agent/auth.js';
import { safePath } from '../files.js';
import { assetStamp, hashAssetSync } from '../asset-stream.js';
import { sha256 } from '../knowledge/operations.js';
import { assertRoot } from '../indexing/reconcile.js';
import { assertOrganizationReadable } from '../workspace/gate.js';
import { validatePng } from '../knowledge/diagram-artifacts.js';
import { fail } from '../knowledge/errors.js';
import type { PortablePreviewNeed } from '../../../shared/portable-delivery-contracts.js';
export type { PortablePreviewNeed } from '../../../shared/portable-delivery-contracts.js';
export type PortablePreviewInput = {
  direction: 'export' | 'import';
  requestId: string;
  contextHash: string;
  document: string;
  role: 'primary' | 'embedded';
  source: string;
  type: 'whiteboard';
  title: string;
  renderer: string;
  config: Record<string, unknown>;
  permissions: string[];
  proofs: { path: string; hash: string; noteId?: string; stamp?: string }[];
  key?: string;
};
type Row = {
  id: string;
  principal: string;
  client: string;
  workspace: string;
  fingerprint: string;
  input: string;
  source_hash: string;
  render_hash: string;
  stage: string;
  expires: number;
  preview_hash: string | null;
  prepare_request: string | null;
};
const verifiedSources = new WeakMap<AppDatabase, Map<string, string>>();
/** Private portable receipts are deliberately independent of active-document preparations.
 * Export needs read authority only. Import sources are incoming bytes, never active UUIDs. */
export function portablePreviewRegistry(config: AppConfig, db: AppDatabase) {
  assertRoot(config, db);
  db.exec(
    `CREATE TABLE IF NOT EXISTS portable_native_previews(id TEXT PRIMARY KEY,principal TEXT NOT NULL,client TEXT NOT NULL,workspace TEXT NOT NULL,fingerprint TEXT NOT NULL,input TEXT NOT NULL,source_hash TEXT NOT NULL,render_hash TEXT NOT NULL,stage TEXT NOT NULL,expires INTEGER NOT NULL,preview_hash TEXT,prepare_request TEXT,UNIQUE(principal,client,workspace,fingerprint));CREATE TABLE IF NOT EXISTS portable_staging_runs(id TEXT PRIMARY KEY,bytes INTEGER NOT NULL,expires INTEGER NOT NULL);`,
  );
  let verified = verifiedSources.get(db);
  if (!verified) verifiedSources.set(db, (verified = new Map()));
  const workspace = () =>
    sha256(
      config.knowledgeRoot +
        '\0' +
        ((db.prepare("SELECT value FROM index_meta WHERE key='root_identity'").get() as any)
          ?.value ?? ''),
    );
  const directory = (stage: string) => join(config.dataRoot, 'portable-staging', stage);
  function reserve(row: Pick<Row, 'stage' | 'expires'>, bytes: number) {
    db.transaction(() => {
      const stages = (
        db
          .prepare('SELECT coalesce(sum(bytes),0) n FROM portable_staging_runs WHERE id<>?')
          .get(row.stage) as any
      ).n;
      const deliveries = db
        .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='portable_deliveries'")
        .get()
        ? (db.prepare('SELECT coalesce(sum(bytes),0) n FROM portable_deliveries').get() as any).n
        : 0;
      if (stages + deliveries + bytes > portableResourceLimits.stagedBytes)
        fail(413, 'PORTABLE_STAGING_QUOTA_EXCEEDED');
      db.prepare(
        'INSERT INTO portable_staging_runs VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET bytes=excluded.bytes,expires=excluded.expires',
      ).run(row.stage, bytes, row.expires);
    }).immediate();
  }
  function authorize(p: Principal, row: Row) {
    assertRoot(config, db);
    assertOrganizationReadable(db);
    if (row.principal !== p.id || row.client !== p.clientId || row.workspace !== workspace())
      fail(404, 'PORTABLE_PREVIEW_NOT_FOUND');
    if (row.expires <= Date.now()) fail(409, 'PORTABLE_PREVIEW_EXPIRED');
    const input = JSON.parse(row.input) as Omit<PortablePreviewInput, 'source'>;
    requireScope(p, input.direction === 'export' ? 'knowledge:read' : 'knowledge:write');
    for (const path of input.permissions)
      authorizePath(p, path, input.direction === 'export' ? 'knowledge:read' : 'knowledge:write');
    for (const proof of input.proofs) {
      if (proof.noteId) {
        const current = db
          .prepare('SELECT path FROM notes WHERE id=? AND active=1')
          .get(proof.noteId) as any;
        if (current?.path !== proof.path) fail(409, 'PORTABLE_VERSION_CONFLICT');
      }
      try {
        const path = safePath(config.knowledgeRoot, proof.path, proof.noteId ? 'note' : 'asset');
        if (proof.stamp ? assetStamp(path) !== proof.stamp : hashAssetSync(path) !== proof.hash)
          fail(409, 'PORTABLE_VERSION_CONFLICT');
      } catch {
        fail(409, 'PORTABLE_VERSION_CONFLICT');
      }
    }
    return input;
  }
  function own(p: Principal, id: string) {
    const row = db.prepare('SELECT * FROM portable_native_previews WHERE id=?').get(id) as
      | Row
      | undefined;
    if (!row) fail(404, 'PORTABLE_PREVIEW_NOT_FOUND');
    authorize(p, row);
    return row;
  }
  function describeRow(row: Row): PortablePreviewNeed {
    const input = JSON.parse(row.input) as PortablePreviewInput;
    return {
      previewId: row.id,
      document: input.document,
      role: input.role,
      sourceHash: row.source_hash,
      renderHash: row.render_hash,
      type: input.type,
      title: input.title,
      renderer: input.renderer,
      config: input.config,
      expiresAt: row.expires,
      direction: input.direction,
      sourceBytes: lstatSync(join(directory(row.stage), 'source.excalidraw')).size,
    };
  }
  function fix(p: Principal, input: PortablePreviewInput) {
    for (const expired of db
      .prepare('SELECT stage FROM portable_native_previews WHERE expires<=?')
      .all(Date.now()) as { stage: string }[]) {
      rmSync(directory(expired.stage), { recursive: true, force: true });
      db.prepare('DELETE FROM portable_staging_runs WHERE id=?').run(expired.stage);
    }

    if (Buffer.byteLength(input.source) > 10 * 1024 ** 2) fail(413, 'DIAGRAM_SOURCE_TOO_LARGE');
    const sourceHash = sha256(input.source),
      renderHash = sha256(serializeDiagramRenderInput({ ...input, sourceHash })),
      { source, ...metadata } = input,
      fingerprint = sha256(JSON.stringify({ ...metadata, sourceHash, renderHash }));
    let row = db
      .prepare(
        'SELECT * FROM portable_native_previews WHERE principal=? AND client=? AND workspace=? AND fingerprint=?',
      )
      .get(p.id, p.clientId, workspace(), fingerprint) as Row | undefined;
    if (row?.expires && row.expires <= Date.now()) {
      rmSync(directory(row.stage), { recursive: true, force: true });
      db.prepare('DELETE FROM portable_staging_runs WHERE id=?').run(row.stage);
      db.prepare('DELETE FROM portable_native_previews WHERE id=?').run(row.id);
      row = undefined;
    }
    if (!row) {
      row = {
        id: randomUUID(),
        principal: p.id,
        client: p.clientId,
        workspace: workspace(),
        fingerprint,
        input: JSON.stringify(metadata),
        source_hash: sourceHash,
        render_hash: renderHash,
        stage: randomUUID(),
        expires: Date.now() + 3600000,
        preview_hash: null,
        prepare_request: null,
      };
      authorize(p, row);
      reserve(row, Buffer.byteLength(source));
      try {
        mkdirSync(directory(row.stage), { recursive: true, mode: 0o700 });
        writeFileSync(join(directory(row.stage), 'source.excalidraw'), source, {
          flag: 'wx',
          mode: 0o600,
        });
        db.prepare('INSERT INTO portable_native_previews VALUES(?,?,?,?,?,?,?,?,?,?,?,?)').run(
          row.id,
          row.principal,
          row.client,
          row.workspace,
          row.fingerprint,
          row.input,
          row.source_hash,
          row.render_hash,
          row.stage,
          row.expires,
          null,
          null,
        );
      } catch (error) {
        rmSync(directory(row.stage), { recursive: true, force: true });
        db.prepare('DELETE FROM portable_staging_runs WHERE id=?').run(row.stage);
        throw error;
      }
    }
    authorize(p, row);
    return describeRow(row);
  }
  function verifiedSource(row: Row) {
    const path = join(directory(row.stage), 'source.excalidraw'),
      before = assetStamp(path),
      key = row.id + ':' + row.source_hash;
    if (lstatSync(path).size > 10 * 1024 ** 2) fail(409, 'PORTABLE_VERSION_CONFLICT');
    const saved = verified!.get(key);
    if (saved) {
      if (saved !== before) fail(409, 'PORTABLE_VERSION_CONFLICT');
    } else {
      if (hashAssetSync(path) !== row.source_hash || assetStamp(path) !== before)
        fail(409, 'PORTABLE_VERSION_CONFLICT');
      verified!.set(key, before);
      if (verified!.size > 256) verified!.delete(verified!.keys().next().value!);
    }
    return before;
  }
  function privateBytes(row: Row, name: string, max: number) {
    const path = join(directory(row.stage), name),
      before = assetStamp(path),
      fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const stat = fstatSync(fd);
      if (!stat.isFile() || stat.nlink !== 1 || stat.size > max)
        fail(409, 'PORTABLE_VERSION_CONFLICT');
      const bytes = readFileSync(fd);
      if (assetStamp(path) !== before) fail(409, 'PORTABLE_VERSION_CONFLICT');
      return bytes;
    } finally {
      closeSync(fd);
    }
  }
  function get(p: Principal, input: { previewId: string } | string) {
    const row = own(p, typeof input === 'string' ? input : input.previewId),
      source = privateBytes(row, 'source.excalidraw', 10 * 1024 ** 2).toString('utf8');
    if (sha256(source) !== row.source_hash) fail(409, 'PORTABLE_VERSION_CONFLICT');
    return { ...describeRow(row), source };
  }
  function prepared(p: Principal, id: string) {
    const row = own(p, id);
    if (!row.preview_hash) return;
    let png: Buffer;
    try {
      png = privateBytes(row, 'preview.png', 10 * 1024 ** 2);
    } catch (error) {
      if ((error as any).code === 'ENOENT') return;
      throw error;
    }
    const source = get(p, id).source;
    if (sha256(png) !== row.preview_hash) fail(409, 'PORTABLE_VERSION_CONFLICT');
    return {
      source,
      png,
      sourceHash: row.source_hash,
      renderHash: row.render_hash,
      previewHash: row.preview_hash,
    };
  }
  function prepare(
    p: Principal,
    input: { previewId: string; sourceHash: string; pngBase64: string; requestId: string },
  ) {
    const row = own(p, input.previewId);
    if (input.sourceHash !== row.source_hash) fail(409, 'DIAGRAM_SOURCE_HASH_MISMATCH');
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(input.requestId)) fail(400, 'INVALID_REQUEST_ID');
    if (input.pngBase64.length > Math.ceil((10 * 1024 ** 2) / 3) * 4)
      fail(413, 'DIAGRAM_PREVIEW_TOO_LARGE');
    const png = Buffer.from(input.pngBase64, 'base64');
    if (png.toString('base64') !== input.pngBase64) fail(400, 'INVALID_DIAGRAM_PNG');
    validatePng(png);
    const hash = sha256(png);
    if (row.preview_hash && (row.preview_hash !== hash || row.prepare_request !== input.requestId))
      fail(409, 'REQUEST_ID_CONFLICT');
    const source = get(p, row.id).source,
      path = join(directory(row.stage), 'preview.png');
    reserve(row, Buffer.byteLength(source) + png.length);
    // The intended tuple is durable before exclusive publication; either crash side is replayable.
    db.prepare(
      'UPDATE portable_native_previews SET preview_hash=?,prepare_request=? WHERE id=?',
    ).run(hash, input.requestId, row.id);
    try {
      writeFileSync(path, png, { flag: 'wx', mode: 0o600 });
    } catch (error) {
      if ((error as any).code !== 'EEXIST') throw error;
      if (sha256(privateBytes(row, 'preview.png', 10 * 1024 ** 2)) !== hash)
        fail(409, 'DIAGRAM_ARTIFACT_CONFLICT');
    }
    return describeRow({ ...row, preview_hash: hash });
  }
  function cancel(p: Principal, id: string) {
    const row = db.prepare('SELECT * FROM portable_native_previews WHERE id=?').get(id) as
      | Row
      | undefined;
    if (
      !row ||
      row.principal !== p.id ||
      row.client !== p.clientId ||
      row.workspace !== workspace()
    )
      fail(404, 'PORTABLE_PREVIEW_NOT_FOUND');
    rmSync(directory(row.stage), { recursive: true, force: true });
    db.prepare('DELETE FROM portable_staging_runs WHERE id=?').run(row.stage);
    db.prepare('DELETE FROM portable_native_previews WHERE id=?').run(id);
    return { cancelled: true };
  }
  function readSource(p: Principal, id: string, input: { offset: number; maxBytes?: number }) {
    const row = own(p, id),
      path = join(directory(row.stage), 'source.excalidraw'),
      maximum = input.maxBytes ?? 8192;
    if (
      !Number.isSafeInteger(input.offset) ||
      input.offset < 0 ||
      !Number.isSafeInteger(maximum) ||
      maximum < 1 ||
      maximum > 16384
    )
      fail(400, 'INVALID_SOURCE_READ_BUDGET');
    const before = verifiedSource(row);
    const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const stat = fstatSync(fd);
      if (
        !stat.isFile() ||
        stat.nlink !== 1 ||
        input.offset > stat.size ||
        stat.size > 10 * 1024 ** 2
      )
        fail(409, 'PORTABLE_VERSION_CONFLICT');
      const count = Math.min(maximum, stat.size - input.offset),
        bytes = Buffer.alloc(count);
      if (readSync(fd, bytes, 0, count, input.offset) !== count || assetStamp(path) !== before)
        fail(409, 'PORTABLE_VERSION_CONFLICT');
      return {
        id,
        sourceHash: row.source_hash,
        offset: input.offset,
        nextOffset: input.offset + count,
        totalBytes: stat.size,
        encoding: 'base64' as const,
        content: bytes.toString('base64'),
        eof: input.offset + count === stat.size,
      };
    } finally {
      closeSync(fd);
    }
  }
  function list(p: Principal, input: { requestId: string; direction: 'export' | 'import' }) {
    assertRoot(config, db);
    assertOrganizationReadable(db);
    requireScope(p, input.direction === 'export' ? 'knowledge:read' : 'knowledge:write');
    const rows = db
      .prepare(
        "SELECT * FROM portable_native_previews WHERE principal=? AND client=? AND workspace=? AND json_extract(input,'$.requestId')=? AND json_extract(input,'$.direction')=? AND expires>? ORDER BY id",
      )
      .all(p.id, p.clientId, workspace(), input.requestId, input.direction, Date.now()) as Row[];
    return rows.map((row) => {
      authorize(p, row);
      return describeRow(row);
    });
  }
  return {
    list,
    fix,
    get,
    readSource,
    describe: (p: Principal, input: { previewId: string } | string) =>
      describeRow(own(p, typeof input === 'string' ? input : input.previewId)),
    prepare,
    prepared,
    cancel,
    cancelRequest: (p: Principal, input: { requestId: string; direction: 'export' | 'import' }) => {
      const rows = db
        .prepare(
          "SELECT id FROM portable_native_previews WHERE principal=? AND client=? AND workspace=? AND json_extract(input,'$.requestId')=? AND json_extract(input,'$.direction')=?",
        )
        .all(p.id, p.clientId, workspace(), input.requestId, input.direction) as { id: string }[];
      for (const row of rows) cancel(p, row.id);
      return { cancelled: true };
    },
  };
}
