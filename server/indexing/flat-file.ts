import { mkdir, open, rename, unlink } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { AppDatabase } from '../db.js';
import type { SourceVersion, PreparedVectorBatch } from '../../shared/knowledge-contracts.js';
import type { VectorRuntimeClient } from './vector-store.js';
import { writeAll, hashFile, readBlocks } from '../knowledge/file-reader.js';
import { sha256 } from '../knowledge/operations.js';
import { fail } from '../knowledge/errors.js';
import { recallFilter } from '../search/filters.js';
import type { Principal, SearchInput } from '../../shared/knowledge-contracts.js';
import { backfillPoints, compactVectors } from './compaction.js';
import { desiredSpace } from './space.js';
interface VectorPoint {
  chunkId: string;
  noteId: string;
  sourceHash: string;
  inputHash: string;
}
export class FlatFileStore {
  readonly name = 'flat_file';
  private masks = new Map<string, string>();
  constructor(
    private db: AppDatabase,
    private root: string,
    private client: VectorRuntimeClient,
    private space: string,
  ) {
    db.exec(`CREATE TABLE IF NOT EXISTS vector_segments(id TEXT PRIMARY KEY,space_id TEXT NOT NULL,note_id TEXT NOT NULL,source_revision INTEGER NOT NULL,source_hash TEXT NOT NULL,file TEXT NOT NULL,checksum TEXT NOT NULL,row_count INTEGER NOT NULL);
   CREATE TABLE IF NOT EXISTS vector_segment_rows(segment_id TEXT NOT NULL,row INTEGER NOT NULL,chunk_id TEXT NOT NULL,note_id TEXT NOT NULL,source_hash TEXT NOT NULL,input_hash TEXT NOT NULL,PRIMARY KEY(segment_id,row));
   CREATE TABLE IF NOT EXISTS generation_segments(generation TEXT NOT NULL,segment_id TEXT NOT NULL,PRIMARY KEY(generation,segment_id));
   CREATE TABLE IF NOT EXISTS vector_cache(space_id TEXT NOT NULL,input_hash TEXT NOT NULL,value BLOB NOT NULL,PRIMARY KEY(space_id,input_hash));`);
    db.exec(
      'CREATE TABLE IF NOT EXISTS vector_points(space_id TEXT NOT NULL,chunk_id TEXT NOT NULL,note_id TEXT NOT NULL,source_hash TEXT NOT NULL,source_revision INTEGER NOT NULL,input_hash TEXT NOT NULL,segment_id TEXT NOT NULL,row INTEGER NOT NULL,PRIMARY KEY(space_id,chunk_id)); CREATE INDEX IF NOT EXISTS points_in_segment ON vector_points(space_id,segment_id,row); CREATE INDEX IF NOT EXISTS rows_by_chunk ON vector_rows(generation,chunk_id)',
    );
    db.exec(
      'CREATE TABLE IF NOT EXISTS vector_query_pins(id TEXT PRIMARY KEY,generation TEXT NOT NULL,expires_at INTEGER NOT NULL); CREATE INDEX IF NOT EXISTS pinned_vector_generation ON vector_query_pins(generation,expires_at)',
    );
  }
  current() {
    return ((
      this.db.prepare("SELECT value FROM index_meta WHERE key='active_generation'").get() as any
    )?.value || null) as string | null;
  }
  async prepare(
    version: SourceVersion,
    chunks: VectorPoint[],
    vectors: number[][],
    complete = true,
  ): Promise<PreparedVectorBatch> {
    if (chunks.length > 16 || vectors.length !== chunks.length || !chunks.length)
      fail(400, 'INVALID_VECTOR_BATCH');
    const bytes = Buffer.alloc(chunks.length * 512 * 4);
    for (let row = 0; row < vectors.length; row++) {
      const v = vectors[row];
      if (v.length !== 512 || !v.every(Number.isFinite)) fail(400, 'INVALID_VECTOR');
      const norm = Math.sqrt(v.reduce((n, x) => n + x * x, 0));
      if (!Number.isFinite(norm) || norm === 0) fail(400, 'INVALID_VECTOR');
      if (chunks[row].noteId !== version.noteId || chunks[row].sourceHash !== version.contentHash)
        fail(409, 'INDEX_VERSION_CONFLICT');
      for (let col = 0; col < 512; col++) bytes.writeFloatLE(v[col] / norm, (row * 512 + col) * 4);
    }
    const id = randomUUID(),
      directory = join(this.root, 'segments');
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const file = join(directory, `${id}.f32`),
      temporary = file + '.tmp',
      fd = await open(temporary, 'wx', 0o600);
    try {
      await writeAll(fd, bytes);
      await fd.sync();
    } finally {
      await fd.close();
    }
    await rename(temporary, file);
    const checksum = await hashFile(file);
    this.db.transaction(() => {
      this.db
        .prepare('INSERT INTO vector_segments VALUES(?,?,?,?,?,?,?,?)')
        .run(
          id,
          this.space,
          version.noteId,
          version.sourceRevision,
          version.contentHash,
          file,
          checksum,
          chunks.length,
        );
      for (let row = 0; row < chunks.length; row++) {
        const c = chunks[row];
        this.db
          .prepare('INSERT INTO vector_segment_rows VALUES(?,?,?,?,?,?)')
          .run(id, row, c.chunkId, c.noteId, c.sourceHash, c.inputHash);
        this.db
          .prepare(
            'INSERT INTO vector_points VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(space_id,chunk_id) DO UPDATE SET source_revision=excluded.source_revision,source_hash=excluded.source_hash,input_hash=excluded.input_hash,segment_id=excluded.segment_id,row=excluded.row',
          )
          .run(
            this.space,
            c.chunkId,
            c.noteId,
            c.sourceHash,
            version.sourceRevision,
            c.inputHash,
            id,
            row,
          );
        this.db
          .prepare('INSERT OR IGNORE INTO vector_cache VALUES(?,?,?)')
          .run(this.space, c.inputHash, bytes.subarray(row * 2048, (row + 1) * 2048));
      }
    })();
    return complete
      ? this.finalize(version)
      : {
          ...version,
          generation: '',
          baseGeneration: this.current(),
          embeddingSpaceId: this.space,
          manifestPath: '',
          checksum: '',
        };
  }
  cached(inputHash: string) {
    const row = this.db
      .prepare('SELECT value FROM vector_cache WHERE space_id=? AND input_hash=?')
      .get(this.space, inputHash) as { value: Buffer } | undefined;
    if (!row) return null;
    return Array.from({ length: 512 }, (_, i) => row.value.readFloatLE(i * 4));
  }
  async finalize(version: SourceVersion): Promise<PreparedVectorBatch> {
    backfillPoints(this.db, this.space);
    const generation = randomUUID(),
      baseGeneration = this.current(),
      directory = join(this.root, 'generations');
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const manifestPath = join(directory, `${generation}.json`),
      temporary = manifestPath + '.tmp',
      fd = await open(temporary, 'wx', 0o600);
    let rowNumber = 0,
      firstSegment = true;
    const selectSegments = this.db.prepare(
      `SELECT s.* FROM vector_segments s WHERE s.space_id=? AND s.id>? AND EXISTS(SELECT 1 FROM vector_points p JOIN document_state d ON d.note_id=p.note_id JOIN notes n ON n.id=p.note_id WHERE p.segment_id=s.id AND p.space_id=s.space_id AND d.active=1 AND n.active=1 AND d.conflict=0 AND p.source_hash=d.content_hash AND p.source_revision=d.source_revision AND ((p.note_id=? AND p.source_revision=? AND p.source_hash=?) OR (p.note_id<>? AND EXISTS(SELECT 1 FROM vector_rows r WHERE r.generation=? AND r.chunk_id=p.chunk_id AND r.source_hash=p.source_hash)))) ORDER BY s.id LIMIT 32`,
    );
    function* segmentPages(this: FlatFileStore) {
      let after = '';
      while (true) {
        const rows = selectSegments.all(
          this.space,
          after,
          version.noteId,
          version.sourceRevision,
          version.contentHash,
          version.noteId,
          baseGeneration,
        ) as any[];
        if (!rows.length) return;
        yield* rows;
        after = rows.at(-1).id;
      }
    }
    this.db
      .prepare(
        'INSERT INTO vector_generations(id,space_id,manifest_path,checksum,status,base_generation,created_at) VALUES(?,?,?,?,?,?,?)',
      )
      .run(generation, this.space, manifestPath, '', 'preparing', baseGeneration, Date.now());
    try {
      await writeAll(
        fd,
        Buffer.from(
          JSON.stringify({
            generation,
            baseGeneration,
            embeddingSpaceId: this.space,
            dimensions: 512,
          }).slice(0, -1) + ',"segments":[',
        ),
      );
      for (const segment of segmentPages.call(this)) {
        await writeAll(
          fd,
          Buffer.from(
            (firstSegment ? '' : ',') +
              JSON.stringify({
                id: segment.id,
                file: segment.file,
                checksum: segment.checksum,
                rowCount: segment.row_count,
              }).slice(0, -1) +
              ',"rows":[',
          ),
        );
        firstSegment = false;
        let firstRow = true;
        this.db.prepare('INSERT INTO generation_segments VALUES(?,?)').run(generation, segment.id);
        let afterRow = -1;
        while (true) {
          const rows = this.db
            .prepare(
              `SELECT p.* FROM vector_points p JOIN document_state d ON d.note_id=p.note_id JOIN notes n ON n.id=p.note_id WHERE p.segment_id=? AND p.row>? AND p.space_id=? AND d.active=1 AND n.active=1 AND d.conflict=0 AND p.source_hash=d.content_hash AND p.source_revision=d.source_revision AND ((p.note_id=? AND p.source_revision=? AND p.source_hash=?) OR (p.note_id<>? AND EXISTS(SELECT 1 FROM vector_rows r WHERE r.generation=? AND r.chunk_id=p.chunk_id AND r.source_hash=p.source_hash))) ORDER BY p.row LIMIT 128`,
            )
            .all(
              segment.id,
              afterRow,
              this.space,
              version.noteId,
              version.sourceRevision,
              version.contentHash,
              version.noteId,
              baseGeneration,
            ) as any[];
          if (!rows.length) break;
          for (const row of rows) {
            const entry = {
              chunkId: row.chunk_id,
              noteId: row.note_id,
              sourceHash: row.source_hash,
              rowIndex: row.row,
            };
            await writeAll(fd, Buffer.from((firstRow ? '' : ',') + JSON.stringify(entry)));
            firstRow = false;
            this.db
              .prepare('INSERT INTO vector_rows VALUES(?,?,?,?,?)')
              .run(generation, rowNumber++, row.chunk_id, row.note_id, row.source_hash);
          }
          afterRow = rows.at(-1).row;
        }
        await writeAll(fd, Buffer.from(']}'));
      }
      await writeAll(fd, Buffer.from(']}'));
      await fd.sync();
    } catch (e) {
      this.db.prepare("UPDATE vector_generations SET status='failed' WHERE id=?").run(generation);
      throw e;
    } finally {
      await fd.close();
    }
    await rename(temporary, manifestPath);
    const checksum = await hashFile(manifestPath);
    await this.client.call('/generations/load', {
      manifestPath: resolve(manifestPath),
      checksum,
      spaceId: this.space,
    });
    this.db
      .prepare("UPDATE vector_generations SET status='ready',checksum=? WHERE id=?")
      .run(checksum, generation);
    return {
      ...version,
      generation,
      baseGeneration,
      embeddingSpaceId: this.space,
      manifestPath,
      checksum,
    };
  }
  async publish(initial: PreparedVectorBatch, valid: () => boolean = () => true): Promise<string> {
    let prepared = initial;
    for (let attempt = 0; attempt < 10; attempt++) {
      const current = this.current();
      if (current !== prepared.baseGeneration) {
        this.db
          .prepare("UPDATE vector_generations SET status='retired' WHERE id=? AND status='ready'")
          .run(prepared.generation);
        prepared = await this.finalize(prepared);
      }
      const outcome = this.db.transaction(() => {
        const state = this.db
          .prepare('SELECT * FROM document_state WHERE note_id=?')
          .get(prepared.noteId) as any;
        if (
          !valid() ||
          desiredSpace(this.db, this.space) !== this.space ||
          prepared.embeddingSpaceId !== this.space ||
          !state?.active ||
          state.conflict ||
          state.content_hash !== prepared.contentHash ||
          state.source_revision !== prepared.sourceRevision
        )
          return 'superseded';
        if (this.current() !== prepared.baseGeneration) return 'rebase';
        if (
          this.db
            .prepare("SELECT 1 FROM sync_runs WHERE status IN ('running','needs_reconciliation')")
            .get()
        )
          return 'paused';
        this.db
          .prepare("UPDATE vector_generations SET status='retired' WHERE status='active'")
          .run();
        this.db
          .prepare("UPDATE vector_generations SET status='active' WHERE id=? AND status='ready'")
          .run(prepared.generation);
        this.db
          .prepare(
            "INSERT INTO index_meta VALUES('active_generation',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
          )
          .run(prepared.generation);
        this.db
          .prepare('UPDATE document_state SET vector_indexed_hash=? WHERE note_id=?')
          .run(prepared.contentHash, prepared.noteId);
        return 'published';
      })();
      if (outcome === 'rebase') continue;
      if (outcome === 'paused') fail(503, 'SYNC_IN_PROGRESS');
      if (outcome === 'superseded')
        this.db
          .prepare("UPDATE vector_generations SET status='retired' WHERE id=? AND status='ready'")
          .run(prepared.generation);
      if (outcome === 'published') await this.maintain();
      return outcome;
    }
    return fail(503, 'VECTOR_PUBLISH_BUSY', '索引发布繁忙', true);
  }
  async search(
    vector: number[],
    allowed: string[] | Principal,
    limit: number,
    filters?: SearchInput['filters'],
  ): Promise<any[]> {
    const generation = this.current();
    if (!generation) fail(503, 'INDEX_NOT_READY');
    const pin = randomUUID();
    this.db
      .prepare('INSERT INTO vector_query_pins VALUES(?,?,?)')
      .run(pin, generation, Date.now() + 60000);
    try {
      const epoch =
        (this.db.prepare("SELECT value FROM index_meta WHERE key='index_epoch'").get() as any)
          ?.value || '0';
      const key = sha256(JSON.stringify([generation, epoch, allowed, filters || {}]));
      let encoded = this.masks.get(key);
      if (!encoded) {
        const row = (
            this.db
              .prepare('SELECT count(*) n FROM vector_rows WHERE generation=?')
              .get(generation) as any
          ).n,
          bitmap = Buffer.alloc(Math.ceil(row / 8));
        if (Array.isArray(allowed)) {
          const set = new Set(allowed);
          for (const entry of this.db
            .prepare('SELECT row,chunk_id FROM vector_rows WHERE generation=?')
            .iterate(generation) as Iterable<any>)
            if (set.has(entry.chunk_id)) bitmap[entry.row >> 3] |= 1 << (entry.row & 7);
        } else {
          const filter = recallFilter(allowed, filters);
          for (const entry of this.db
            .prepare(
              `SELECT (r.row >> 3) byte,sum(1 << (r.row & 7)) bits FROM vector_rows r JOIN chunks c INDEXED BY vector_active_chunks ON c.chunk_id=r.chunk_id JOIN document_state d ON d.note_id=r.note_id JOIN notes n ON n.id=r.note_id WHERE r.generation=? AND c.active=1 AND n.active=1 AND d.active=1 AND d.conflict=0 AND r.source_hash=d.content_hash AND c.source_revision=d.source_revision AND (${filter.sql}) GROUP BY (r.row >> 3)`,
            )
            .iterate(generation, ...filter.values) as Iterable<any>)
            bitmap[entry.byte] = entry.bits;
        }
        encoded = bitmap.toString('base64');
        if (encoded.length <= 1024 * 1024) {
          this.masks.set(key, encoded);
          while (
            this.masks.size > 16 ||
            [...this.masks.values()].reduce((n, value) => n + value.length, 0) > 2 * 1024 * 1024
          )
            this.masks.delete(this.masks.keys().next().value!);
        }
      }
      const body = {
        generation,
        queryVector: vector,
        spaceId: this.space,
        allowedRows: encoded,
        limit,
      };
      try {
        return (await this.client.call('/vectors/search', body)).results;
      } catch (e) {
        if ((e as any).code !== 'GENERATION_NOT_LOADED') throw e;
        const gen =
          (this.db
            .prepare('SELECT * FROM vector_generations WHERE id=? AND status=?')
            .get(generation, 'active') as any) ||
          (this.db
            .prepare('SELECT * FROM vector_generations WHERE id=? AND status=?')
            .get(generation, 'retired') as any);
        if (!gen) fail(503, 'GENERATION_NOT_LOADED');
        await this.client.call('/generations/load', {
          manifestPath: gen.manifest_path,
          checksum: gen.checksum,
          spaceId: this.space,
        });
        return (await this.client.call('/vectors/search', body)).results;
      }
    } finally {
      this.db.prepare('DELETE FROM vector_query_pins WHERE id=?').run(pin);
    }
  }
  async maintain() {
    this.db.prepare('DELETE FROM vector_query_pins WHERE expires_at<=?').run(Date.now());
    const generations = this.db
      .prepare(
        "SELECT g.* FROM vector_generations g WHERE g.status IN ('retired','failed') AND NOT EXISTS(SELECT 1 FROM vector_query_pins p WHERE p.generation=g.id AND p.expires_at>?) LIMIT 32",
      )
      .all(Date.now()) as any[];
    for (const generation of generations) {
      await this.client.call('/generations/retire', { generation: generation.id });
      const removable = this.db.transaction(() => {
        if (
          this.current() === generation.id ||
          this.db
            .prepare('SELECT 1 FROM vector_query_pins WHERE generation=? AND expires_at>?')
            .get(generation.id, Date.now())
        )
          return false;
        this.db.prepare('DELETE FROM vector_rows WHERE generation=?').run(generation.id);
        this.db.prepare('DELETE FROM generation_segments WHERE generation=?').run(generation.id);
        this.db.prepare('DELETE FROM vector_generations WHERE id=?').run(generation.id);
        return true;
      })();
      if (
        removable &&
        generation.manifest_path === join(this.root, 'generations', generation.id + '.json')
      )
        await unlink(generation.manifest_path).catch(() => {});
    }
    this.db
      .prepare(
        'DELETE FROM vector_points WHERE space_id=? AND NOT EXISTS(SELECT 1 FROM notes n JOIN document_state d ON d.note_id=n.id WHERE n.id=vector_points.note_id AND n.active=1 AND d.active=1 AND d.content_hash=vector_points.source_hash AND d.source_revision=vector_points.source_revision)',
      )
      .run(this.space);
    const segments = this.db
      .prepare(
        'SELECT s.* FROM vector_segments s WHERE NOT EXISTS(SELECT 1 FROM generation_segments g WHERE g.segment_id=s.id) AND NOT EXISTS(SELECT 1 FROM vector_points p WHERE p.segment_id=s.id) LIMIT 32',
      )
      .all() as any[];
    for (const segment of segments) {
      if (segment.file !== join(this.root, 'segments', segment.id + '.f32')) continue;
      this.db.prepare('DELETE FROM vector_segment_rows WHERE segment_id=?').run(segment.id);
      this.db.prepare('DELETE FROM vector_segments WHERE id=?').run(segment.id);
      await unlink(segment.file).catch(() => {});
    }
  }
  async compact(force = false) {
    return compactVectors(
      this.db,
      this.root,
      this.client,
      this.space,
      () => this.current(),
      () => this.maintain(),
      force,
    );
  }
}
