"""Isolated, reproducible flat_file arithmetic benchmark and real offline BGE server.

Random matrices measure arithmetic/transport capacity only. The TypeScript search
benchmark builds its semantic fixtures with genuine local BGE document embeddings.
"""
import os
import sys
import time

STARTED = time.perf_counter()
threads = int(sys.argv[sys.argv.index('--threads') + 1]) if '--threads' in sys.argv else int(os.environ.get('DOOKNOW_RUNTIME_THREADS', '2'))
for name in ('OPENBLAS_NUM_THREADS', 'OMP_NUM_THREADS', 'MKL_NUM_THREADS', 'DOOKNOW_RUNTIME_THREADS'):
    os.environ[name] = str(threads)
for name in ('HF_HUB_OFFLINE', 'TRANSFORMERS_OFFLINE', 'HF_HUB_DISABLE_TELEMETRY'):
    os.environ[name] = '1'

import argparse
from concurrent.futures import ThreadPoolExecutor
import json
import math
from pathlib import Path
import platform
import resource
import tempfile
import threading
import numpy as np
from flat_index import FlatIndex, checksum, normalize

PROJECT = Path(__file__).resolve().parents[2]
OUTPUT = PROJECT / '.local/benchmarks'


def safe_output(path):
    path = Path(path).absolute()
    if not path.resolve().is_relative_to(OUTPUT) or path.resolve() != path:
        raise ValueError('BENCHMARK_OUTPUT_MUST_BE_ISOLATED')
    return path


def summarize(latencies, wall_seconds, cpu_seconds):
    if not latencies or wall_seconds <= 0 or any(not math.isfinite(x) or x < 0 for x in latencies):
        raise ValueError('INVALID_SAMPLES')
    values = sorted(latencies)
    return {'samples': len(values), 'p50Ms': values[math.ceil(len(values) * .5) - 1],
            'p95Ms': values[math.ceil(len(values) * .95) - 1], 'maxMs': max(values),
            'wallMs': wall_seconds * 1000, 'throughputPerSecond': len(values) / wall_seconds,
            'cpuPercent': cpu_seconds / wall_seconds * 100}


def publish_manifest(root, matrix_file, rows, space='numerical-baseline', dimension=512):
    manifest = root / 'generation.json'
    data = {'generation': 'benchmark', 'embeddingSpaceId': space, 'dimensions': dimension,
            'segments': [{'file': str(matrix_file), 'checksum': checksum(matrix_file), 'rows': rows}]}
    with manifest.open('x', encoding='utf8') as f:
        json.dump(data, f, ensure_ascii=False, separators=(',', ':'))
    return manifest


def validate_numerics(root):
    root = Path(root)
    root.mkdir(parents=True, exist_ok=True)
    segment = root / 'truth.f32'
    np.asarray([[1, 0], [0, 1], [-1, 0]], dtype='<f4').tofile(segment)
    rows = [{'chunkId': name, 'noteId': name, 'sourceHash': 'synthetic'} for name in ['east', 'north', 'west']]
    manifest = publish_manifest(root, segment, rows, dimension=2)
    index = FlatIndex(root)
    index.load(manifest, 'numerical-baseline')
    result = index.search('benchmark', [1, .5], 'numerical-baseline', [0, 1, 2], 2)
    if [r['chunkId'] for r in result] != ['east', 'north']:
        raise ValueError('NUMERICAL_VALIDATION_FAILED')
    if index.search('benchmark', [1, .5], 'numerical-baseline', [], 10):
        raise ValueError('EMPTY_FILTER_FAILED')
    return {'numericalCorrectness': True, 'semanticQualityMeasured': False,
            'selectedChunkIds': [r['chunkId'] for r in result]}


def current_rss():
    with Path('/proc/self/status').open() as f:
        for line in f:
            if line.startswith('VmRSS:'):
                return int(line.split()[1]) * 1024
    return None


