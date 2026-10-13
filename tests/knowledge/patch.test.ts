import { it, expect } from 'vitest';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createFixture } from '../support/fixture.js';
import { agentConfig, agentHeaders } from '../support/agent.js';
import { readyRead } from '../support/read.js';
import { createHash } from 'node:crypto';
it('patches only a loaded range, deduplicates and refuses stale hashes, overlapping or split UTF-8 ranges', async () => {
  const f = await createFixture({ agent: agentConfig });
  try {
    const file = join(f.knowledgeRoot, '00-Inbox/patch.md'),
      original = '# 中文\nFIRST\nUNLOADED_END';
    await writeFile(file, original);
    const n = (await f.app.inject({ url: '/api/agent/v1/notes', headers: agentHeaders() })).json()
        .data.items[0],
      r = await readyRead(f, n.id, { range: { startLine: 2, endLine: 2 } });
    expect(r.statusCode).toBe(200);
    const page = r.json().data.data;
    const base = {
        snapshotId: page.snapshotId,
        expectedModifiedAt: page.modifiedAt,
        expectedContentHash: page.sourceHash,
      },
      url = `/api/agent/v1/notes/${n.id}/patch`;
    for (const edits of [
      [{ type: 'replace_text', before: 'missing', after: 'bad' }],
      [
        {
          type: 'replace_range',
          startByte: 3,
          endByte: 5,
          expectedRangeHash: 'bad',
          insert: 'bad',
        },
      ],
      [
        { type: 'replace_range', startByte: 0, endByte: 6, expectedRangeHash: 'bad', insert: '' },
        { type: 'replace_range', startByte: 2, endByte: 7, expectedRangeHash: 'bad', insert: '' },
      ],
    ]) {
      const bad = await f.app.inject({
        method: 'POST',
        url,
        headers: agentHeaders(),
        payload: { ...base, requestId: `invalid-${JSON.stringify(edits)}`, edits },
      });
      expect(bad.statusCode).toBeGreaterThanOrEqual(400);
      expect(await readFile(file, 'utf8')).toBe(original);
    }
    const payload = {
      ...base,
      requestId: 'patch-once',
      edits: [
        {
          type: 'replace_range',
          startByte: page.startByte,
          endByte: page.endByte,
          expectedRangeHash: page.rangeHash,
          insert: 'CHANGED\n',
        },
      ],
    };
    const good = await f.app.inject({ method: 'POST', url, headers: agentHeaders(), payload });
    expect(good.statusCode).toBe(200);
    const accepted = good.json().data;
    expect(accepted.kind).toBe('accepted');
    let result: any;
    for (let i = 0; i < 100; i++) {
      result = (
        await f.app.inject({
          url: `/api/agent/v1/operations/${accepted.operation.operationId}`,
          headers: agentHeaders(),
        })
      ).json().data;
      if (['succeeded', 'failed', 'needs_reconciliation'].includes(result.status)) break;
      await new Promise((r) => setTimeout(r, 20));
    }
    expect(result.status).toBe('succeeded');
    expect(result.result).not.toHaveProperty('content');
    expect(result.result.contentHash).toBe(
      createHash('sha256').update('# 中文\nCHANGED\nUNLOADED_END').digest('hex'),
    );
    expect(await readFile(file, 'utf8')).toBe('# 中文\nCHANGED\nUNLOADED_END');
    const retry = await f.app.inject({ method: 'POST', url, headers: agentHeaders(), payload });
    expect(retry.json().data.operation.operationId).toBe(accepted.operation.operationId);
  } finally {
    await f.close();
  }
});
