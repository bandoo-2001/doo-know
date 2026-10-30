import { afterEach, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync, readFileSync, renameSync, readdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase } from '../packages/core/db.js';
import { createMcpTransferStore } from '../apps/server/plugins/mcp-transfers.js';
import type { Principal } from '../shared/knowledge-contracts.js';
import type { McpTransferBinding } from '../shared/mcp-domain-tools.js';

const cleanup: Array<() => void> = [];
afterEach(() => { for (const close of cleanup.splice(0)) close(); vi.useRealTimers(); });
const p: Principal = { id: 'owner', clientId: 'client', scopes: ['knowledge:read', 'knowledge:write'], allowedPrefixes: ['00-Inbox'] };
const binding: McpTransferBinding = { domain: 'knowledge', kind: 'asset-upload', id: 'note', revision: 'v1' };
const sha = (s: string) => createHash('sha256').update(s).digest('hex');
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'mcp-transfer-'));
  const config = { dataRoot: join(root, 'data'), knowledgeRoot: join(root, 'knowledge'), origin: 'http://localhost' };
  mkdirSync(config.knowledgeRoot);
  const db = openDatabase(config.dataRoot);
  db.prepare("INSERT INTO index_meta(key,value) VALUES('root_identity',?)").run(JSON.stringify({ path: config.knowledgeRoot, dev: '1', ino: '1' }));
  cleanup.push(() => { if (db.open) db.close(); rmSync(root, { recursive: true, force: true }); });
  return { root, config, db, store: createMcpTransferStore(config, db) };
}
it('persists ordered chunks, accepts identical retries and finalizes the original result once', () => {
  const f = fixture(), input = { requestId: 'upload', binding, name: 'note.txt', mime: 'text/plain', totalBytes: 4, sha256: sha('abcd') };
  const meta = f.store.beginUpload(p, input);
  expect(f.store.beginUpload(p, input).transferId).toBe(meta.transferId);
  expect(() => f.store.beginUpload(p, { ...input, totalBytes: 5 })).toThrow();
  const chunk = { transferId: meta.transferId, offset: 0, base64: Buffer.from('ab').toString('base64') };
  expect(f.store.append(p, chunk).receivedBytes).toBe(2);
  expect(f.store.append(p, chunk).receivedBytes).toBe(2);
  expect(() => f.store.append(p, { ...chunk, base64: Buffer.from('zz').toString('base64') })).toThrow();
  expect(() => f.store.append(p, { ...chunk, offset: 3 })).toThrow();
  const next = createMcpTransferStore(f.config, f.db);
  expect(next.append(p, { transferId: meta.transferId, offset: 2, base64: Buffer.from('cd').toString('base64') }).state).toBe('ready');
  expect(next.readUpload(p, meta.transferId, binding).bytes.toString()).toBe('abcd');
  const done = next.complete(p, meta.transferId, 'finish', { assetId: 'asset' });
  expect(done.state).toBe('completed');
  expect(next.complete(p, meta.transferId, 'finish', { assetId: 'asset' }).result).toEqual({ assetId: 'asset' });
  expect(() => next.complete(p, meta.transferId, 'different', { assetId: 'other' })).toThrow();
});
it('binds uploads to caller, client, workspace and exact domain resource', () => {
  const f = fixture(), meta = f.store.beginUpload(p, { requestId: 'bound', binding, name: 'x.txt', mime: 'text/plain', totalBytes: 0 });
  expect(() => f.store.info({ ...p, id: 'other' }, meta.transferId)).toThrow();
  expect(() => f.store.info({ ...p, clientId: 'other' }, meta.transferId)).toThrow();
  expect(() => f.store.readUpload(p, meta.transferId, { ...binding, id: 'different' })).toThrow();
  f.db.prepare("UPDATE index_meta SET value='new-workspace' WHERE key='root_identity'").run();
  expect(() => f.store.info(p, meta.transferId)).toThrow();
});
it('bounds downloads and prevents cross-client reads, bad offsets and malformed chunk uploads', () => {
  const f = fixture(), meta = f.store.createDownload(p, { requestId: 'download', binding: { ...binding, kind: 'document-download' }, name: 'x.txt', mime: 'text/plain', bytes: Buffer.from('abcd') });
  const first = f.store.read(p, { transferId: meta.transferId, offset: 0, maxBytes: 2 });
  expect(Buffer.from(first.base64, 'base64').toString()).toBe('ab');
  expect(first).toMatchObject({ nextOffset: 2, done: false, totalBytes: 4 });
  expect(f.store.read(p, { transferId: meta.transferId, offset: 2, maxBytes: 2 }).done).toBe(true);
  expect(() => f.store.read({ ...p, clientId: 'other' }, { transferId: meta.transferId, offset: 0 })).toThrow();
  expect(() => f.store.read(p, { transferId: meta.transferId, offset: -1 })).toThrow();
  const upload = f.store.beginUpload(p, { requestId: 'bad', binding, name: 'a.txt', mime: 'text/plain', totalBytes: 4 });
  expect(() => f.store.append(p, { transferId: upload.transferId, offset: 0, base64: '!!!' })).toThrow();
  expect(() => f.store.append(p, { transferId: upload.transferId, offset: 0, base64: Buffer.alloc(20000).toString('base64') })).toThrow();
});
it('checks declared hashes, session expiry and cancellation without following replaced files', () => {
  const f = fixture(), meta = f.store.beginUpload(p, { requestId: 'hash', binding, name: 'a.txt', mime: 'text/plain', totalBytes: 4, sha256: sha('xxxx') });
  expect(() => f.store.append(p, { transferId: meta.transferId, offset: 0, base64: Buffer.from('abcd').toString('base64') })).toThrow();
  const cancel = f.store.beginUpload(p, { requestId: 'cancel', binding, name: 'a.txt', mime: 'text/plain', totalBytes: 4 });
  expect(f.store.cancel(p, cancel.transferId)).toMatchObject({ cancelled: true });
  expect(() => f.store.readUpload(p, cancel.transferId)).toThrow();
  const expired = f.store.beginUpload(p, { requestId: 'expired', binding, name: 'a.txt', mime: 'text/plain', totalBytes: 1 });
  f.db.prepare('UPDATE mcp_transfers SET expires_at=0 WHERE id=?').run(expired.transferId);
  expect(() => f.store.info(p, expired.transferId)).toThrow();
  const linked = f.store.beginUpload(p, { requestId: 'link', binding, name: 'a.txt', mime: 'text/plain', totalBytes: 4 });
  const secret = join(f.root, 'protected.txt'); writeFileSync(secret, 'keep');
  const file = join(f.config.dataRoot, 'mcp/transfers', linked.transferId, 'payload.bin');
  rmSync(file); symlinkSync(secret, file);
  expect(() => f.store.append(p, { transferId: linked.transferId, offset: 0, base64: Buffer.from('evil').toString('base64') })).toThrow();
  expect(readFileSync(secret, 'utf8')).toBe('keep');
});

