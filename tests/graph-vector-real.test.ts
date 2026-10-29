import { afterEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { openDatabase } from '../packages/core/db.js';
import { createKnowledgeGraph } from '../packages/core/graph/knowledge-service.js';
import { hash } from '../packages/core/graph/analysis-source.js';
import { observeSource } from '../packages/core/indexing/state.js';
import { FlatFileStore } from '../packages/core/indexing/flat-file.js';
import { VectorRuntimeClient } from '../packages/core/indexing/vector-store.js';
import { webPrincipal } from '../packages/core/knowledge/core.js';
import type { NoteService } from '../packages/core/notes.js';
import type { GraphModelPort } from '../shared/graph-semantic-contracts.js';
import { startVectorRuntime } from './support/vector-runtime.js';

// Fixed acceptance corpus and thresholds, independent of the model's measured scores.
const corpus = [
  {
    id: 'backup-original',
    text: '把家中照片定期复制到另一块硬盘，并把一份备份放到异地；每隔一段时间尝试恢复，确认资料能够找回。',
  },
  {
    id: 'backup-paraphrase',
    text: '家庭相册需要按计划保存副本到独立磁盘，还应在不同地点留存一份，并定期演练还原，检查重要影像是否完整。',
  },
  {
    id: 'unrelated-recipe',
    text: '制作番茄炒蛋时，先将鸡蛋打散炒熟盛出，再炒软番茄，最后混合调味即可。',
  },
] as const;
const THRESHOLD = 0.65;
const pythonPath =
  process.env.DOOKNOW_TEST_VECTOR_PYTHON ?? resolve('runtime/vector-service/.venv/bin/python');
const modelDir = process.env.DOOKNOW_TEST_MODEL_DIR ?? resolve('.local/models/bge-small-zh-v1.5');
const realModelAvailable =
  existsSync(pythonPath) && existsSync(join(modelDir, 'dooknow-model-manifest.json'));
// An explicit acceptance run must fail on a bad path rather than silently becoming a skip.
const realModelRequested = !!(
  process.env.DOOKNOW_TEST_VECTOR_PYTHON || process.env.DOOKNOW_TEST_MODEL_DIR
);
const cleanups: (() => unknown)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'graph-real-bge-'));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const config = {
    knowledgeRoot: join(root, 'knowledge'),
    dataRoot: join(root, 'data'),
    secret: 'fixture-only-secret',
    origin: 'http://test',
  };
  mkdirSync(config.knowledgeRoot);
  const db = openDatabase(config.dataRoot);
  cleanups.push(() => db.close());
  const model: GraphModelPort = {
    settings: () => ({
      version: 1,
      provider: 'none',
      baseUrl: '',
      model: '',
      automatic: true,
      remoteContentAllowed: false,
      apiKeyConfigured: false,
      timeoutMs: 1000,
      maxInputCharacters: 12000,
    }),
    fingerprint: () => 'real-vector-acceptance-no-chat-model',
    update: () => {
      throw new Error('No extraction model is configured');
    },
    test: async () => ({ ok: false, message: 'No extraction model is configured' }),
    extract: async () => {
      throw new Error('No extraction model is configured');
    },
    answer: async () => {
      throw new Error('No extraction model is configured');
    },
  };
  const graph = createKnowledgeGraph(config, db, {} as NoteService, model);
  cleanups.push(() => graph.close());
  return { config, db, graph };
}

it('reports unconfigured and unsupported vector spaces honestly without a model', async () => {
  const { db, graph } = fixture();
  const missing = await graph.explore(webPrincipal, { includeSimilarity: true });
  expect(missing.similarity?.state).toBe('unconfigured');
  expect(missing.edges.filter((edge) => edge.kind === 'similarity')).toEqual([]);
  db.prepare("INSERT INTO index_meta VALUES('desired_embedding_space','unsupported-space')").run();
  db.prepare('INSERT INTO embedding_spaces VALUES(?,?,?)').run('unsupported-space', 256, '{}');
  const unsupported = await graph.explore(webPrincipal, { includeSimilarity: true });
  expect(unsupported.similarity?.state).not.toBe('ready');
  expect(unsupported.edges.filter((edge) => edge.kind === 'similarity')).toEqual([]);
});

