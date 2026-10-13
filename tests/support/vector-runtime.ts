import {spawn} from 'node:child_process';
import {join,resolve} from 'node:path';
import {writeFile,mkdir} from 'node:fs/promises';
export async function startVectorRuntime(root:string){
 const indexRoot=join(root,'indexes');await mkdir(indexRoot,{recursive:true});const token='fixture-runtime-only-at-least-thirty-two-characters';
 const runtimeRoot=resolve('runtime/vector-service');const child=spawn(join(runtimeRoot,'.venv/bin/python'),[join(runtimeRoot,'tests/serve_fixture.py'),resolve('.local/models/bge-small-zh-v1.5'),indexRoot,token],{stdio:['ignore','pipe','pipe'],env:{...process.env,PYTHONUNBUFFERED:'1'}});child.stderr.resume();
 const ready=await new Promise<{url:string;spaceId:string} >((yes,no)=>{let output='';const timeout=setTimeout(()=>no(new Error('runtime startup timeout')),20000);child.on('error',no);child.on('exit',code=>no(new Error(`runtime exited ${code}`)));child.stdout.on('data',bytes=>{output+=bytes.toString();let end:number;while((end=output.indexOf('\n'))!==-1){const line=output.slice(0,end);output=output.slice(end+1);try{const value=JSON.parse(line);if(value.port){clearTimeout(timeout);yes({url:`http://127.0.0.1:${value.port}`,spaceId:value.spaceId});}}catch{}}});});
 for(let i=0;i<100;i++){try{if((await fetch(ready.url+'/health')).ok)break;}catch{}await new Promise(r=>setTimeout(r,20));}
 return {...ready,indexRoot,token,close:async()=>{if(child.exitCode!=null||child.signalCode!=null)return;const done=new Promise<void>(r=>child.once('exit',()=>r()));child.kill('SIGTERM');await done;}};
}