it('shares the MCP text-read rate budget with binary downloads', () => {
  const f = fixture(), meta = f.store.createDownload(p, { requestId: 'rate', binding, name: 'x.txt', mime: 'text/plain', bytes: Buffer.from('x') });
  const window = Math.floor(Date.now() / 60000);
  f.db.prepare('INSERT INTO read_rates VALUES(?,?,?,?,?)').run(p.id, p.clientId, 'mcp', window, 2 * 1024 * 1024);
  expect(() => f.store.read(p, { transferId: meta.transferId, offset: 0 })).toThrow();
});

it('claims an upload for one finalization identity before a domain can mutate data', () => {
  const f = fixture(), meta = f.store.beginUpload(p, { requestId: 'claim', binding, name: 'a.txt', mime: 'text/plain', totalBytes: 1 });
  f.store.append(p, { transferId: meta.transferId, offset: 0, base64: Buffer.from('x').toString('base64') });
  expect(f.store.readUpload(p, meta.transferId, binding, 'first-finish').bytes.toString()).toBe('x');
  expect(() => f.store.readUpload(p, meta.transferId, binding, 'second-finish')).toThrow();
  f.store.complete(p, meta.transferId, 'first-finish', { written: true });
  expect(f.store.readUpload(p, meta.transferId, binding, 'first-finish').bytes.toString()).toBe('x');
  expect(() => f.store.readUpload(p, meta.transferId, binding, 'second-finish')).toThrow();
});

it('releases declared byte and session quotas when uploads are canceled', () => {
  const f = fixture();
  for (let i = 0; i < 7; i++) {
    const meta = f.store.beginUpload(p, { requestId: 'cancel-big-' + i, binding, name: 'source.json', mime: 'application/json', totalBytes: 72 * 1024 * 1024 });
    f.store.cancel(p, meta.transferId);
  }
  expect(() => f.store.beginUpload(p, { requestId: 'replacement-big', binding, name: 'source.json', mime: 'application/json', totalBytes: 72 * 1024 * 1024 })).not.toThrow();
});
it('rechecks creation and cleanup ancestors rather than following a replaced transfer root', () => {
  const f = fixture();
  const meta = f.store.beginUpload(p, { requestId: 'before-swap', binding, name: 'a.txt', mime: 'text/plain', totalBytes: 1 });
  const transfers = join(f.config.dataRoot, 'mcp/transfers'), outside = join(f.root, 'outside');
  mkdirSync(join(outside, meta.transferId), { recursive: true });
  writeFileSync(join(outside, meta.transferId, 'keep.txt'), 'keep');
  renameSync(transfers, transfers + '-old'); symlinkSync(outside, transfers, 'dir');
  expect(() => f.store.createDownload(p, { requestId: 'after-swap', binding, name: 'a.txt', mime: 'text/plain', bytes: Buffer.from('x') })).toThrow();
  expect(readdirSync(outside)).toEqual([meta.transferId]);
  f.db.prepare('UPDATE mcp_transfers SET expires_at=0 WHERE id=?').run(meta.transferId);
  expect(() => f.store.cleanup()).toThrow();
  expect(readFileSync(join(outside, meta.transferId, 'keep.txt'), 'utf8')).toBe('keep');
});
it('cleans expired payloads while the service is idle and stops maintenance after DB close', () => {
  vi.useFakeTimers();
  const f = fixture(), meta = f.store.beginUpload(p, { requestId: 'idle-expiry', binding, name: 'a.txt', mime: 'text/plain', totalBytes: 1 });
  const directory = join(f.config.dataRoot, 'mcp/transfers', meta.transferId);
  f.db.prepare('UPDATE mcp_transfers SET expires_at=? WHERE id=?').run(Date.now() - 1, meta.transferId);
  vi.advanceTimersByTime(60000);
  expect(existsSync(directory)).toBe(false);
  expect(f.db.prepare('SELECT id FROM mcp_transfers WHERE id=?').get(meta.transferId)).toBeUndefined();
  f.db.close();
  expect(() => vi.advanceTimersByTime(60000)).not.toThrow();
});
