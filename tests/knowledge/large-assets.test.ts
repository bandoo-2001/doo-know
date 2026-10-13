import { it, expect } from 'vitest';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createFixture, loginFixtureOwner } from '../support/fixture.js';

const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a7i8AAAAASUVORK5CYII=',
  'base64',
);
it('uploads and serves only current saved references for a large shared note', async () => {
  const f = await createFixture();
  try {
    const h = await loginFixtureOwner(f);
    const path = join(f.knowledgeRoot, '00-Inbox/附件大文件.md');
    const tail = '大文件正文\n\n'.repeat(170000);
    await writeFile(path, '# 大文件附件\n\n' + tail);
    const notes = (await f.app.inject({ url: '/api/notes', headers: h })).json();
    const note = notes.find((n: any) => n.relativePath === '00-Inbox/附件大文件.md');
    expect(note.editorMode).toBe('large');
    const boundary = 'doo-large-asset-fixture';
    const up = await f.app.inject({
      method: 'POST',
      url: `/api/notes/${note.id}/assets`,
      headers: { ...h, 'content-type': `multipart/form-data; boundary=${boundary}` },
      payload: Buffer.concat([
        Buffer.from(
          `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="图.png"\r\nContent-Type: image/png\r\n\r\n`,
        ),
        png,
        Buffer.from(`\r\n--${boundary}--\r\n`),
      ]),
    });
    expect(up.statusCode).toBe(201);
    const asset = up.json();
    expect(
      (await f.app.inject({ url: `/api/notes/${note.id}/assets`, headers: h })).json(),
    ).toEqual(expect.arrayContaining([expect.objectContaining({ id: asset.id })]));
    const share = (
      await f.app.inject({
        method: 'POST',
        url: `/api/notes/${note.id}/share`,
        headers: h,
        payload: {},
      })
    ).json();
    const base = `/api/public/shares/${share.token}`;
    const byId = `${base}/assets/${asset.id}`;
    const bySource = `${base}/asset?source=${encodeURIComponent(asset.markdownPath)}`;
    expect((await f.app.inject({ url: byId })).statusCode).toBe(404);
    await writeFile(path, `# 大文件附件\n\n![保存的图片](${asset.markdownPath})\n\n` + tail);
    for (const url of [byId, bySource]) {
      const read = await f.app.inject({ url });
      expect(read.statusCode).toBe(200);
      expect(read.rawPayload.equals(png)).toBe(true);
    }
    expect(
      (
        await f.app.inject({
          url: `${base}/asset?source=${encodeURIComponent('../private/image.png')}`,
        })
      ).statusCode,
    ).toBe(404);
    await writeFile(
      path,
      `# 大文件附件\n\n\`\`\`markdown\n![仅代码](${asset.markdownPath})\n\`\`\`\n\n` + tail,
    );
    expect((await f.app.inject({ url: bySource })).statusCode).toBe(404);
    await writeFile(path, `# 大文件附件\n\n![保存的图片](${asset.markdownPath})\n\n` + tail);
    await f.app.inject({ method: 'DELETE', url: `/api/notes/${note.id}/share`, headers: h });
    expect((await f.app.inject({ url: byId })).statusCode).toBe(404);
    expect((await f.app.inject({ url: bySource })).statusCode).toBe(404);
  } finally {
    await f.close();
  }
}, 30000);
