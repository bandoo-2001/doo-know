import { spawn } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { mkdir, stat } from 'node:fs/promises';
import { once } from 'node:events';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { performance } from 'node:perf_hooks';
import { createInterface } from 'node:readline';
import {
  createRun,
  parseOptions,
  ResourceMonitor,
  statistics,
  workload,
  environment,
  saveReport,
  projectRoot,
  assertBenchmarkOutput,
} from '../tests/benchmarks/support.js';

export async function writeSample(
  file: string,
  bytes: number,
  kind: 'unicode' | 'long-line' | 'escapes',
) {
  if (!Number.isSafeInteger(bytes) || bytes < 1) throw new Error('Invalid sample size');
  const pattern = Buffer.from(
      kind === 'unicode' ? '中文🙂 CRLF\r\n' : kind === 'long-line' ? '超长🙂行' : '\\"\t\r\\\\',
    ),
    block = Buffer.concat(
      Array.from({ length: Math.floor(65536 / pattern.length) }, () => pattern),
    ),
    output = createWriteStream(file, { flags: 'wx', mode: 0o600 });
  const finished = once(output, 'finish');
  let remaining = bytes;
  while (remaining >= block.length) {
    if (!output.write(block)) await once(output, 'drain');
    remaining -= block.length;
  }
  const full = Math.floor(remaining / pattern.length) * pattern.length;
  if (full) output.write(block.subarray(0, full));
  output.end(Buffer.alloc(remaining - full, 120));
  await finished;
}

async function benchmarkAgent() {
  const { agentConfig } = await import('../tests/support/agent.js');
  return {
    ...agentConfig,
    policies: [
      ...agentConfig.policies,
      ...[1, 2, 20].flatMap((size) =>
        ['unicode', 'long-line', 'escapes'].map((kind) => ({
          ...agentConfig.policies[0],
          id: `benchmark-${size}-${kind}`,
        })),
      ),
    ],
  };
}

async function childMode(mode: 'worker' | 'gateway', root: string) {
  assertBenchmarkOutput(root);
  let context: any;
  if (mode === 'worker') {
    const [{ openDatabase }, { noteService }, { snapshotService }, { fileJobService }] =
      await Promise.all([
        import('../server/db.js'),
        import('../server/notes.js'),
        import('../server/knowledge/snapshots.js'),
        import('../server/knowledge/file-jobs.js'),
      ]);
    const config = {
        knowledgeRoot: join(root, 'knowledge'),
        dataRoot: join(root, 'data'),
        secret: 'isolated-benchmark-secret-at-least-thirty-two-characters',
        origin: 'http://127.0.0.1:3010',
        agent: await benchmarkAgent(),
        fileTasks: { embedded: true },
        indexing: { enabled: false, watch: false },
      },
      db = openDatabase(config.dataRoot),
      notes = noteService(config, db),
      snapshots = snapshotService(config, db, notes),
      files = fileJobService(config, db, notes, snapshots);
    context = { snapshots, files, db };
  } else
    context = await import(
      pathToFileURL(resolve(projectRoot, '../../mcp/doo-know-bridge/src/budgets.ts')).href
    );
  process.stdout.write(JSON.stringify({ ready: true, pid: process.pid }) + '\n');
  const lines = createInterface({ input: process.stdin });
  for await (const line of lines) {
    const input = JSON.parse(line);
    const readPage = async () => {
      const response = await fetch(input.url, {
        method: 'POST',
        headers: input.headers,
        body: JSON.stringify(input.payload),
        signal: AbortSignal.timeout(10000),
      });
      if (!response.ok) throw new Error(`HTTP_${response.status}`);
      const body = await context.readBoundedResponse(response);
      context.assertResponse(body);
      return {
        responseBytes: context.resultSize(body),
        contentBytes: body.data?.data?.bytesReturned || 0,
      };
    };
    if (mode === 'gateway') for (let i = 0; i < input.warmup; i++) await readPage();
    const monitor = new ResourceMonitor();
    try {
      if (mode === 'worker') {
        await context.snapshots.recover();
        await context.files.recover();
        await context.snapshots.drain();
        await context.files.drain();
        process.stdout.write(JSON.stringify({ id: input.id, metrics: monitor.finish() }) + '\n');
      } else {
        const single = new ResourceMonitor();
        await readPage();
        const singleRequestResources = single.finish();
        const run = await workload(input.count, Math.min(2, input.concurrency), readPage);
        const resources = monitor.finish();
        process.stdout.write(
          JSON.stringify({
            id: input.id,
            metrics: {
              ...statistics(run.latencies, run.wallMs, resources.cpuUs),
              resources,
              singleRequestResources,
              errors: run.errors,
              maxResponseBytes: Math.max(...run.values.filter(Boolean).map((x) => x.responseBytes)),
              maxContentBytes: Math.max(...run.values.filter(Boolean).map((x) => x.contentBytes)),
              rawLatenciesMs: run.latencies,
            },
          }) + '\n',
        );
      }
    } catch (error) {
      const metrics = monitor.finish();
      process.stdout.write(
        JSON.stringify({
          id: input.id,
          error: error instanceof Error ? error.message : String(error),
          metrics,
        }) + '\n',
      );
    }
  }
  if (mode === 'worker') {
    await context.files.close();
    await context.snapshots.close();
    context.db.close();
  }
}