describe.skipIf(!realModelAvailable && !realModelRequested)(
  'actual local BGE document embeddings',
  () => {
    it('publishes real paraphrase vectors and serves two-sided semantic evidence with the runtime stopped', async () => {
      const { config, db, graph } = fixture();
      const runtime = await startVectorRuntime(config.dataRoot, { pythonPath, modelDir });
      cleanups.push(() => runtime.close());
      const client = new VectorRuntimeClient(runtime.url, runtime.token, runtime.spaceId);
      const store = new FlatFileStore(db, runtime.indexRoot, client, runtime.spaceId);
      db.prepare("INSERT INTO index_meta VALUES('desired_embedding_space',?)").run(runtime.spaceId);
      db.prepare('INSERT INTO embedding_spaces VALUES(?,?,?)').run(runtime.spaceId, 512, '{}');
      // Documents protocol is intentional: no query instruction or fabricated vectors.
      const vectors = await client.documents(corpus.map((note) => note.text));
      expect(vectors).toHaveLength(corpus.length);
      for (const vector of vectors) {
        expect(vector).toHaveLength(512);
        expect(vector.every(Number.isFinite)).toBe(true);
        expect(Math.hypot(...vector)).toBeCloseTo(1, 5);
      }
      const cosine = (a: number[], b: number[]) =>
        a.reduce((sum, value, i) => sum + value * b[i], 0) / (Math.hypot(...a) * Math.hypot(...b));
      const paraphraseScore = cosine(vectors[0], vectors[1]);
      const originalUnrelatedScore = cosine(vectors[0], vectors[2]);
      const paraphraseUnrelatedScore = cosine(vectors[1], vectors[2]);
      console.info(
        'Actual BGE fixed-corpus cosine:',
        JSON.stringify({
          spaceId: runtime.spaceId,
          paraphraseScore,
          originalUnrelatedScore,
          paraphraseUnrelatedScore,
        }),
      );
      expect(paraphraseScore).toBeGreaterThan(THRESHOLD);
      expect(originalUnrelatedScore).toBeLessThan(THRESHOLD);
      expect(paraphraseUnrelatedScore).toBeLessThan(THRESHOLD);
      expect(
        paraphraseScore - Math.max(originalUnrelatedScore, paraphraseUnrelatedScore),
      ).toBeGreaterThan(0.15);

      for (let i = 0; i < corpus.length; i++) {
        const note = corpus[i];
        const path = `${note.id}.md`;
        const absolutePath = join(config.knowledgeRoot, path);
        writeFileSync(absolutePath, note.text);
        db.prepare('INSERT INTO notes(id,path) VALUES(?,?)').run(note.id, path);
        const stat = statSync(absolutePath, { bigint: true });
        const version = observeSource(
          db,
          note.id,
          hash(note.text),
          String(stat.mtimeNs),
          Number(stat.size),
        );
        const chunkId = hash([note.id, version.contentHash, 'real-bge-acceptance', '0'].join('\0'));
        const inputHash = hash(note.text);
        db.prepare(
          `INSERT INTO chunks(chunk_id,note_id,source_hash,source_revision,chunker_id,ordinal,
        heading_path,start_line,end_line,content,input_hash,title,path,active,start_byte,end_byte)
        VALUES(?,?,?,?,?,0,'[]',1,1,?,?,?,?,1,0,?)`,
        ).run(
          chunkId,
          note.id,
          version.contentHash,
          version.sourceRevision,
          'real-bge-acceptance',
          note.text,
          inputHash,
          note.id,
          path,
          Number(stat.size),
        );
        db.prepare('UPDATE document_state SET text_indexed_hash=?,title=? WHERE note_id=?').run(
          version.contentHash,
          note.id,
          note.id,
        );
        expect(
          await store.publish(
            await store.prepare(
              version,
              [
                {
                  chunkId,
                  noteId: note.id,
                  sourceHash: version.contentHash,
                  inputHash,
                },
              ],
              [vectors[i]],
            ),
          ),
        ).toBe('published');
      }
      graph.start();
      await vi.waitFor(() => expect(graph.status(webPrincipal).completed).toBe(corpus.length), {
        timeout: 8000,
        interval: 50,
      });
      // No graph similarity request has been made yet; the first one must read the published cache offline.
      await runtime.close();
      await expect(
        fetch(`${runtime.url}/health`, { signal: AbortSignal.timeout(1000) }),
      ).rejects.toThrow();
      const result = await graph.explore(webPrincipal, {
        view: 'notes',
        includeSimilarity: true,
        similarityThreshold: THRESHOLD,
      });
      expect(result.similarity).toMatchObject({ state: 'ready', readyNotes: 3, dimensions: 512 });
      const edges = result.edges.filter((edge) => edge.kind === 'similarity');
      expect(edges).toHaveLength(1);
      const edge = edges[0];
      expect(new Set([edge.source, edge.target])).toEqual(
        new Set(corpus.slice(0, 2).map((note) => note.id)),
      );
      expect(edge.similarity).toMatchObject({
        method: 'embedding-cosine',
        spaceId: runtime.spaceId,
        dimensions: 512,
        aggregation: 'overlap-weighted-mean',
      });
      expect(edge.similarity!.score).toBeCloseTo(paraphraseScore, 5);
      expect(new Set(edge.evidence.map((item) => item.noteId))).toEqual(
        new Set(corpus.slice(0, 2).map((note) => note.id)),
      );
      for (const evidence of edge.evidence) {
        const note = corpus.find((item) => item.id === evidence.noteId)!;
        expect(evidence).toMatchObject({
          method: 'embedding',
          embeddingSpaceId: runtime.spaceId,
          relativePath: `${note.id}.md`,
          sourceHash: hash(note.text),
          sourceRevision: 1,
          startLine: 1,
          endLine: 1,
          quote: note.text,
        });
        expect(evidence.chunkId).toBeTruthy();
      }
      const focused = await graph.explore(webPrincipal, {
        view: 'notes',
        focus: corpus[0].id,
        depth: 1,
        includeSimilarity: true,
        similarityThreshold: THRESHOLD,
      });
      expect(focused.nodes.map((node) => node.id)).toContain(corpus[1].id);
      expect(focused.edges.find((item) => item.id === edge.id)?.similarity?.score).toBeCloseTo(
        paraphraseScore,
        5,
      );
    }, 60000);
  },
);