def numerical_run(root, count, args):
    root.mkdir(mode=0o700)
    rng = np.random.default_rng(args.seed)
    started, cpu = time.perf_counter(), time.process_time()
    segment = root / 'numerical.f32'
    with segment.open('xb') as f:
        for offset in range(0, count, 4096):
            normalize(rng.standard_normal((min(4096, count - offset), 512), dtype=np.float32), 512).astype('<f4').tofile(f)
        f.flush()
        os.fsync(f.fileno())
    rows = [{'chunkId': f'n-{i}', 'noteId': f'note-{i // 50}', 'sourceHash': 'numeric-fixture'} for i in range(count)]
    manifest = publish_manifest(root, segment, rows)
    build = {'wallMs': (time.perf_counter() - started) * 1000, 'cpuMs': (time.process_time() - cpu) * 1000}
    index = FlatIndex(root)
    before = time.perf_counter()
    index.load(manifest, 'numerical-baseline')
    load_ms = (time.perf_counter() - before) * 1000
    del rows
    queries = normalize(rng.standard_normal((max(args.queries, args.warmup), 512), dtype=np.float32), 512)
    allowed = np.arange(count)
    for i in range(args.warmup):
        index.search('benchmark', queries[i], 'numerical-baseline', allowed, 50)
    baseline_rss = current_rss()
    stop = threading.Event()
    background_batches = [0]

    def background():
        generator = np.random.default_rng(args.seed + 1)
        with (root / 'background.f32').open('wb') as f:
            while not stop.is_set():
                f.seek(0)
                normalize(generator.standard_normal((16, 512), dtype=np.float32), 512).tofile(f)
                f.flush()
                background_batches[0] += 1
                stop.wait(.005)

    worker = threading.Thread(target=background, daemon=True)
    if not args.no_background:
        worker.start()
    latencies = []
    started, cpu = time.perf_counter(), time.process_time()

    def query(i):
        before = time.perf_counter()
        hits = index.search('benchmark', queries[i], 'numerical-baseline', allowed, 50)
        if len(hits) != min(50, count):
            raise ValueError('WRONG_RESULT_COUNT')
        return (time.perf_counter() - before) * 1000

    try:
        with ThreadPoolExecutor(max_workers=args.concurrency) as executor:
            latencies = list(executor.map(query, range(args.queries)))
        result = summarize(latencies, time.perf_counter() - started, time.process_time() - cpu)
    finally:
        stop.set()
        if worker.is_alive():
            worker.join(timeout=5)
    return {'chunks': count, 'dimensions': 512, 'backend': 'flat_file', 'dataKind': 'seeded random normalized Float32 arithmetic baseline',
            'semanticQualityMeasured': False, 'build': build, 'generationLoadMs': load_ms, 'baselineRssBytes': baseline_rss,
            'peakRssBytes': resource.getrusage(resource.RUSAGE_SELF).ru_maxrss * 1024,
            'backgroundKind': 'bounded numeric generation and file writing, not model inference',
            'backgroundBatches': background_batches[0], 'vectorSearch': result,
            'rawLatenciesMs': latencies, 'targetP95Ms': 100, 'targetPassed': result['p95Ms'] <= 100}


def serve(args):
    import socket
    from embedding import Embedding
    from app import create_app
    import uvicorn
    root = safe_output(args.root)
    token_file = safe_output(args.token_file)
    if not token_file.is_relative_to(root) or token_file.stat().st_mode & 0o077:
        raise ValueError('BENCHMARK_TOKEN_PERMISSIONS')
    model = Path(args.model_dir).resolve()
    if not model.is_relative_to(PROJECT / '.local/models'):
        raise ValueError('BENCHMARK_MODEL_MUST_BE_LOCAL')
    engine = Embedding(model)
    app = create_app(engine, root, token_file.read_text().strip())
    sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    sock.bind(('127.0.0.1', 0))
    import torch
    manifest = json.loads((model / 'dooknow-model-manifest.json').read_text())
    print(json.dumps({'port': sock.getsockname()[1], 'pid': os.getpid(), 'spaceId': engine.space_id,
                      'coldStartMs': (time.perf_counter() - STARTED) * 1000, 'rssBytes': current_rss(), 'threads': threads,
                      'pythonVersion': platform.python_version(), 'numpyVersion': np.__version__, 'torchVersion': torch.__version__,
                      'modelRevision': manifest['revision'], 'modelManifestSha256': checksum(model / 'dooknow-model-manifest.json')}), flush=True)
    uvicorn.run(app, fd=sock.fileno(), access_log=False, log_level='warning')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--counts', default='10000,100000')
    parser.add_argument('--queries', type=int, default=100)
    parser.add_argument('--warmup', type=int, default=10)
    parser.add_argument('--concurrency', type=int, default=5)
    parser.add_argument('--threads', type=int, default=2)
    parser.add_argument('--seed', type=int, default=20261014)
    parser.add_argument('--no-background', action='store_true')
    parser.add_argument('--validate', action='store_true')
    parser.add_argument('--serve', action='store_true')
    parser.add_argument('--root')
    parser.add_argument('--token-file')
    parser.add_argument('--model-dir', default=str(PROJECT / '.local/models/bge-small-zh-v1.5'))
    parser.add_argument('--output', default=str(OUTPUT))
    args = parser.parse_args()
    counts = [int(x) for x in args.counts.split(',')]
    if not counts or any(n < 1 or n > 1000000 for n in counts) or not 1 <= args.concurrency <= 32 or not 1 <= args.queries <= 10000 or not 0 <= args.warmup <= 1000 or not 1 <= args.threads <= 16 or not 0 <= args.seed <= 4294967295:
        parser.error('Invalid workload size/concurrency/thread limit')
    if args.serve:
        serve(args)
        return
    output = safe_output(args.output)
    output.mkdir(parents=True, exist_ok=True, mode=0o700)
    root = Path(tempfile.mkdtemp(prefix='vectors-', dir=output))
    if args.validate:
        print(json.dumps(validate_numerics(root)))
        return
    startup_ms = (time.perf_counter() - STARTED) * 1000
    results = []
    for count in counts:
        value = numerical_run(root / str(count), count, args)
        results.append(value)
        print(json.dumps({'chunks': count, 'vectorSearch': value['vectorSearch'], 'targetPassed': value['targetPassed']}), flush=True)
    report = {'environment': {'timestamp': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()), 'python': platform.python_version(), 'numpy': np.__version__, 'platform': platform.platform(), 'logicalCpus': os.cpu_count(), 'threads': threads, 'startupMsBeforeNumericalBuild': startup_ms}, 'parameters': vars(args), 'results': results}
    (root / 'result.json').write_text(json.dumps(report, ensure_ascii=False, indent=2) + '\n')
    print(json.dumps({'resultFile': str(root / 'result.json')}), flush=True)


if __name__ == '__main__':
    main()
