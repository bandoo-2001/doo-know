import { currentAgentConfig } from '../agent/config.js';
import { mkdir, open, stat, unlink } from 'node:fs/promises';
import { join, basename } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import type { AppConfig } from '../../shared/contracts.js';
import type { AppDatabase } from '../db.js';
import type { NoteService } from '../notes.js';
import type {
  Principal,
  FileOperation,
  FileReply,
  ReadPage,
  ReadInput,
  OutlinePage,
} from '../../shared/knowledge-contracts.js';
import { safePath } from '../files.js';
import { authorizePath } from '../agent/auth.js';
import { fail, KnowledgeError } from './errors.js';
import { beginOperation, completeOperation, sha256 } from './operations.js';
import { enqueueSource } from './core.js';
import { limits, readPolicies, utf8Prefix, messageSize, type ReadChannel } from './limits.js';
import { readBlocks, stableStat, sameFile, writeAll } from './file-reader.js';
import { signCursor, decodeCursor, acquireRead, chargeRate } from '../agent/budgets.js';
export interface SnapshotRow {
  id: string;
  note_id: string;
  source_hash: string;
  modified_at: string;
  path: string;
  size_bytes: number;
  longest_line_bytes: number;
  created_at: number;
  expires_at: number;
  refs: number;
  principal: string;
}
export function snapshotService(config: AppConfig, db: AppDatabase, notes: NoteService) {
  let tail = Promise.resolve();
  let closing = false;
  const operation = (id: string): FileOperation => {
    const row = db
      .prepare(
        'SELECT o.*,f.kind,f.snapshot_id FROM operations o JOIN file_operations f ON f.id=o.id WHERE o.id=?',
      )
      .get(id) as any;
    return {
      operationId: id,
      requestId: row.request_id,
      kind: row.kind,
      status: row.status,
      ...(row.snapshot_id ? { snapshotId: row.snapshot_id } : {}),
      ...(row.error
        ? { error: { code: row.error, retryable: row.status === 'needs_reconciliation' } }
        : {}),
    };
  };
  const authorizedFile = (p: Principal, id: string) => {
    const [noteId, revisionId] = id.split('@');
    const n = notes.row(noteId);
    authorizePath(p, n.path);
    if (p.id !== 'web-owner' && !p.id.startsWith('share:')) {
      const policy = currentAgentConfig(config)?.policies.find(
        (x) => x.id === p.id && x.clientId === p.clientId,
      );
      if (!policy) fail(403, 'FORBIDDEN');
      authorizePath(policy, n.path);
    }
    if (revisionId) {
      const r = db
        .prepare('SELECT file FROM revisions WHERE id=? AND note_id=?')
        .get(revisionId, noteId) as any;
      if (!r || !/^[a-zA-Z0-9-]+\.md$/.test(r.file)) fail(404, 'REVISION_NOT_FOUND');
      return { n, file: join(config.dataRoot, 'history', r.file), historical: true };
    }
    return { n, file: safePath(config.knowledgeRoot, n.path, 'note'), historical: false };
  };
  async function check(p: Principal, id: string, snapshotId: string) {
    const { file, n, historical } = authorizedFile(p, id);
    const row = db
      .prepare('SELECT * FROM read_snapshots WHERE id=? AND note_id=? AND source_key=?')
      .get(snapshotId, n.id, id) as SnapshotRow | undefined;
    if (!row) fail(404, 'SNAPSHOT_NOT_FOUND');
    if (row.expires_at <= Date.now() && !row.refs) fail(410, 'CURSOR_EXPIRED');
    const s = await stableStat(file),
      state = db.prepare('SELECT content_hash FROM document_state WHERE note_id=?').get(id) as any;
    if (
      s.mtimeNs.toString() !== row.modified_at ||
      Number(s.size) !== row.size_bytes ||
      (!historical && state?.content_hash && state.content_hash !== row.source_hash)
    )
      fail(409, 'STALE_CURSOR');
    return row;
  }
  async function build(p: Principal, id: string, opId: string) {
    const lease = db
      .prepare(
        "UPDATE file_operations SET status='running',started_at=?,deadline=?,lease_until=?,lease_epoch=lease_epoch+1,worker_id=? WHERE id=? AND status='queued' AND deadline>?",
      )
      .run(
        Date.now(),
        Date.now() + 300000,
        Date.now() + 60000,
        'embedded-file-worker',
        opId,
        Date.now(),
      );
    if (!lease.changes) {
      const expired = db
        .prepare(
          "UPDATE file_operations SET status='failed',error='TASK_DEADLINE' WHERE id=? AND status='queued' AND deadline<=?",
        )
        .run(opId, Date.now());
      if (expired.changes)
        db.prepare(
          "UPDATE operations SET status='failed',error='TASK_DEADLINE' WHERE id=? AND status='queued'",
        ).run(opId);
      return;
    }
    db.prepare("UPDATE operations SET status='running' WHERE id=?").run(opId);
    const row = db.prepare('SELECT lease_epoch FROM file_operations WHERE id=?').get(opId) as any;
    const snapshotId = randomUUID(),
      dir = join(config.dataRoot, 'read-snapshots'),
      destination = join(dir, `${snapshotId}.md`);
    let fd: Awaited<ReturnType<typeof open>> | undefined;
    try {
      const { n, file, historical } = authorizedFile(p, id),
        before = await stableStat(file);
      await mkdir(dir, { recursive: true, mode: 0o700 });
      fd = await open(destination, 'wx', 0o600);
      const hash = createHash('sha256'),
        decoder = new TextDecoder('utf-8', { fatal: true });
      let byte = 0,
        line = 1,
        lineLength = 0,
        longest = 0,
        prefix = Buffer.alloc(0),
        ordinal = 0,
        title = basename(n.path, '.md'),
        inFence = false;
      db.prepare('INSERT INTO read_snapshots VALUES(?,?,?,?,?,?,?,?,?,?,?,?)').run(
        snapshotId,
        n.id,
        'preparing',
        before.mtimeNs.toString(),
        destination,
        Number(before.size),
        0,
        Date.now(),
        Date.now() + limits.ttl,
        1,
        p.id,
        id,
      );
      db.prepare('UPDATE file_operations SET snapshot_id=? WHERE id=?').run(snapshotId, opId);
      db.prepare('INSERT INTO snapshot_offsets VALUES(?,?,?)').run(snapshotId, 1, 0);
      const newline = (lineEnd: number) => {
        longest = Math.max(longest, lineLength);
        const text = prefix.toString('utf8').replace(/\r$/, '');
        if (/^\s*(```|~~~)/.test(text)) inFence = !inFence;
        const m = !inFence && text.match(/^(#{1,6})\s+(.+)/);
        if (m) {
          const heading = [...m[2]].slice(0, 256).join('');
          db.prepare('INSERT INTO outline_offsets VALUES(?,?,?,?,?,?)').run(
            snapshotId,
            ordinal++,
            heading,
            m[1].length,
            line,
            lineEnd - lineLength,
          );
          if (m[1].length === 1 && title === basename(n.path, '.md')) title = heading;
        }
        line++;
        lineLength = 0;
        prefix = Buffer.alloc(0);
        if ((line - 1) % 128 === 0)
          db.prepare('INSERT OR IGNORE INTO snapshot_offsets VALUES(?,?,?)').run(
            snapshotId,
            line,
            lineEnd + 1,
          );
      };
      for await (const bytes of readBlocks(file, 0, undefined, AbortSignal.timeout(300000))) {
        const active = db
          .prepare('SELECT status,lease_epoch,deadline,lease_until FROM file_operations WHERE id=?')
          .get(opId) as any;
        if (
          active.status !== 'running' ||
          active.lease_epoch !== row.lease_epoch ||
          active.deadline <= Date.now() ||
          active.lease_until <= Date.now()
        )
          fail(409, 'TASK_CANCELLED');
        db.prepare('UPDATE file_operations SET lease_until=? WHERE id=? AND lease_epoch=?').run(
          Date.now() + 60000,
          opId,
          row.lease_epoch,
        );
        decoder.decode(bytes, { stream: true });
        hash.update(bytes);
        await writeAll(fd, bytes);
        db.transaction(() => {
          let start = 0;
          for (let i = 0; i < bytes.length; i++) {
            if (bytes[i] !== 10) continue;
            const segment = bytes.subarray(start, i);
            if (prefix.length < 1024)
              prefix = Buffer.concat([prefix, segment.subarray(0, 1024 - prefix.length)]);
            lineLength += segment.length;
            newline(byte + i);
            start = i + 1;
          }
          const rest = bytes.subarray(start);
          if (prefix.length < 1024)
            prefix = Buffer.concat([prefix, rest.subarray(0, 1024 - prefix.length)]);
          lineLength += rest.length;
        })();
        byte += bytes.length;
      }
      decoder.decode();
      longest = Math.max(longest, lineLength);
      if (lineLength) newline(byte);
      await fd.sync();
      await fd.close();
      fd = undefined;
      if (!sameFile(before, await stableStat(authorizedFile(p, id).file)))
        fail(409, 'STALE_CURSOR');
      const sourceHash = hash.digest('hex');
      authorizedFile(p, id);
      db.transaction(() => {
        const active = db
          .prepare('SELECT status,lease_epoch FROM file_operations WHERE id=?')
          .get(opId) as any;
        if (active.status !== 'running' || active.lease_epoch !== row.lease_epoch)
          fail(409, 'TASK_CANCELLED');
        db.prepare(
          'UPDATE read_snapshots SET source_hash=?,longest_line_bytes=?,refs=0 WHERE id=?',
        ).run(sourceHash, longest, snapshotId);
        if (!historical) {
          enqueueSource(db, config, n.id, sourceHash, before.mtimeNs.toString(), byte);
          db.prepare('UPDATE document_state SET longest_line_bytes=?,title=? WHERE note_id=?').run(
            longest,
            title,
            n.id,
          );
        }
        db.prepare("UPDATE file_operations SET status='succeeded',snapshot_id=? WHERE id=?").run(
          snapshotId,
          opId,
        );
        completeOperation(db, opId, {
          snapshotId,
          sourceHash,
          modifiedAt: before.mtimeNs.toString(),
          sizeBytes: byte,
        });
      })();
    } catch (e) {
      const ownership = db
        .prepare('SELECT lease_epoch FROM file_operations WHERE id=?')
        .get(opId) as any;
      if (ownership?.lease_epoch !== row.lease_epoch) {
        await fd?.close();
        db.prepare('DELETE FROM read_snapshots WHERE id=?').run(snapshotId);
        await unlink(destination).catch(() => {});
        return;
      }
      const code =
        e instanceof KnowledgeError
          ? e.code
          : e instanceof TypeError
            ? 'INVALID_UTF8'
            : 'SNAPSHOT_FAILED';
      db.prepare(
        "UPDATE operations SET status=CASE WHEN status='cancelled' THEN status ELSE 'failed' END,error=? WHERE id=?",
      ).run(code, opId);
      db.prepare(
        "UPDATE file_operations SET status=CASE WHEN status='cancelled' THEN status ELSE 'failed' END,error=? WHERE id=?",
      ).run(code, opId);
      await fd?.close();
      db.prepare('DELETE FROM read_snapshots WHERE id=?').run(snapshotId);
      await unlink(destination).catch(() => {});
    }
  }
  async function prepare(p: Principal, id: string, requestId: string) {
    const { file, n } = authorizedFile(p, id),
      s = await stableStat(file),
      modifiedAt = s.mtimeNs.toString();
    const accepted = db
      .transaction(() => {
        const pending = db
          .prepare(
            "SELECT f.id FROM file_operations f JOIN operations o ON o.id=f.id WHERE f.kind='prepare_snapshot' AND f.status IN ('queued','running') AND o.principal=? AND o.client_id=? AND json_extract(f.payload,'$.sourceKey')=? AND json_extract(f.payload,'$.modifiedAt')=? LIMIT 1",
          )
          .get(p.id, p.clientId, id, modifiedAt) as { id: string } | undefined;
        if (pending) return { id: pending.id, fresh: false };
        const op = beginOperation(db, p, 'prepare_snapshot', requestId, { noteId: id, modifiedAt });
        if (
          !op.fresh &&
          db.prepare('SELECT 1 FROM file_operations WHERE id=?').get(op.operation.id)
        )
          return { id: op.operation.id, fresh: false };
        const own = (
            db
              .prepare('SELECT coalesce(sum(size_bytes),0) n FROM read_snapshots WHERE principal=?')
              .get(p.id) as any
          ).n,
          all = (
            db.prepare('SELECT coalesce(sum(size_bytes),0) n FROM read_snapshots').get() as any
          ).n;
        const reservation =
          "SELECT coalesce(sum(CAST(json_extract(payload,'$.sizeBytes') AS INTEGER)),0) n FROM file_operations f JOIN operations o ON o.id=f.id WHERE f.kind='prepare_snapshot' AND f.status IN ('queued','running') AND f.snapshot_id IS NULL";
        const pendingBytes = (db.prepare(reservation).get() as any).n,
          ownPending = (db.prepare(reservation + ' AND o.principal=?').get(p.id) as any).n;
        if (
          own + ownPending + Number(s.size) > 64 * 1024 * 1024 ||
          all + pendingBytes + Number(s.size) > 256 * 1024 * 1024
        )
          fail(429, 'SNAPSHOT_QUOTA_EXCEEDED');
        db.prepare(
          'INSERT INTO file_operations(id,note_id,kind,status,payload,created_at,deadline) VALUES(?,?,?,?,?,?,?)',
        ).run(
          op.operation.id,
          n.id,
          'prepare_snapshot',
          'queued',
          JSON.stringify({ sizeBytes: Number(s.size), sourceKey: id, modifiedAt, principal: p }),
          Date.now(),
          Date.now() + 300000,
        );
        db.prepare("UPDATE operations SET status='queued' WHERE id=?").run(op.operation.id);
        return { id: op.operation.id, fresh: true };
      })
      .immediate();
    if (accepted.fresh && !closing && config.fileTasks?.embedded !== false)
      tail = tail.then(() => build(p, id, accepted.id));
    return operation(accepted.id);
  }
  async function available(p: Principal, id: string, input: ReadInput) {
    if (input.snapshotId) return check(p, id, input.snapshotId);
    const { file, n, historical } = authorizedFile(p, id),
      s = await stableStat(file),
      state = historical
        ? null
        : (db.prepare('SELECT content_hash FROM document_state WHERE note_id=?').get(n.id) as any);
    const row = db
      .prepare(
        'SELECT * FROM read_snapshots WHERE note_id=? AND source_key=? AND modified_at=? AND size_bytes=? AND source_hash<>? AND expires_at>? ORDER BY created_at DESC LIMIT 1',
      )
      .get(n.id, id, s.mtimeNs.toString(), Number(s.size), 'preparing', Date.now()) as
      | SnapshotRow
      | undefined;
    if (row && (!state?.content_hash || row.source_hash === state.content_hash)) return row;
    return {
      operation: await prepare(
        p,
        id,
        `snapshot:${sha256(JSON.stringify([id, s.mtimeNs.toString(), state?.content_hash || '']))}:${randomUUID()}`,
      ),
    };
  }
  async function lineByte(snapshot: SnapshotRow, target: number) {
    const near = db
      .prepare(
        'SELECT line,byte FROM snapshot_offsets WHERE snapshot_id=? AND line<=? ORDER BY line DESC LIMIT 1',
      )
      .get(snapshot.id, target) as { line: number; byte: number };
    let line = near.line,
      offset = near.byte;
    if (line === target) return offset;
    for await (const bytes of readBlocks(snapshot.path, offset)) {
      for (let i = 0; i < bytes.length; i++)
        if (bytes[i] === 10 && ++line === target) return offset + i + 1;
      offset += bytes.length;
    }
    return snapshot.size_bytes;
  }
  async function read(
    p: Principal,
    id: string,
    input: ReadInput = {},
    channel: ReadChannel = 'mcp',
  ): Promise<FileReply<ReadPage>> {
    const policy = readPolicies[channel];
    if (input.cursor && (input.range || input.snapshotId)) fail(400, 'INVALID_INPUT');
    if (
      input.maxBytes != null &&
      (!Number.isInteger(input.maxBytes) || input.maxBytes < 4 || input.maxBytes > policy.maxBytes)
    )
      fail(400, 'INVALID_READ_BUDGET');
    const release = acquireRead(db, p, channel);
    try {
      let snapshot: SnapshotRow,
        session: any,
        cursor: any,
        maxBytes = input.maxBytes || policy.defaultBytes;
      if (input.cursor) {
        cursor = decodeCursor(config.secret, input.cursor);
        if (
          cursor.principal !== p.id ||
          cursor.clientId !== p.clientId ||
          cursor.noteId !== id ||
          cursor.channel !== channel
        )
          fail(403, 'FORBIDDEN');
        session = db.prepare('SELECT * FROM read_sessions WHERE id=?').get(cursor.sessionId);
        if (!session || session.expires_at <= Date.now()) fail(410, 'CURSOR_EXPIRED');
        snapshot = await check(p, id, session.snapshot_id);
        maxBytes = cursor.maxBytes;
      } else {
        const found = await available(p, id, input);
        if ('operation' in found) return { kind: 'accepted', operation: found.operation };
        snapshot = found;
        const r = input.range;
        if (
          r &&
          (!Number.isSafeInteger(r.startLine) ||
            !Number.isSafeInteger(r.endLine) ||
            r.startLine < 1 ||
            r.endLine < r.startLine ||
            (r.lineByteOffset != null &&
              (!Number.isSafeInteger(r.lineByteOffset) || r.lineByteOffset < 0)))
        )
          fail(400, 'INVALID_RANGE');
        const startLine = r?.startLine || 1,
          base = await lineByte(snapshot, startLine),
          startByte = base + (r?.lineByteOffset || 0),
          endByte = r ? await lineByte(snapshot, r.endLine + 1) : snapshot.size_bytes;
        if (
          startByte > endByte ||
          (r?.lineByteOffset && startByte > (await lineByte(snapshot, startLine + 1)))
        )
          fail(400, 'INVALID_RANGE');
        const sessionId = randomUUID();
        db.prepare(
          'INSERT INTO read_sessions(id,snapshot_id,principal,client_id,channel,expires_at) VALUES(?,?,?,?,?,?)',
        ).run(sessionId, snapshot.id, p.id, p.clientId, channel, Date.now() + limits.ttl);
        session = db.prepare('SELECT * FROM read_sessions WHERE id=?').get(sessionId);
        cursor = {
          sessionId,
          principal: p.id,
          clientId: p.clientId,
          noteId: id,
          channel,
          startByte,
          startLine,
          endByte,
          maxBytes,
          maxLines: r ? 200 : 100,
        };
      }
      const pageKey = sha256(JSON.stringify(cursor)),
        cached = db
          .prepare('SELECT result FROM read_pages WHERE session_id=? AND page_key=?')
          .get(session.id, pageKey) as any;
      if (cached) {
        const page = JSON.parse(cached.result);
        db.transaction(() => chargeRate(db, p, channel, page.bytesReturned))();
        return { kind: 'ready', data: page };
      }
      const fd = await open(snapshot.path, 'r');
      let bytes: Buffer;
      try {
        const buf = Buffer.alloc(
          Math.min(maxBytes + 4, Math.max(0, cursor.endByte - cursor.startByte)),
        );
        const r = await fd.read(buf, 0, buf.length, cursor.startByte);
        bytes = buf.subarray(0, r.bytesRead);
      } finally {
        await fd.close();
      }
      if (bytes.length && (bytes[0] & 0xc0) === 0x80) fail(400, 'INVALID_UTF8_BOUNDARY');
      let n = Math.min(maxBytes, bytes.length),
        newlines = 0;
      for (let i = 0; i < n; i++)
        if (bytes[i] === 10 && ++newlines >= cursor.maxLines) {
          n = i + 1;
          break;
        }
      let data: ReadPage;
      while (true) {
        const part = utf8Prefix(bytes, n),
          content = new TextDecoder('utf-8', { fatal: true }).decode(part),
          count = part.reduce((a, b) => a + (b === 10 ? 1 : 0), 0),
          end = cursor.startByte + part.length,
          hasMore = end < cursor.endByte;
        data = {
          snapshotId: snapshot.id,
          sourceHash: snapshot.source_hash,
          modifiedAt: snapshot.modified_at,
          content,
          startLine: cursor.startLine,
          endLine: cursor.startLine + count - (part.at(-1) === 10 ? 1 : 0),
          startByte: cursor.startByte,
          endByte: end,
          bytesReturned: part.length,
          hasMore,
          budgetRemainingBytes: policy.bytes - session.bytes - part.length,
          rangeHash: sha256(part),
          ...(hasMore
            ? {
                nextCursor: signCursor(config.secret, {
                  ...cursor,
                  startByte: end,
                  startLine: cursor.startLine + count,
                }),
              }
            : {}),
        };
        const size =
          channel === 'mcp'
            ? messageSize({ kind: 'ready', data })
            : Buffer.byteLength(JSON.stringify(data));
        if (size <= policy.response) break;
        if (n <= 4) fail(413, 'RESPONSE_TOO_LARGE');
        n = Math.floor(n / 2);
      }
      const page = db.transaction(() => {
        const duplicate = db
          .prepare('SELECT result FROM read_pages WHERE session_id=? AND page_key=?')
          .get(session.id, pageKey) as any;
        if (duplicate) {
          const old = JSON.parse(duplicate.result);
          chargeRate(db, p, channel, old.bytesReturned);
          return old;
        }
        const fresh = db.prepare('SELECT * FROM read_sessions WHERE id=?').get(session.id) as any;
        if (fresh.pages >= policy.pages || fresh.bytes + data.bytesReturned > policy.bytes)
          fail(429, 'READ_BUDGET_EXCEEDED');
        chargeRate(db, p, channel, data.bytesReturned);
        data.budgetRemainingBytes = policy.bytes - fresh.bytes - data.bytesReturned;
        db.prepare('UPDATE read_sessions SET pages=pages+1,bytes=bytes+? WHERE id=?').run(
          data.bytesReturned,
          session.id,
        );
        db.prepare('INSERT INTO read_pages VALUES(?,?,?)').run(
          session.id,
          pageKey,
          JSON.stringify(data),
        );
        return data;
      })();
      return { kind: 'ready', data: page };
    } finally {
      release();
    }
  }
  async function outline(
    p: Principal,
    id: string,
    cursor?: string,
  ): Promise<FileReply<OutlinePage>> {
    let start = 0,
      snapshot: SnapshotRow;
    if (cursor) {
      const c = decodeCursor(config.secret, cursor);
      if (
        c.principal !== p.id ||
        c.clientId !== p.clientId ||
        c.noteId !== id ||
        c.kind !== 'outline'
      )
        fail(403, 'FORBIDDEN');
      start = c.offset;
      snapshot = await check(p, id, c.snapshotId);
    } else {
      const ready = await available(p, id, {});
      if ('operation' in ready) return { kind: 'accepted', operation: ready.operation };
      snapshot = ready;
    }
    const rows = db
      .prepare(
        'SELECT title,level,line,byte AS startByte FROM outline_offsets WHERE snapshot_id=? AND ordinal>=? ORDER BY ordinal LIMIT 51',
      )
      .all(snapshot.id, start) as OutlinePage['items'];
    const more = rows.length > 50;
    const data = {
      snapshotId: snapshot.id,
      sourceHash: snapshot.source_hash,
      modifiedAt: snapshot.modified_at,
      items: rows.slice(0, 50),
      ...(more
        ? {
            nextCursor: signCursor(config.secret, {
              kind: 'outline',
              principal: p.id,
              clientId: p.clientId,
              noteId: id,
              snapshotId: snapshot.id,
              offset: start + 50,
            }),
          }
        : {}),
    };
    return { kind: 'ready', data };
  }
  async function clean() {
    const rows = db
      .prepare('SELECT * FROM read_snapshots WHERE expires_at<=? AND refs=0')
      .all(Date.now()) as SnapshotRow[];
    for (const r of rows) {
      if (
        db
          .prepare(
            "SELECT 1 FROM file_operations WHERE snapshot_id=? AND status IN ('queued','running','committing','needs_reconciliation')",
          )
          .get(r.id)
      )
        continue;
      if (
        !/^[0-9a-f-]{36}$/.test(r.id) ||
        r.path !== join(config.dataRoot, 'read-snapshots', `${r.id}.md`)
      )
        fail(500, 'INVALID_SNAPSHOT_PATH');
      await unlink(r.path).catch(() => {});
      db.prepare('DELETE FROM read_snapshots WHERE id=? AND refs=0').run(r.id);
    }
  }
  async function drain() {
    await tail;
  }
  async function close() {
    closing = true;
    await tail;
  }
  async function recover() {
    db.prepare(
      "UPDATE file_operations SET status='queued',lease_epoch=lease_epoch+1 WHERE kind='prepare_snapshot' AND status='running' AND lease_until<=?",
    ).run(Date.now());
    db.prepare(
      "UPDATE operations SET status='queued' WHERE id IN (SELECT id FROM file_operations WHERE kind='prepare_snapshot' AND status='queued')",
    ).run();
    if (config.fileTasks?.embedded === false) return;
    for (const row of db
      .prepare(
        "SELECT * FROM file_operations WHERE kind='prepare_snapshot' AND status='queued' ORDER BY created_at",
      )
      .all() as any[]) {
      const payload = JSON.parse(row.payload);
      tail = tail.then(() => build(payload.principal, payload.sourceKey || row.note_id, row.id));
    }
  }
  return {
    prepare,
    read,
    outline,
    check,
    available,
    lineByte,
    operation,
    clean,
    close,
    recover,
    drain,
  };
}
export type SnapshotService = ReturnType<typeof snapshotService>;
