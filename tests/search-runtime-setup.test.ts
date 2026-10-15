import { it, expect } from 'vitest';
import { createFixture, loginFixtureOwner } from './support/fixture.js';
it('keeps notes usable when local search is unprepared and protects preparation with owner authentication and CSRF', async () => {
  const f = await createFixture();
  try {
    expect((await f.app.inject({ url: '/api/platform/search-runtime' })).statusCode).toBe(401);
    const headers = await loginFixtureOwner(f);
    const state = await f.app.inject({ url: '/api/platform/search-runtime', headers });
    expect(state.statusCode).toBe(200);
    expect(state.json().distributionAvailable).toBe(false);
    expect(
      (
        await f.app.inject({
          method: 'POST',
          url: '/api/platform/search-runtime/prepare',
          headers: { ...headers, origin: 'https://untrusted.invalid' },
          payload: { requestId: 'prepare' },
        })
      ).statusCode,
    ).toBe(403);
    const unavailable = await f.app.inject({
      method: 'POST',
      url: '/api/platform/search-runtime/prepare',
      headers,
      payload: { requestId: 'prepare' },
    });
    expect(unavailable.statusCode).toBe(503);
    expect(unavailable.json().code).toBe('SEARCH_DISTRIBUTION_UNAVAILABLE');
    const note = await f.app.inject({
      method: 'POST',
      url: '/api/notes',
      headers,
      payload: {
        folderPath: '00-Inbox',
        fileName: 'no-model.md',
        content: '# available',
        requestId: 'no-model',
      },
    });
    expect(note.statusCode).toBe(201);
  } finally {
    await f.close();
  }
});
