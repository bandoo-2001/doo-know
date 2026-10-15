import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { once } from 'node:events';
import { performance } from 'node:perf_hooks';
import Fastify from 'fastify';
import { openDatabase } from '../packages/core/db.js';
import { noteService } from '../packages/core/notes.js';
import { registerAgentRoutes } from '../apps/server/agent/routes.js';
import { messageSize } from '../packages/core/knowledge/limits.js';
import { agentConfig, agentHeaders } from '../tests/support/agent.js';
import { syntheticFixture } from '../tests/benchmarks/fixtures.js';
import {
  createRun,
  parseOptions,
  ResourceMonitor,
  statistics,
  workload,
  qualityScore,
  environment,
  saveReport,
  projectRoot,
  modelDir,
  python,
  assertBenchmarkOutput,
  assertBenchmarkDirectory,
  assertDirectoryIdentity,
  assertBenchmarkFileTarget,
  readBenchmarkJson,
  benchmarkArtifactBudgets,
} from '../tests/benchmarks/support.js';
import type { AppConfig } from '../shared/contracts.js';
import type { Principal } from '../shared/knowledge-contracts.js';
import { startRuntime } from '../tests/benchmarks/runtime.js';
import { seedCorpus, noise } from '../tests/benchmarks/corpus.js';

const principal: Principal = {
  id: 'owner',
  clientId: 'test-client',
  scopes: ['knowledge:read', 'knowledge:write', 'knowledge:index'],
  allowedPrefixes: ['00-Inbox/benchmark'],
};

