import { createPrimaryWhiteboard } from './support/primary-whiteboard';
import { parseDiagramDocument } from '../shared/diagram-document';
import { localReference } from '../packages/core/render';
import { it, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createFixture, loginFixtureOwner } from './support/fixture';
import { emptyWhiteboard } from '../shared/whiteboard';
import { extractArchive } from '../apps/server/platform/archive';
it('exports referenced current whiteboards portably and resolves their stable identities after a rename', async () => {
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
    const board = await createPrimaryWhiteboard(f,headers,'design.md',JSON.stringify(emptyWhiteboard()));
    const parent = await create('00-Inbox/docs', 'readme.md', '#说明\n\n```excalidraw\n' + board.id + '\n```\n');
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
      '```excalidraw\n../design.md\n```',
    );
    const exported = parseDiagramDocument(await readFile(join(output,'00-Inbox/design.md'),'utf8'));
    expect(exported.status).toBe('diagram');
    if(exported.status!=='diagram'||exported.primary.source.format!=='excalidraw')throw Error('Missing portable native source');
    const sourcePath=localReference('00-Inbox/design.md',exported.primary.source.path)!;
    expect(JSON.parse(await readFile(join(output,sourcePath),'utf8'))).toMatchObject({type:'excalidraw'});
    const version=(await f.app.inject({url:'/api/notes/'+board.id,headers})).json();
    const importedBoard={noteId:board.id};
    const moved = await post('/api/notes/' + version.id + '/move', {
      folderPath: '00-Inbox',
      fileName: '移动后.md',
      expectedModifiedAt: version.modifiedAt,
      requestId: randomUUID(),
    });
    expect(moved.statusCode, moved.body).toBe(200);
    const resolved = await f.app.inject({
      url:
        '/api/notes/' +
        parent.id +
        '/whiteboards/resolve?source=' +
        encodeURIComponent(importedBoard.noteId),
      headers,
    });
    expect(resolved.statusCode, resolved.body).toBe(200);
    expect(resolved.json().relativePath).toBe('00-Inbox/移动后.md');
    expect(resolved.json()).toMatchObject({id:version.id,noteId:version.id,documentType:'whiteboard',source:{format:'excalidraw'}});
    expect(resolved.json()).not.toHaveProperty('content');
  } finally {
    await f.close();
  }
});
