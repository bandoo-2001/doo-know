import { it, expect } from 'vitest';
import { mkdtemp, mkdir, writeFile, readFile, rm, readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';

for (const client of ['curl', 'wget']) for (const lengthKnown of [true, false]) it(`shows live ${client} (length known: ${lengthKnown}) byte/percent/speed/ETA progress without revealing URLs or diagnostic secrets`, async () => {
  const root=await mkdtemp(join(tmpdir(),'installer-progress-'));
  try {
    const bin=join(root,'bin');await mkdir(bin);
    await writeFile(join(bin,client),`#!${process.execPath}\n`+String.raw`
const fs=require('fs'),a=process.argv.slice(2),get=k=>a[a.indexOf(k)+1];
const headers='HTTP/1.1 200 OK\r\n'+(process.env.TEST_LENGTH_KNOWN==='true'?'Content-Length: 8192\r\n':'')+'Location: https://release-assets.githubusercontent.com/file?sig=fixture_secret_signed_url\r\n\r\n';
if(a.includes('--dump-header'))fs.writeFileSync(get('--dump-header'),headers);else process.stderr.write(headers);
process.stderr.write('fixture_secret_diagnostic\n');
const output=a.includes('--output')?get('--output'):get('-O');fs.writeFileSync(output,'');
(async()=>{for(let i=0;i<8;i++){fs.appendFileSync(output,Buffer.alloc(1024,65));await new Promise(r=>setTimeout(r,350));}
if(a.includes('--write-out'))process.stdout.write('200');})();
`,{mode:0o700});
    const child=spawn('bash',['-c',`source '${resolve('deploy/github-fetch.sh')}'\ngithub_fetch owner/public 81 '${join(root,'package.tar.gz')}' ${client} 'https://github.com/owner/public/releases/download/v1/package.tar.gz'`],{env:{...process.env,PATH:bin+':'+process.env.PATH,DOOKNOW_GITHUB_TOKEN_FILE:'',TEST_LENGTH_KNOWN:String(lengthKnown)},stdio:['ignore','pipe','pipe']});
    let stderr='',stdout='',intermediate=false;
    child.stdout.on('data',b=>stdout+=b);
    child.stderr.on('data',b=>{const s=b.toString();stderr+=s;if(lengthKnown?/进度\s+(?:[1-9]|[1-9]\d)%/.test(s):s.includes('总大小未知'))intermediate=true;});
    const code=await new Promise<number|null>((yes,no)=>{child.on('error',no);child.on('close',yes);});
    expect(code,stderr).toBe(0);expect(intermediate,stderr).toBe(true);
    expect(stderr).toContain('100%');expect(stderr).toContain('已下载');expect(stderr).toContain('速度');expect(stderr).toContain('剩余');
    expect(stderr).not.toContain('fixture_secret');expect(stdout).toBe('');
    expect((await readFile(join(root,'package.tar.gz'))).length).toBe(8192);
    expect((await readdir(root)).filter(n=>n.startsWith('.github-download.'))).toEqual([]);
  }finally{await rm(root,{recursive:true,force:true});}
});

it('announces environment, download, checksum, unpacking and account/service stages in the installer template',async()=>{
  const script=await readFile('deploy/install.sh','utf8');
  for(const stage of ['检查安装环境','下载发行清单','下载应用安装包','校验应用安装包','解包应用','初始化账号与服务'])expect(script).toContain(stage);
});
