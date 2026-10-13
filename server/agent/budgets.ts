import { createHmac, timingSafeEqual, randomUUID } from 'node:crypto';
import type { AppDatabase } from '../db.js';
import type { Principal } from '../../shared/knowledge-contracts.js';
import { fail } from '../knowledge/errors.js';
import { readPolicies, type ReadChannel } from '../knowledge/limits.js';
export function signCursor(secret: string, payload: unknown) {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `${body}.${createHmac('sha256', secret).update(body).digest('base64url')}`;
}
export function decodeCursor(secret: string, cursor: string): any {
  try {
    if (typeof cursor !== 'string' || cursor.length > 8192) throw new Error();
    const parts = cursor.split('.');
    if (parts.length !== 2) throw new Error();
    const sig = Buffer.from(parts[1], 'base64url'),
      expected = createHmac('sha256', secret).update(parts[0]).digest();
    if (sig.length !== expected.length || !timingSafeEqual(sig, expected)) throw new Error();
    return JSON.parse(Buffer.from(parts[0], 'base64url').toString());
  } catch {
    return fail(400, 'INVALID_CURSOR');
  }
}
export function acquireRead(db: AppDatabase, p: Principal, channel: ReadChannel) {
  return db.transaction(() => {
    db.exec(
      'CREATE TABLE IF NOT EXISTS read_leases(id TEXT PRIMARY KEY,principal TEXT NOT NULL,client_id TEXT NOT NULL,channel TEXT NOT NULL,expires_at INTEGER NOT NULL)',
    );
    db.prepare('DELETE FROM read_leases WHERE expires_at<=?').run(Date.now());
    const count = (
      db
        .prepare(
          'SELECT count(*) n FROM read_leases WHERE principal=? AND client_id=? AND channel=?',
        )
        .get(p.id, p.clientId, channel) as any
    ).n;
    if (count >= 2) fail(429, 'READ_CONCURRENCY_EXCEEDED', '读取并发上限', true);
    const id = randomUUID();
    db.prepare('INSERT INTO read_leases VALUES(?,?,?,?,?)').run(
      id,
      p.id,
      p.clientId,
      channel,
      Date.now() + 30000,
    );
    return () => db.prepare('DELETE FROM read_leases WHERE id=?').run(id);
  })();
}
export function chargeRate(db: AppDatabase, p: Principal, channel: ReadChannel, bytes: number) {
  const window = Math.floor(Date.now() / 60000);
  const old =
    (
      db
        .prepare(
          'SELECT bytes FROM read_rates WHERE principal=? AND client_id=? AND channel=? AND window=?',
        )
        .get(p.id, p.clientId, channel, window) as any
    )?.bytes || 0;
  if (old + bytes > readPolicies[channel].rate)
    fail(429, 'READ_RATE_EXCEEDED', '读取速率上限', true);
  db.prepare(
    'INSERT INTO read_rates VALUES(?,?,?,?,?) ON CONFLICT(principal,client_id,channel,window) DO UPDATE SET bytes=bytes+excluded.bytes',
  ).run(p.id, p.clientId, channel, window, bytes);
}
