import { it, expect, vi } from 'vitest';
import { writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createFixture } from '../support/fixture.js';
import { agentConfig, agentHeaders } from '../support/agent.js';
const fault = vi.hoisted(() => ({ diskFull: false }));
vi.mock('node:fs', async (original) => {
  const fs = await original<typeof import('node:fs')>();
  return {
    ...fs,
    writeFileSync: (...args: any[]) => {
      if (fault.diskFull) throw Object.assign(new Error('fixture ENOSPC'), { code: 'ENOSPC' });
      return (fs.writeFileSync as any)(...args);
    },
  };
});
it.each(['create', 'update', 'archive', 'large'])(
  'keeps a deterministic %s refusal terminal and replays the same failure',
  async (kind) => {
    const f = await createFixture({ agent: agentConfig });
    try {
      const n = (
        await f.app.inject({
          method: 'POST',
          url: '/api/agent/v1/notes',
          headers: agentHeaders(),
          payload: {
            directory: '00-Inbox',
            fileName: 'known.md',
            content: 'ORIGINAL',
            requestId: 'create-known',
          },
        })
      ).json().data;
      if (kind === 'large')
        await writeFile(join(f.knowledgeRoot, '00-Inbox/known.md'), 'x'.repeat(2 * 1024 * 1024));
      const requestId = 'known-refusal';
      const input =
        kind === 'create'
          ? {
              method: 'POST' as const,
              url: '/api/agent/v1/notes',
              payload: { directory: '00-Inbox', fileName: 'known.md', content: 'OTHER', requestId },
            }
          : kind === 'archive'
            ? {
                method: 'POST' as const,
                url: `/api/agent/v1/notes/${n.id}/archive`,
                payload: { expectedModifiedAt: '0', requestId },
              }
            : {
                method: 'PUT' as const,
                url: `/api/agent/v1/notes/${n.id}`,
                payload: {
                  content: 'OTHER',
                  expectedModifiedAt: kind === 'large' ? n.modifiedAt : '0',
                  requestId,
                },
              };
      const first = await f.app.inject({ ...input, headers: agentHeaders() });
      expect(first.statusCode).toBe(409);
      const status = await f.app.inject({
        url: '/api/agent/v1/operations?requestId=' + requestId,
        headers: agentHeaders(),
      });
      expect(status.json().data.status).toBe('failed');
      expect(status.json().data.error.code).toBe(first.json().error.code);
      const retry = await f.app.inject({ ...input, headers: agentHeaders() });
      expect(retry.statusCode).toBe(first.statusCode);
      expect(retry.json().error).toEqual(first.json().error);
      expect(await readFile(join(f.knowledgeRoot, '00-Inbox/known.md'), 'utf8')).toBe(
        kind === 'large' ? 'x'.repeat(2 * 1024 * 1024) : 'ORIGINAL',
      );
    } finally {
      await f.close();
    }
  },
);
it('records ENOSPC before an intent as unapplied and leaves original/history unchanged', async () => {
  const f = await createFixture({ agent: agentConfig });
  try {
    const n = (
      await f.app.inject({
        method: 'POST',
        url: '/api/agent/v1/notes',
        headers: agentHeaders(),
        payload: {
          directory: '00-Inbox',
          fileName: 'disk-full.md',
          content: 'ORIGINAL',
          requestId: 'disk-create',
        },
      })
    ).json().data;
    fault.diskFull = true;
    await f.app.inject({
      method: 'PUT',
      url: `/api/agent/v1/notes/${n.id}`,
      headers: agentHeaders(),
      payload: { content: 'NEW', expectedModifiedAt: n.modifiedAt, requestId: 'disk-full' },
    });
    fault.diskFull = false;
    const status = (
      await f.app.inject({
        url: '/api/agent/v1/operations?requestId=disk-full',
        headers: agentHeaders(),
      })
    ).json().data;
    expect(status.status).toBe('failed');
    expect(await readFile(join(f.knowledgeRoot, '00-Inbox/disk-full.md'), 'utf8')).toBe('ORIGINAL');
  } finally {
    fault.diskFull = false;
    await f.close();
  }
});
