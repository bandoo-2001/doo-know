import { expect, it, vi } from 'vitest';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { openDatabase } from '../packages/core/db.js';

it.each(['ENOENT', 'EACCES', 'EPERM'])(
  'refuses the workload and retains original bytes when process containment is unavailable: %s',
  async (code) => {
    const root = await mkdtemp(join(tmpdir(), 'runner-unavailable-'));
    const db = openDatabase(join(root, 'data')),
      marker = join(root, 'executed'),
      retained = join(root, 'retained.md');
    const original = '# 原文保持完整\r\n保留空白  \r\n';
    try {
      await writeFile(retained, original);
      vi.resetModules();
      if (code === 'EPERM') {
        vi.doMock('node:child_process', async () => {
          const actual =
            await vi.importActual<typeof import('node:child_process')>('node:child_process');
          return {
            ...actual,
            execFileSync: (file: any, args: any, ...rest: any[]) => {
              if (String(file).endsWith('/.build/process-runner') && args?.[0] === '--check')
                throw Object.assign(new Error('fixture kernel policy refused'), { code });
              return (actual.execFileSync as any)(file, args, ...rest);
            },
          };
        });
      } else {
        vi.doMock('node:fs', async () => {
          const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
          return {
            ...actual,
            lstatSync: (file: any, ...rest: any[]) => {
              if (String(file).endsWith('/.build/process-runner'))
                throw Object.assign(new Error('fixture component unavailable'), { code });
              return (actual.lstatSync as any)(file, ...rest);
            },
          };
        });
      }
      const { guardedProcess } = await import('../packages/core/processes/guarded.js');
      const { workspaceExclusive, workspacePermit } =
        await import('../packages/core/workspace/gate.js');
      await expect(
        workspaceExclusive(
          db,
          { kind: 'unavailable-component-fixture' },
          async () =>
            guardedProcess(
              db,
              { kind: 'workspace', token: workspacePermit(db) },
              process.execPath,
              ['-e', `require('node:fs').writeFileSync(${JSON.stringify(marker)},'executed')`],
              root,
              { env: {} },
            ).wait,
        ),
      ).rejects.toMatchObject({ code: 'PROCESS_CONTAINMENT_UNAVAILABLE', statusCode: 503 });
      expect(existsSync(marker)).toBe(false);
      expect(await readFile(retained, 'utf8')).toBe(original);
      expect(db.prepare('SELECT * FROM workspace_guards').all()).toEqual([]);
      expect(db.prepare('SELECT * FROM workspace_gate').all()).toEqual([]);
    } finally {
      vi.doUnmock('node:fs');
      vi.doUnmock('node:child_process');
      vi.resetModules();
      db.close();
      await rm(root, { recursive: true, force: true });
    }
  },
);