async function runScale(
  count: number,
  options: ReturnType<typeof parseOptions>,
  outputRoot: string,
  existingRoot?: string,
) {
  const fixtureReused = !!existingRoot,
    run = existingRoot
      ? {
          root: assertBenchmarkOutput(existingRoot),
          knowledgeRoot: join(existingRoot, 'knowledge'),
          dataRoot: join(existingRoot, 'data'),
        }
      : await createRun(`search-${count}`, outputRoot),
    resultRun = fixtureReused ? await createRun(`retest-${count}`, outputRoot) : run;
  const previous = fixtureReused
    ? await readBenchmarkJson(join(run.root, 'result.json'), benchmarkArtifactBudgets.result)
    : null;
  const reusedFixture = fixtureReused
    ? await readBenchmarkJson(join(run.root, 'labels.json'), benchmarkArtifactBudgets.labels)
    : null;
  if (!fixtureReused) {
    await mkdir(run.knowledgeRoot);
    await mkdir(run.dataRoot);
    const git = spawn('git', ['init', '--quiet', '--initial-branch=benchmark', run.knowledgeRoot], {
      stdio: 'ignore',
    });
    if ((await once(git, 'exit'))[0] !== 0) throw new Error('Isolated Git initialization failed');
  }
  const directoryIdentities = [run.root, run.knowledgeRoot, run.dataRoot].map(
    assertBenchmarkDirectory,
  );
  const databaseTargets = ['app.sqlite', 'app.sqlite-wal', 'app.sqlite-shm'].map((name) =>
    join(run.dataRoot, name),
  );
  databaseTargets.forEach(assertBenchmarkFileTarget);
  const runtime = await startRuntime(run.dataRoot, options.threads);
  directoryIdentities.forEach(assertDirectoryIdentity);
  databaseTargets.forEach(assertBenchmarkFileTarget);
  const config: AppConfig = {
      ...run,
      secret: 'isolated-benchmark-secret-at-least-thirty-two-characters',
      origin: 'http://127.0.0.1:3010',
      agent: {
        ...agentConfig,
        policies: [{ ...agentConfig.policies[0], allowedPrefixes: principal.allowedPrefixes }],
      },
      indexing: { enabled: false, watch: false },
      fileTasks: { embedded: true },
      vectorServiceUrl: runtime.url,
      vectorServiceToken: runtime.token,
      embeddingSpaceId: runtime.spaceId,
      modelDir,
      vectorRuntimeRoot: join(projectRoot, 'runtime/vector-service'),
      tokenizerPython: python,
    },
    db = openDatabase(run.dataRoot),
    notes = noteService(config, db),
    app = Fastify();
  const core = await registerAgentRoutes(app, config, db, notes),
    phases: Record<string, any> = {},
    quality: Record<string, any> = {};
  try {
    let corpus: Awaited<ReturnType<typeof seedCorpus>>;
    if (fixtureReused) {
      if (
        previous.chunks !== count ||
        previous.model.spaceId !== runtime.spaceId ||
        !previous.semanticVectorsAreReal
      )
        throw new Error('Existing corpus count/model/provenance mismatch');
      const fixture = reusedFixture;
      if (fixture.labelProvenance !== syntheticFixture().labelProvenance)
        throw new Error('Reuse requires an explicitly synthetic benchmark fixture');
      corpus = { fixture, build: previous.build };
      const active = db
        .prepare('SELECT manifest_path,checksum FROM vector_generations WHERE id=?')
        .get(core.worker.vectors!.current()) as any;
      await core.worker.client!.call('/generations/load', {
        manifestPath: active.manifest_path,
        checksum: active.checksum,
        spaceId: runtime.spaceId,
      });
    } else corpus = await seedCorpus(count, config, db, core, runtime, options.seed);
    const address = await app.listen({ host: '127.0.0.1', port: 0 });
    const request = async (query: string, mode: string, extras: Record<string, unknown> = {}) => {
      const response = await fetch(address + '/api/agent/v1/search', {
          method: 'POST',
          headers: {
            ...agentHeaders({ allowedPrefixes: principal.allowedPrefixes }),
            'content-type': 'application/json',
          },
          body: JSON.stringify({ query, mode, limit: 10, ...extras }),
          signal: AbortSignal.timeout(15000),
        }),
        value = (await response.json()) as any;
      if (!response.ok) throw new Error(value.error?.code || `HTTP_${response.status}`);
      return value.data;
    };
    const questions = options.validate
      ? corpus.fixture.questions.filter(
          (q) =>
            q.id === '0-chinese-short' ||
            q.id === '0-identifier' ||
            q.id === '0-paraphrase' ||
            q.id === '0-directory' ||
            q.id === 'negative-3',
        )
      : corpus.fixture.questions;
    const vectorQueries = await Promise.all(
      questions
        .slice(0, Math.min(10, questions.length))
        .map((q) => core.worker.client!.query(q.query)),
    );
    let backgroundNumber = (
      db
        .prepare("SELECT count(*) n FROM notes WHERE path LIKE '00-Inbox/benchmark/background-%'")
        .get() as any
    ).n;
    const background = async () => {
      if (!options.background || options.validate) return { enabled: false };
      const path = `00-Inbox/benchmark/background-${backgroundNumber++}.md`,
        started = performance.now(),
        backgroundMonitor = new ResourceMonitor([runtime.pid]);
      await writeFile(
        join(run.knowledgeRoot, path),
        Array.from(
          { length: 40 },
          (_, i) => `# 后台段落 ${backgroundNumber}-${i}\n\n${noise[i % noise.length].repeat(8)}\n`,
        ).join('\n'),
      );
      await core.indexing.reconcile([path], true);
      await core.worker.drain();
      const states = db
        .prepare(
          'SELECT status,count(*) n FROM index_jobs WHERE note_id=(SELECT id FROM notes WHERE path=?) GROUP BY status',
        )
        .all(path);
      return {
        enabled: true,
        method:
          'real production index worker, tokenizer, BGE document embedding and generation publication',
        wallMs: performance.now() - started,
        resources: backgroundMonitor.finish(),
        states,
      };
    };
    for (const phase of ['text', 'vector-runtime', 'vector-adapter', 'hybrid']) {
      const activeChunksBefore = (
        db.prepare('SELECT count(*) n FROM chunks WHERE active=1').get() as any
      ).n;
      const generation = core.worker.vectors!.current()!,
        bitmap = Buffer.alloc(
          Math.ceil(
            (
              db
                .prepare('SELECT count(*) n FROM vector_rows WHERE generation=?')
                .get(generation) as any
            ).n / 8,
          ),
          255,
        ),
        action = async (i: number) => {
          const q = questions[i % questions.length];
          if (phase === 'vector-runtime')
            return core.worker.client!.call('/vectors/search', {
              generation,
              queryVector: vectorQueries[i % vectorQueries.length],
              spaceId: runtime.spaceId,
              allowedRows: bitmap.toString('base64'),
              limit: 50,
            });
          if (phase === 'vector-adapter')
            return core.worker.vectors!.search(
              vectorQueries[i % vectorQueries.length],
              principal,
              50,
            );
          return request(
            q.query,
            phase,
            q.directory ? { filters: { directory: q.directory } } : {},
          );
        };
      for (let i = 0; i < options.warmup; i++) await action(i);
      const monitor = new ResourceMonitor([runtime.pid]),
        backgroundTask = background(),
        measured = await workload(options.queries, options.concurrency, action),
        resources = monitor.finish();
      phases[phase] = {
        activeChunksBefore,
        ...statistics(measured.latencies, measured.wallMs, resources.cpuUs),
        resources,
        errors: measured.errors,
        rawLatenciesMs: measured.latencies,
        background: await backgroundTask,
        targetP95Ms: phase === 'hybrid' ? 500 : 100,
      };
      phases[phase].targetPassed =
        phases[phase].p95Ms <= phases[phase].targetP95Ms && !measured.errors.length;
      console.log(
        JSON.stringify({
          chunks: count,
          phase,
          p50Ms: phases[phase].p50Ms,
          p95Ms: phases[phase].p95Ms,
          throughput: phases[phase].throughputPerSecond,
          targetPassed: phases[phase].targetPassed,
        }),
      );
    }
    let permissionLeaks = 0,
      maxMessageBytes = 0;
    for (const mode of ['text', 'semantic', 'hybrid']) {
      const observations = [];
      for (const q of questions) {
        const result = await request(
          q.query,
          mode,
          q.directory ? { filters: { directory: q.directory } } : {},
        );
        maxMessageBytes = Math.max(maxMessageBytes, messageSize(result));
        observations.push({
          id: q.id,
          kind: q.kind,
          query: q.query,
          expectedPaths: q.expectedPaths,
          returnedPaths: result.results.map((r: any) => r.relativePath),
          unrelated: q.kind === 'unrelated',
          directory: q.directory,
        });
      }
      const privateResult = await request('private_acl_sentinel_qz9981', mode);
      permissionLeaks += privateResult.results.filter(
        (r: any) => !r.relativePath.startsWith('00-Inbox/benchmark/'),
      ).length;
      quality[mode] = { ...qualityScore(observations), observations };
    }
    const strictStart = performance.now(),
      strictMonitor = new ResourceMonitor([runtime.pid]);
    let strictError: string | null = null;
    try {
      await request('backup_restore', 'hybrid', { freshness: 'strict' });
    } catch (error) {
      strictError = error instanceof Error ? error.message : String(error);
    }
    const strict = {
      wallMs: performance.now() - strictStart,
      error: strictError,
      resources: strictMonitor.finish(),
      sourceDocumentCount: corpus.build.documentCount,
      deadlineMs: 10000,
    };
    const report = {
      chunks: count,
      fixtureRoot: run.root,
      fixtureReused,
      buildMeasuredThisRun: !fixtureReused,
      semanticVectorsAreReal: true,
      syntheticLabelsAreHumanGold: false,
      labelProvenance: corpus.fixture.labelProvenance,
      environment: environment(),
      parameters: options,
      queryLengths: {
        minimumUnicodeCharacters: Math.min(...questions.map((q) => [...q.query].length)),
        maximumUnicodeCharacters: Math.max(...questions.map((q) => [...q.query].length)),
      },
      model: {
        name: 'BAAI/bge-small-zh-v1.5',
        dimensions: 512,
        spaceId: runtime.spaceId,
        coldStartMs: runtime.coldStartMs,
        residentRssBytes: runtime.rssBytes,
        offline: true,
        threads: options.threads,
        revision: runtime.modelRevision,
        manifestSha256: runtime.modelManifestSha256,
        python: runtime.pythonVersion,
        numpy: runtime.numpyVersion,
        torch: runtime.torchVersion,
      },
      build: corpus.build,
      phases,
      quality,
      strict,
      permissionLeaks,
      responseBoundsPassed: maxMessageBytes <= 65536,
      maxMessageBytes,
      limitations: [
        'Synthetic AI labels, not the required human gold standard; repeated distractors do not represent a real personal library.',
        'Scaled fixture materialization uses real text.stage/publish and cached genuine BGE document vectors, not unique 100k-document production rebuild.',
        'Resource sampling is 10ms; Node plus BGE CPU excludes the separate tokenizer child CPU.',
        'Vector-runtime phase uses a precomputed all-row bitmap and is arithmetic/HTTP only; vector-adapter includes actual permission bitmap generation.',
        'File-system page caches are warm; cold start means a fresh process, not a flushed host page cache.',
      ],
    };
    await saveReport(resultRun.root, report);
    await writeFile(
      join(resultRun.root, 'labels.json'),
      JSON.stringify(corpus.fixture, null, 2) + '\n',
    );
    console.log(
      JSON.stringify({
        chunks: count,
        fixtureReused,
        fixtureRoot: run.root,
        semanticVectorsAreReal: true,
        permissionLeaks,
        responseBoundsPassed: report.responseBoundsPassed,
        strictMs: strict.wallMs,
        strictError,
        resultFile: join(resultRun.root, 'result.json'),
      }),
    );
    return report;
  } finally {
    core.stopWatching();
    await core.worker.close();
    await core.files.close();
    await core.snapshots.close();
    await core.indexing.close();
    await app.close();
    db.close();
    await runtime.close();
  }
}

