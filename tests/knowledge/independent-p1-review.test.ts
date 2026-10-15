import { it, expect, vi } from 'vitest';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import * as files from '../../server/files.js';
import { HttpError } from '../../server/errors.js';
import { KnowledgeError } from '../../server/knowledge/errors.js';
import { createFixture, loginFixtureOwner } from '../support/fixture.js';

// Losing threshold classification must fail the boundary cases below.
for (const [label, line, mode] of [
  ['ASCII below', 'x'.repeat(32767), 'full'],
  ['ASCII exact', 'x'.repeat(32768), 'full'],
  ['ASCII above', 'x'.repeat(32769), 'large'],
  ['UTF8 below', '测'.repeat(10922) + 'x', 'full'],
  ['UTF8 exact', '测'.repeat(10922) + 'xx', 'full'],
  ['UTF8 above', '测'.repeat(10923), 'large'],
] as const)
  it(`independent W01 threshold ${label}`, async () => {
    const f = await createFixture();
    try {
      const h = await loginFixtureOwner(f);
      const made = await f.app.inject({
        method: 'POST',
        url: '/api/notes',
        headers: h,
        payload: { folderPath: '00-Inbox', fileName: 'threshold.md', content: '# original' },
      });
      expect(made.statusCode).toBe(201);
      const n = made.json();
      const content = '# threshold\n' + line;
      const r = await f.app.inject({
        method: 'PUT',
        url: `/api/notes/${n.id}`,
        headers: h,
        payload: { content, expectedModifiedAt: n.modifiedAt, requestId: 'threshold-save' },
      });
      const op = (
        await f.app.inject({ url: '/api/operations?requestId=threshold-save', headers: h })
      ).json();
      expect(await readFile(join(f.knowledgeRoot, n.relativePath), 'utf8')).toBe(content);
      expect(op.status).toBe('succeeded');
      expect(r.statusCode).toBe(200);
      expect(r.json().receipt).toEqual(op.result);
      if (mode === 'full') expect(r.json().content).toBe(content);
      else expect(r.json()).toMatchObject({ id: n.id, editorMode: 'large' });
      expect(
        (await f.app.inject({ url: `/api/notes/${n.id}/meta`, headers: h })).json().editorMode,
      ).toBe(mode);
    } finally {
      await f.close();
    }
  });
// A readback failure after a committed update must not replace its fixed receipt.
for (const [label, error] of [
  ['read-race', () => new HttpError(409, '读取时文件变化', { currentModifiedAt: '999' })],
  ['invalid-utf8', () => new KnowledgeError(422, 'INVALID_UTF8', '回读编码异常')],
  ['io', () => new Error('synthetic readback I/O fault')],
] as const)
  it(`independent W01 committed update retains success after ${label}`, async () => {
    const f = await createFixture();
    let spy: ReturnType<typeof vi.spyOn> | undefined;
    try {
      const h = await loginFixtureOwner(f);
      const n = (
        await f.app.inject({
          method: 'POST',
          url: '/api/notes',
          headers: h,
          payload: { folderPath: '00-Inbox', fileName: 'receipt.md', content: '# original' },
        })
      ).json();
      const read = files.readDocument;
      let calls = 0;
      spy = vi
        .spyOn(files, 'readDocument')
        .mockImplementation((...args: Parameters<typeof files.readDocument>) => {
          calls++;
          if (calls === 3) throw error();
          return read(...args);
        });
      const r = await f.app.inject({
        method: 'PUT',
        url: `/api/notes/${n.id}`,
        headers: h,
        payload: {
          content: '# committed',
          expectedModifiedAt: n.modifiedAt,
          requestId: 'committed-save',
        },
      });
      spy.mockRestore();
      spy = undefined;
      const op = (
        await f.app.inject({ url: '/api/operations?requestId=committed-save', headers: h })
      ).json();
      expect(calls).toBe(3);
      expect(await readFile(join(f.knowledgeRoot, n.relativePath), 'utf8')).toBe('# committed');
      expect(op.status).toBe('succeeded');
      console.log(
        'INDEPENDENT-W01-READBACK',
        JSON.stringify({ label, http: r.statusCode, operation: op.status, body: r.json() }),
      );
      expect(r.statusCode).toBe(200);
      expect(r.json().receipt).toEqual(op.result);
    } finally {
      spy?.mockRestore();
      await f.close();
    }
  });
// Restoring the supported root README note must still preserve its identity.
it('independent W03 restores a root README without stranding its intent', async () => {
  const f = await createFixture();
  try {
    const h = await loginFixtureOwner(f);
    const { writeFile } = await import('node:fs/promises');
    await writeFile(join(f.knowledgeRoot, 'README.md'), '# root README');
    const listed = (await f.app.inject({ url: '/api/notes', headers: h })).json();
    const n = listed.find((item: any) => item.relativePath === 'README.md');
    expect(n).toBeTruthy();
    const deleted = await f.app.inject({
      method: 'DELETE',
      url: `/api/notes/${n.id}`,
      headers: h,
      payload: { expectedModifiedAt: n.modifiedAt, requestId: 'root-archive' },
    });
    expect(deleted.statusCode).toBe(200);
    const restored = await f.app.inject({
      method: 'POST',
      url: `/api/notes/${n.id}/restore`,
      headers: h,
      payload: { requestId: 'root-restore' },
    });
    const op = (
      await f.app.inject({ url: '/api/operations?requestId=root-restore', headers: h })
    ).json();
    console.log(
      'INDEPENDENT-W03-ROOT',
      JSON.stringify({ http: restored.statusCode, body: restored.json(), operation: op.status }),
    );
    expect(restored.statusCode).toBe(200);
    expect(restored.json().id).toBe(n.id);
    expect(await readFile(join(f.knowledgeRoot, 'README.md'), 'utf8')).toBe('# root README');
    expect(op.status).toBe('succeeded');
  } finally {
    await f.close();
  }
});

it('W03 retains the committed restore receipt if optional current readback fails', async () => {
  const f = await createFixture();
  let spy: ReturnType<typeof vi.spyOn> | undefined;
  try {
    const h = await loginFixtureOwner(f);
    const n = (
      await f.app.inject({
        method: 'POST',
        url: '/api/notes',
        headers: h,
        payload: { folderPath: '00-Inbox', fileName: 'restore-receipt.md', content: '# private' },
      })
    ).json();
    expect(
      (
        await f.app.inject({
          method: 'DELETE',
          url: `/api/notes/${n.id}`,
          headers: h,
          payload: { expectedModifiedAt: n.modifiedAt, requestId: 'receipt-archive' },
        })
      ).statusCode,
    ).toBe(200);
    spy = vi.spyOn(files, 'readDocument').mockImplementation(() => {
      throw new KnowledgeError(422, 'INVALID_UTF8', 'synthetic current readback failure');
    });
    const r = await f.app.inject({
      method: 'POST',
      url: `/api/notes/${n.id}/restore`,
      headers: h,
      payload: { requestId: 'receipt-restore' },
    });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({
      id: n.id,
      receipt: { restored: true },
      currentReadError: 'INVALID_UTF8',
    });
    expect(
      (await f.app.inject({ url: '/api/operations?requestId=receipt-restore', headers: h })).json(),
    ).toMatchObject({ status: 'succeeded', result: r.json().receipt });
  } finally {
    spy?.mockRestore();
    await f.close();
  }
});
