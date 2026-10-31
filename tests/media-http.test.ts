import { openDatabase } from '../packages/core/db';
import { noteService } from '../packages/core/notes';
import { assetService } from '../packages/core/assets';
import { shareService } from '../packages/core/shares';
import { publicDiagramProjectionService } from '../packages/core/public-diagram-projection';
import { expect, it } from 'vitest';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createFixture, loginFixtureOwner } from './support/fixture';
import { request } from 'node:http';
import { once } from 'node:events';

it('uploads real media via streaming multipart and serves owner/public byte ranges with current grants', async () => {
  const f = await createFixture(),
    headers = await loginFixtureOwner(f);
  try {
    const note = (
      await f.app.inject({
        method: 'POST',
        url: '/api/notes',
        headers,
        payload: { folderPath: '00-Inbox', fileName: 'media.md', content: '# Media' },
      })
    ).json();
    const address = await f.app.listen({ host: '127.0.0.1', port: 0 });
    const size = 12 * 1024 * 1024,
      head = Buffer.alloc(44);
    head.write('RIFF');
    head.writeUInt32LE(36 + size, 4);
    head.write('WAVEfmt ', 8);
    head.writeUInt32LE(16, 16);
    head.writeUInt16LE(1, 20);
    head.writeUInt16LE(1, 22);
    head.writeUInt32LE(8000, 24);
    head.writeUInt32LE(16000, 28);
    head.writeUInt16LE(2, 32);
    head.writeUInt16LE(16, 34);
    head.write('data', 36);
    head.writeUInt32LE(size, 40);
    const boundary = 'stream-media-fixture';
    const req = request(address + `/api/notes/${note.id}/assets`, {
      method: 'POST',
      headers: {
        ...headers,
        'content-type': `multipart/form-data; boundary=${boundary}`,
        'x-dooknow-upload-id': 'stream-media-upload',
      },
    });
    const responsePromise = new Promise<{ status: number; data: any }>((resolve, reject) => {
      req.once('response', (res) => {
        let text = '';
        res.on('data', (part) => (text += part));
        res.on('end', () => resolve({ status: res.statusCode!, data: JSON.parse(text) }));
      });
      req.on('error', reject);
    });
    req.write(
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="large.wav"\r\nContent-Type: audio/wav\r\n\r\n`,
    );
    req.write(head);
    const chunk = Buffer.alloc(65536);
    for (let bytes = 0; bytes < size; bytes += chunk.length)
      if (!req.write(chunk)) await once(req, 'drain');
    req.end(`\r\n--${boundary}--\r\n`);
    const uploaded = await responsePromise;
    expect(uploaded.status).toBe(201);
    const asset = uploaded.data;
    const range = await f.app.inject({
      url: `/api/assets/${asset.id}`,
      headers: { ...headers, range: 'bytes=0-43' },
    });
    expect(range.statusCode).toBe(206);
    expect(range.rawPayload).toEqual(head);
    expect(range.headers['content-range']).toBe(`bytes 0-43/${size + 44}`);
    expect(range.headers['content-type']).toBe('audio/wav');
    expect(
      (
        await f.app.inject({
          url: `/api/assets/${asset.id}`,
          headers: { ...headers, range: 'bytes=999999999-' },
        })
      ).statusCode,
    ).toBe(416);
    const share = (
      await f.app.inject({
        method: 'POST',
        url: `/api/notes/${note.id}/share`,
        headers,
        payload: {},
      })
    ).json();
    expect(
      (await f.app.inject({ url: `/api/public/shares/${share.token}/assets/${asset.id}` }))
        .statusCode,
    ).toBe(404);
    await writeFile(
      join(f.knowledgeRoot, note.relativePath),
      `# Media\n\n[play](${asset.markdownPath})\n`,
    );
    const publicRange = await f.app.inject({
      url: `/api/public/shares/${share.token}/assets/${asset.id}`,
      headers: { range: 'bytes=-16' },
    });
    expect(publicRange.statusCode).toBe(206);
    expect(publicRange.rawPayload).toEqual(Buffer.alloc(16));
    const db = openDatabase(f.dataRoot);
    try {
      const notes = noteService(f.config, db),
        assets = assetService(f.config, db, notes),
        shares = shareService(db, notes),
        projection = publicDiagramProjectionService(f.config, db, notes, assets, shares);
      const descriptor = await projection.asset(share.token, { id: asset.id });
      if (!('absolutePath' in descriptor)) throw Error('media descriptor expected');
      const stream = assets.open(descriptor, { check: descriptor.check });
      let received = 0;
      const read = async () => {
        for await (const chunk of stream) {
          expect(chunk.length).toBeLessThanOrEqual(65536);
          received += chunk.length;
          shares.revoke(note.id);
        }
      };
      await expect(read()).rejects.toThrow();
      expect(received).toBeGreaterThan(0);
      expect(received).toBeLessThan(size);
    } finally {
      db.close();
    }
    await f.app.inject({ method: 'DELETE', url: `/api/notes/${note.id}/share`, headers });
    expect(
      (await f.app.inject({ url: `/api/public/shares/${share.token}/assets/${asset.id}` }))
        .statusCode,
    ).toBe(404);
    const bad = await f.app.inject({
      method: 'POST',
      url: `/api/notes/${note.id}/assets`,
      headers: { ...headers, 'content-type': `multipart/form-data; boundary=${boundary}` },
      payload: Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="fake.mp4"\r\nContent-Type: video/mp4\r\n\r\nnot mp4\r\n--${boundary}--\r\n`,
      ),
    });
    expect(bad.statusCode).toBe(400);
  } finally {
    await f.close();
  }
}, 20000);
