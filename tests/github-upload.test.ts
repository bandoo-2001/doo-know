import { it, expect } from 'vitest';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { curlGithubUpload } from '../scripts/github-upload.js';
it('streams binary uploads with real curl, keeps credentials out of argv, ignores curlrc and refuses authenticated redirects', async () => {
  const root = await mkdtemp(join(tmpdir(), 'github-curl-upload-'));
  let redirect = false, requests = 0;
  const server = createServer(async (req, res) => {
    requests++; expect(req.headers.authorization).toBe('Bearer fixture_github_012345678901234567890123456789');
    const chunks = []; for await (const b of req) chunks.push(b);
    expect(Buffer.concat(chunks).toString()).toBe('binary fixture');
    if (redirect) res.writeHead(302, { location: 'https://evil.example/credential-target' }).end();
    else res.writeHead(201, { 'content-type': 'application/json' }).end('{"id":19}');
  });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  const originalPath = process.env.PATH, originalHome = process.env.CURL_HOME;
  try {
    const bin = join(root, 'bin'); await mkdir(bin);
    await writeFile(join(root, '.curlrc'), 'header = "Authorization: Bearer fixture_poisoned_default"\n');
    const realCurl = execFileSync('sh', ['-c', 'command -v curl'], { encoding: 'utf8' }).trim();
    await writeFile(join(bin, 'curl'), `#!${process.execPath}\nconst {spawnSync}=require('child_process');const a=process.argv.slice(2);if(a.some(x=>x.includes('fixture_github_')))process.exit(71);a[a.length-1]='http://127.0.0.1:${(server.address() as any).port}/';a[a.indexOf('--proto')+1]='=https,http';const r=spawnSync(${JSON.stringify(realCurl)},a,{stdio:'inherit',env:{...process.env,http_proxy:'',https_proxy:'',all_proxy:'',HTTP_PROXY:'',HTTPS_PROXY:'',ALL_PROXY:'',NO_PROXY:'*'}});process.exit(r.status??1);`, { mode: 0o700 });
    process.env.PATH = bin + ':' + originalPath; process.env.CURL_HOME = root;
    const file = join(root, 'artifact'); await writeFile(file, 'binary fixture');
    const url = 'https://uploads.github.com/repos/owner/private/releases/19/assets?name=artifact';
    const headers = { authorization: 'Bearer fixture_github_012345678901234567890123456789', 'content-type': 'application/octet-stream' };
    expect(await (await curlGithubUpload(url, headers, file, 14)).json()).toEqual({ id: 19 });
    redirect = true;
    await expect(curlGithubUpload(url, headers, file, 14)).rejects.toThrow('GITHUB_UPLOAD_HTTP_302');
    expect(requests).toBe(2);
  } finally { process.env.PATH = originalPath; if(originalHome===undefined)delete process.env.CURL_HOME;else process.env.CURL_HOME=originalHome; server.closeAllConnections(); await new Promise<void>(r=>server.close(()=>r())); await rm(root,{recursive:true,force:true}); }
});
