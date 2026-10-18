import { it, expect } from 'vitest';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

for (const client of ['curl', 'wget']) it(`downloads public assets using ${client} with no token/config/auth and ignores a stale default token`, async () => {
  const root = await mkdtemp(join(tmpdir(), 'github-public-'));
  try {
    const bin=join(root,'bin'); await mkdir(bin);
    const secret=join(root,'config/doo-know/secrets'); await mkdir(secret,{recursive:true});
    await writeFile(join(secret,'github.token'),'invalid stale token',{mode:0o600});
    await writeFile(join(bin,client),`#!${process.execPath}\n`+String.raw`
const fs=require('fs'),a=process.argv.slice(2),get=k=>a[a.indexOf(k)+1];
if(a.includes('--config')||a.some(v=>/authorization|bearer/i.test(v)))process.exit(71);
const url=a.at(-1);if(!url.startsWith('https://github.com/owner/public/releases/download/v1/'))process.exit(72);
fs.writeFileSync(a.includes('--output')?get('--output'):get('-O'),'public bytes');
if(a.includes('--dump-header')){fs.writeFileSync(get('--dump-header'),'HTTP/1.1 200 OK\r\n\r\n');process.stdout.write('200');}
else process.stderr.write('  HTTP/1.1 200 OK\n');
`,{mode:0o700});
    await promisify(execFile)('bash',['-c',`source '${resolve('deploy/github-fetch.sh')}'\nunset DOOKNOW_GITHUB_TOKEN_FILE\ngithub_fetch owner/public 81 '${join(root,'asset')}' ${client} 'https://github.com/owner/public/releases/download/v1/package.tar.gz'`],{env:{...process.env,PATH:bin+':'+process.env.PATH,XDG_CONFIG_HOME:join(root,'config')}});
    expect(await readFile(join(root,'asset'),'utf8')).toBe('public bytes');
  } finally { await rm(root,{recursive:true,force:true}); }
});
