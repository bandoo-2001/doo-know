import {it,expect} from 'vitest';
import {writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {createFixture} from '../support/fixture.js';
import {readyRead} from '../support/read.js';
import {agentConfig,agentHeaders} from '../support/agent.js';
import {openDatabase} from '../../packages/core/db.js';
import {TokenizerClient} from '../../packages/core/indexing/tokenizer-client.js';
import {chunkService} from '../../packages/core/indexing/chunks.js';
import {pluginRuntimeFixture} from '../support/plugin-runtime.js';
it('streams complete UTF-8 coverage with exact original line/byte ranges and model token limits',async()=>{
 const f=await createFixture({agent:agentConfig}),tokenizer=new TokenizerClient();try{
  const body='# 主题\r\n\n## 章节\n'+('中文😀\nembedding_space_id\n'.repeat(1800))+'TAIL_WITHOUT_NEWLINE';await writeFile(join(f.knowledgeRoot,'00-Inbox/chunk.md'),body);
  const n=(await f.app.inject({url:'/api/agent/v1/notes',headers:agentHeaders()})).json().data.items[0],page=(await readyRead(f,n.id)).json().data.data,db=openDatabase(f.dataRoot),bytes=Buffer.from(body);
  let end=0,count=0,last:any;for await(const chunk of chunkService(f.config,db,tokenizer).chunkDocument(page.snapshotId,'bge-320-48-v1')){expect(chunk.startByte).toBeLessThanOrEqual(end);expect(chunk.endByte).toBeGreaterThan(end);expect(Buffer.from(chunk.content)).toEqual(bytes.subarray(chunk.startByte,chunk.endByte));expect(chunk.startLine).toBe(1+bytes.subarray(0,chunk.startByte).filter(b=>b===10).length);expect(chunk.tokenCount).toBeLessThanOrEqual(320);expect(await tokenizer.count([chunk.embeddingInput])).toEqual([chunk.embeddingTokenCount]);expect(chunk.embeddingTokenCount).toBeLessThanOrEqual(512);end=chunk.endByte;last=chunk;count++;}
  expect(count).toBeGreaterThan(5);expect(end).toBe(bytes.length);expect(last.content).toContain('TAIL_WITHOUT_NEWLINE');db.close();
 }finally{await tokenizer.close();await f.close();}
});

it.each([
 {name:'H2 root and H4 child',body:'## Parent\nfirst\n#### Child\nsecond\n## Sibling\nlast\n',want:[
  {headingPath:['Parent'],content:'## Parent\nfirst\n'},
  {headingPath:['Parent','Child'],content:'#### Child\nsecond\n'},
  {headingPath:['Sibling'],content:'## Sibling\nlast\n'},
 ]},
 {name:'H4 root and H6 child',body:'#### First\nfirst\n###### Deep\nsecond\n#### Last\nlast\n',want:[
  {headingPath:['First'],content:'#### First\nfirst\n'},
  {headingPath:['First','Deep'],content:'###### Deep\nsecond\n'},
  {headingPath:['Last'],content:'#### Last\nlast\n'},
 ]},
])('keeps $name without missing-ancestor placeholders in indexed chunk paths',async({body,want})=>{
 const f=await pluginRuntimeFixture();try{
  const created=await f.services.knowledge.create({directory:'00-Inbox',fileName:'heading-gaps.md',content:body,requestId:'heading-gap-create'});
  let read=await f.services.knowledge.readPage({noteId:created.id});
  if(read.kind==='accepted'){
   await f.platform.get().knowledge.snapshots.drain();
   read=await f.services.knowledge.readPage({noteId:created.id});
  }
  expect(read.kind).toBe('ready');if(read.kind!=='ready')throw new Error('fixture snapshot was not ready');
  const chunks=[];
  for await(const chunk of chunkService(f.config,f.db,f.platform.get().knowledge.worker.tokenizer).chunkDocument(read.data.snapshotId,'heading-gap-regression')){
   expect(Buffer.from(chunk.content)).toEqual(Buffer.from(body).subarray(chunk.startByte,chunk.endByte));
   chunks.push({headingPath:chunk.headingPath,content:chunk.content});
  }
  expect(chunks).toEqual(want);
 }finally{await f.close();}
});
