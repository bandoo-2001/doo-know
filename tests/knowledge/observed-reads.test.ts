import {it,expect} from 'vitest';
import {writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {createFixture,loginFixtureOwner} from '../support/fixture.js';
import {agentConfig,agentHeaders} from '../support/agent.js';
it('reads already hashed notes and externally changed public notes without exceeding internal requestId limits',async()=>{
 const f=await createFixture({agent:agentConfig});try{
  const h=await loginFixtureOwner(f),n=(await f.app.inject({method:'POST',url:'/api/notes',headers:h,payload:{folderPath:'00-Inbox',fileName:'observed.md',content:'# Saved'}})).json();
  const r=await f.app.inject({method:'POST',url:`/api/agent/v1/notes/${n.id}/read`,headers:agentHeaders(),payload:{}});expect(r.statusCode).toBe(200);expect(r.json().data.kind).toBe('accepted');
  const share=(await f.app.inject({method:'POST',url:`/api/notes/${n.id}/share`,headers:h,payload:{}})).json();
  await writeFile(join(f.knowledgeRoot,n.relativePath),'# External latest');
  let reply:any;for(let i=0;i<100;i++){reply=await f.app.inject({method:'POST',url:`/api/public/shares/${share.token}/read`,payload:{}});if(reply.statusCode!==200||reply.json().kind==='ready')break;await new Promise(resolve=>setTimeout(resolve,20));}
  expect(reply.statusCode).toBe(200);expect(reply.json().data.content).toBe('# External latest');
 }finally{await f.close();}
});
