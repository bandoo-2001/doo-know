import { it, expect } from 'vitest';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createFixture } from '../support/fixture.js';
import { agentConfig, agentHeaders } from '../support/agent.js';
it.each([1024 * 1024, 2 * 1024 * 1024, 20 * 1024 * 1024, 20 * 1024 * 1024 + 1])(
  'metadata and background snapshot support %i bytes without full-response reads',
  async (size) => {
    const f = await createFixture({ agent: agentConfig });
    try {
      await writeFile(join(f.knowledgeRoot, '00-Inbox/large.md'), 'x'.repeat(size));
      const headers = agentHeaders();
      const n = (await f.app.inject({ url: '/api/agent/v1/notes', headers })).json().data.items[0];
      expect(n.sizeBytes).toBe(size);
      expect(n).not.toHaveProperty('content');
      expect(n.editorMode).toBe(size > 20 * 1024 * 1024 ? 'metadata' : 'large');
      const r = await f.app.inject({
        method: 'POST',
        url: `/api/agent/v1/notes/${n.id}/read`,
        headers,
        payload: {},
      });
      if (size > 20 * 1024 * 1024) {
        expect(r.statusCode).toBe(413);
        expect(r.json().error.code).toBe('FILE_TOO_LARGE');
      } else {
        expect(r.statusCode).toBe(200);
        expect(r.json().data.kind).toBe('accepted');
        expect(r.json().data.operation.operationId).toBeTruthy();
      }
    } finally {
      await f.close();
    }
  },
);
