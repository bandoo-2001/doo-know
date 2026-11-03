import { afterEach, expect, it } from 'vitest';
import { createFixture, loginFixtureOwner, type Fixture } from './support/fixture';
const fixtures:Fixture[]=[];
afterEach(async()=>{for(const f of fixtures.splice(0))await f.close();});
it('does not expose old whiteboard migration, draft conversion or preview APIs',async()=>{
 const f=await createFixture();fixtures.push(f);
 const headers=await loginFixtureOwner(f);
 for(const [method,url] of [
  ['GET','/api/whiteboard-migrations'],
  ['POST','/api/whiteboard-migrations/plan'],
  ['POST','/api/notes/nonexistent/diagram/legacy-draft-conversion'],
  ['POST','/api/notes/nonexistent/diagram/legacy-preview'],
 ] as const){
  const response=await f.app.inject({method,url,headers,...(method==='POST'?{payload:{}}:{})});
  expect(response.statusCode,`${method} ${url}: ${response.body}`).toBe(404);
 }
});