async function startChild(mode: 'worker' | 'gateway', root: string) {
  const child = spawn(
      process.execPath,
      [
        '--import',
        'tsx',
        resolve(projectRoot, 'scripts/file-benchmark.ts'),
        `--${mode}-child`,
        root,
      ],
      { stdio: ['pipe', 'pipe', 'pipe'], cwd: projectRoot },
    ),
    pending = new Map<string, (reply: any) => void>();
  let stderr = '';
  child.stderr.on('data', (bytes) => {
    stderr = (stderr + bytes).slice(-2000);
  });
  const lines = createInterface({ input: child.stdout });
  let ready!: (value: any) => void;
  const first = new Promise<any>((yes, no) => {
    ready = yes;
    child.on('error', no);
    child.once('exit', (code) => no(new Error(`Benchmark child exited ${code}: ${stderr}`)));
  });
  lines.on('line', (line) => {
    try {
      const reply = JSON.parse(line);
      if (reply.ready) ready(reply);
      else {
        pending.get(reply.id)?.(reply);
        pending.delete(reply.id);
      }
    } catch {}
  });
  const timeout = setTimeout(() => child.kill(), 20000);
  const initialized = await first;
  clearTimeout(timeout);
  return {
    pid: initialized.pid as number,
    run: async (input: any = {}) => {
      const id = `${Date.now()}-${pending.size}`;
      return new Promise<any>((yes, no) => {
        const deadline = setTimeout(() => {
          pending.delete(id);
          no(new Error('Benchmark child operation timeout'));
        }, 300000);
        deadline.unref();
        pending.set(id, (reply) => {
          clearTimeout(deadline);
          reply.error ? no(new Error(reply.error)) : yes(reply.metrics);
        });
        child.stdin.write(JSON.stringify({ ...input, id }) + '\n');
      });
    },
    close: async () => {
      if (child.exitCode !== null || child.signalCode !== null) return;
      const ended = once(child, 'exit');
      child.stdin.end();
      const stop = setTimeout(() => child.kill(), 5000);
      await ended;
      clearTimeout(stop);
    },
  };
}

