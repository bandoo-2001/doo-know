import { createHash, randomUUID } from 'node:crypto';
import { closeSync, constants, fstatSync, fsyncSync, ftruncateSync, lstatSync, mkdirSync, openSync, readFileSync, readSync, realpathSync, rmSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import type { AppDatabase } from '../../../packages/core/db.js';
import { KnowledgeError } from '../../../packages/core/knowledge/errors.js';
import { chargeRate } from '../../../packages/core/agent/budgets.js';
import type { Principal } from '../../../shared/knowledge-contracts.js';
import type { McpDownloadInput, McpTransferBinding, McpTransferInfo, McpTransferStore, McpUploadInput } from '../../../shared/mcp-domain-tools.js';

const maximumBytes = 72 * 1024 * 1024, downloadMaximum = 256 * 1024 * 1024, chunkBytes = 8192, uploadChunkBytes = 16384;
const lifetime = 60 * 60 * 1000, ownerQuota = 512 * 1024 * 1024;
const maintenance = new WeakMap<AppDatabase, ReturnType<typeof setInterval>>();
const sha = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex');
const canonical = (v: unknown): string => JSON.stringify(sort(v));
function sort(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sort);
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).sort(([a], [b]) => a.localeCompare(b)).map(([k, value]) => [k, sort(value)]));
  return v;
}
function fail(code: string, status = 409): never { throw new KnowledgeError(status, code, code, status === 429); }
type Row = {
  id: string; owner: string; principal: string; client: string; workspace: string;
  direction: 'upload' | 'download'; state: McpTransferInfo['state']; request_id: string;
  fingerprint: string; binding: string; name: string; mime: string; total_bytes: number;
  received_bytes: number; expected_hash: string | null; digest: string | null;
  expires_at: number; complete_request: string | null; result: string | null;
};