async function productionBuild(options: ReturnType<typeof parseOptions>, outputRoot: string) {
  const run = await createRun('production-build', outputRoot);
  await mkdir(run.knowledgeRoot);
  await mkdir(run.dataRoot);
  const git = spawn('git', ['init', '--quiet', '--initial-branch=benchmark', run.knowledgeRoot], {
    stdio: 'ignore',
  });
  await once(git, 'exit');
  const runtime = await startRuntime(run.dataRoot, options.threads),
    config: AppConfig = {
      ...run,
      secret: 'isolated-benchmark-secret-at-least-thirty-two-characters',
      origin: 'http://127.0.0.1:3010',
      agent: {
        ...agentConfig,
        policies: [{ ...agentConfig.policies[0], allowedPrefixes: principal.allowedPrefixes }],
      },
      indexing: { enabled: false, watch: false },
      fileTasks: { embedded: true },
      vectorServiceUrl: runtime.url,
      vectorServiceToken: runtime.token,
      embeddingSpaceId: runtime.spaceId,
      modelDir,
      vectorRuntimeRoot: join(projectRoot, 'runtime/vector-service'),
      tokenizerPython: python,
    },
    db = openDatabase(run.dataRoot),
    app = Fastify(),
    core = await registerAgentRoutes(app, config, db, noteService(config, db));
  try {
    const fixture = syntheticFixture(options.seed);
    for (const document of fixture.documents) {
      const path = join(run.knowledgeRoot, document.path);
      await mkdir(resolve(path, '..'), { recursive: true });
      await writeFile(path, document.content, { mode: 0o600, flag: 'wx' });
    }
    const started = performance.now(),
      monitor = new ResourceMonitor([runtime.pid]);
    await core.indexing.reconcile(principal.allowedPrefixes, true);
    await core.worker.drain();
    const resources = monitor.finish(),
      state = db
        .prepare(
          'SELECT count(*) n FROM document_state WHERE content_hash IS NULL OR text_indexed_hash IS NULL OR vector_indexed_hash IS NULL OR content_hash<>text_indexed_hash OR content_hash<>vector_indexed_hash',
        )
        .get() as any,
      jobs = db.prepare('SELECT status,count(*) n FROM index_jobs GROUP BY status').all() as any[];
    if (state.n || jobs.some((j) => j.status !== 'done'))
      throw new Error('Production full-job build did not publish both complete indexes');
    const result = {
      productionJobBuildMeasured: true,
      documentCount: fixture.documents.length,
      chunks: (db.prepare('SELECT count(*) n FROM chunks WHERE active=1').get() as any).n,
      wallMs: performance.now() - started,
      resources,
      jobs,
      coldStartMs: runtime.coldStartMs,
      modelRevision: runtime.modelRevision,
      pythonVersion: runtime.pythonVersion,
      numpyVersion: runtime.numpyVersion,
      torchVersion: runtime.torchVersion,
      embeddingSpaceId: runtime.spaceId,
      method:
        'Actual reconcile -> durable text/vector jobs -> snapshots/chunker -> uncached genuine BGE -> prepare/finalize/publish; isolated 20-document full-job build',
      resultFile: join(run.root, 'result.json'),
    };
    await saveReport(run.root, result);
    console.log(
      JSON.stringify({
        productionJobBuildMeasured: true,
        chunks: result.chunks,
        buildMs: result.wallMs,
        resultFile: result.resultFile,
      }),
    );
    return result;
  } finally {
    core.stopWatching();
    await core.worker.close();
    await core.files.close();
    await core.snapshots.close();
    await core.indexing.close();
    await app.close();
    db.close();
    await runtime.close();
  }
}

async function main() {
  const options = parseOptions(process.argv.slice(2)),
    root = await createRun('search', options.output),
    results = [];
  const productionJobBuild = options.reuse ? null : await productionBuild(options, root.root);
  if (options.reuse) {
    const previous = await readBenchmarkJson(
      join(options.reuse, 'result.json'),
      benchmarkArtifactBudgets.result,
    );
    if (!options.counts.includes(previous.chunks))
      throw new Error('Reuse count must match the original fixture');
    results.push(await runScale(previous.chunks, options, root.root, options.reuse));
  } else
    for (const count of options.counts) results.push(await runScale(count, options, root.root));
  await saveReport(root.root, {
    environment: environment(),
    parameters: options,
    productionJobBuild,
    results,
  });
  console.log(JSON.stringify({ resultFile: join(root.root, 'result.json') }));
}
if (
  process.argv[1] &&
  resolve(process.argv[1]) === join(projectRoot, 'scripts/search-benchmark.ts')
)
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
