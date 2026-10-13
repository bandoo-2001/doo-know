import { createFixture } from './fixture.js';
import { agentHeaders } from './agent.js';
export async function readyRead(
  f: Awaited<ReturnType<typeof createFixture>>,
  id: string,
  payload: any = {},
) {
  const headers = agentHeaders(),
    url = `/api/agent/v1/notes/${id}/read`;
  for (let i = 0; i < 100; i++) {
    const r = await f.app.inject({ method: 'POST', url, headers, payload });
    if (r.statusCode !== 200 || r.json().data.kind === 'ready') return r;
    if (r.json().data.kind === 'accepted') {
      await new Promise((r) => setTimeout(r, 20));
      continue;
    }
    return r;
  }
  throw new Error('snapshot did not become ready');
}
