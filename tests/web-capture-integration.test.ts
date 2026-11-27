import { randomUUID } from 'node:crypto';
import { readFile, rmdir } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { createFixture, loginFixtureOwner } from './support/fixture.js';

it('saves confirmed capture as inbox Markdown and exposes the saved body and source to MCP', async () => {
  let fixture: Awaited<ReturnType<typeof createFixture>> | undefined;
  try {
    const f = (fixture = await createFixture({
      indexing: { watch: false },
    }));
    const headers = await loginFixtureOwner(f);
    const post = (url: string, payload: Record<string, unknown> = {}) =>
      f.app.inject({ method: 'POST', url, headers, payload });

    const previewPath = '/api/web-capture/preview';
    const privateUrl = { url: 'http://127.0.0.1/' };
    const anonymous = await f.app.inject({ method: 'POST', url: previewPath, payload: privateUrl });
    expect(anonymous.statusCode).toBe(401);
    const blocked = await post(previewPath, privateUrl);
    expect(blocked.statusCode, blocked.body).toBe(422);

    // A freshly bound library can have no inbox yet.
    await rmdir(join(f.knowledgeRoot, '00-Inbox'));
    const confirmation = {
      title: 'Recovery procedure',
      sourceUrl: 'https://example.com/manual#restore',
      markdown: '## Verification\n\nRun the captureverification marker after restore.',
      requestId: randomUUID(),
    };
    const savePath = '/api/web-capture/save';
    const first = await post(savePath, confirmation);
    expect(first.statusCode, first.body).toBe(201);
    const { id, relativePath } = first.json();
    expect(relativePath).toBe('00-Inbox/Recovery procedure.md');
    expect(await readFile(join(f.knowledgeRoot, relativePath), 'utf8')).toBe(
      `# ${confirmation.title}\n\n原网页：<${confirmation.sourceUrl}>\n\n${confirmation.markdown}\n`,
    );
    expect((await post(savePath, confirmation)).json().id).toBe(id);

    const other = { ...confirmation, markdown: 'Other content', requestId: randomUUID() };
    const duplicateTitle = await post(savePath, other);
    expect(duplicateTitle.statusCode, duplicateTitle.body).toBe(201);
    expect(duplicateTitle.json().relativePath).not.toBe(relativePath);
    expect((await post(savePath, other)).json().id).toBe(duplicateTitle.json().id);

    const enabled = await f.app.inject({ method: 'PUT', url: '/api/platform/mcp/enabled', headers, payload: { enabled: true } });
    expect(enabled.statusCode, enabled.body).toBe(200);
    const permissions = await f.app.inject({ url: '/api/platform/mcp/permissions', headers });
    const client = await post('/api/platform/mcp/api-clients', {
      name: 'Web capture MCP fixture',
      permissionPolicy: permissions.json().policy,
    });
    expect(client.statusCode, client.body).toBe(200);
    let sequence = 0;
    const tool = async (name: string, args: Record<string, unknown>) => {
      const response = await f.app.inject({
        method: 'POST',
        url: '/mcp/api-key',
        headers: {
          host: new URL(f.config.origin).host,
          authorization: 'Bearer ' + client.json().key,
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
        },
        payload: {
          jsonrpc: '2.0',
          id: ++sequence,
          method: 'tools/call',
          params: { name, arguments: args },
        },
      });
      expect(response.statusCode, response.body).toBe(200);
      const { result } = response.json();
      expect(result?.isError, response.body).not.toBe(true);
      expect(result?.structuredContent, response.body).toBeDefined();
      return result.structuredContent;
    };

    const query = 'captureverification';
    await expect
      .poll(() => tool('search', { query }), { timeout: 10_000 })
      .toMatchObject({ results: [{ title: confirmation.title }] });
    const indexed = await tool('search_notes', { query, mode: 'text' });
    expect(indexed.data.results).toMatchObject([{ noteId: id, relativePath }]);
    const search = await tool('search', { query });
    expect(search.results).toHaveLength(1);
    const found = await tool('fetch', { id: search.results[0].id });
    expect(found.text).toContain(confirmation.sourceUrl);
    expect(found.text).toContain(confirmation.markdown);
  } finally {
    await fixture?.close();
  }
});
