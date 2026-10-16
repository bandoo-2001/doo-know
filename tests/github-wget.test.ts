import { it, expect } from 'vitest';
import { createServer } from 'node:http';
import { mkdtemp, writeFile, mkdir, readFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';

it('uses real GNU wget with the private config on the API hop and ignores default config on the unauthenticated CDN hop', async () => {
  const root = await mkdtemp(join(tmpdir(), 'github-real-wget-'));
  const headers: Array<string | undefined> = [];
  const server = createServer((req, res) => {
    headers.push(req.headers.authorization);
    if (req.url === '/api') {
      if (req.headers.authorization !== 'Bearer fixture_github_012345678901234567890123456789') { res.writeHead(401).end(); return; }
      res.writeHead(302, { location: 'https://release-assets.githubusercontent.com/private/object?sig=fixture' }).end();
    } else res.end('real wget bytes');
  });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  try {
    const bin = join(root, 'bin'), tokenFile = join(root, 'github.token'), poison = join(root, 'wgetrc'); await mkdir(bin);
    await writeFile(tokenFile, 'fixture_github_012345678901234567890123456789', { mode: 0o600 });
    await writeFile(poison, 'header = Authorization: Bearer fixture_unwanted_default\n', { mode: 0o600 });
    const realWget = execFileSync('sh', ['-c', 'command -v wget'], { encoding: 'utf8' }).trim();
    // Rewrite only the endpoint; the real executable parses all production flags/configs.
    await writeFile(join(bin, 'wget'), `#!${process.execPath}\nconst {spawnSync}=require('child_process');const a=process.argv.slice(2),u=a.at(-1);a[a.length-1]='http://127.0.0.1:${(server.address() as any).port}'+(u.startsWith('https://api.github.com/')?'/api':'/cdn');const r=spawnSync(${JSON.stringify(realWget)},a,{stdio:'inherit'});process.exit(r.status??1);`, { mode: 0o700 });
    const result = await promisify(execFile)('bash', ['-c', `source '${resolve('deploy/github-fetch.sh')}'\ngithub_fetch owner/private 81 '${join(root, 'result')}' wget`], { env: { ...process.env, PATH: bin + ':' + process.env.PATH, WGETRC: poison, DOOKNOW_GITHUB_TOKEN_FILE: tokenFile, http_proxy: '', https_proxy: '', no_proxy: '*' } });
    expect(result.stderr).not.toContain('fixture_github_');
    expect(headers).toEqual(['Bearer fixture_github_012345678901234567890123456789', undefined]);
    expect(await readFile(join(root, 'result'), 'utf8')).toBe('real wget bytes');
  } finally { server.closeAllConnections(); await new Promise<void>(r => server.close(() => r())); await rm(root, { recursive: true, force: true }); }
});
