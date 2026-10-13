import { it, expect, vi } from 'vitest';
import { writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createFixture } from '../support/fixture.js';
import { readyRead } from '../support/read.js';
import { agentConfig, agentHeaders } from '../support/agent.js';
import { createApp } from '../../server/app.js';
import { openDatabase } from '../../server/db.js';
const gate = vi.hoisted(() => ({
  hold: false,
  started: undefined as (() => void) | undefined,
  resume: undefined as Promise<void> | undefined,
}));
vi.mock('node:fs/promises', async (original) => {
  const fs = await original<typeof import('node:fs/promises')>();
  return {
    ...fs,
    open: async (...args: any[]) => {
      const fd = await (fs.open as any)(...args);
      if (gate.hold && String(args[0]).endsWith('.tmp')) {
        gate.hold = false;
        return new Proxy(fd, {
          get(target, key) {
            if (key === 'write')
              return async (...parts: any[]) => {
                gate.started?.();
                await gate.resume;
                return target.write(...parts);
              };
            const value = Reflect.get(target, key, target);
            return typeof value === 'function' ? value.bind(target) : value;
          },
        });
      }
      return fd;
    },
  };
});
it('fences expired workers and preserves the replacement worker result, lock and single revision', async () => {
  const f = await createFixture({ agent: agentConfig });
  let replacement: Awaited<ReturnType<typeof createApp>> | undefined,
    release: () => void = () => {};
  try {
    const file = join(f.knowledgeRoot, '00-Inbox/leased.md');
    await writeFile(file, '# Before\n' + 'x'.repeat(2 * 1024 * 1024));
    const headers = agentHeaders(),
      n = (await f.app.inject({ url: '/api/agent/v1/notes', headers })).json().data.items[0],
      page = (await readyRead(f, n.id)).json().data.data;
    const started = new Promise<void>((resolve) => {
      gate.started = resolve;
    });
    gate.resume = new Promise<void>((resolve) => {
      release = resolve;
    });
    gate.hold = true;
    const r = await f.app.inject({
      method: 'POST',
      url: `/api/agent/v1/notes/${n.id}/patch`,
      headers,
      payload: {
        snapshotId: page.snapshotId,
        expectedModifiedAt: page.modifiedAt,
        expectedContentHash: page.sourceHash,
        requestId: 'fence-once',
        edits: [{ type: 'replace_text', before: '# Before', after: '# Winner' }],
      },
    });
    expect(r.statusCode).toBe(200);
    const id = r.json().data.operation.operationId;
    await started;
    const db = openDatabase(f.dataRoot);
    db.prepare(
      "UPDATE file_operations SET status='queued',lease_until=0,lease_epoch=lease_epoch+1 WHERE id=?",
    ).run(id);
    db.prepare("UPDATE operations SET status='queued' WHERE id=?").run(id);
    db.close();
    replacement = await createApp({ ...f.config, agent: agentConfig });
    let op: any;
    for (let i = 0; i < 100; i++) {
      op = (
        await replacement.inject({ url: `/api/agent/v1/operations/${id}`, headers: agentHeaders() })
      ).json().data;
      if (['succeeded', 'failed'].includes(op.status)) break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    expect(op.status).toBe('succeeded');
    release();
    await f.app.close();
    expect(
      (
        await replacement.inject({ url: `/api/agent/v1/operations/${id}`, headers: agentHeaders() })
      ).json().data.status,
    ).toBe('succeeded');
    expect((await readFile(file, 'utf8')).startsWith('# Winner')).toBe(true);
    const check = openDatabase(f.dataRoot);
    expect((check.prepare('SELECT count(*) n FROM revisions').get() as any).n).toBe(1);
    check.close();
  } finally {
    release();
    gate.hold = false;
    gate.started = undefined;
    gate.resume = undefined;
    await replacement?.close();
    await f.close();
  }
});
