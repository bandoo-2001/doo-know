import {it,expect} from 'vitest';
import {createFixture} from '../support/fixture.js';
import {openDatabase} from '../../packages/core/db.js';
import {observeSource} from '../../packages/core/indexing/state.js';
import {indexJobService} from '../../packages/core/indexing/jobs.js';
it('deduplicates versions and fences expired leases including A to B to A content',async()=>{
 const f=await createFixture(),db=openDatabase(f.dataRoot);try{
  let now=1000;const jobs=indexJobService(db,{now:()=>now,random:()=>0,spaceId:'space-a'});db.prepare('INSERT INTO notes(id,path) VALUES(?,?)').run('note','00-Inbox/n.md');
  const a=observeSource(db,'note','a'.repeat(64),'1',1);jobs.enqueue(a,'text');jobs.enqueue(a,'text');expect((db.prepare('SELECT count(*) n FROM index_jobs').get() as any).n).toBe(1);
  const first=jobs.claim('worker-one')!;expect(first).toBeTruthy();now+=61000;const second=jobs.claim('worker-two')!;expect(second.leaseEpoch).toBeGreaterThan(first.leaseEpoch);expect(jobs.valid(first)).toBe(false);expect(jobs.valid(second)).toBe(true);
  db.prepare('UPDATE document_state SET text_indexed_hash=?,vector_indexed_hash=?,longest_line_bytes=1').run(a.contentHash,a.contentHash);
  const b=observeSource(db,'note','b'.repeat(64),'2',1);jobs.enqueue(b,'text');const again=observeSource(db,'note','a'.repeat(64),'3',1);jobs.enqueue(again,'text');expect(again.sourceRevision).toBe(3);expect(jobs.valid(second)).toBe(false);expect(jobs.complete(second)).toBe('superseded');
  const state=db.prepare('SELECT text_indexed_hash,vector_indexed_hash,longest_line_bytes FROM document_state WHERE note_id=?').get('note');expect(state).toEqual({text_indexed_hash:null,vector_indexed_hash:null,longest_line_bytes:null});
  jobs.fail(second,'LATE_FAILURE');expect((db.prepare('SELECT status FROM index_jobs WHERE id=?').get(second.id) as any).status).toBe('superseded');
 }finally{db.close();await f.close();}
});
it('retains failed attempt counts across scans and retries only within the capped policy',async()=>{
 const f=await createFixture(),db=openDatabase(f.dataRoot);try{let now=0;const jobs=indexJobService(db,{now:()=>now,random:()=>0});db.prepare('INSERT INTO notes(id,path) VALUES(?,?)').run('note','00-Inbox/n.md');const v=observeSource(db,'note','f'.repeat(64),'1',1);jobs.enqueue(v,'text');for(let i=0;i<10;i++){const job=jobs.claim('worker')!;expect(job).toBeTruthy();jobs.fail(job,'MODEL_OFFLINE');jobs.enqueue(v,'text');now+=300001;}expect(jobs.claim('worker')).toBeNull();expect((db.prepare('SELECT attempts,status FROM index_jobs').get() as any)).toEqual({attempts:10,status:'failed'});}finally{db.close();await f.close();}
});
it('yields a checkpointed large text job to an interactive small note without charging an error retry',async()=>{
 const f=await createFixture(),db=openDatabase(f.dataRoot);try{
  const jobs=indexJobService(db);for(const [id,size]of [['large',2097152],['small',20]] as const){db.prepare('INSERT INTO notes(id,path) VALUES(?,?)').run(id,`00-Inbox/${id}.md`);const v=observeSource(db,id,id[0].repeat(64),'1',size);if(id==='large')jobs.enqueue(v,'text');}
  const large=jobs.claim('worker')!;expect(large.noteId).toBe('large');jobs.checkpoint(large,16);
  jobs.enqueue({noteId:'small',sourceRevision:1,contentHash:'s'.repeat(64)},'text');expect(jobs.preempt(large)).toBe(true);expect(jobs.valid(large)).toBe(false);
  const small=jobs.claim('worker')!;expect(small.noteId).toBe('small');jobs.complete(small);
  const resumed=jobs.claim('worker')!;expect(resumed.noteId).toBe('large');expect(resumed.checkpoint).toBe(16);expect(resumed.attempts).toBe(1);expect(resumed.leaseEpoch).toBeGreaterThan(large.leaseEpoch);
 }finally{db.close();await f.close();}
});

