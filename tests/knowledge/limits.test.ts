import { it, expect } from 'vitest';
import { createFixture } from '../support/fixture.js';
import { agentConfig, agentHeaders } from '../support/agent.js';
it('rejects full serialized request oversize and compressed bodies without mutating files', async () => {
  const f = await createFixture({ agent: agentConfig });
  try {
    const r = await f.app.inject({
      method: 'POST',
      url: '/api/agent/v1/notes',
      headers: agentHeaders(),
      payload: {
        directory: '00-Inbox',
        fileName: 'x.md',
        content: '\\'.repeat(32768),
        padding: 'x'.repeat(128 * 1024),
        requestId: 'big',
      },
    });
    expect(r.statusCode).toBe(413);
    expect(r.json().error.code).toBe('REQUEST_TOO_LARGE');
    expect(
      (
        await f.app.inject({
          method: 'POST',
          url: '/api/agent/v1/notes',
          headers: { ...agentHeaders(), 'content-encoding': 'gzip' },
          payload: {},
        })
      ).statusCode,
    ).toBe(415);
  } finally {
    await f.close();
  }
});