async function main() {
  const options = parseOptions(process.argv.slice(2)),
    run = await createRun('files', options.output),
    results: any[] = [];
  await mkdir(join(run.knowledgeRoot, '00-Inbox'), { recursive: true });
  await mkdir(run.dataRoot);
  if (options.validate) {
    await writeSample(join(run.knowledgeRoot, '00-Inbox/validation.md'), 131073, 'long-line');
    console.log(
      JSON.stringify({
        isolated: true,
        bytes: (await stat(join(run.knowledgeRoot, '00-Inbox/validation.md'))).size,
      }),
    );
    return;
  }
  const [{ createApp }, { agentHeaders }, { messageSize }, { hashFile }] = await Promise.all([
    import('../server/app.js'),
    import('../tests/support/agent.js'),
    import('../server/knowledge/limits.js'),
    import('../server/knowledge/file-reader.js'),
  ]);
  const app = await createApp({
    ...run,
    origin: 'http://127.0.0.1:3010',
    secret: 'isolated-benchmark-secret-at-least-thirty-two-characters',
    agent: await benchmarkAgent(),
    fileTasks: { embedded: false },
    indexing: { enabled: false, watch: false },
  });
  const address = await app.listen({ host: '127.0.0.1', port: 0 }),
    worker = await startChild('worker', run.root),
    gateway = await startChild('gateway', run.root);
  try {
    let activePrincipal = 'owner';
    const request = (url: string, payload?: unknown) =>
      app.inject({
        ...(payload ? { method: 'POST' as const, payload } : {}),
        url,
        headers: agentHeaders({ sub: activePrincipal }),
      });
    for (const size of [1, 2, 20])
      for (const kind of ['unicode', 'long-line', 'escapes'] as const) {
        activePrincipal = `benchmark-${size}-${kind}`;
        const relativePath = `00-Inbox/${size}-${kind}.md`,
          file = join(run.knowledgeRoot, relativePath);
        await writeSample(file, size * 1024 * 1024, kind);
        const n = (await request('/api/agent/v1/notes'))
            .json()
            .data.items.find((note: any) => note.relativePath === relativePath),
          metadataStart = performance.now();
        const metadata = await request(`/api/agent/v1/notes/${n.id}`),
          metadataMs = performance.now() - metadataStart;
        const readUrl = `/api/agent/v1/notes/${n.id}/read`,
          before = performance.now(),
          accepted = await request(readUrl, { maxBytes: 16384 }),
          acceptanceMs = performance.now() - before;
        if (accepted.statusCode !== 200 || accepted.json().data.kind !== 'accepted')
          throw new Error(`Expected async snapshot: ${accepted.body}`);
        const snapshotResources = await worker.run(),
          ready = await request(readUrl, { maxBytes: 16384 });
        if (ready.statusCode !== 200 || ready.json().data.kind !== 'ready')
          throw new Error(`Snapshot failed: ${ready.body}`);
        const page = ready.json().data.data,
          firstPageMs = performance.now() - before;
        const pageMetrics = await gateway.run({
          url: address + readUrl,
          headers: {
            ...agentHeaders({ sub: activePrincipal }),
            'content-type': 'application/json',
          },
          payload: { maxBytes: 16384 },
          count: options.queries,
          concurrency: options.concurrency,
          warmup: options.warmup,
        });
        const patchStart = performance.now(),
          patch = await request(`/api/agent/v1/notes/${n.id}/patch`, {
            snapshotId: page.snapshotId,
            expectedModifiedAt: page.modifiedAt,
            expectedContentHash: page.sourceHash,
            requestId: `benchmark-${size}-${kind}`,
            edits: [
              {
                type: 'replace_range',
                startByte: page.startByte,
                endByte: page.endByte,
                expectedRangeHash: page.rangeHash,
                insert: 'PATCHED\n',
              },
            ],
          });
        if (patch.statusCode !== 200 || patch.json().data.kind !== 'accepted')
          throw new Error(`Patch rejected: ${patch.body}`);
        const patchAcceptanceMs = performance.now() - patchStart,
          patchResources = await worker.run(),
          final = (
            await request(`/api/agent/v1/operations/${patch.json().data.operation.operationId}`)
          ).json().data;
        if (
          final.status !== 'succeeded' ||
          final.result.content != null ||
          (await stat(file)).size !== size * 1024 * 1024 - page.bytesReturned + 8 ||
          (await hashFile(file)) !== final.result.contentHash
        )
          throw new Error('Patch summary/content verification failed');
        const result = {
          sizeBytes: size * 1024 * 1024,
          kind,
          metadataMs,
          metadataBytes: messageSize(metadata.json().data),
          snapshotAcceptanceMs: acceptanceMs,
          firstPageMs,
          snapshotResources,
          page: pageMetrics,
          patchAcceptanceMs,
          patchTotalMs: performance.now() - patchStart,
          patchResources,
          patchResponseBytes: messageSize(final),
          patchStatus: final.status,
          workerExtraRssTargetBytes: 64 * 1024 * 1024,
          gatewayExtraRssTargetBytes: 16 * 1024 * 1024,
          workerMemoryTargetPassed:
            Math.max(
              snapshotResources.processes[0].extraRssBytes,
              patchResources.processes[0].extraRssBytes,
            ) <=
            64 * 1024 * 1024,
          gatewayMemoryTargetPassed:
            pageMetrics.singleRequestResources.processes[0].extraRssBytes <= 16 * 1024 * 1024,
          responseTargetPassed:
            pageMetrics.maxResponseBytes <= 65536 &&
            pageMetrics.maxContentBytes <= 16384 &&
            messageSize(final) <= 65536,
        };
        results.push(result);
        console.log(
          JSON.stringify({
            size,
            kind,
            firstPageMs,
            p95Ms: pageMetrics.p95Ms,
            workerExtraMiB:
              Math.max(
                snapshotResources.processes[0].extraRssBytes,
                patchResources.processes[0].extraRssBytes,
              ) / 1048576,
            gatewayExtraMiB: pageMetrics.resources.processes[0].extraRssBytes / 1048576,
            responseTargetPassed: result.responseTargetPassed,
          }),
        );
        await saveReport(run.root, {
          environment: environment(),
          parameters: options,
          results,
          limitations: [
            'Gateway budget functions and bounded HTTP reads execute in a separate process; OAuth/MCP transport and browser rendering are not timed.',
            'Worker RSS is sampled every 10ms after imports and DB setup; short peaks below sampling cadence can be missed.',
            'Warm read requests replay the first page and do not claim full-file reading throughput.',
          ],
        });
      }
    await writeSample(
      join(run.knowledgeRoot, '00-Inbox/oversize.md'),
      20 * 1024 * 1024 + 1,
      'long-line',
    );
    const oversize = (await request('/api/agent/v1/notes'))
        .json()
        .data.items.find((n: any) => n.relativePath === '00-Inbox/oversize.md'),
      rejected = await request(`/api/agent/v1/notes/${oversize.id}/read`, {});
    results.push({
      sizeBytes: 20 * 1024 * 1024 + 1,
      oversizeReadStatus: rejected.statusCode,
      error: rejected.json().error?.code,
    });
    await saveReport(run.root, {
      environment: environment(),
      parameters: options,
      results,
      limitations: [
        'Separate worker/gateway processes; gateway HTTP budget functions measured, OAuth/MCP/browser rendering excluded.',
        'RSS sampled every 10ms from preloaded processes; warm reads replay a bounded first page.',
      ],
    });
    console.log(JSON.stringify({ resultFile: join(run.root, 'result.json') }));
  } finally {
    await gateway.close();
    await worker.close();
    await app.close();
  }
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === resolve(projectRoot, 'scripts/file-benchmark.ts')
) {
  const mode = process.argv[2];
  (mode === '--worker-child' || mode === '--gateway-child'
    ? childMode(mode === '--worker-child' ? 'worker' : 'gateway', process.argv[3])
    : main()
  ).catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
