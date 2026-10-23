import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createFixture, loginFixtureOwner, type Fixture } from './support/fixture';

const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8"><path d="M0 0H8V8Z"/></svg>';

describe('knowledge syntax preserves public attachment scope', () => {
  let f: Fixture;
  let headers: Awaited<ReturnType<typeof loginFixtureOwner>>;
  let serial = 0;
  beforeAll(async () => { f = await createFixture(); headers = await loginFixtureOwner(f); });
  afterAll(async () => f?.close());

  async function shared(content: (path: string) => string) {
    const created = await f.app.inject({ method: 'POST', url: '/api/notes', headers,
      payload: { folderPath: '00-Inbox', fileName: `knowledge-assets-${++serial}.md`, content: '# fixture' } });
    expect(created.statusCode, created.body).toBe(201);
    const note = created.json();
    const boundary = 'knowledge-assets-fixture';
    const uploaded = await f.app.inject({ method: 'POST', url: `/api/notes/${note.id}/assets`,
      headers: { ...headers, 'content-type': `multipart/form-data; boundary=${boundary}` },
      payload: Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="source.svg"\r\nContent-Type: image/svg+xml\r\n\r\n${svg}\r\n--${boundary}--\r\n`),
    });
    expect(uploaded.statusCode, uploaded.body).toBe(201);
    const asset = uploaded.json();
    await writeFile(join(f.knowledgeRoot, note.relativePath), content(asset.markdownPath));
    const share = await f.app.inject({ method: 'POST', url: `/api/notes/${note.id}/share`, headers, payload: {} });
    expect(share.statusCode, share.body).toBe(200);
    const token = share.json().token;
    return { note, token, urls: [
      `/api/public/shares/${token}/assets/${asset.id}`,
      `/api/public/shares/${token}/asset?source=${encodeURIComponent(asset.markdownPath)}`,
    ] };
  }

  it.each([
    (path: string) => `$$\nx\n\n![hidden](${path})\n\n$$\n`,
    (path: string) => `$$x\r\n\r\n[source](${path})\r\n\r\nx$$\r\n`,
    (path: string) => `$$\nx\n\n[source](${path})\n`,
  ])('denies anonymous reads of attachment-looking text inside display math %#', async content => {
    const { urls } = await shared(content);
    for (const url of urls) for (const suffix of ['', (url.includes('?') ? '&' : '?') + 'download=1']) {
      const response = await f.app.inject({ url: url + suffix });
      expect(response.statusCode, response.body).toBe(404);
      expect(response.body).not.toContain(svg);
    }
  });

  it.each([
    (path: string) => `reference[^a]\n\n[^a]: ![visible](${path})\n`,
    (path: string) => `[^a]: ![visible](${path})\n\nreference[^a]\n`,
    (path: string) => `reference[^a]\n\n[^a]: explanation\n\n    [source](${path})\n`,
  ])('allows current saved attachment references in a rendered footnote %#', async content => {
    const { urls } = await shared(content);
    for (const url of urls) {
      const response = await f.app.inject({ url: url + (url.includes('?') ? '&' : '?') + 'download=1' });
      expect(response.statusCode, response.body).toBe(200);
      expect(response.body).toBe(svg);
    }
  });

  it.each([
    (path: string) => `[^unused]: ![hidden](${path})\n`,
    (path: string) => `reference[^a]\n\n[^a]: explanation\n\n        ![hidden](${path})\n`,
    (path: string) => `reference[^a]\n\n[^a]: ![old](${path})\n\n[^a]: replacement without attachment\n`,
  ])('denies unused, code-only or superseded footnote attachments %#', async content => {
    const { urls } = await shared(content);
    for (const url of urls) {
      const response = await f.app.inject({ url });
      expect(response.statusCode, response.body).toBe(404);
    }
  });
});
