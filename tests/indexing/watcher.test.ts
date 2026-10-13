import { it, expect, vi } from 'vitest';
import { setTimeout as delay } from 'node:timers/promises';
import { writeFile, utimes } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { createFixture } from '../support/fixture.js';
import { agentConfig, agentHeaders } from '../support/agent.js';
const hash = (s: string) => createHash('sha256').update(s).digest('hex');
it('discovers edits from root watching without an explicit refresh', async () => {
  const f = await createFixture({ agent: agentConfig, indexing: { enabled: true, watch: true } });
  try {
    await writeFile(join(f.knowledgeRoot, '00-Inbox/watched.md'), 'WATCHED');
    let data: any;
    for (let i = 0; i < 60; i++) {
      data = (
        await f.app.inject({ url: '/api/agent/v1/index/status', headers: agentHeaders() })
      ).json().data;
      if (data.documents[0]?.sourceHash === hash('WATCHED')) break;
      await delay(50);
    }
    expect(data.documents[0]?.sourceHash).toBe(hash('WATCHED'));
  } finally {
    await f.close();
  }
});
it('recovers missed equal-stat edits through the 300-second full hash clock', async () => {
  vi.useFakeTimers({
    toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'],
  });
  const f = await createFixture({ agent: agentConfig, indexing: { enabled: true, watch: false } });
  try {
    const file = join(f.knowledgeRoot, '00-Inbox/periodic.md');
    await writeFile(file, 'AAAA');
    await utimes(file, 1700000000, 1700000000);
    const status = async () =>
      (await f.app.inject({ url: '/api/agent/v1/index/status', headers: agentHeaders() })).json()
        .data;
    await vi.advanceTimersByTimeAsync(60000);
    let data: any;
    for (let i = 0; i < 100; i++) {
      data = await status();
      if (data.documents[0]?.sourceHash === hash('AAAA')) break;
      await delay(10);
    }
    expect(data.documents[0]?.sourceHash).toBe(hash('AAAA'));
    await writeFile(file, 'BBBB');
    await utimes(file, 1700000000, 1700000000);
    await vi.advanceTimersByTimeAsync(60000);
    await delay(100);
    expect((await status()).documents[0]?.sourceHash).toBe(hash('AAAA'));
    await vi.advanceTimersByTimeAsync(180000);
    for (let i = 0; i < 100; i++) {
      data = await status();
      if (data.documents[0]?.sourceHash === hash('BBBB')) break;
      await delay(10);
    }
    expect(data.documents[0]?.sourceHash).toBe(hash('BBBB'));
  } finally {
    await f.close();
    vi.useRealTimers();
  }
});
