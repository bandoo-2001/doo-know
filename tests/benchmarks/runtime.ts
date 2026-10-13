import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { once } from 'node:events';
import { createInterface } from 'node:readline';
import {
  projectRoot,
  python,
  modelDir,
  assertBenchmarkDirectory,
  assertDirectoryIdentity,
  assertBenchmarkOutput,
} from './support.js';

export async function startRuntime(root: string, threads: number) {
  const rootIdentity = assertBenchmarkDirectory(root),
    indexes = assertBenchmarkOutput(join(root, 'indexes'));
  await mkdir(indexes, { recursive: true });
  const indexIdentity = assertBenchmarkDirectory(indexes);
  assertDirectoryIdentity(rootIdentity);
  assertDirectoryIdentity(indexIdentity);
  const tokenFile = join(indexes, `runtime-${process.pid}.key`),
    token = 'isolated-benchmark-runtime-only-at-least-thirty-two-characters';
  await writeFile(tokenFile, token, { mode: 0o600, flag: 'wx' });
  const child = spawn(
    python,
    [
      join(projectRoot, 'runtime/vector-service/benchmark.py'),
      '--serve',
      '--root',
      indexes,
      '--token-file',
      tokenFile,
      '--model-dir',
      modelDir,
      '--threads',
      String(threads),
    ],
    {
      cwd: projectRoot,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        HF_HUB_OFFLINE: '1',
        TRANSFORMERS_OFFLINE: '1',
        PYTHONUNBUFFERED: '1',
      },
    },
  );
  let errors = '';
  child.stderr.on('data', (b) => {
    errors = (errors + b.toString()).slice(-2000);
  });
  const reader = createInterface({ input: child.stdout });
  const ready = await new Promise<any>((yes, no) => {
    const timeout = setTimeout(() => {
      child.kill();
      no(new Error('Real BGE startup exceeded 30 seconds'));
    }, 30000);
    child.on('error', no);
    child.once('exit', (code) => {
      clearTimeout(timeout);
      no(new Error(`Real BGE runtime exited ${code}: ${errors}`));
    });
    reader.on('line', (line) => {
      try {
        const value = JSON.parse(line);
        if (value.port) {
          clearTimeout(timeout);
          yes(value);
        }
      } catch {}
    });
  });
  const url = `http://127.0.0.1:${ready.port}`;
  for (let i = 0; i < 100; i++) {
    try {
      if ((await fetch(url + '/health')).ok) break;
    } catch {}
    await new Promise((r) => setTimeout(r, 20));
  }
  return {
    ...ready,
    url,
    token,
    indexes,
    close: async () => {
      if (child.exitCode !== null || child.signalCode !== null) return;
      const done = once(child, 'exit');
      child.kill();
      await done;
    },
  };
}
