import { it, expect } from 'vitest';
import { existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { projectRoot, modelDir } from './support.js';
import { join } from 'node:path';
import { dirname } from 'node:path';
import { readFile } from 'node:fs/promises';
it.skipIf(!existsSync(join(modelDir, 'dooknow-model-manifest.json')))(
  'executes a real offline BGE search fixture and verifies ACL/response bounds',
  async () => {
    const child = spawn(
      process.execPath,
      [
        '--import',
        'tsx',
        'scripts/search-benchmark.ts',
        '--validate',
        '--counts',
        '128',
        '--queries',
        '5',
        '--warmup',
        '1',
        '--no-background',
      ],
      { cwd: projectRoot },
    );
    let output = '',
      errors = '';
    child.stdout.on('data', (b) => (output += b));
    child.stderr.on('data', (b) => (errors += b));
    const code = await new Promise<number | null>((yes, no) => {
      child.on('error', no);
      child.on('exit', yes);
    });
    expect(code, errors).toBe(0);
    expect(output).toContain('"semanticVectorsAreReal":true');
    expect(output).toContain('"permissionLeaks":0');
    expect(output).toContain('"responseBoundsPassed":true');
    expect(output).toContain('"productionJobBuildMeasured":true');
    const scale = output
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line))
      .find((line) => line.chunks === 128 && line.resultFile && line.semanticVectorsAreReal);
    const fixtureRoot = dirname(scale.resultFile),
      original = await readFile(scale.resultFile, 'utf8');
    const retest = spawn(
      process.execPath,
      [
        '--import',
        'tsx',
        'scripts/search-benchmark.ts',
        '--reuse',
        fixtureRoot,
        '--validate',
        '--counts',
        '128',
        '--queries',
        '5',
        '--warmup',
        '1',
        '--no-background',
      ],
      { cwd: projectRoot },
    );
    let reuseOutput = '',
      reuseErrors = '';
    retest.stdout.on('data', (b) => (reuseOutput += b));
    retest.stderr.on('data', (b) => (reuseErrors += b));
    const reuseCode = await new Promise<number | null>((yes, no) => {
      retest.on('error', no);
      retest.on('exit', yes);
    });
    expect(reuseCode, reuseErrors).toBe(0);
    expect(reuseOutput).toContain('"fixtureReused":true');
    expect(await readFile(scale.resultFile, 'utf8')).toBe(original);
  },
  60000,
);
