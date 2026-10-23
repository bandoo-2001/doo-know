import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createFixture, loginFixtureOwner, type Fixture } from './support/fixture.js';

const svg =
  '<?xml version="1.0" encoding="UTF-8"?>\r\n' +
  '<!-- 原始源码注释 -->\r\n' +
  '<svg xmlns="http://www.w3.org/2000/svg" width="64" height="32" viewBox="0 0 64 32">' +
  '<defs><linearGradient id="color"><stop offset="0%" stop-color="#123456"/>' +
  '<stop offset="100%" stop-color="#abcdef"/></linearGradient></defs>' +
  '<path d="M0 0H64V32H0Z" fill="url(#color)"/>' +
  '<text x="2" y="20" font-size="12">中文 &amp; SVG</text></svg>';
const wrap = (body: string, attrs = '') =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="64" height="32" ${attrs}>${body}</svg>`;
const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a7i8AAAAASUVORK5CYII=',
  'base64',
);

describe('restricted SVG attachments', () => {
  let f: Fixture;
  let headers: Awaited<ReturnType<typeof loginFixtureOwner>>;
  let serial = 0;
  beforeAll(async () => {
    f = await createFixture();
    headers = await loginFixtureOwner(f);
  });
  afterAll(async () => f?.close());
  async function note() {
    const response = await f.app.inject({
      method: 'POST',
      url: '/api/notes',
      headers,
      payload: { folderPath: '00-Inbox', fileName: `svg-${++serial}.md`, content: '# SVG' },
    });
    expect(response.statusCode).toBe(201);
    return response.json();
  }
  async function upload(
    id: string,
    name = 'diagram.svg',
    mime = 'image/svg+xml',
    bytes = Buffer.from(svg),
  ) {
    const boundary = 'svg-attachment-fixture';
    return f.app.inject({
      method: 'POST',
      url: `/api/notes/${id}/assets`,
      headers: { ...headers, 'content-type': `multipart/form-data; boundary=${boundary}` },
      payload: Buffer.concat([
        Buffer.from(
          `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${name}"\r\nContent-Type: ${mime}\r\n\r\n`,
        ),
        bytes,
        Buffer.from(`\r\n--${boundary}--\r\n`),
      ]),
    });
  }
  async function uploaded(id: string) {
    const response = await upload(id);
    expect(response.statusCode).toBe(201);
    return response.json();
  }
  async function share(id: string, reset = false) {
    const response = await f.app.inject({
      method: 'POST',
      url: `/api/notes/${id}/share${reset ? '/reset' : ''}`,
      headers,
      payload: {},
    });
    expect(response.statusCode).toBe(200);
    return response.json().token as string;
  }

  it('preserves accepted SVG bytes and separates controlled preview from source download', async () => {
    const n = await note(),
      asset = await uploaded(n.id);
    expect(asset.mime).toBe('image/svg+xml');
    expect(asset.markdownPath).toMatch(/^assets\/[^/]+\.svg$/);
    expect(await readFile(join(f.knowledgeRoot, asset.relativePath), 'utf8')).toBe(svg);
    const url = `/api/assets/${asset.id}`;
    const preview = await f.app.inject({ url, headers });
    expect(preview.statusCode).toBe(200);
    expect(preview.headers['content-type']).toMatch(/^image\/svg\+xml(?:;|$)/);
    expect(preview.headers['content-disposition']).toBe('inline');
    expect(preview.headers['content-security-policy']).toContain("default-src 'none'");
    expect(preview.headers['x-content-type-options']).toBe('nosniff');
    expect(preview.body).toContain('<linearGradient');
    expect(preview.body).toContain('中文 &amp; SVG');
    expect(preview.body).not.toContain('<!--');
    expect(preview.body).not.toContain('<?xml');
    const source = await f.app.inject({ url: url + '?download=1', headers });
    expect(source.statusCode).toBe(200);
    expect(source.headers['content-type']).toBe('application/octet-stream');
    expect(source.headers['content-disposition']).toMatch(/^attachment;.*\.svg/);
    expect(source.rawPayload.equals(Buffer.from(svg))).toBe(true);
    for (const suffix of ['', '?download=1'])
      expect((await f.app.inject({ url: url + suffix })).statusCode).toBe(401);
    expect((await f.app.inject({ url: `/api/notes/${n.id}/assets`, headers })).json()).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: asset.id })]),
    );
  });

  it('uses current saved references for public SVG previews and downloads, including invalidated shares', async () => {
    const n = await note(),
      asset = await uploaded(n.id),
      token = await share(n.id);
    const urls = (value: string) => [
      `/api/public/shares/${value}/assets/${asset.id}`,
      `/api/public/shares/${value}/asset?source=${encodeURIComponent(asset.markdownPath)}`,
    ];
    for (const url of urls(token))
      for (const suffix of ['', (url.includes('?') ? '&' : '?') + 'download=1'])
        expect((await f.app.inject({ url: url + suffix })).statusCode).toBe(404);
    await writeFile(
      join(f.knowledgeRoot, n.relativePath),
      `# SVG\n\n![矢量图](${asset.markdownPath})`,
    );
    const rendered = (await f.app.inject({ url: `/api/public/shares/${token}` })).json();
    expect(rendered.html).toContain(`/api/public/shares/${token}/assets/${asset.id}`);
    expect(rendered.html).toContain('alt="矢量图"');
    for (const url of urls(token)) {
      const preview = await f.app.inject({ url });
      expect(preview.statusCode).toBe(200);
      expect(preview.headers['content-type']).toMatch(/^image\/svg\+xml(?:;|$)/);
      const source = await f.app.inject({
        url: url + (url.includes('?') ? '&' : '?') + 'download=1',
      });
      expect(source.headers['content-type']).toBe('application/octet-stream');
      expect(source.rawPayload.equals(Buffer.from(svg))).toBe(true);
    }
    const otherToken = await share((await note()).id);
    expect((await f.app.inject({ url: urls(otherToken)[0] })).statusCode).toBe(404);
    const replacement = await share(n.id, true);
    for (const url of urls(token))
      for (const suffix of ['', (url.includes('?') ? '&' : '?') + 'download=1'])
        expect((await f.app.inject({ url: url + suffix })).statusCode).toBe(404);
    await writeFile(
      join(f.knowledgeRoot, n.relativePath),
      `\`\`\`markdown\n![代码内引用](${asset.markdownPath})\n\`\`\``,
    );
    expect((await f.app.inject({ url: urls(replacement)[0] })).statusCode).toBe(404);
    await writeFile(join(f.knowledgeRoot, n.relativePath), `![图](${asset.markdownPath})`);
    await f.app.inject({ method: 'DELETE', url: `/api/notes/${n.id}/share`, headers });
    expect((await f.app.inject({ url: urls(replacement)[0] + '?download=1' })).statusCode).toBe(
      404,
    );
  });

  it.each([
    ['DOCTYPE', '<!DOCTYPE svg><svg xmlns="http://www.w3.org/2000/svg"/>'],
    [
      'entity declaration',
      '<!DOCTYPE svg [<!ENTITY x SYSTEM "file:///etc/passwd">]>' + wrap('<text>&x;</text>'),
    ],
    ['undeclared entity', wrap('<text>&unknown;</text>')],
    ['script', wrap('<script>alert(1)</script>')],
    ['event handler', wrap('<path d="M0 0" onload="alert(1)"/>')],
    [
      'foreignObject',
      wrap('<foreignObject><div xmlns="http://www.w3.org/1999/xhtml">x</div></foreignObject>'),
    ],
    ['external image', wrap('<image href="https://evil.invalid/tracker.png"/>')],
    ['embedded image', wrap('<image href="data:image/svg+xml;base64,PHN2Zy8+"/>')],
    ['external link', wrap('<a href="https://evil.invalid/"><text>x</text></a>')],
    ['external paint', wrap('<path d="M0 0" fill="url(https://evil.invalid/paint.svg#x)"/>')],
    ['encoded external paint', wrap('<path d="M0 0" fill="url(&#104;ttps://evil.invalid/x)"/>')],
    [
      'external gradient',
      wrap('<defs><linearGradient id="x" href="//evil.invalid/paint.svg#x"/></defs>'),
    ],
    [
      'font CSS',
      wrap('<style>@font-face{font-family:x;src:url(https://evil.invalid/font)}</style>'),
    ],
    ['inline CSS', wrap('<path d="M0 0" style="fill:url(https://evil.invalid/x)"/>')],
    ['stylesheet PI', '<?xml-stylesheet href="https://evil.invalid/style.css"?>' + wrap('')],
    ['wrong root namespace', '<svg xmlns="http://www.w3.org/1999/xhtml"><path/></svg>'],
    ['wrong descendant namespace', wrap('<g xmlns="http://evil.invalid/"><path/></g>')],
    ['unused foreign namespace', wrap('', 'xmlns:evil="http://evil.invalid/"')],
    ['malformed XML', wrap('<path>')],
    ['duplicate attributes', wrap('<path d="M0 0" d="M1 1"/>')],
    ['recursive reuse', wrap('<defs><g id="x"><use href="#x"/></g></defs><use href="#x"/>')],
    [
      'cyclic gradient',
      wrap('<defs><linearGradient id="x" href="#y"/><linearGradient id="y" href="#x"/></defs>'),
    ],
    ['oversized viewport', wrap('', 'viewBox="0 0 8193 1"')],
    [
      'oversized pixel area',
      '<svg xmlns="http://www.w3.org/2000/svg" width="8192" height="8192"/>',
    ],
    ['deep tree', wrap('<g>'.repeat(33) + '</g>'.repeat(33))],
    ['many elements', wrap('<path d="M0 0"/>'.repeat(10000))],
  ])('rejects %s before persisting an attachment', async (_name, source) => {
    const n = await note();
    const before = (await f.app.inject({ url: `/api/notes/${n.id}/assets`, headers })).json();
    const response = await upload(n.id, 'bad.svg', 'image/svg+xml', Buffer.from(source));
    expect(response.statusCode).toBe(400);
    expect((await f.app.inject({ url: `/api/notes/${n.id}/assets`, headers })).json()).toEqual(
      before,
    );
  });

  it('rejects MIME spoofing in both directions and invalid UTF-8', async () => {
    const n = await note();
    for (const [name, mime, bytes] of [
      ['fake.png', 'image/png', Buffer.from(svg)],
      ['fake.svg', 'image/svg+xml', png],
      ['fake.svg', 'image/png', png],
      ['fake.svg', 'text/html', Buffer.from(svg)],
      ['fake.svg', 'image/svg+xml', Buffer.from('<html>unsafe</html>')],
      ['fake.svg', 'image/svg+xml', Buffer.from([0xff, 0xfe, 0x3c, 0x73])],
    ] as const)
      expect((await upload(n.id, name, mime, bytes)).statusCode).toBe(400);
  });

  it('applies a stricter SVG byte limit while retaining the global 10 MiB cap', async () => {
    const n = await note();
    const oversizedSvg = Buffer.from(wrap(' '.repeat(1024 * 1024)));
    expect((await upload(n.id, 'large.svg', 'image/svg+xml', oversizedSvg)).statusCode).toBe(413);
    const oversizedPng = Buffer.concat([png, Buffer.alloc(10 * 1024 * 1024)]);
    expect((await upload(n.id, 'large.png', 'image/png', oversizedPng)).statusCode).toBe(413);
  });

  it('revalidates changed files on every private/public preview and source read', async () => {
    const n = await note(),
      asset = await uploaded(n.id),
      token = await share(n.id);
    await writeFile(join(f.knowledgeRoot, n.relativePath), `![图](${asset.markdownPath})`);
    for (const replacement of [
      wrap('<script>alert(1)</script>'),
      wrap(' '.repeat(1024 * 1024)),
      '<html>fake</html>',
    ]) {
      await writeFile(join(f.knowledgeRoot, asset.relativePath), replacement);
      for (const base of [
        `/api/assets/${asset.id}`,
        `/api/public/shares/${token}/assets/${asset.id}`,
      ])
        for (const suffix of ['', '?download=1']) {
          const response = await f.app.inject({ url: base + suffix, headers });
          expect(response.statusCode).toBe(404);
          expect(response.headers['content-type']).not.toMatch(/^image\/svg/);
          expect(response.body).not.toContain('alert(1)');
        }
    }
  });
});
