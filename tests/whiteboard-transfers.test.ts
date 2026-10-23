import { it, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createFixture, loginFixtureOwner } from './support/fixture';
import { emptyWhiteboard } from '../shared/whiteboard';
import { extractArchive } from '../apps/server/platform/archive';
it('exports referenced whiteboards portably and resolves imported renamed whiteboard references', async () => {
  const f = await createFixture();
  try {
    const headers = await loginFixtureOwner(f);
    await mkdir(join(f.knowledgeRoot, '00-Inbox/docs'));
    const post = (url: string, payload: unknown) =>
      f.app.inject({ method: 'POST', url, headers, payload: payload as any });
    const create = async (folderPath: string, fileName: string, content: string) => {
      const response = await post('/api/notes', { folderPath, fileName, content });
      expect(response.statusCode, response.body).toBe(201);
      return response.json();
    };
    const board = await create('00-Inbox', 'design.excalidraw', JSON.stringify(emptyWhiteboard()));
    await create('00-Inbox/docs', 'readme.md', '#说明\n\n```excalidraw\n' + board.id + '\n```\n');
    const settle = async (id: string) => {
      for (let n = 0; n < 150; n++) {
        const task = (await f.app.inject({ url: '/api/manage/tasks/' + id, headers })).json();
        if (!['queued', 'running'].includes(task.state)) return task;
        await new Promise((r) => setTimeout(r, 20));
      }
      throw Error('task timeout');
    };
    const task = await settle(
      (
        await post('/api/manage/export', { folderPath: '00-Inbox/docs', requestId: randomUUID() })
      ).json().id,
    );
    expect(task.state).toBe('succeeded');
    const download = await f.app.inject({
      url: '/api/manage/tasks/' + task.id + '/download',
      headers,
    });
    const archive = join(f.root, 'boards.tar.gz'),
      output = join(f.root, 'exported');
    await writeFile(archive, download.rawPayload);
    await mkdir(output);
    await extractArchive(archive, output);
    expect(await readFile(join(output, '00-Inbox/docs/readme.md'), 'utf8')).toContain(
      '```excalidraw\n../design.excalidraw\n```',
    );
    expect(
      JSON.parse(await readFile(join(output, '00-Inbox/design.excalidraw'), 'utf8')),
    ).toMatchObject({ type: 'excalidraw' });
    const request = {
      folderPath: '00-Inbox',
      collision: 'rename',
      requestId: randomUUID(),
      entries: [
        { path: 'design.excalidraw', encoding: 'utf8', content: JSON.stringify(emptyWhiteboard()) },
        {
          path: 'imported.md',
          encoding: 'utf8',
          content: '```excalidraw\ndesign.excalidraw\n```\n',
        },
      ],
    };
    const nativeBoard = JSON.stringify({ ...emptyWhiteboard(), dooknow: { id: board.id } });
    const nativeTask = await settle(
      (
        await post('/api/manage/import', {
          folderPath: '00-Inbox',
          collision: 'rename',
          requestId: randomUUID(),
          entries: [
            {
              path: 'native.md',
              encoding: 'utf8',
              content: '```excalidraw\n' + board.id + '\n```\n',
            },
            { path: 'native.excalidraw', encoding: 'utf8', content: nativeBoard },
          ],
        })
      ).json().id,
    );
    expect(nativeTask.state).toBe('succeeded');
    const nativeNote = nativeTask.items.find((i: any) => i.path === 'native.md');
    const nativeCopy = nativeTask.items.find((i: any) => i.path === 'native.excalidraw');
    expect(nativeCopy.noteId).not.toBe(board.id);
    expect(
      (await f.app.inject({ url: '/api/notes/' + nativeNote.noteId, headers })).json().content,
    ).toContain(nativeCopy.noteId);
    const imported = await settle((await post('/api/manage/import', request)).json().id);
    expect(imported.state).toBe('succeeded');
    const item = imported.items.find((i: any) => i.path === 'imported.md');
    const document = (await f.app.inject({ url: '/api/notes/' + item.noteId, headers })).json();
    const importedBoard = imported.items.find((i: any) => i.path === 'design.excalidraw');
    expect(document.content).toContain(importedBoard.noteId);
    const version = (
      await f.app.inject({ url: '/api/notes/' + importedBoard.noteId, headers })
    ).json();
    const moved = await post('/api/notes/' + version.id + '/move', {
      folderPath: '00-Inbox/docs',
      fileName: '移动后.excalidraw',
      expectedModifiedAt: version.modifiedAt,
      requestId: randomUUID(),
    });
    expect(moved.statusCode, moved.body).toBe(200);
    const resolved = await f.app.inject({
      url:
        '/api/notes/' +
        item.noteId +
        '/whiteboards/resolve?source=' +
        encodeURIComponent(importedBoard.noteId),
      headers,
    });
    expect(resolved.statusCode, resolved.body).toBe(200);
    expect(resolved.json().relativePath).toBe('00-Inbox/docs/移动后.excalidraw');
  } finally {
    await f.close();
  }
});
