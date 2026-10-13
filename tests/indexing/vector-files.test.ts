import {it,expect} from 'vitest';
import {createFixture} from '../support/fixture.js';
import {startVectorRuntime} from '../support/vector-runtime.js';
import {openDatabase} from '../../server/db.js';
import {observeSource} from '../../server/indexing/state.js';
import {VectorRuntimeClient} from '../../server/indexing/vector-store.js';
import {FlatFileStore} from '../../server/indexing/flat-file.js';
import {access} from 'node:fs/promises';
const vector=(a:number,b=0)=>{const value=Array(512).fill(0);value[a]=1;return value;};
it('preloads checksummed generations, filters rows and rebases concurrent document publication',async()=>{
 const f=await createFixture(),runtime=await startVectorRuntime(f.dataRoot),db=openDatabase(f.dataRoot);try{
  const client=new VectorRuntimeClient(runtime.url,runtime.token,runtime.spaceId),store=new FlatFileStore(db,runtime.indexRoot,client,runtime.spaceId);
  for(const id of ['a','b'])db.prepare('INSERT INTO notes(id,path) VALUES(?,?)').run(id,`00-Inbox/${id}.md`);
  const a=observeSource(db,'a','a'.repeat(64),'1',8),b=observeSource(db,'b','b'.repeat(64),'2',8);
  const pa=await store.prepare(a,[{chunkId:'ca',noteId:'a',sourceHash:a.contentHash,inputHash:'x'.repeat(64)}],[vector(0)]),pb=await store.prepare(b,[{chunkId:'cb',noteId:'b',sourceHash:b.contentHash,inputHash:'y'.repeat(64)}],[vector(1)]);
  expect(await store.publish(pa)).toBe('published');expect(await store.publish(pb)).toBe('published');
  const all=await store.search(vector(0),['ca','cb'],10);expect(all.map((x:any)=>x.chunkId)).toEqual(['ca','cb']);expect((await store.search(vector(0),['cb'],10)).map((x:any)=>x.chunkId)).toEqual(['cb']);
  await expect(store.prepare(a,[{chunkId:'bad',noteId:'a',sourceHash:a.contentHash,inputHash:'bad'}],[Array(512).fill(0)])).rejects.toThrow();
 }finally{db.close();await runtime.close();await f.close();}
});
it('compacts invalid rows into a new generation and subsequent edits preserve other notes',async()=>{
 const f=await createFixture(),runtime=await startVectorRuntime(f.dataRoot),db=openDatabase(f.dataRoot);try{
  const client=new VectorRuntimeClient(runtime.url,runtime.token,runtime.spaceId),store=new FlatFileStore(db,runtime.indexRoot,client,runtime.spaceId);
  for(const id of ['a','b','c'])db.prepare('INSERT INTO notes(id,path) VALUES(?,?)').run(id,`00-Inbox/${id}.md`);
  for(const [id,col]of [['a',0],['b',1]] as const){const v=observeSource(db,id,id.repeat(64),'1',8);await store.publish(await store.prepare(v,[{chunkId:'c'+id,noteId:id,sourceHash:v.contentHash,inputHash:id}],[vector(col)]));}
  db.prepare('UPDATE notes SET active=0 WHERE id=?').run('a');db.prepare('UPDATE document_state SET active=0 WHERE note_id=?').run('a');
  const old=store.current();expect(await store.compact()).toBe(true);expect(store.current()).not.toBe(old);
  expect((db.prepare('SELECT count(*) n FROM generation_segments WHERE generation=?').get(store.current()) as any).n).toBe(1);
  expect((await store.search(vector(1),['ca','cb'],10)).map((x:any)=>x.chunkId)).toEqual(['cb']);
  const c=observeSource(db,'c','c'.repeat(64),'3',8);await store.publish(await store.prepare(c,[{chunkId:'cc',noteId:'c',sourceHash:c.contentHash,inputHash:'c'}],[vector(2)]));
  expect((await store.search(vector(1),['cb','cc'],10)).map((x:any)=>x.chunkId)).toEqual(['cb','cc']);
  const b=observeSource(db,'b','d'.repeat(64),'4',8);await store.publish(await store.prepare(b,[{chunkId:'cb2',noteId:'b',sourceHash:b.contentHash,inputHash:'d'}],[vector(3)]));
  expect((await store.search(vector(2),['cb','cb2','cc'],10)).map((x:any)=>x.chunkId)).toEqual(['cc','cb2']);
 }finally{db.close();await runtime.close();await f.close();}
});
it('pins a generation while querying and retires old runtime matrices/files after release',async()=>{
 const f=await createFixture(),runtime=await startVectorRuntime(f.dataRoot),db=openDatabase(f.dataRoot);try{
  const client=new VectorRuntimeClient(runtime.url,runtime.token,runtime.spaceId),store=new FlatFileStore(db,runtime.indexRoot,client,runtime.spaceId);
  for(const id of ['a','b'])db.prepare('INSERT INTO notes(id,path) VALUES(?,?)').run(id,`00-Inbox/${id}.md`);
  const a=observeSource(db,'a','a'.repeat(64),'1',8),b=observeSource(db,'b','b'.repeat(64),'2',8),pa=await store.prepare(a,[{chunkId:'ca',noteId:'a',sourceHash:a.contentHash,inputHash:'a'}],[vector(0)]);
  await store.publish(pa);
  let resume!:()=>void;const held=new Promise<void>(resolve=>{resume=resolve;}),call=client.call.bind(client);let block=true;
  client.call=async(path,body)=>{if(path==='/vectors/search'&&block){block=false;await held;}return call(path,body);};
  const pending=store.search(vector(0),['ca'],10);
  const pb=await store.prepare(b,[{chunkId:'cb',noteId:'b',sourceHash:b.contentHash,inputHash:'b'}],[vector(1)]);await store.publish(pb);
  await store.maintain();await expect(access(pa.manifestPath)).resolves.toBeUndefined();
  resume();expect((await pending)[0].chunkId).toBe('ca');await store.maintain();
  await expect(access(pa.manifestPath)).rejects.toThrow();
  await expect(call('/vectors/search',{generation:pa.generation,spaceId:runtime.spaceId,queryVector:vector(0),allowedRows:'AQ==',limit:10})).rejects.toThrow();
  expect((await store.search(vector(0),['ca','cb'],10)).map((x:any)=>x.chunkId)).toEqual(['ca','cb']);
 }finally{db.close();await runtime.close();await f.close();}
});
