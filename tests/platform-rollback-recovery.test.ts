import { expect, it } from 'vitest';
import { mkdtemp, mkdir, writeFile, symlink, readFile, readlink, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import { openDatabase } from '../packages/core/db.js';
import { recoverTransaction, rollbackPlatform, durableJson, setCurrent } from '../apps/server/platform/updates.js';

async function fixture() {
 const root=await mkdtemp(join(tmpdir(),'rollback-recovery-'));
 const installRoot=join(root,'install'),dataRoot=join(root,'data'),profileFile=join(root,'profile.json');
 const config={installRoot,dataRoot,profileFile,serviceManaged:false,serviceName:'dooknow-disposable-recovery.service',origin:'http://localhost:3010',secret:'fixture-only-secret-at-least-thirty-two-characters',indexing:{enabled:false,watch:false}};
 const db=openDatabase(dataRoot); db.prepare('INSERT INTO notes(id,path) VALUES(?,?)').run('retained','00-Inbox/latest.md'); db.close();
 for(const version of ['1.0.0','1.1.0','1.2.0']) {
  const release=join(installRoot,'releases',version);
  await mkdir(join(release,'runtime/node/bin'),{recursive:true}); await mkdir(join(release,'dist/server/scripts'),{recursive:true});
  await writeFile(join(release,'release.json'),JSON.stringify({version,databaseCompatibility:3}));
  await symlink(process.execPath,join(release,'runtime/node/bin/node'));
  await writeFile(join(release,'dist/server/scripts/manage.js'),'process.exit(0);');
 }
 await symlink('releases/1.1.0',join(installRoot,'current'));
 await writeFile(join(installRoot,'installation.json'),JSON.stringify({current:'1.1.0',previous:'1.0.0',databaseCompatibility:3}));
 const bin=join(root,'bin'); await mkdir(bin);
 await writeFile(join(bin,'systemctl'),'#!/bin/sh\nexit 3\n',{mode:0o700});
 const journal=join(installRoot,'update-transaction.json');
 return {root,config,journal,bin,close:()=>rm(root,{recursive:true,force:true})};
}

it.each(['stopped','switched'])('recovers rollback SIGKILL after %s without replacing current data',async(point)=>{
 const f=await fixture(); const oldPath=process.env.PATH,oldConfig=process.env.XDG_CONFIG_HOME;
 try {
  const marker=join(f.root,'killed.json'),candidate=join(f.config.installRoot,'releases/1.0.0');
  const kill=`require('node:fs').writeFileSync(${JSON.stringify(marker)},JSON.stringify({parent:process.ppid}));process.kill(process.ppid,'SIGKILL');`;
  if(point==='stopped')await writeFile(join(candidate,'dist/server/scripts/manage.js'),kill);
  else {
   f.config.serviceManaged=true;
   await writeFile(join(f.bin,'systemctl'),`#!${process.execPath}\nif(process.argv[3]==='daemon-reload'){${kill}}else process.exit(3);`,{mode:0o700});
  }
  await writeFile(f.config.profileFile,JSON.stringify(f.config));
  const childFile=join(f.root,'rollback.mts');
  await writeFile(childFile,`import {readFile} from 'node:fs/promises';import {rollbackPlatform} from ${JSON.stringify(resolve('apps/server/platform/updates.ts'))};await rollbackPlatform(JSON.parse(await readFile(process.argv[2],'utf8')));`);
  const child=spawn(process.execPath,['--import',resolve('node_modules/tsx/dist/loader.mjs'),childFile,f.config.profileFile],{env:{...process.env,PATH:f.bin+':'+oldPath,XDG_CONFIG_HOME:join(f.root,'config')},stdio:['ignore','ignore','pipe']});
  let stderr='';child.stderr.on('data',chunk=>stderr+=chunk);
  const outcome=await new Promise(resolve=>child.on('close',(code,signal)=>resolve({code,signal})));
  expect(outcome,stderr).toEqual({code:null,signal:'SIGKILL'});
  expect(JSON.parse(await readFile(marker,'utf8')).parent).toBe(child.pid);
  const before=openDatabase(f.config.dataRoot);expect(before.prepare('SELECT active FROM maintenance').get()).toEqual({active:1});before.close();
  // Recovery uses a harmless systemd substitute even for the switch interruption.
  await writeFile(join(f.bin,'systemctl'),'#!/bin/sh\n[ "$2" = "is-active" ] && exit 3\nexit 0\n',{mode:0o700});
  process.env.PATH=f.bin+':'+oldPath;process.env.XDG_CONFIG_HOME=join(f.root,'config');
  await recoverTransaction(f.config);await recoverTransaction(f.config);
  const after=openDatabase(f.config.dataRoot);
  try {expect(after.prepare('SELECT active FROM maintenance').get()).toEqual({active:0});expect(after.prepare('SELECT id FROM notes').all()).toEqual([{id:'retained'}]);}finally{after.close();}
  expect(await readlink(join(f.config.installRoot,'current'))).toBe('releases/1.1.0');
  expect(JSON.parse(await readFile(f.journal,'utf8')).phase).toBe('recovered');
  await writeFile(join(candidate,'dist/server/scripts/manage.js'),'process.exit(0);');
  await expect(rollbackPlatform(f.config)).resolves.toMatchObject({version:'1.0.0',dataPreserved:true});
 }finally{process.env.PATH=oldPath;if(oldConfig===undefined)delete process.env.XDG_CONFIG_HOME;else process.env.XDG_CONFIG_HOME=oldConfig;await f.close();}
},15000);

it.each(['accepted','recoveryAccepted'])('finishes %s rollback without losing writes accepted before restart',async(phase)=>{
 const f=await fixture();
 try{
  if(phase==='accepted')await setCurrent(f.config.installRoot,'1.0.0');
  await durableJson(f.journal,{kind:'rollback',previous:'1.1.0',candidate:'1.0.0',wasActive:false,phase});
  const db=openDatabase(f.config.dataRoot);db.prepare('INSERT INTO notes(id,path) VALUES(?,?)').run('accepted','00-Inbox/accepted.md');db.close();
  await recoverTransaction(f.config);await recoverTransaction(f.config);
  const check=openDatabase(f.config.dataRoot);try{expect(check.prepare('SELECT id FROM notes ORDER BY id').all()).toEqual([{id:'accepted'},{id:'retained'}]);expect(check.prepare('SELECT active FROM maintenance').get()).toEqual({active:0});}finally{check.close();}
 }finally{await f.close();}
});

it.each([
 {phase:'switched',previous:'../outside',candidate:'1.0.0'},
 {phase:'switched',previous:'1.1.0',candidate:'1.0.0',pointer:'1.2.0'},
 {phase:'accepted',previous:'1.1.0',candidate:'1.0.0',pointer:'1.2.0'},
 {phase:'switched',previous:'1.1.0',candidate:'1.0.0'},
])('refuses malformed or stale rollback recovery without changing data: %j',async(state)=>{
 const f=await fixture();try{
  if(state.pointer)await setCurrent(f.config.installRoot,state.pointer);
  await durableJson(f.journal,{kind:'rollback',wasActive:false,...state});
  await expect(recoverTransaction(f.config)).rejects.toThrow();
  expect(await readlink(join(f.config.installRoot,'current'))).toBe('releases/'+(state.pointer||'1.1.0'));
  const db=openDatabase(f.config.dataRoot);try{expect(db.prepare('SELECT active FROM maintenance').get()).toEqual({active:0});expect(db.prepare('SELECT id FROM notes').all()).toEqual([{id:'retained'}]);}finally{db.close();}
 }finally{await f.close();}
});

it('refuses an unknown transaction kind rather than treating it as an accepted update',async()=>{
 const f=await fixture();try{
  await durableJson(f.journal,{kind:'unknown-operation',phase:'accepted',previous:'1.1.0',candidate:'1.0.0',wasActive:false});
  await expect(recoverTransaction(f.config)).rejects.toThrow();
  expect(JSON.parse(await readFile(join(f.config.installRoot,'installation.json'),'utf8')).current).toBe('1.1.0');
 }finally{await f.close();}
});

it('keeps generation three intact when a rollback recovery journal names generation two',async()=>{
 const f=await fixture();try{
  await writeFile(join(f.config.installRoot,'releases/1.0.0/release.json'),JSON.stringify({version:'1.0.0',databaseCompatibility:2}));
  await durableJson(f.journal,{kind:'rollback',phase:'quiescing',previous:'1.1.0',candidate:'1.0.0',wasActive:false});
  await expect(recoverTransaction(f.config)).rejects.toThrow(/不支持普通代码回退/);
  await expect(rollbackPlatform(f.config)).rejects.toThrow(/不支持普通代码回退/);
  expect(await readlink(join(f.config.installRoot,'current'))).toBe('releases/1.1.0');
 }finally{await f.close();}
});

it('recovers a durable switched rollback repeatedly without requiring a database snapshot',async()=>{
 const f=await fixture();const oldPath=process.env.PATH;
 try{
  await setCurrent(f.config.installRoot,'1.0.0');
  const db=openDatabase(f.config.dataRoot);db.prepare('UPDATE maintenance SET active=1').run();db.close();
  await durableJson(f.journal,{kind:'rollback',phase:'switched',previous:'1.1.0',candidate:'1.0.0',wasActive:false});
  process.env.PATH=f.bin+':'+oldPath;
  await recoverTransaction(f.config);await recoverTransaction(f.config);
  expect(await readlink(join(f.config.installRoot,'current'))).toBe('releases/1.1.0');
  const check=openDatabase(f.config.dataRoot);try{expect(check.prepare('SELECT id FROM notes').all()).toEqual([{id:'retained'}]);expect(check.prepare('SELECT active FROM maintenance').get()).toEqual({active:0});}finally{check.close();}
 }finally{process.env.PATH=oldPath;await f.close();}
});
