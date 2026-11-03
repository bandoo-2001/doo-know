import { randomUUID, createHash } from 'node:crypto';
import { expect } from 'vitest';
import { diagramRendererVersions, renderPreparedDiagramDocument } from '../../shared/diagram-primary';
import type { Fixture, loginFixtureOwner } from './fixture';
export async function createPrimaryWhiteboard(f: Fixture, headers: Awaited<ReturnType<typeof loginFixtureOwner>>, name: string, source: string) {
 const intent=await f.app.inject({method:'POST',url:'/api/diagram-documents/intents',headers,payload:{path:'00-Inbox/'+name,type:'whiteboard',requestId:randomUUID()}});
 expect(intent.statusCode,intent.body).toBe(201);
 const preparation=await f.app.inject({method:'POST',url:'/api/diagram-documents/prepare',headers,payload:{target:{kind:'creation',intentId:intent.json().id},type:'whiteboard',source,sourceHash:createHash('sha256').update(source).digest('hex'),title:name.replace(/\.md$/,''),renderer:diagramRendererVersions.whiteboard,config:{},pngBase64:'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a7i8AAAAASUVORK5CYII=',requestId:randomUUID()}});
 expect(preparation.statusCode,preparation.body).toBe(201);
 const prepared=preparation.json(),markdown=renderPreparedDiagramDocument({prepared,title:prepared.title,source});
 const commit=await f.app.inject({method:'POST',url:'/api/diagram-documents/commit',headers,payload:{preparedId:prepared.id,markdown,requestId:randomUUID()}});
 expect(commit.statusCode,commit.body).toBe(200);
 return { ...commit.json(), nativeSource: source, nativeSourcePath: prepared.source.relativePath };
}
