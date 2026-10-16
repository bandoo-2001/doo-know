import { it, expect } from 'vitest';
import { mkdtemp, writeFile, mkdir, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';

// The command stub models GitHub's 302 boundary, not curl/wget's redirect implementation.
// Actual curl and wget are separately exercised against the published private release.
for (const client of ['curl', 'wget']) it(`uses ${client} without credential arguments or inherited config and drops authentication on the CDN hop`, async () => {
  const root = await mkdtemp(join(tmpdir(), 'github-bootstrap-'));
  try {
    const bin = join(root, 'bin'); await mkdir(bin);
    const token = join(root, 'github.token');
    await writeFile(token, 'fixture_github_012345678901234567890123456789', { mode: 0o600 });
    const executable = join(bin, client);
    await writeFile(executable, `#!${process.execPath}\n` + String.raw`
const fs=require('fs'),a=process.argv.slice(2);if(a.some(v=>v.includes('fixture_github_')))process.exit(71);
const get=(k)=>a[a.indexOf(k)+1];let url=a.at(-1),cfg=a.includes('--config')?fs.readFileSync(get('--config'),'utf8'):'';
if(url.startsWith('https://api.github.com/')) {
 if(!cfg.includes('Authorization: Bearer fixture_github_'))process.exit(72);
 const headers='HTTP/1.1 302 Found\r\nLocation: https://release-assets.githubusercontent.com/private/object?sig=fixture\r\n\r\n';
 if(a.includes('--dump-header')){fs.writeFileSync(get('--dump-header'),headers);process.stdout.write('302');}else process.stderr.write(headers);
} else {
 if(cfg.includes('Authorization')||(!a.includes('-q')&&!a.includes('--no-config')))process.exit(73);
 fs.writeFileSync(a.includes('--output')?get('--output'):get('-O'),'artifact bytes');
}
` , { mode: 0o700 });
    const shell = `source '${resolve('deploy/github-fetch.sh')}'\nDOOKNOW_GITHUB_TOKEN_FILE='${token}'\ngithub_fetch owner/private 81 '${join(root, 'result')}' ${client}\n`;
    const result = await new Promise<{ code: number | null; output: string }>((done) => {
      const p = spawn('bash', ['-c', shell], { env: { ...process.env, PATH: bin + ':' + process.env.PATH }, stdio: ['ignore', 'pipe', 'pipe'] });
      let output = ''; p.stdout.on('data', b => output += b); p.stderr.on('data', b => output += b); p.on('exit', code => done({ code, output }));
    });
    expect(result.output).not.toContain('fixture_github_');
    expect(result.code, result.output).toBe(0);
    expect(await readFile(join(root, 'result'), 'utf8')).toBe('artifact bytes');
  } finally { await rm(root, { recursive: true, force: true }); }
});
