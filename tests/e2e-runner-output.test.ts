import { EventEmitter } from 'node:events';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, expect, it, vi } from 'vitest';

const spawn = vi.hoisted(() => vi.fn());
vi.mock('node:child_process', () => ({ spawn }));
const argv = process.argv;
afterEach(() => {
  process.argv = argv;
  spawn.mockReset();
  vi.restoreAllMocks();
  vi.resetModules();
});

it.each(['separate', 'equals'] as const)(
  'retains desktop failure evidence when the mobile project starts with %s output syntax',
  async (syntax) => {
    const root = await mkdtemp(join(tmpdir(), 'e2e-project-output-'));
    const output = join(root, 'results');
    const exit = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    process.argv = [
      process.execPath,
      'scripts/e2e.ts',
      ...(syntax === 'separate' ? ['--output', output] : ['--output=' + output]),
    ];
    spawn.mockImplementation((_binary: string, args: string[]) => {
      const child = new EventEmitter();
      queueMicrotask(async () => {
        try {
          const project = args[args.indexOf('--project') + 1];
          const index = args.findIndex((arg) => arg === '--output' || arg.startsWith('--output='));
          const directory =
            args[index] === '--output' ? args[index + 1] : args[index].slice('--output='.length);
          // Playwright clears the selected output directory at each CLI startup.
          await rm(directory, { recursive: true, force: true });
          await mkdir(directory, { recursive: true });
          await writeFile(join(directory, 'evidence.json'), JSON.stringify({ project }));
          child.emit('exit', 0);
        } catch (error) {
          child.emit('error', error);
        }
      });
      return child;
    });
    try {
      await import('../scripts/e2e.js');
      expect(exit).toHaveBeenCalledWith(0);
      for (const project of ['desktop', 'mobile'])
        expect(JSON.parse(await readFile(join(output, project, 'evidence.json'), 'utf8'))).toEqual({
          project,
        });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);

it('forwards an explicit project and output directory without splitting or relocating its evidence', async () => {
  const root = await mkdtemp(join(tmpdir(), 'e2e-explicit-project-'));
  const output = join(root, 'selected-results');
  vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
  process.argv = [
    process.execPath,
    'scripts/e2e.ts',
    '--project',
    'mobile',
    '--output',
    output,
    '--grep',
    'scroll',
  ];
  spawn.mockImplementation((_binary: string, args: string[]) => {
    const child = new EventEmitter();
    queueMicrotask(async () => {
      try {
        const directory = args[args.indexOf('--output') + 1];
        await mkdir(directory, { recursive: true });
        await writeFile(
          join(directory, 'evidence.json'),
          JSON.stringify({
            project: args[args.indexOf('--project') + 1],
            filter: args[args.indexOf('--grep') + 1],
          }),
        );
        child.emit('exit', 0);
      } catch (error) {
        child.emit('error', error);
      }
    });
    return child;
  });
  try {
    await import('../scripts/e2e.js');
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(JSON.parse(await readFile(join(output, 'evidence.json'), 'utf8'))).toEqual({
      project: 'mobile',
      filter: 'scroll',
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
