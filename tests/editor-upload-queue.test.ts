import {it,expect} from 'vitest';
import { createUploadQueue } from '../apps/web/editor/upload-queue';
it('keeps order and retries only a failed item with its original identity',async()=>{
  const calls:string[]=[],ids=new Map<string,string>();let fail=true;
  const q=createUploadQueue<string,string>(async(item)=>{
    calls.push(item.data);if(ids.has(item.data))expect(item.requestId).toBe(ids.get(item.data));
    ids.set(item.data,item.requestId);
    if(item.data==='b'&&fail){fail=false;throw Error('断线');}return item.data.toUpperCase();
  });
  q.add(['a','b','c']);await q.run();
  expect(q.items.map(x=>x.state)).toEqual(['succeeded','failed','succeeded']);
  expect(q.results()).toEqual(['A','C']);
  q.retry(q.items[1].id);await q.run();
  expect(q.results()).toEqual(['A','B','C']);expect(calls).toEqual(['a','b','c','b']);
});
it('does not duplicate work when run is requested twice and supports cancelling queued items',async()=>{
  let finish!:()=>void;const wait=new Promise<void>(r=>finish=r);let calls=0;
  const q=createUploadQueue(async()=>{calls++;await wait;return 'ok';});
  q.add(['a','b']);const a=q.run(),b=q.run();q.cancel(q.items[1].id);finish();await Promise.all([a,b]);
  expect(calls).toBe(1);expect(q.items[1].state).toBe('cancelled');
});
