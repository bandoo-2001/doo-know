import { mkdir, open, rename, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { AppDatabase } from '../db.js';
import type { VectorRuntimeClient } from './vector-store.js';
import { writeAll, hashFile } from '../knowledge/file-reader.js';
import { fail } from '../knowledge/errors.js';
import { desiredSpace } from './space.js';

export function backfillPoints(db: AppDatabase, space: string) {
  db.prepare(
    'INSERT OR IGNORE INTO vector_points SELECT s.space_id,r.chunk_id,r.note_id,r.source_hash,d.source_revision,r.input_hash,r.segment_id,r.row FROM vector_segment_rows r JOIN vector_segments s ON s.id=r.segment_id JOIN document_state d ON d.note_id=r.note_id JOIN notes n ON n.id=r.note_id WHERE s.space_id=? AND n.active=1 AND d.active=1 AND d.content_hash=r.source_hash',
  ).run(space);
}

export async function compactVectors(
  db: AppDatabase,
  root: string,
  client: VectorRuntimeClient,
  space: string,
  current: () => string | null,
  maintain: () => Promise<void>,
  force = false,
) {
  const base = current();
  if (!base) return false;
  if (desiredSpace(db, space) !== space) return false;
  backfillPoints(db, space);
  if (!db.prepare('SELECT 1 FROM vector_generations WHERE id=? AND space_id=?').get(base, space))
    return false;
  const total = (
    db.prepare('SELECT count(*) n FROM vector_rows WHERE generation=?').get(base) as any
  ).n;
  const activeWhere =
    'd.active=1 AND n.active=1 AND d.conflict=0 AND p.source_hash=d.content_hash AND p.source_revision=d.source_revision AND EXISTS(SELECT 1 FROM vector_rows r WHERE r.generation=? AND r.chunk_id=p.chunk_id AND r.source_hash=p.source_hash)';
  const active = (
    db
      .prepare(
        `SELECT count(*) n FROM vector_points p JOIN document_state d ON d.note_id=p.note_id JOIN notes n ON n.id=p.note_id WHERE p.space_id=? AND ${activeWhere}`,
      )
      .get(space, base) as any
  ).n;
  const count = (
    db.prepare('SELECT count(*) n FROM generation_segments WHERE generation=?').get(base) as any
  ).n;
  if (!force && count < 32 && (!total || (total - active) / total < 0.2)) return false;
  const pin = randomUUID(),
    generation = randomUUID(),
    id = randomUUID(),
    file = join(root, 'segments', id + '.f32'),
    manifest = join(root, 'generations', generation + '.json');
  db.prepare('INSERT INTO vector_query_pins VALUES(?,?,?)').run(pin, base, Date.now() + 60000);
  const heartbeat = setInterval(
    () =>
      db
        .prepare('UPDATE vector_query_pins SET expires_at=? WHERE id=?')
        .run(Date.now() + 60000, pin),
    15000,
  );
  heartbeat.unref();
  let rowNumber = 0,
    published = false,
    fd: Awaited<ReturnType<typeof open>> | undefined;
  try {
    await mkdir(join(root, 'segments'), { recursive: true, mode: 0o700 });
    await mkdir(join(root, 'generations'), { recursive: true, mode: 0o700 });
    fd = await open(file + '.tmp', 'wx', 0o600);
    let afterSegment = '';
    while (true) {
      const segments = db
        .prepare(
          `SELECT DISTINCT s.* FROM vector_segments s JOIN vector_points p ON p.segment_id=s.id JOIN document_state d ON d.note_id=p.note_id JOIN notes n ON n.id=p.note_id WHERE s.space_id=? AND s.id>? AND ${activeWhere} ORDER BY s.id LIMIT 32`,
        )
        .all(space, afterSegment, base) as any[];
      if (!segments.length) break;
      for (const segment of segments) {
        if ((await hashFile(segment.file)) !== segment.checksum) fail(409, 'INDEX_CORRUPT');
        const input = await open(segment.file, 'r');
        try {
          let after = -1;
          while (true) {
            const points = db
              .prepare(
                `SELECT p.* FROM vector_points p JOIN document_state d ON d.note_id=p.note_id JOIN notes n ON n.id=p.note_id WHERE p.space_id=? AND p.segment_id=? AND p.row>? AND ${activeWhere} ORDER BY p.row LIMIT 32`,
              )
              .all(space, segment.id, after, base) as any[];
            if (!points.length) break;
            const bytes = Buffer.alloc(points.length * 2048);
            for (let i = 0; i < points.length; i++) {
              const r = await input.read(bytes, i * 2048, 2048, points[i].row * 2048);
              if (r.bytesRead !== 2048) fail(409, 'INDEX_CORRUPT');
            }
            await writeAll(fd, bytes);
            db.transaction(() => {
              for (const point of points)
                db.prepare('INSERT INTO vector_segment_rows VALUES(?,?,?,?,?,?)').run(
                  id,
                  rowNumber++,
                  point.chunk_id,
                  point.note_id,
                  point.source_hash,
                  point.input_hash,
                );
            })();
            after = points.at(-1).row;
          }
        } finally {
          await input.close();
        }
      }
      afterSegment = segments.at(-1).id;
    }
    await fd.sync();
    await fd.close();
    fd = undefined;
    await rename(file + '.tmp', file);
    const checksum = await hashFile(file);
    fd = await open(manifest + '.tmp', 'wx', 0o600);
    await writeAll(
      fd,
      Buffer.from(
        JSON.stringify({
          generation,
          baseGeneration: base,
          embeddingSpaceId: space,
          dimensions: 512,
        }).slice(0, -1) +
          ',"segments":[' +
          JSON.stringify({ id, file, checksum, rowCount: rowNumber }).slice(0, -1) +
          ',"rows":[',
      ),
    );
    let after = -1,
      first = true;
    while (true) {
      const rows = db
        .prepare(
          'SELECT * FROM vector_segment_rows WHERE segment_id=? AND row>? ORDER BY row LIMIT 128',
        )
        .all(id, after) as any[];
      if (!rows.length) break;
      for (const row of rows) {
        await writeAll(
          fd,
          Buffer.from(
            (first ? '' : ',') +
              JSON.stringify({
                chunkId: row.chunk_id,
                noteId: row.note_id,
                sourceHash: row.source_hash,
              }),
          ),
        );
        first = false;
      }
      after = rows.at(-1).row;
    }
    await writeAll(fd, Buffer.from(']}]}'));
    await fd.sync();
    await fd.close();
    fd = undefined;
    await rename(manifest + '.tmp', manifest);
    const manifestHash = await hashFile(manifest);
    await client.call('/generations/load', {
      manifestPath: manifest,
      checksum: manifestHash,
      spaceId: space,
    });
    published = db.transaction(() => {
      if (
        current() !== base ||
        desiredSpace(db, space) !== space ||
        (db.prepare('SELECT active FROM maintenance WHERE id=1').get() as any).active ||
        db
          .prepare("SELECT 1 FROM sync_runs WHERE status IN ('running','needs_reconciliation')")
          .get()
      )
        return false;
      db.prepare('INSERT INTO vector_segments VALUES(?,?,?,?,?,?,?,?)').run(
        id,
        space,
        'compacted',
        0,
        'compacted',
        file,
        checksum,
        rowNumber,
      );
      db.prepare('INSERT INTO vector_generations VALUES(?,?,?,?,?,?,?)').run(
        generation,
        space,
        manifest,
        manifestHash,
        'active',
        base,
        Date.now(),
      );
      db.prepare('INSERT INTO generation_segments VALUES(?,?)').run(generation, id);
      db.prepare(
        'INSERT INTO vector_rows SELECT ?,row,chunk_id,note_id,source_hash FROM vector_segment_rows WHERE segment_id=?',
      ).run(generation, id);
      db.prepare(
        'UPDATE vector_points SET segment_id=?,row=(SELECT r.row FROM vector_segment_rows r WHERE r.segment_id=? AND r.chunk_id=vector_points.chunk_id) WHERE space_id=? AND chunk_id IN (SELECT chunk_id FROM vector_segment_rows WHERE segment_id=?)',
      ).run(id, id, space, id);
      db.prepare("UPDATE vector_generations SET status='retired' WHERE id=?").run(base);
      db.prepare("UPDATE index_meta SET value=? WHERE key='active_generation'").run(generation);
      return true;
    }).immediate();
    if (!published) await client.call('/generations/retire', { generation });
    return published;
  } finally {
    await fd?.close();
    clearInterval(heartbeat);
    db.prepare('DELETE FROM vector_query_pins WHERE id=?').run(pin);
    if (!published) {
      db.prepare('DELETE FROM vector_segment_rows WHERE segment_id=?').run(id);
      for (const path of [file, file + '.tmp', manifest, manifest + '.tmp'])
        await unlink(path).catch(() => {});
    }
    await maintain().catch(() => {});
  }
}