/** Opaque temporary payloads. Domain adapters authorize resources before each public operation. */
export function createMcpTransferStore(config: { dataRoot: string }, db: AppDatabase): McpTransferStore & { downloadForOwner(ownerId: string, transferId: string): { bytes: Buffer; name: string; mime: string } } {
  const dataRoot = realpathSync(config.dataRoot), directory = join(dataRoot, 'mcp', 'transfers');
  for (const part of [join(dataRoot, 'mcp'), directory]) {
    mkdirSync(part, { recursive: true, mode: 0o700 });
    const stat = lstatSync(part);
    if (!stat.isDirectory() || stat.isSymbolicLink()) fail('MCP_TRANSFER_UNAVAILABLE', 503);
  }
  db.exec(`CREATE TABLE IF NOT EXISTS mcp_transfers(
    id TEXT PRIMARY KEY,owner TEXT NOT NULL,principal TEXT NOT NULL,client TEXT NOT NULL,workspace TEXT NOT NULL,
    direction TEXT NOT NULL,state TEXT NOT NULL,request_id TEXT NOT NULL,fingerprint TEXT NOT NULL,binding TEXT NOT NULL,
    name TEXT NOT NULL,mime TEXT NOT NULL,total_bytes INTEGER NOT NULL,received_bytes INTEGER NOT NULL,
    expected_hash TEXT,digest TEXT,expires_at INTEGER NOT NULL,complete_request TEXT,result TEXT,
    UNIQUE(owner,principal,client,workspace,direction,request_id));
    CREATE TABLE IF NOT EXISTS mcp_transfer_rates(actor TEXT PRIMARY KEY,starts_at INTEGER NOT NULL,bytes INTEGER NOT NULL);`);
  function workspace() { return (db.prepare("SELECT value FROM index_meta WHERE key='root_identity'").get() as { value: string } | undefined)?.value || 'unbound'; }
  function checkParents() {
    for (const path of [join(dataRoot, 'mcp'), directory]) {
      const stat = lstatSync(path);
      if (!stat.isDirectory() || stat.isSymbolicLink()) fail('MCP_TRANSFER_UNAVAILABLE', 503);
    }
  }
  function actor(p: Principal) { return { owner: p.ownerId || p.id, principal: p.id, client: p.clientId }; }
  function validateId(value: string) { if (!/^[a-f0-9-]{36}$/.test(value)) fail('MCP_TRANSFER_NOT_FOUND', 404); }
  function payload(id: string) {
    validateId(id);
    for (const path of [join(dataRoot, 'mcp'), directory, join(directory, id)]) {
      const s = lstatSync(path);
      if (!s.isDirectory() || s.isSymbolicLink()) fail('MCP_TRANSFER_UNAVAILABLE', 503);
    }
    return join(directory, id, 'payload.bin');
  }
  function openPayload(id: string, flags: number) {
    const fd = openSync(payload(id), flags | constants.O_NOFOLLOW);
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.nlink !== 1) { closeSync(fd); fail('MCP_TRANSFER_UNAVAILABLE', 503); }
    return fd;
  }
  function remove(id: string) { validateId(id); checkParents(); rmSync(join(directory, id), { recursive: true, force: true }); }
  function cleanup() {
    checkParents();
    for (const row of db.prepare('SELECT id FROM mcp_transfers WHERE expires_at<=?').all(Date.now()) as { id: string }[]) {
      remove(row.id); db.prepare('DELETE FROM mcp_transfers WHERE id=?').run(row.id);
    }
    db.prepare('DELETE FROM mcp_transfer_rates WHERE starts_at<?').run(Date.now() - 120000);
  }
  function owned(p: Principal, id: string): Row {
    validateId(id);
    const a = actor(p), row = db.prepare('SELECT * FROM mcp_transfers WHERE id=? AND owner=? AND principal=? AND client=?').get(id, a.owner, a.principal, a.client) as Row | undefined;
    if (!row || row.expires_at <= Date.now()) fail('MCP_TRANSFER_NOT_FOUND', 404);
    if (row.workspace !== workspace()) fail('MCP_TRANSFER_BINDING_CHANGED');
    return row;
  }
  function infoOf(r: Row): McpTransferInfo {
    return { transferId: r.id, direction: r.direction, state: r.state, name: r.name, mime: r.mime,
      totalBytes: r.total_bytes, receivedBytes: r.received_bytes, sha256: r.digest ?? r.expected_hash,
      expiresAt: new Date(r.expires_at).toISOString(), requestId: r.request_id, binding: JSON.parse(r.binding),
      ...(r.result ? { result: JSON.parse(r.result) } : {}) };
  }
  function validate(input: McpUploadInput, maximum = maximumBytes) {
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(input.requestId) || typeof input.name !== 'string' || !input.name || input.name.length > 256 || /[\x00-\x1f/\\]/.test(input.name) || typeof input.mime !== 'string' || !/^[\w.+-]+\/[\w.+-]+(?:;charset=utf-8)?$/.test(input.mime) || !Number.isSafeInteger(input.totalBytes) || input.totalBytes < 0 || input.totalBytes > maximum || (input.sha256 !== undefined && !/^[a-f0-9]{64}$/.test(input.sha256))) fail('MCP_TRANSFER_INVALID', 400);
    const b = input.binding;
    if (!b || !['knowledge', 'blog', 'to-doo'].includes(b.domain) || typeof b.kind !== 'string' || !/^[a-z][a-z0-9-]{0,63}$/.test(b.kind) || typeof b.id !== 'string' || !b.id || b.id.length > 2048 || /[\x00-\x1f]/.test(b.id) || (b.revision !== undefined && (typeof b.revision !== 'string' || b.revision.length > 2048)) || Buffer.byteLength(canonical(b)) > 8192) fail('MCP_TRANSFER_INVALID', 400);
    for (const [key, value] of Object.entries(b.metadata || {})) if (key.length > 64 || /[\x00-\x1f]/.test(key) || ![null, 'string', 'number', 'boolean'].includes(value === null ? null : typeof value) || (typeof value === 'number' && !Number.isFinite(value))) fail('MCP_TRANSFER_INVALID', 400);
  }
  function begin(p: Principal, input: McpUploadInput, direction: Row['direction'], bytes?: Buffer) {
    validate(input, direction === 'download' ? downloadMaximum : maximumBytes); checkParents(); cleanup();
    const a = actor(p), currentWorkspace = workspace(), fingerprint = sha(canonical(input));
    return db.transaction(() => {
      const existing = db.prepare('SELECT * FROM mcp_transfers WHERE owner=? AND principal=? AND client=? AND workspace=? AND direction=? AND request_id=?').get(a.owner, a.principal, a.client, currentWorkspace, direction, input.requestId) as Row | undefined;
      if (existing) { if (existing.fingerprint !== fingerprint) fail('MCP_TRANSFER_CONFLICT'); return infoOf(existing); }
      const usage = db.prepare("SELECT count(*) AS n,coalesce(sum(total_bytes),0) AS bytes FROM mcp_transfers WHERE owner=? AND state<>'cancelled'").get(a.owner) as { n: number; bytes: number };
      if (usage.n >= 128 || usage.bytes + input.totalBytes > ownerQuota) fail('MCP_TRANSFER_QUOTA', 429);
      const globalUsage = db.prepare("SELECT coalesce(sum(total_bytes),0) AS bytes FROM mcp_transfers WHERE state<>'cancelled'").get() as { bytes: number };
      if (globalUsage.bytes + input.totalBytes > 1024 * 1024 * 1024) fail('MCP_TRANSFER_QUOTA', 429);
      const id = randomUUID(), path = join(directory, id);
      mkdirSync(path, { mode: 0o700 });
      try {
        const fd = openSync(join(path, 'payload.bin'), constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
        try { if (bytes) writeSync(fd, bytes); fsyncSync(fd); } finally { closeSync(fd); }
        const digest = bytes ? sha(bytes) : input.totalBytes === 0 ? sha(Buffer.alloc(0)) : null;
        if (digest && input.sha256 && input.sha256 !== digest) fail('MCP_TRANSFER_HASH_MISMATCH');
        db.prepare('INSERT INTO mcp_transfers VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(id, a.owner, a.principal, a.client, currentWorkspace, direction, direction === 'download' || input.totalBytes === 0 ? 'ready' : 'uploading', input.requestId, fingerprint, canonical(input.binding), input.name, input.mime, input.totalBytes, bytes?.length ?? 0, input.sha256 ?? null, digest, Date.now() + lifetime * (direction === 'download' ? 4 : 1), null, null);
        return infoOf(owned(p, id));
      } catch (error) { remove(id); throw error; }
    }).immediate();
  }
  function info(p: Principal, id: string) { return infoOf(owned(p, id)); }
  function append(p: Principal, input: { transferId: string; offset: number; base64: string }) {
    if (!Number.isSafeInteger(input.offset) || input.offset < 0 || typeof input.base64 !== 'string' || input.base64.length > Math.ceil(uploadChunkBytes / 3) * 4 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(input.base64)) fail('MCP_TRANSFER_INVALID', 400);
    const bytes = Buffer.from(input.base64, 'base64');
    if (!bytes.length || bytes.length > uploadChunkBytes) fail('MCP_TRANSFER_INVALID', 400);
    return db.transaction(() => {
      const row = owned(p, input.transferId);
      if (row.direction !== 'upload' || !['uploading', 'ready'].includes(row.state) || input.offset + bytes.length > row.total_bytes || input.offset > row.received_bytes) fail('MCP_TRANSFER_CONFLICT');
      const fd = openPayload(row.id, constants.O_RDWR);
      try {
        if (input.offset < row.received_bytes) {
          if (input.offset + bytes.length > row.received_bytes) fail('MCP_TRANSFER_CONFLICT');
          const prior = Buffer.alloc(bytes.length); readSync(fd, prior, 0, prior.length, input.offset);
          if (!prior.equals(bytes)) fail('MCP_TRANSFER_CONFLICT');
          return infoOf(row);
        }
        if (fstatSync(fd).size < row.received_bytes) fail('MCP_TRANSFER_UNAVAILABLE', 503);
        ftruncateSync(fd, row.received_bytes);
        writeSync(fd, bytes, 0, bytes.length, input.offset); fsyncSync(fd);
        const received = input.offset + bytes.length, complete = received === row.total_bytes;
        const digest = complete ? sha(readFileSync(fd)) : null;
        if (digest && row.expected_hash && digest !== row.expected_hash) {
          ftruncateSync(fd, row.received_bytes); fsyncSync(fd); fail('MCP_TRANSFER_HASH_MISMATCH');
        }
        db.prepare('UPDATE mcp_transfers SET received_bytes=?,digest=?,state=? WHERE id=?').run(received, digest, complete ? 'ready' : 'uploading', row.id);
        return infoOf(owned(p, row.id));
      } finally { closeSync(fd); }
    }).immediate();
  }
  function readUpload(p: Principal, id: string, expectedBinding?: McpTransferBinding, completionRequestId?: string) {
    const row = owned(p, id);
    if (row.direction !== 'upload' || !['ready', 'completed'].includes(row.state) || row.received_bytes !== row.total_bytes) fail('MCP_TRANSFER_INCOMPLETE');
    if (expectedBinding && canonical(expectedBinding) !== row.binding) fail('MCP_TRANSFER_CONFLICT');
    const fd = openPayload(id, constants.O_RDONLY);
    try {
      if (fstatSync(fd).size !== row.total_bytes) fail('MCP_TRANSFER_HASH_MISMATCH');
      const bytes = readFileSync(fd), digest = sha(bytes);
      if (digest !== row.digest) fail('MCP_TRANSFER_HASH_MISMATCH');
      if (completionRequestId !== undefined) {
        if (!/^[A-Za-z0-9_-]{1,128}$/.test(completionRequestId)) fail('MCP_TRANSFER_INVALID', 400);
        db.transaction(() => {
          const latest = owned(p, id);
          if (!['ready', 'completed'].includes(latest.state) || (latest.complete_request && latest.complete_request !== completionRequestId)) fail('MCP_TRANSFER_CONFLICT');
          if (!latest.complete_request) db.prepare('UPDATE mcp_transfers SET complete_request=? WHERE id=? AND complete_request IS NULL').run(completionRequestId, id);
        }).immediate();
      }
      return { bytes, binding: JSON.parse(row.binding) as McpTransferBinding, name: row.name, mime: row.mime, sha256: digest };
    } finally { closeSync(fd); }
  }
  function read(p: Principal, input: { transferId: string; offset: number; maxBytes?: number }) {
    const row = owned(p, input.transferId), maximum = input.maxBytes ?? chunkBytes;
    if (row.direction !== 'download' || row.state !== 'ready' || !Number.isSafeInteger(input.offset) || input.offset < 0 || input.offset > row.total_bytes || !Number.isInteger(maximum) || maximum < 1 || maximum > chunkBytes) fail('MCP_TRANSFER_INVALID', 400);
    const count = Math.min(maximum, row.total_bytes - input.offset), a = actor(p), rateKey = canonical([a.owner, a.principal, a.client]);
    const fd = openPayload(row.id, constants.O_RDONLY);
    try {
      if (fstatSync(fd).size !== row.total_bytes) fail('MCP_TRANSFER_HASH_MISMATCH');
      const bytes = Buffer.alloc(count); if (readSync(fd, bytes, 0, count, input.offset) !== count) fail('MCP_TRANSFER_UNAVAILABLE', 503);
      db.transaction(() => chargeRate(db, p, 'mcp', count)).immediate();
      return { transferId: row.id, offset: input.offset, nextOffset: input.offset + count, totalBytes: row.total_bytes, base64: bytes.toString('base64'), done: input.offset + count === row.total_bytes, sha256: row.digest! };
    } finally { closeSync(fd); }
  }
  function complete(p: Principal, id: string, requestId: string, result: Record<string, unknown>) {
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(requestId) || !result || typeof result !== 'object' || Array.isArray(result) || Buffer.byteLength(canonical(result)) > 16384) fail('MCP_TRANSFER_INVALID', 400);
    return db.transaction(() => {
    const row = owned(p, id), encoded = canonical(result);
    if (row.complete_request && row.complete_request !== requestId) fail('MCP_TRANSFER_CONFLICT');
    if (row.state === 'completed') {
      if (row.complete_request !== requestId || row.result !== encoded) fail('MCP_TRANSFER_CONFLICT');
      return infoOf(row);
    }
    if (row.direction !== 'upload' || row.state !== 'ready') fail('MCP_TRANSFER_INCOMPLETE');
    readUpload(p, id);
    db.prepare("UPDATE mcp_transfers SET state='completed',complete_request=?,result=? WHERE id=? AND state='ready'").run(requestId, encoded, id);
    return infoOf(owned(p, id));
    }).immediate();
  }
  function cancel(p: Principal, id: string) {
    return db.transaction(() => {
    const row = owned(p, id);
    if (row.state === 'completed') return { transferId: id, cancelled: false, state: row.state };
    db.prepare("UPDATE mcp_transfers SET state='cancelled' WHERE id=?").run(id); remove(id);
    return { transferId: id, cancelled: true, state: 'cancelled' as const };
    }).immediate();
  }
  function downloadForOwner(ownerId: string, id: string) {
    validateId(id);
    const row = db.prepare("SELECT * FROM mcp_transfers WHERE id=? AND owner=? AND direction='download' AND state='ready' AND expires_at>?").get(id, ownerId, Date.now()) as Row | undefined;
    if (!row || row.workspace !== workspace()) fail('MCP_TRANSFER_NOT_FOUND', 404);
    const fd = openPayload(id, constants.O_RDONLY);
    try {
      if (fstatSync(fd).size !== row.total_bytes) fail('MCP_TRANSFER_HASH_MISMATCH');
      const bytes = readFileSync(fd);
      if (sha(bytes) !== row.digest) fail('MCP_TRANSFER_HASH_MISMATCH');
      return { bytes, name: row.name, mime: row.mime };
    } finally { closeSync(fd); }
  }
  cleanup();
  if (!maintenance.has(db)) {
    const timer = setInterval(() => {
      if (!db.open) { clearInterval(timer); maintenance.delete(db); return; }
      try { cleanup(); } catch { /* Foreground transfer access reports unsafe/unavailable storage. */ }
    }, 60000);
    timer.unref(); maintenance.set(db, timer);
  }
  return { beginUpload: (p, input) => begin(p, input, 'upload'),
    createDownload: (p: Principal, input: McpDownloadInput) => begin(p, { requestId: input.requestId, binding: input.binding, name: input.name, mime: input.mime, totalBytes: input.bytes.length, sha256: sha(input.bytes) }, 'download', input.bytes),
    info, append, read, readUpload, complete, cancel, cleanup, downloadForOwner };
}