it.each(['claim', 'retry'] as const)('exposes an exhausted expired lease before %s and permits explicit retry without reviving its old worker', async (trigger) => {
 const f=await createFixture(),db=openDatabase(f.dataRoot);
 try {
  let now=0; const jobs=indexJobService(db,{now:()=>now,random:()=>0});
  db.prepare('INSERT INTO notes(id,path) VALUES(?,?)').run('note','00-Inbox/n.md');
  const v=observeSource(db,'note','f'.repeat(64),'1',1); jobs.enqueue(v,'text');
  for(let i=0;i<9;i++){const j=jobs.claim('worker')!; jobs.fail(j,'TEMPORARY_FAILURE'); now+=300001;}
  const tenth=jobs.claim('worker')!; expect(tenth.attempts).toBe(10);
  now+=59000; expect(jobs.claim('replacement')).toBeNull(); expect(jobs.retry(['note'])).toBe(0);
  expect(jobs.heartbeat(tenth)).toBe(true); now+=59000;
  expect(jobs.claim('replacement')).toBeNull(); expect(jobs.valid(tenth)).toBe(true);
  now+=1000;
  if(trigger==='claim') {
   expect(jobs.claim('replacement')).toBeNull();
   expect(db.prepare('SELECT status,lease_until,error FROM index_jobs').get()).toEqual({status:'failed',lease_until:null,error:'LEASE_EXPIRED'});
  }
  expect(jobs.retry(['note'])).toBe(1);
  jobs.enqueue(v,'text'); const next=jobs.claim('replacement')!;
  expect(next.attempts).toBe(1); expect(next.leaseEpoch).toBeGreaterThan(tenth.leaseEpoch);
  expect(jobs.heartbeat(tenth)).toBe(false); expect(jobs.complete(tenth)).toBe('superseded');
  jobs.fail(tenth,'LATE_FAILURE'); expect(jobs.valid(next)).toBe(true);
 }finally{db.close();await f.close();}
});

it.each(['claim', 'retry'] as const)(
 'fences a failure already in flight when another connection expires and retries through %s',
 async (trigger) => {
  const f = await createFixture(), db = openDatabase(f.dataRoot), other = openDatabase(f.dataRoot);
  try {
   let now = 0, interleave = false, retryCount = 0;
   const replacementJobs = indexJobService(other, { now: () => now });
   const jobs = indexJobService(db, {
    now: () => now,
    random: () => {
     if (interleave) {
      interleave = false;
      // fail() has read its leased row, but has not yet published its failure.
      // A real second connection revokes that lease and accepts the user's retry.
      if (trigger === 'claim') expect(replacementJobs.claim('replacement')).toBeNull();
      retryCount = replacementJobs.retry(['note']);
      expect(other.prepare('SELECT status,attempts,error FROM index_jobs').get())
       .toEqual({ status: 'pending', attempts: 0, error: null });
     }
     return 0;
    },
   });
   db.prepare('INSERT INTO notes(id,path) VALUES(?,?)').run('note', '00-Inbox/n.md');
   jobs.enqueue(observeSource(db, 'note', 'f'.repeat(64), '1', 1), 'text');
   for (let i = 0; i < 9; i++) {
    const job = jobs.claim('old-worker')!;
    jobs.fail(job, 'TEMPORARY_FAILURE');
    now += 300001;
   }
   const tenth = jobs.claim('old-worker')!;
   expect(tenth.attempts).toBe(10);
   now += 60000;
   interleave = true;
   jobs.fail(tenth, 'LATE_FAILURE');
   expect(retryCount).toBe(1);
   expect(db.prepare('SELECT status,attempts,error FROM index_jobs').get())
    .toEqual({ status: 'pending', attempts: 0, error: null });
   const replacement = replacementJobs.claim('replacement');
   expect(replacement).toMatchObject({ workerId: 'replacement', attempts: 1 });
   expect(jobs.heartbeat(tenth)).toBe(false);
   expect(jobs.complete(tenth)).toBe('superseded');
   jobs.fail(tenth, 'ANOTHER_LATE_FAILURE');
   expect(replacementJobs.valid(replacement!)).toBe(true);
  } finally { other.close(); db.close(); await f.close(); }
 },
);
