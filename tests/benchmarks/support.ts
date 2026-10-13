import { cpus, totalmem } from 'node:os';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { existsSync, lstatSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { monitorEventLoopDelay, performance } from 'node:perf_hooks';

export const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
export const benchmarkRoot = join(projectRoot, '.local/benchmarks');
export const python = join(projectRoot, 'runtime/vector-service/.venv/bin/python');
export const modelDir = join(projectRoot, '.local/models/bge-small-zh-v1.5');
export function assertBenchmarkOutput(path: string) {
  const full = resolve(path),
    suffix = relative(benchmarkRoot, full);
  if (suffix === '..' || suffix.startsWith('..' + sep) || suffix.startsWith(sep))
    throw new Error('Output must remain in the ignored .local/benchmarks directory');
  let existing = full;
  while (!existsSync(existing)) existing = dirname(existing);
  if (lstatSync(existing).isSymbolicLink() || realpathSync(existing) !== existing)
    throw new Error('Symlinked benchmark output is forbidden');
  return full;
}
export function parseOptions(argv: string[]) {
  const options = {
    counts: [10000, 100000],
    concurrency: 5,
    queries: 100,
    warmup: 10,
    seed: 20261014,
    threads: 2,
    background: true,
    validate: false,
    output: benchmarkRoot,
    reuse: '',
  };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (flag === '--validate') {
      options.validate = true;
      continue;
    }
    if (flag === '--no-background') {
      options.background = false;
      continue;
    }
    const field = (
      {
        '--counts': 'counts',
        '--concurrency': 'concurrency',
        '--queries': 'queries',
        '--warmup': 'warmup',
        '--seed': 'seed',
        '--threads': 'threads',
        '--output': 'output',
        '--reuse': 'reuse',
      } as const
    )[flag as '--counts'];
    if (!field || argv[i + 1] == null) throw new Error(`Unknown or incomplete argument: ${flag}`);
    const value = argv[++i];
    if (field === 'counts') options.counts = value.split(',').map(Number);
    else if (field === 'output') options.output = assertBenchmarkOutput(value);
    else if (field === 'reuse') options.reuse = assertBenchmarkOutput(value);
    else (options as unknown as Record<string, unknown>)[field] = Number(value);
  }
  if (
    !options.counts.length ||
    options.counts.some((n) => !Number.isSafeInteger(n) || n < 1 || n > 1000000)
  )
    throw new Error('counts must be integers in 1..1000000');
  for (const [field, minimum, maximum] of [
    ['concurrency', 1, 32],
    ['queries', 1, 10000],
    ['warmup', 0, 1000],
    ['seed', 0, 4294967295],
    ['threads', 1, 16],
  ] as const) {
    if (
      !Number.isSafeInteger(options[field]) ||
      options[field] < minimum ||
      options[field] > maximum
    )
      throw new Error(`Invalid ${field}`);
  }
  return options;
}
export function statistics(latencies: number[], wallMs: number, cpuMicroseconds: number) {
  if (!latencies.length || !(wallMs > 0) || latencies.some((n) => !Number.isFinite(n) || n < 0))
    throw new Error('Invalid benchmark samples');
  const sorted = [...latencies].sort((a, b) => a - b),
    at = (q: number) => sorted[Math.max(0, Math.ceil(sorted.length * q) - 1)];
  return {
    samples: sorted.length,
    p50Ms: at(0.5),
    p95Ms: at(0.95),
    maxMs: sorted.at(-1)!,
    wallMs,
    throughputPerSecond: (sorted.length * 1000) / wallMs,
    cpuPercent: cpuMicroseconds / (wallMs * 10),
  };
}
export type QualityObservation = {
  expectedPaths: string[];
  returnedPaths: string[];
  unrelated: boolean;
  directory?: string;
};
export function qualityScore(observations: QualityObservation[]) {
  const positive = observations.filter((q) => q.expectedPaths.length),
    negative = observations.filter((q) => q.unrelated);
  let recall = 0,
    reciprocal = 0,
    ndcg = 0,
    filterViolations = 0;
  for (const q of positive) {
    const seen = new Set<string>();
    const ranks = q.returnedPaths
      .slice(0, 10)
      .map((p, i) => {
        if (seen.has(p)) return 0;
        seen.add(p);
        return q.expectedPaths.includes(p) ? i + 1 : 0;
      })
      .filter(Boolean);
    recall +=
      new Set(q.returnedPaths.slice(0, 10).filter((p) => q.expectedPaths.includes(p))).size /
      q.expectedPaths.length;
    reciprocal += ranks.length ? 1 / ranks[0] : 0;
    const ideal = Array.from(
      { length: Math.min(10, q.expectedPaths.length) },
      (_, i) => 1 / Math.log2(i + 2),
    ).reduce((a, b) => a + b, 0);
    ndcg += ranks.reduce((a, r) => a + 1 / Math.log2(r + 1), 0) / ideal;
  }
  for (const q of observations)
    if (q.directory)
      filterViolations += q.returnedPaths.filter(
        (p) => p !== q.directory && !p.startsWith(q.directory + '/'),
      ).length;
  return {
    positiveQueries: positive.length,
    negativeQueries: negative.length,
    recallAt10: positive.length ? recall / positive.length : null,
    meanReciprocalRank: positive.length ? reciprocal / positive.length : null,
    ndcgAt10: positive.length ? ndcg / positive.length : null,
    negativeFalseHitRate: negative.length
      ? negative.filter((q) => q.returnedPaths.length).length / negative.length
      : null,
    directoryFilterViolations: filterViolations,
  };
}
function resources(pid: number) {
  try {
    const status = readFileSync(`/proc/${pid}/status`, 'utf8'),
      stat = readFileSync(`/proc/${pid}/stat`, 'utf8').split(') ')[1].split(' ');
    return {
      rss: Number(status.match(/VmRSS:\s+(\d+)/)?.[1] || 0) * 1024,
      cpuUs: (Number(stat[11]) + Number(stat[12])) * 10000,
    };
  } catch {
    return { rss: 0, cpuUs: 0 };
  }
}
export class ResourceMonitor {
  private initial: Map<number, ReturnType<typeof resources>>;
  private peak: Map<number, number>;
  private timer: ReturnType<typeof setInterval>;
  private eventLoop = monitorEventLoopDelay({ resolution: 10 });
  private start = performance.now();
  private cpu = process.cpuUsage();
  constructor(private children: number[] = []) {
    this.initial = new Map([process.pid, ...children].map((pid) => [pid, resources(pid)]));
    this.peak = new Map([...this.initial].map(([pid, r]) => [pid, r.rss]));
    this.eventLoop.enable();
    this.timer = setInterval(() => {
      for (const pid of this.initial.keys())
        this.peak.set(pid, Math.max(this.peak.get(pid)!, resources(pid).rss));
    }, 10);
    this.timer.unref();
  }
  finish() {
    clearInterval(this.timer);
    this.eventLoop.disable();
    const wallMs = performance.now() - this.start,
      cpu = process.cpuUsage(this.cpu),
      childCpu = this.children.reduce(
        (sum, pid) => sum + Math.max(0, resources(pid).cpuUs - this.initial.get(pid)!.cpuUs),
        0,
      );
    return {
      wallMs,
      cpuUs: cpu.user + cpu.system + childCpu,
      cpuPercent: (cpu.user + cpu.system + childCpu) / (wallMs * 10),
      processes: [...this.initial].map(([pid, initial]) => {
        const peak = Math.max(this.peak.get(pid)!, resources(pid).rss);
        return {
          pid,
          baselineRssBytes: initial.rss,
          peakRssBytes: peak,
          extraRssBytes: Math.max(0, peak - initial.rss),
        };
      }),
      eventLoop: { p95Ms: this.eventLoop.percentile(95) / 1e6, maxMs: this.eventLoop.max / 1e6 },
    };
  }
}
export async function workload<T>(
  count: number,
  concurrency: number,
  action: (i: number) => Promise<T>,
) {
  let next = 0;
  const latencies: number[] = [],
    values: T[] = [],
    errors: string[] = [],
    start = performance.now();
  await Promise.all(
    Array.from({ length: Math.min(count, concurrency) }, async () => {
      while (next < count) {
        const i = next++,
          before = performance.now();
        try {
          values[i] = await action(i);
        } catch (error) {
          errors.push(error instanceof Error ? error.message : String(error));
        } finally {
          latencies[i] = performance.now() - before;
        }
      }
    }),
  );
  return { latencies, values, errors, wallMs: performance.now() - start };
}
export async function createRun(label: string, output = benchmarkRoot) {
  await mkdir(assertBenchmarkOutput(output), { recursive: true, mode: 0o700 });
  const root = await mkdtemp(join(output, label + '-'));
  return { root, knowledgeRoot: join(root, 'knowledge'), dataRoot: join(root, 'data') };
}
export async function saveReport(root: string, result: unknown) {
  await writeFile(
    join(assertBenchmarkOutput(root), 'result.json'),
    JSON.stringify(result, null, 2) + '\n',
    { mode: 0o600 },
  );
}
export function environment() {
  return {
    timestamp: new Date().toISOString(),
    platform: process.platform,
    node: process.version,
    cpu: cpus()[0]?.model,
    logicalCpus: cpus().length,
    memoryBytes: totalmem(),
    samplingIntervalMs: 10,
    cpuClockTicksPerSecond: 100,
  };
}
