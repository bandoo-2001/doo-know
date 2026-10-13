import { describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseOptions, statistics, qualityScore, assertBenchmarkOutput } from './support.js';
import { syntheticFixture } from './fixtures.js';
import { writeSample } from '../../scripts/file-benchmark.js';

describe('isolated benchmark contracts', () => {
  it('rejects unsafe output destinations and malformed workload parameters', () => {
    expect(() => assertBenchmarkOutput('/home/bandoo/workspace/knowledge/doo-konw')).toThrow();
    expect(() => assertBenchmarkOutput('/tmp/benchmarks')).toThrow();
    expect(() => parseOptions(['--counts', '0,10000'])).toThrow();
    expect(() => parseOptions(['--concurrency', '0'])).toThrow();
    expect(() => parseOptions(['--queries', 'NaN'])).toThrow();
    expect(() => parseOptions(['--knowledge-root', '/tmp/notes'])).toThrow();
    expect(parseOptions(['--counts', '10000,100000', '--concurrency', '5']).counts).toEqual([
      10000, 100000,
    ]);
  });

  it('uses nearest-rank percentiles and wall time for throughput', () => {
    expect(statistics([10, 20, 30, 40], 100, 20_000)).toMatchObject({
      samples: 4,
      p50Ms: 20,
      p95Ms: 40,
      throughputPerSecond: 40,
      cpuPercent: 20,
    });
    expect(() => statistics([], 100, 0)).toThrow();
  });

  it('reports independently labeled recall, rank and negative false hits', () => {
    expect(
      qualityScore([
        { expectedPaths: ['a', 'b'], returnedPaths: ['c', 'a'], unrelated: false },
        { expectedPaths: [], returnedPaths: ['c'], unrelated: true },
        { expectedPaths: [], returnedPaths: [], unrelated: true },
      ]),
    ).toMatchObject({ recallAt10: 0.5, meanReciprocalRank: 0.5, negativeFalseHitRate: 0.5 });
    expect(
      qualityScore([{ expectedPaths: ['a'], returnedPaths: ['a', 'a'], unrelated: false }]),
    ).toMatchObject({ recallAt10: 1, ndcgAt10: 1 });
  });

  it('supplies at least fifty reviewable labels across every requested query class', () => {
    const f = syntheticFixture(42);
    expect(f.labelProvenance).toBe('AI-authored synthetic labels; not a human gold standard');
    expect(f.questions.length).toBeGreaterThanOrEqual(50);
    expect(new Set(f.questions.map((q) => q.kind))).toEqual(
      new Set(['chinese-short', 'identifier', 'paraphrase', 'unrelated', 'directory']),
    );
    const paths = new Set(f.documents.map((d) => d.path));
    for (const q of f.questions)
      for (const path of q.expectedPaths) expect(paths.has(path)).toBe(true);
    expect(syntheticFixture(42)).toEqual(f);
  });

  it('writes exact UTF-8 sizes with long lines and JSON escapes using bounded blocks', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dooknow-benchmark-contract-'));
    try {
      for (const kind of ['unicode', 'long-line', 'escapes'] as const) {
        const file = join(root, `${kind}.md`);
        await writeSample(file, 131073, kind);
        const bytes = await readFile(file); // Small test fixture; production samples are streamed.
        expect(bytes.length).toBe(131073);
        expect(() => new TextDecoder('utf-8', { fatal: true }).decode(bytes)).not.toThrow();
        if (kind === 'long-line') expect(bytes.includes(10)).toBe(false);
        if (kind === 'escapes') {
          expect(bytes.includes(92) && bytes.includes(34)).toBe(true);
          expect(bytes.includes(10)).toBe(false);
        }
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
