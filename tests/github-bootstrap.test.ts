import { it, expect } from 'vitest';
import { mkdtemp, writeFile, mkdir, rm, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';

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
 if(a.includes('--dump-header')){fs.writeFileSync(get('--dump-header'),headers);process.stdout.write('302');}else process.stderr.write(headers.replace(/^(.+)$/gm,'  $1')+'Location: https://release-assets.githubusercontent.com/private/object?sig=fixture [following]\n');
} else {
 if(cfg.includes('Authorization')||(!a.includes('-q')&&!a.includes('--no-config')))process.exit(73);
 fs.writeFileSync(a.includes('--output')?get('--output'):get('-O'),'artifact bytes');
 if(a.includes('--dump-header')){fs.writeFileSync(get('--dump-header'),'HTTP/1.1 200 OK\r\n\r\n');process.stdout.write('200');}
 else process.stderr.write('  HTTP/1.1 200 OK\n');
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

it.each([
  { client: 'curl', code: 6, status: '000', expected: '无法解析下载服务器地址' },
  { client: 'wget', code: 4, status: '000', details: 'Connection timed out', expected: '下载超时' },
  { client: 'curl', code: 60, status: '000', expected: 'TLS 证书校验失败' },
  { client: 'curl', code: 0, status: '401', expected: '下载认证失败' },
  { client: 'wget', code: 8, status: '403', headers: 'X-RateLimit-Remaining: 0\r\n', expected: '等待限流解除' },
  { client: 'wget', code: 8, status: '404', expected: '发行版或制品不可用' },
  { client: 'curl', code: 0, status: '407', expected: '代理要求认证' },
  { client: 'curl', code: 0, status: '503', expected: '服务端错误' },
  { client: 'curl', code: 0, status: '302', headers: 'Location: https://unexpected.example/files?signature=fixture_secret\r\n', expected: '未经允许的地址' },
  { client: 'curl', code: 0, status: '200', expected: '返回了空文件' },
])('explains $client response $status and exit $code without exposing tool output', async ({ client, code, status, details, headers, expected }) => {
  const root = await mkdtemp(join(tmpdir(), 'github-download-error-'));
  try {
    const output = join(root, 'artifact');
    const response = status === '000' ? '' : `  HTTP/1.1 ${status} example\r\n${headers ?? ''}\r\n`;
    await writeFile(join(root, client), `#!${process.execPath}\n` + `
const fs = require('fs');
const args = process.argv;
const headers = ${JSON.stringify(response)};
const headerIndex = args.indexOf('--dump-header');
if (headerIndex !== -1) {
  fs.writeFileSync(args[headerIndex + 1], headers);
  process.stdout.write(${JSON.stringify(status)});
} else {
  process.stderr.write(headers);
}
process.stderr.write(${JSON.stringify((details ?? '') + ' fixture_secret\n')});
process.exit(${code});
`, { mode: 0o700 });
    const result = await promisify(execFile)('bash', ['-c',
      'source "$1"; github_fetch owner/public 81 "$2" "$3"',
      '--', resolve('deploy/github-fetch.sh'), output, client,
    ], { env: { ...process.env, PATH: root + ':' + process.env.PATH, DOOKNOW_GITHUB_TOKEN_FILE: '' } })
      .then(({ stderr }) => ({ code: 0, stderr }), ({ code, stderr }) => ({ code, stderr }));
    expect(result.code).toBe(1);
    expect(result.stderr).toContain(expected);
    expect(result.stderr).not.toContain('fixture_secret');
    expect(await readdir(root)).toEqual([client]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it('identifies a pinned bootstrap checksum mismatch before executing the install script', async () => {
  const root = await mkdtemp(join(tmpdir(), 'github-bootstrap-invalid-'));
  try {
    await writeFile(join(root, 'curl'), `#!${process.execPath}\n` + String.raw`
const fs = require('fs');
const args = process.argv;
fs.writeFileSync(args[args.indexOf('--dump-header') + 1], 'HTTP/1.1 200 OK\r\n\r\n');
fs.writeFileSync(args[args.indexOf('--output') + 1], 'echo SHOULD_NOT_RUN');
process.stdout.write('200');
`, { mode: 0o700 });
    const result = await promisify(execFile)('bash', [resolve('deploy/github-install.sh')], {
      env: { ...process.env, PATH: root + ':' + process.env.PATH, TMPDIR: root, DOOKNOW_GITHUB_TOKEN_FILE: '' },
    }).then(({ stderr, stdout }) => ({ code: 0, stderr, stdout }), ({ code, stderr, stdout }) => ({ code, stderr, stdout }));
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('安装脚本的 SHA-256 校验失败');
    expect(result.stdout).not.toContain('SHOULD_NOT_RUN');
    expect(await readdir(root)).toEqual(['curl']);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
