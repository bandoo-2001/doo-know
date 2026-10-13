import { it, expect } from 'vitest';
import { writeFile, mkdir, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { createFixture, loginFixtureOwner } from './support/fixture.js';
const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a7i8AAAAASUVORK5CYII=',
  'base64',
);
function multipart(name: string, mime: string, bytes: Buffer) {
  const boundary = 'dooknow-fixture-boundary';
  return {
    body: Buffer.concat([
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${name}"\r\nContent-Type: ${mime}\r\n\r\n`,
      ),
      bytes,
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]),
    type: `multipart/form-data; boundary=${boundary}`,
  };
}
it('searches current Chinese/English files and refuses anonymous queries', async () => {
  const f = await createFixture({ indexing: { enabled: true, watch: true } });
  try {
    const h = await loginFixtureOwner(f);
    await writeFile(join(f.knowledgeRoot, '00-Inbox/中文.md'), '# 中文名称\noriginal english');
    const untilIndexed = async (query: string, count: number) => {
      for (let i = 0; i < 100; i++) {
        const r = await f.app.inject({
          url: '/api/search?q=' + encodeURIComponent(query),
          headers: h,
        });
        if (r.statusCode !== 200 || r.json().length === count) return r;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      throw new Error('watcher did not publish searchable content');
    };
    const r = await untilIndexed('中文', 1);
    expect(r.statusCode).toBe(200);
    expect(r.json()[0].title).toBe('中文名称');
    await writeFile(join(f.knowledgeRoot, '00-Inbox/中文-其他.md'), '# 另一个中文\n其他正文');
    expect((await untilIndexed('中文', 2)).json()).toHaveLength(2);
    expect((await untilIndexed('中文名称', 1)).json()).toHaveLength(1);
    await writeFile(join(f.knowledgeRoot, '00-Inbox/中文.md'), '# 中文名称\nLATEST external');
    expect((await untilIndexed('latest', 1)).json()).toHaveLength(1);
    expect((await f.app.inject({ url: '/api/search?q=original', headers: h })).json()).toHaveLength(
      0,
    );
    expect((await f.app.inject({ url: '/api/search?q=中文' })).statusCode).toBe(401);
  } finally {
    await f.close();
  }
});
it('uploads image/PDF and authorizes only saved current share references', async () => {
  const f = await createFixture();
  try {
    const h = await loginFixtureOwner(f);
    const n = (
      await f.app.inject({
        method: 'POST',
        url: '/api/notes',
        headers: h,
        payload: { folderPath: '00-Inbox', fileName: '附件.md', content: '# Attachments' },
      })
    ).json();
    const upload = async (name: string, mime: string, bytes: Buffer) => {
      const m = multipart(name, mime, bytes);
      return f.app.inject({
        method: 'POST',
        url: `/api/notes/${n.id}/assets`,
        headers: { ...h, 'content-type': m.type },
        payload: m.body,
      });
    };
    const up = await upload('中文图.png', 'image/png', png);
    expect(up.statusCode).toBe(201);
    const image = up.json();
    const pdf = await upload('文档.pdf', 'application/pdf', Buffer.from('%PDF-1.4\nfixture'));
    expect(pdf.statusCode).toBe(201);
    const s = (
      await f.app.inject({
        method: 'POST',
        url: `/api/notes/${n.id}/share`,
        headers: h,
        payload: {},
      })
    ).json();
    const assetUrl = `/api/public/shares/${s.token}/assets/${image.id}`;
    expect((await f.app.inject({ url: assetUrl })).statusCode).toBe(404);
    await writeFile(
      join(f.knowledgeRoot, n.relativePath),
      `# 图片\n![图片](${image.markdownPath})\n[PDF](${pdf.json().markdownPath})`,
    );
    expect((await f.app.inject({ url: assetUrl })).statusCode).toBe(200);
    expect(
      (await f.app.inject({ url: `/api/public/shares/${s.token}/assets/${pdf.json().id}` }))
        .statusCode,
    ).toBe(200);
    expect((await f.app.inject({ url: `/api/assets/${image.id}` })).statusCode).toBe(401);
    expect(
      (await f.app.inject({ url: `/api/assets/${image.id}`, headers: h })).headers['content-type'],
    ).toBe('image/png');
    await writeFile(join(f.knowledgeRoot, n.relativePath), '# 引用已移除');
    expect((await f.app.inject({ url: assetUrl })).statusCode).toBe(404);
    await writeFile(join(f.knowledgeRoot, n.relativePath), `![x](${image.markdownPath})`);
    await f.app.inject({ method: 'DELETE', url: `/api/notes/${n.id}/share`, headers: h });
    expect((await f.app.inject({ url: assetUrl })).statusCode).toBe(404);
  } finally {
    await f.close();
  }
});
it('blocks disguised active uploads, oversized files and unsafe HTML/links', async () => {
  const f = await createFixture();
  try {
    const h = await loginFixtureOwner(f);
    const n = (
      await f.app.inject({
        method: 'POST',
        url: '/api/notes',
        headers: h,
        payload: {
          folderPath: '00-Inbox',
          fileName: '安全.md',
          content:
            '<script>alert(1)</script>\n[x](javascript:alert(2))\n![x](https://evil.invalid/track.png)\n[private](../AGENTS.md)',
        },
      })
    ).json();
    for (const [name, mime, body] of [
      ['evil.svg', 'image/svg+xml', Buffer.from('<svg/>')],
      ['fake.png', 'image/png', Buffer.from('<html>evil</html>')],
    ] as [string, string, Buffer][]) {
      const m = multipart(name, mime, body);
      expect(
        (
          await f.app.inject({
            method: 'POST',
            url: `/api/notes/${n.id}/assets`,
            headers: { ...h, 'content-type': m.type },
            payload: m.body,
          })
        ).statusCode,
      ).toBe(400);
    }
    const m = multipart(
      'big.png',
      'image/png',
      Buffer.concat([png, Buffer.alloc(10 * 1024 * 1024)]),
    );
    expect(
      (
        await f.app.inject({
          method: 'POST',
          url: `/api/notes/${n.id}/assets`,
          headers: { ...h, 'content-type': m.type },
          payload: m.body,
        })
      ).statusCode,
    ).toBe(413);
    const s = (
      await f.app.inject({
        method: 'POST',
        url: `/api/notes/${n.id}/share`,
        headers: h,
        payload: {},
      })
    ).json();
    const r = await f.app.inject({ url: `/api/public/shares/${s.token}` });
    expect(r.json().html).not.toContain('<script>');
    expect(r.json().html).not.toContain('href="javascript:');
    expect(r.json().html).not.toContain('src="https://evil');
    expect(r.json().html).not.toContain('href="../AGENTS');
  } finally {
    await f.close();
  }
});
it('supports attachments for root README and denies other note assets to guests', async () => {
  const f = await createFixture();
  try {
    const h = await loginFixtureOwner(f);
    await writeFile(join(f.knowledgeRoot, 'README.md'), '# Root README');
    const all = (await f.app.inject({ url: '/api/notes', headers: h })).json();
    const n = all.find((x: any) => x.relativePath === 'README.md');
    const m = multipart('root.png', 'image/png', png);
    const up = await f.app.inject({
      method: 'POST',
      url: `/api/notes/${n.id}/assets`,
      headers: { ...h, 'content-type': m.type },
      payload: m.body,
    });
    expect(up.statusCode).toBe(201);
    expect(up.json().markdownPath).toMatch(/^assets\//);
    const other = (
      await f.app.inject({
        method: 'POST',
        url: '/api/notes',
        headers: h,
        payload: { folderPath: '00-Inbox', fileName: '其他.md', content: '# Other' },
      })
    ).json();
    const share = (
      await f.app.inject({
        method: 'POST',
        url: `/api/notes/${other.id}/share`,
        headers: h,
        payload: {},
      })
    ).json();
    expect(
      (await f.app.inject({ url: `/api/public/shares/${share.token}/assets/${up.json().id}` }))
        .statusCode,
    ).toBe(404);
  } finally {
    await f.close();
  }
});
